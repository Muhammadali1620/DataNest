<script lang="ts">
  import { onMount } from 'svelte';
  import type { CellValue } from '../../../../src/shared/cell-value';
  import type { EditInput } from '../../../../src/shared/cell-input';
import type { RowAction } from '../../../../src/shared/row-action';
  import {
    MAX_WINDOW_ROWS,
    type ResultGridProtocol,
    type ResultGridState,
    type ResultTab,
  } from '../../../../src/shared/protocols/result-grid';
  import type { RpcPeer } from '../../../../src/shared/rpc';
  import type { Translate } from '../../lib/i18n';
  import type { TableFilter } from '../../../../src/shared/table-filter';
  import { toTsv } from '../../../../src/shared/tsv';
  import { fitColumnWidth, initialWidths, keepWidths } from './columns';
  import {
    type ColumnView,
    displayOrder,
    isCustomized,
    isHidden,
    isPinned,
    NO_VIEW,
    showAll,
    toggleHidden,
    togglePinned,
    viewKey,
  } from './column-view';
  import Grid from './Grid.svelte';
  import { COPY_FORMATS, type CopyFormat } from '../../../../src/shared/copy-format';
  import type { MessageKey } from '../../l10n/en';
  import FilterBar from './FilterBar.svelte';
  import { activeCount } from './filter-model';
  import {
    currentPage,
    hasNextPage,
    isWholeTable,
    offsetOfPage,
    pageCount,
    pageSizeChoices,
  } from './pager-model';
  import RecordPanel from './RecordPanel.svelte';
  import ValuePanel from './ValuePanel.svelte';
  import { RowCache, windowFor } from './rows';
  import { type CellRef, type SelectionInfo } from './selection';

  /** Export formats beyond the CSV and JSON buttons. */
  const MORE_EXPORTS = ['sql', 'markdown', 'xlsx'] as const;

  interface Props {
    rpc: RpcPeer<ResultGridProtocol['webview'], ResultGridProtocol['host']>;
    t: Translate;
  }

  const { rpc, t }: Props = $props();

  let gridState = $state<ResultGridState | undefined>(undefined);
  let failure = $state<string | undefined>(undefined);
  let widths = $state<number[]>([]);
  let search = $state('');
  let hits = $state<number[]>([]);
  let hitTotal = $state(0);
  let hitIndex = $state(0);
  let revealRow = $state<number | undefined>(undefined);
  /** The selected cells, which "Copy as" renders; the whole result when nothing is selected. */
  let selected = $state<SelectionInfo | undefined>(undefined);
  /** What the last "Copy as" did, until the selection changes. */
  let copyNote = $state<string | undefined>(undefined);
  /** The filter bar of a table view, the columns it offers and whether a request is out. */
  let filterOpen = $state(false);
  let filterColumns = $state<string[]>([]);
  let filtering = $state(false);
  /** Which columns are hidden or pinned, per kind of result (the same columns share a view). */
  let views = $state<Record<string, ColumnView>>({});
  let columnsOpen = $state(false);
  /** Widths the user chose, per kind of result; not reactive: only `widths` is drawn. */
  const savedWidths: Record<string, number[]> = {};
  /** True once a width was dragged or fitted, so later rows do not re-measure over it. */
  let userSized = false;
  /** The rows on screen, so "fit to content" measures what the user is looking at. */
  let visibleRange = { first: 0, count: 0 };
  function changeView(next: ColumnView): void {
    views = { ...views, [viewId]: next };
  }

  function rememberWidths(next: number[]): void {
    widths = next;
    userSized = true;
    savedWidths[viewId] = next;
  }

  /** The rows that are loaded and on screen. */
  function rowsOnScreen(): (readonly CellValue[])[] {
    return Array.from({ length: visibleRange.count }, (_, offset) =>
      rowAt(visibleRange.first + offset),
    ).filter((row): row is readonly CellValue[] => row !== undefined);
  }

  function fit(index: number, rows: readonly (readonly CellValue[])[]): void {
    const column = activeTab?.columns[index];
    if (column === undefined) {
      return;
    }
    const next = [...widths];
    next[index] = fitColumnWidth(column, index, rows);
    rememberWidths(next);
  }

  function fitAll(): void {
    const tab = activeTab;
    if (tab === undefined) {
      return;
    }
    const rows = rowsOnScreen();
    rememberWidths(tab.columns.map((column, index) => fitColumnWidth(column, index, rows)));
  }

  /** The value panel beside the grid, and the cell it follows. */
  let valueOpen = $state(false);
  /** The record card; it takes the same place, so only one of the two is open. */
  let recordOpen = $state(false);
  let revealColumn = $state<number | undefined>(undefined);

  function toggleValue(): void {
    valueOpen = !valueOpen;
    recordOpen = false;
  }

  function toggleRecord(): void {
    recordOpen = !recordOpen;
    valueOpen = false;
  }

  /** Moves the card to the neighbouring row, keeping the focused column. */
  function stepRecord(delta: number): void {
    const tab = activeTab;
    if (focused === undefined || tab === undefined) {
      return;
    }
    const row = Math.max(0, Math.min(focused.row + delta, displayCount(tab) - 1));
    revealColumn = focused.column;
    // Re-pointing at the same row must still scroll, so the value is cleared first.
    revealRow = undefined;
    revealRow = row;
  }
  let focused = $state<CellRef | undefined>(undefined);
  /** Bumped when rows arrive, so the grid re-reads the cache. */
  let loaded = $state(0);

  /** Rows live here; the grid reads them through `rowAt`. */
  let cache = new RowCache();
  /** The window being fetched, so the same range is not asked for twice. */
  let pending: string | undefined;

  const activeTab = $derived<ResultTab | undefined>(
    gridState?.tabs.find((tab) => tab.id === gridState?.activeId),
  );

  const viewId = $derived(
    activeTab === undefined ? '' : viewKey(activeTab.columns.map((column) => column.name)),
  );
  const columnView = $derived(views[viewId] ?? NO_VIEW);
  const display = $derived(displayOrder(activeTab?.columns.length ?? 0, columnView));


  function rowAt(index: number): readonly CellValue[] | undefined {
    // Reading `loaded` ties the grid's cells to the rows that have arrived.
    return loaded >= 0 ? cache.get(index) : undefined;
  }

  const focusedCell = $derived<CellValue | undefined>(
    focused === undefined ? undefined : rowAt(focused.row)?.[focused.column],
  );

  async function loadBytes(): Promise<{ size: number; data?: string | undefined }> {
    const tab = activeTab;
    if (tab === undefined || focused === undefined) {
      return { size: 0 };
    }
    return rpc.request('binaryBytes', {
      resultId: tab.id,
      row: focused.row,
      column: focused.column,
    });
  }

  /** The table a column's foreign key leads to, if the column is part of one. */
  function linkTarget(column: number): string | undefined {
    return activeTab?.links?.find((link) => link.columns.includes(column))?.target;
  }

  async function follow(row: number, column: number): Promise<void> {
    const tab = activeTab;
    const link = tab?.links?.find((candidate) => candidate.columns.includes(column));
    if (tab === undefined || link === undefined) {
      return;
    }
    failure = undefined;
    try {
      const answer = await rpc.request('followLink', { resultId: tab.id, row, link: link.id });
      if (!answer.ok) {
        failure = t(`grid.linkError.${answer.error ?? 'no-link'}`);
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : t('grid.linkFailed');
    }
  }

  function stateAt(row: number): 'inserted' | 'deleted' | undefined {
    return loaded >= 0 ? cache.stateAt(row) : undefined;
  }

  /** Rows the grid shows: the server's, then the ones waiting to be inserted. */
  function displayCount(tab: ResultTab | undefined): number {
    return tab === undefined ? 0 : tab.rowCount + tab.insertedRows;
  }

  /** Adds, duplicates, deletes or restores rows; scrolls to the first new row. */
  async function onRowAction(action: RowAction, rows: number[]): Promise<void> {
    const tab = activeTab;
    if (tab === undefined) {
      return;
    }
    failure = undefined;
    try {
      const answer = await rpc.request('rowAction', { resultId: tab.id, action, rows });
      if (!answer.ok) {
        failure = t(`grid.editError.${answer.error ?? 'not-editable'}`);
      } else if (answer.row !== undefined) {
        // Re-pointing at the same row must still scroll, so the value is cleared first.
        revealRow = undefined;
        revealRow = answer.row;
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : t('grid.editFailed');
    }
  }

  /** The failure of the last save, with the statement that caused it. */
  let saveProblem = $state<{ message: string; statement?: string | undefined } | undefined>(
    undefined,
  );
  let saving = $state(false);

  function pendingCount(tab: ResultTab | undefined): number {
    return tab === undefined ? 0 : tab.changedCells + tab.insertedRows + tab.deletedRows;
  }

  async function onSave(): Promise<void> {
    const tab = activeTab;
    if (tab === undefined || saving || pendingCount(tab) === 0) {
      return;
    }
    saving = true;
    saveProblem = undefined;
    try {
      const answer = await rpc.request('saveChanges', { resultId: tab.id });
      if (!answer.ok) {
        saveProblem = {
          message: answer.message ?? t('grid.saveFailed'),
          statement: answer.statement,
        };
      }
    } catch (error) {
      saveProblem = { message: error instanceof Error ? error.message : t('grid.saveFailed') };
    } finally {
      saving = false;
    }
  }

  async function onPreview(): Promise<void> {
    const tab = activeTab;
    if (tab === undefined) {
      return;
    }
    saveProblem = undefined;
    try {
      const answer = await rpc.request('previewChanges', { resultId: tab.id });
      if (!answer.ok) {
        saveProblem = { message: answer.message ?? t('grid.saveFailed') };
      }
    } catch (error) {
      saveProblem = { message: error instanceof Error ? error.message : t('grid.saveFailed') };
    }
  }

  async function onDiscard(): Promise<void> {
    const tab = activeTab;
    if (tab === undefined) {
      return;
    }
    saveProblem = undefined;
    try {
      await rpc.request('discardChanges', { resultId: tab.id });
    } catch (error) {
      saveProblem = { message: error instanceof Error ? error.message : t('grid.saveFailed') };
    }
  }

  function changeAt(row: number, column: number): 'value' | 'default' | undefined {
    return loaded >= 0 ? cache.changeAt(row, column) : undefined;
  }

  /** Per column, how to edit it; undefined when the whole result is read-only. */
  const editColumns = $derived(
    activeTab?.edit?.editable === true ? (activeTab.edit.columns ?? []) : undefined,
  );

  /**
   * Sends one edit to the host. Resolves to what went wrong, or undefined when the
   * change was queued; the host then re-sends the state and the rows are re-read.
   */
  /** True while a page-size, load-all or count request is out. */
  let paging = $state(false);

  async function runPaging(request: () => Promise<unknown>): Promise<void> {
    if (paging) {
      return;
    }
    paging = true;
    failure = undefined;
    try {
      // The host answers by re-sending the state with the new page as a new tab.
      await request();
    } catch (error) {
      failure = error instanceof Error ? error.message : t('grid.pageFailed');
    } finally {
      paging = false;
    }
  }

  async function copyAs(format: CopyFormat): Promise<void> {
    const tab = activeTab;
    if (tab === undefined || tab.error !== undefined) {
      return;
    }
    failure = undefined;
    copyNote = undefined;
    // What is on screen is what is copied: hidden columns stay out, pinned ones come first.
    const columns = selected?.columns ?? (isCustomized(columnView) ? display.order : undefined);
    try {
      const answer = await rpc.request('copyAs', {
        resultId: tab.id,
        format,
        ...(selected === undefined ? {} : { top: selected.top, bottom: selected.bottom }),
        ...(columns === undefined ? {} : { columns: [...columns] }),
      });
      if (answer.ok) {
        copyNote = t('grid.copied', answer.rows ?? 0);
      } else {
        failure = t(`grid.copyError.${answer.error ?? 'no-rows'}`);
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : t('grid.copyFailed');
    }
  }

  async function onApplyFilter(filter: TableFilter | null): Promise<void> {
    const tab = activeTab;
    if (tab === undefined || filtering) {
      return;
    }
    filtering = true;
    failure = undefined;
    try {
      // The host answers by re-sending the state with the filtered result as a new tab.
      await rpc.request('filterTable', { resultId: tab.id, filter });
    } catch (error) {
      failure = error instanceof Error ? error.message : t('filter.failed');
    } finally {
      filtering = false;
    }
  }

  async function onEdit(row: number, column: number, input: EditInput): Promise<string | undefined> {
    const tab = activeTab;
    if (tab === undefined) {
      return t('grid.editFailed');
    }
    try {
      const answer = await rpc.request('editCell', { resultId: tab.id, row, column, input });
      return answer.ok ? undefined : t(`grid.editError.${answer.error ?? 'not-editable'}`);
    } catch (error) {
      return error instanceof Error ? error.message : t('grid.editFailed');
    }
  }

  async function fetchRows(tab: ResultTab, firstIndex: number, count: number): Promise<void> {
    const range = windowFor(firstIndex, count, displayCount(tab));
    if (range === undefined || cache.hasRange(range.offset, range.limit)) {
      return;
    }
    const key = `${tab.id}:${range.offset}:${range.limit}`;
    if (pending === key) {
      return;
    }
    pending = key;
    failure = undefined;
    try {
      const window = await rpc.request('rows', {
        resultId: tab.id,
        offset: range.offset,
        limit: range.limit,
      });
      // A late answer for another tab must not land in this one.
      if (window.resultId === gridState?.activeId) {
        cache.put(window.offset, window.rows, window.rowCount, window.changes, window.states);
        if (window.offset === 0 && window.rows.length > 0) {
          // The first rows are what the column widths are measured from, unless the
          // user has already sized them.
          if (!userSized) {
            widths = initialWidths(tab.columns, window.rows);
          }
        }
        loaded += 1;
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : t('grid.loadFailed');
    } finally {
      if (pending === key) {
        pending = undefined;
      }
    }
  }

  function onVisible(firstIndex: number, count: number): void {
    visibleRange = { first: firstIndex, count };
    const tab = activeTab;
    if (tab !== undefined && tab.error === undefined) {
      void fetchRows(tab, firstIndex, count);
    }
  }

  function resetFor(tab: ResultTab | undefined): void {
    saveProblem = undefined;
    cache = new RowCache();
    cache.reset(displayCount(tab));
    pending = undefined;
    failure = undefined;
    search = '';
    hits = [];
    hitTotal = 0;
    hitIndex = 0;
    revealRow = undefined;
    const saved =
      tab === undefined
        ? undefined
        : savedWidths[viewKey(tab.columns.map((column) => column.name))];
    widths = tab === undefined ? [] : (saved ?? keepWidths([], tab.columns));
    userSized = saved !== undefined;
    loaded += 1;
  }

  function selectTab(resultId: string): void {
    if (gridState === undefined || gridState.activeId === resultId) {
      return;
    }
    gridState = { ...gridState, activeId: resultId };
    rpc.emit('selectTab', { resultId });
    resetFor(gridState.tabs.find((candidate) => candidate.id === resultId));
  }

  /** Copies the selected cells as TSV, fetching whatever is not loaded yet. */
  async function copySelection(tab: ResultTab, selection: SelectionInfo): Promise<void> {
    const count = selection.bottom - selection.top + 1;
    failure = undefined;
    try {
      const window = await rpc.request('rows', {
        resultId: tab.id,
        offset: selection.top,
        limit: Math.min(count, MAX_WINDOW_ROWS),
      });
      if (window.resultId !== gridState?.activeId) {
        return;
      }
      // Only the selected cells travel: headers are a separate action (V2.8).
      const rows = window.rows.map((row) => selection.columns.map((column) => row[column] ?? null));
      rpc.emit('copyText', { text: toTsv(rows) });
    } catch (error) {
      failure = error instanceof Error ? error.message : t('grid.copyFailed');
    }
  }

  function onCopy(selection: SelectionInfo): void {
    const tab = activeTab;
    if (tab !== undefined && tab.error === undefined) {
      void copySelection(tab, selection);
    }
  }

  /** Clicking a header cycles ascending → descending → the server's own order. */
  async function onSort(column: number): Promise<void> {
    const tab = activeTab;
    if (tab === undefined || tab.error !== undefined) {
      return;
    }
    const current = tab.sort;
    const direction =
      current?.column !== column ? 'asc' : current.direction === 'asc' ? 'desc' : undefined;
    try {
      await rpc.request('sort', {
        resultId: tab.id,
        column,
        ...(direction === undefined ? {} : { direction }),
      });
      // The host answers by re-sending the state; the handler below reloads the
      // rows and re-runs the search, because sorting moved every row index.
    } catch (error) {
      failure = error instanceof Error ? error.message : t('grid.sortFailed');
    }
  }

  async function runSearch(text: string): Promise<void> {
    const tab = activeTab;
    search = text;
    if (tab === undefined || text.trim() === '') {
      hits = [];
      hitTotal = 0;
      hitIndex = 0;
      return;
    }
    try {
      const found = await rpc.request('search', { resultId: tab.id, text });
      // Typing on while a big result is searched: only the latest text's answer counts.
      if (found.resultId !== gridState?.activeId || search !== text) {
        return;
      }
      hits = found.rows;
      hitTotal = found.total;
      hitIndex = 0;
      revealRow = found.rows[0];
    } catch (error) {
      failure = error instanceof Error ? error.message : t('grid.searchFailed');
    }
  }

  /** Steps through the matches, wrapping around at both ends. */
  function stepHit(delta: number): void {
    if (hits.length === 0) {
      return;
    }
    hitIndex = (hitIndex + delta + hits.length) % hits.length;
    const row = hits[hitIndex];
    // Re-pointing at the same row must still scroll, so the value is cleared first.
    revealRow = undefined;
    revealRow = row;
  }

  /** Shows another page of a table view. */
  async function goToPage(offset: number): Promise<void> {
    const tab = activeTab;
    if (tab?.page === undefined || offset < 0) {
      return;
    }
    try {
      await rpc.request('pageTo', { resultId: tab.id, offset });
    } catch (error) {
      failure = error instanceof Error ? error.message : t('grid.pageFailed');
    }
  }

  function onResize(index: number, width: number): void {
    const next = [...widths];
    next[index] = width;
    rememberWidths(next);
  }

  onMount(() => {
    const subscription = rpc.on('state', (next) => {
      const previous = activeTab;
      gridState = next;
      const tab = next.tabs.find((candidate) => candidate.id === next.activeId);
      if (tab?.page !== undefined && tab.columns.length > 0) {
        // A failed read has no columns, but the bar still needs them to be corrected.
        filterColumns = tab.columns.map((column) => column.name);
      }
      // Rows are kept only while the very same result in the very same order is
      // still on screen; sorting changes which row sits at which index.
      const sameOrder =
        tab !== undefined &&
        previous?.id === tab.id &&
        previous.rowCount === tab.rowCount &&
        previous.sort?.column === tab.sort?.column &&
        previous.sort?.direction === tab.sort?.direction;
      const sameResult = sameOrder && previous.revision === tab.revision;
      if (sameOrder && !sameResult) {
        // A pending change moved: the rows must be read again, but the widths and the
        // search belong to the same result and stay.
        cache.reset(displayCount(tab));
        pending = undefined;
        loaded += 1;
      } else if (!sameResult) {
        // The same result in a new order keeps the search; another tab starts fresh.
        const text = tab !== undefined && previous?.id === tab.id ? search : '';
        resetFor(tab);
        if (text !== '') {
          void runSearch(text);
        }
      }
    });
    rpc.emit('ready', {});
    return () => {
      subscription.dispose();
    };
  });
</script>

<main>
  {#if gridState === undefined}
    <p class="hint">{t('grid.loading')}</p>
  {:else if gridState.tabs.length === 0}
    <p class="hint">{gridState.running ? t('grid.running') : t('grid.empty')}</p>
  {:else}
    <div class="tabs" role="tablist">
      {#each gridState.tabs as tab (tab.id)}
        <button
          type="button"
          role="tab"
          class="tab"
          class:active={tab.id === gridState.activeId}
          class:failed={tab.error !== undefined}
          aria-selected={tab.id === gridState.activeId}
          title={tab.statement}
          onclick={() => {
            selectTab(tab.id);
          }}
        >
          {tab.title}
        </button>
      {/each}
      <span class="spacer"></span>
      {#if activeTab !== undefined && activeTab.error === undefined && activeTab.columns.length > 0}
        <button
          type="button"
          class="cancel"
          aria-pressed={columnsOpen}
          title={t('columns.hint')}
          data-testid="columns-toggle"
          onclick={() => {
            columnsOpen = !columnsOpen;
          }}
        >
          {columnView.hidden.length > 0
            ? t('columns.titleHidden', columnView.hidden.length)
            : t('columns.title')}
        </button>
        <select
          class="cancel"
          aria-label={t('grid.copyAs')}
          title={t('grid.copyAsHint')}
          data-testid="copy-as"
          value=""
          onchange={(event) => {
            const format = COPY_FORMATS.find((item) => item === event.currentTarget.value);
            event.currentTarget.value = '';
            if (format !== undefined) {
              void copyAs(format);
            }
          }}
        >
          <option value="" disabled>{t('grid.copyAs')}</option>
          {#each COPY_FORMATS as format (format)}
            <option value={format} disabled={format === 'update' && editColumns === undefined}>
              {t(`grid.copyFormat.${format}` as MessageKey)}
            </option>
          {/each}
        </select>
        {#if copyNote !== undefined}
          <span class="note" data-testid="copy-note">{copyNote}</span>
        {/if}
      {/if}
      {#if activeTab?.page !== undefined}
        <button
          type="button"
          class="cancel"
          aria-pressed={filterOpen}
          data-testid="filter-toggle"
          onclick={() => {
            filterOpen = !filterOpen;
          }}
        >
          {activeCount(activeTab.filter) > 0
            ? t('filter.titleWithCount', activeCount(activeTab.filter))
            : t('filter.title')}
        </button>
      {/if}
      {#if activeTab !== undefined && activeTab.error === undefined && activeTab.columns.length > 0}
        <button
          type="button"
          class="cancel"
          aria-pressed={valueOpen}
          title={t('value.toggleHint')}
          data-testid="value-toggle"
          onclick={toggleValue}
        >
          {t('value.title')}
        </button>
        <button
          type="button"
          class="cancel"
          aria-pressed={recordOpen}
          title={t('record.toggleHint')}
          data-testid="record-toggle"
          onclick={toggleRecord}
        >
          {t('record.title')}
        </button>
      {/if}
      {#if gridState.running}
        <button
          type="button"
          class="cancel"
          onclick={() => {
            rpc.emit('cancel', {});
          }}
        >
          {t('grid.cancel')}
        </button>
      {:else if activeTab !== undefined && activeTab.error === undefined}
        {#if activeTab.columns.length > 0}
          <button
            type="button"
            class="cancel"
            title={t('grid.chartHint')}
            data-testid="chart"
            onclick={() => {
              rpc.emit('chartResult', { resultId: activeTab.id });
            }}
          >
            {t('grid.chart')}
          </button>
        {/if}
        <button
          type="button"
          class="cancel"
          title={t('grid.exportHint')}
          onclick={() => {
            rpc.emit('exportResult', { resultId: activeTab.id, format: 'csv' });
          }}
        >
          {t('grid.exportCsv')}
        </button>
        <button
          type="button"
          class="cancel"
          title={t('grid.exportHint')}
          onclick={() => {
            rpc.emit('exportResult', { resultId: activeTab.id, format: 'json' });
          }}
        >
          {t('grid.exportJson')}
        </button>
        <select
          class="cancel"
          aria-label={t('grid.exportMore')}
          title={t('grid.exportHint')}
          data-testid="export-more"
          value=""
          onchange={(event) => {
            const format = MORE_EXPORTS.find((item) => item === event.currentTarget.value);
            event.currentTarget.value = '';
            if (format !== undefined) {
              rpc.emit('exportResult', { resultId: activeTab.id, format });
            }
          }}
        >
          <option value="" disabled>{t('grid.exportMore')}</option>
          {#each MORE_EXPORTS as format (format)}
            <option value={format}>{t(`grid.exportFormat.${format}` as MessageKey)}</option>
          {/each}
        </select>
      {/if}
    </div>

    {#if columnsOpen && activeTab !== undefined && activeTab.error === undefined && activeTab.columns.length > 0}
      <div class="columns-menu" data-testid="columns-menu" role="group" aria-label={t('columns.title')}>
        <div class="columns-actions">
          <button
            type="button"
            class="cancel"
            data-testid="columns-show-all"
            disabled={columnView.hidden.length === 0}
            onclick={() => {
              changeView(showAll(columnView));
            }}
          >
            {t('columns.showAll')}
          </button>
          <button
            type="button"
            class="cancel"
            data-testid="columns-fit-all"
            onclick={fitAll}
          >
            {t('columns.fitAll')}
          </button>
          <button
            type="button"
            class="cancel"
            data-testid="columns-reset"
            disabled={!isCustomized(columnView)}
            onclick={() => {
              changeView(NO_VIEW);
            }}
          >
            {t('columns.reset')}
          </button>
        </div>
        <ul class="columns-list">
          {#each activeTab.columns as column, index (index)}
            <li class="columns-item" data-testid="columns-item">
              <label>
                <input
                  type="checkbox"
                  checked={!isHidden(columnView, index)}
                  onchange={() => {
                    changeView(toggleHidden(columnView, index, activeTab.columns.length));
                  }}
                />
                {column.name === '' ? `#${index + 1}` : column.name}
              </label>
              <button
                type="button"
                class="pin-toggle"
                aria-pressed={isPinned(columnView, index)}
                aria-label={t('columns.pin', column.name)}
                title={t('columns.pinHint')}
                disabled={isHidden(columnView, index)}
                onclick={() => {
                  changeView(togglePinned(columnView, index));
                }}
              >
                📌
              </button>
            </li>
          {/each}
        </ul>
      </div>
    {/if}

    {#if activeTab?.page !== undefined && filterOpen}
      {#key activeTab.id}
        <FilterBar
          columns={filterColumns}
          applied={activeTab.filter}
          busy={filtering}
          onApply={(filter: TableFilter | null) => {
            void onApplyFilter(filter);
          }}
          {t}
        />
      {/key}
    {/if}

    {#if activeTab === undefined}
      <p class="hint">{t('grid.empty')}</p>
    {:else if activeTab.error !== undefined}
      <div class="failed" role="alert" data-testid="error">
        <p class="error">{activeTab.error.message}</p>
        <p class="where">
          {#if activeTab.error.position !== undefined}
            {t('grid.errorAt', activeTab.error.position + 1)}
          {/if}
          <button
            type="button"
            class="link"
            onclick={() => {
              rpc.emit('revealError', { resultId: activeTab.id });
            }}
          >
            {t('grid.goToError')}
          </button>
        </p>
      </div>
    {:else}
      <p class="summary" data-testid="summary">
        {#if activeTab.affectedRows !== undefined}
          {t('grid.affected', activeTab.affectedRows, activeTab.durationMs)}
        {:else}
          {t('grid.rows', activeTab.rowCount, activeTab.durationMs)}
        {/if}
        {#if activeTab.truncated}
          <span class="warn">{t('grid.truncated')}</span>
        {/if}
        {#if activeTab.changedCells + activeTab.insertedRows + activeTab.deletedRows > 0}
          <span class="warn" data-testid="changed-count">
            {t(
              'grid.changedCells',
              activeTab.changedCells + activeTab.insertedRows + activeTab.deletedRows,
            )}
          </span>
        {/if}
        {#if activeTab.edit !== undefined}
          {#if activeTab.edit.editable}
            <span class="badge" data-testid="edit-badge">{t('grid.editable')}</span>
          {:else}
            <span
              class="badge readonly"
              data-testid="edit-badge"
              title={activeTab.edit.reason === undefined
                ? ''
                : t(`grid.readOnly.${activeTab.edit.reason}`)}
            >
              {t('grid.readOnly')}
            </span>
          {/if}
        {/if}
      </p>
      {#if activeTab.columns.length > 0}
        <div class="find">
          <input
            class="control"
            type="search"
            placeholder={t('grid.searchPlaceholder')}
            aria-label={t('grid.searchPlaceholder')}
            value={search}
            oninput={(event) => {
              void runSearch(event.currentTarget.value);
            }}
            onkeydown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                stepHit(event.shiftKey ? -1 : 1);
              }
            }}
          />
          {#if search.trim() !== ''}
            <span class="hits" data-testid="hits">
              {hitTotal === 0
                ? t('grid.noMatches')
                : t('grid.matchOf', hitIndex + 1, hitTotal)}
            </span>
            <button
              type="button"
              class="step"
              aria-label={t('grid.previousMatch')}
              disabled={hits.length === 0}
              onclick={() => {
                stepHit(-1);
              }}
            >
              ↑
            </button>
            <button
              type="button"
              class="step"
              aria-label={t('grid.nextMatch')}
              disabled={hits.length === 0}
              onclick={() => {
                stepHit(1);
              }}
            >
              ↓
            </button>
          {/if}
        </div>
        {#if pendingCount(activeTab) > 0}
          <div class="changes" data-testid="changes-bar">
            <button
              type="button"
              class="primary"
              disabled={saving}
              onclick={() => {
                void onSave();
              }}
            >
              {saving ? t('grid.saving') : t('grid.save', pendingCount(activeTab))}
            </button>
            <button
              type="button"
              class="cancel"
              disabled={saving}
              onclick={() => {
                void onPreview();
              }}
            >
              {t('grid.previewSql')}
            </button>
            <button
              type="button"
              class="cancel"
              disabled={saving}
              onclick={() => {
                void onDiscard();
              }}
            >
              {t('grid.discard')}
            </button>
          </div>
        {/if}
        {#if saveProblem !== undefined}
          <div class="save-problem" role="alert" data-testid="save-error">
            <p>{saveProblem.message}</p>
            {#if saveProblem.statement !== undefined}
              <p class="statement"><code>{saveProblem.statement}</code></p>
            {/if}
          </div>
        {/if}
        <div class="body">
          <div class="grid-area">
        <Grid
          resetKey={`${activeTab.id}:${activeTab.rowCount}:${activeTab.columns.length}:${display.order.join(',')}`}
          order={display.order}
          pinnedCount={display.pinnedCount}
          onFit={fit}
          sort={activeTab.sort}
          {onSort}
          {revealRow}
          columns={activeTab.columns}
          rowCount={displayCount(activeTab)}
          {widths}
          {rowAt}
          {onVisible}
          {onResize}
          {onCopy}
          {editColumns}
          {changeAt}
          {stateAt}
          {onEdit}
          {onRowAction}
          {onSave}
          onSelectionChange={(next: SelectionInfo | undefined) => {
            selected = next;
            copyNote = undefined;
          }}
          onFocusChange={(cell: CellRef | undefined) => {
            focused = cell;
          }}
          onToggleValue={toggleValue}
          onToggleRecord={toggleRecord}
          {revealColumn}
          {linkTarget}
          onFollow={(row: number, column: number) => {
            void follow(row, column);
          }}
          {t}
        />
          </div>
          {#if recordOpen}
            <RecordPanel
              row={focused?.row}
              rowCount={displayCount(activeTab)}
              rowKey={`${activeTab.id}:${activeTab.revision}:${activeTab.sort?.column ?? ''}${activeTab.sort?.direction ?? ''}:${focused?.row ?? ''}`}
              columns={activeTab.columns}
              cells={focused === undefined ? undefined : rowAt(focused.row)}
              {editColumns}
              {changeAt}
              {stateAt}
              {onEdit}
              {linkTarget}
              onFollow={(column: number) => {
                if (focused !== undefined) {
                  void follow(focused.row, column);
                }
              }}
              onStep={stepRecord}
              onClose={() => {
                recordOpen = false;
              }}
              {t}
            />
          {/if}
          {#if valueOpen}
            <ValuePanel
              cell={focusedCell}
              cellKey={`${activeTab.id}:${activeTab.revision}:${activeTab.sort?.column ?? ''}${activeTab.sort?.direction ?? ''}:${focused?.row ?? ''}:${focused?.column ?? ''}`}
              columnName={focused === undefined ? undefined : activeTab.columns[focused.column]?.name}
              dataType={focused === undefined ? undefined : activeTab.columns[focused.column]?.dataType}
              {loadBytes}
              onCopy={(text: string) => {
                rpc.emit('copyText', { text });
              }}
              onClose={() => {
                valueOpen = false;
              }}
              {t}
            />
          {/if}
        </div>
      {/if}
      {#if activeTab.page !== undefined}
        {@const page = activeTab.page}
        {@const from = activeTab.rowCount === 0 ? 0 : page.offset + 1}
        {@const to = page.offset + activeTab.rowCount}
        {@const pages = pageCount(page)}
        <div class="pager" data-testid="pager">
          <button
            type="button"
            class="button secondary"
            disabled={page.offset === 0}
            onclick={() => {
              void goToPage(Math.max(0, page.offset - page.pageSize));
            }}
          >
            {t('grid.previousPage')}
          </button>
          <span class="range" data-testid="range">
            {page.totalRows === undefined
              ? t('grid.rangeUnknown', from, to)
              : page.approximate === true
                ? t('grid.rangeApproximate', from, to, page.totalRows)
                : t('grid.range', from, to, page.totalRows)}
          </span>
          {#if page.approximate === true}
            <button
              type="button"
              class="button secondary"
              title={t('grid.countExactlyHint')}
              data-testid="count-exactly"
              disabled={paging}
              onclick={() => {
                void runPaging(() => rpc.request('countRows', { resultId: activeTab.id }));
              }}
            >
              {t('grid.countExactly')}
            </button>
          {/if}
          <button
            type="button"
            class="button secondary"
            disabled={!hasNextPage(page, activeTab.rowCount)}
            onclick={() => {
              void goToPage(page.offset + page.pageSize);
            }}
          >
            {t('grid.nextPage')}
          </button>
          <span class="spacer"></span>
          <label class="field">
            {t('grid.pageNumber')}
            <input
              class="control number"
              type="number"
              min="1"
              max={pages}
              data-testid="page-number"
              value={currentPage(page.offset, page.pageSize)}
              onkeydown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  const offset = offsetOfPage(event.currentTarget.valueAsNumber, page);
                  if (offset !== undefined) {
                    void goToPage(offset);
                  }
                }
              }}
            />
            {#if pages !== undefined}
              {t('grid.ofPages', pages)}
            {/if}
          </label>
          <label class="field">
            {t('grid.pageSize')}
            <select
              class="control"
              data-testid="page-size"
              disabled={paging}
              value={page.pageSize}
              onchange={(event) => {
                const size = Number(event.currentTarget.value);
                void runPaging(() =>
                  rpc.request('pageSize', { resultId: activeTab.id, pageSize: size }),
                );
              }}
            >
              {#each pageSizeChoices(page.pageSize) as size (size)}
                <option value={size}>{size}</option>
              {/each}
            </select>
          </label>
          <button
            type="button"
            class="button secondary"
            title={t('grid.loadAllHint')}
            data-testid="load-all"
            disabled={paging || isWholeTable(page, activeTab.rowCount)}
            onclick={() => {
              void runPaging(() => rpc.request('loadAll', { resultId: activeTab.id }));
            }}
          >
            {t('grid.loadAll')}
          </button>
        </div>
      {/if}
      {#if failure !== undefined}
        <p class="error" role="alert">{failure}</p>
      {/if}
    {/if}
  {/if}
</main>

<style>
  main {
    display: flex;
    flex-direction: column;
    height: 100vh;
    padding: 0;
  }

  .body {
    display: flex;
    flex: 1;
    min-height: 0;
  }

  .grid-area {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }

  .tabs {
    display: flex;
    flex: none;
    gap: 2px;
    align-items: center;
    padding: 4px 8px 0;
    overflow-x: auto;
  }

  .tab {
    padding: 4px 10px;
    color: var(--vscode-foreground);
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    font-family: inherit;
    font-size: inherit;
    white-space: nowrap;
    cursor: pointer;
  }

  .tab.active {
    border-bottom-color: var(--vscode-focusBorder);
  }

  .tab.failed {
    color: var(--vscode-errorForeground);
  }

  .spacer {
    flex: 1;
  }

  .cancel {
    padding: 2px 10px;
    color: var(--vscode-button-secondaryForeground);
    background: var(--vscode-button-secondaryBackground);
    border: none;
    border-radius: 2px;
    cursor: pointer;
  }

  .changes {
    display: flex;
    flex: none;
    gap: 6px;
    align-items: center;
    padding: 2px 8px;
  }

  .primary {
    padding: 2px 10px;
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
    border: none;
    border-radius: 2px;
    cursor: pointer;
  }

  .primary:disabled,
  .cancel:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .save-problem {
    flex: none;
    margin: 2px 8px;
    padding: 4px 8px;
    color: var(--vscode-inputValidation-errorForeground, var(--vscode-foreground));
    background: var(--vscode-inputValidation-errorBackground);
    border: 1px solid var(--vscode-inputValidation-errorBorder);
  }

  .save-problem p {
    margin: 0;
  }

  .statement {
    margin-top: 2px;
    overflow-wrap: anywhere;
    font-family: var(--vscode-editor-font-family);
  }

  .find {
    display: flex;
    flex: none;
    gap: 6px;
    align-items: center;
    padding: 0 8px;
  }

  .find .control {
    width: 220px;
  }

  .hits {
    color: var(--vscode-descriptionForeground);
    font-size: 0.9em;
  }

  .step {
    padding: 0 6px;
    color: var(--vscode-foreground);
    background: none;
    border: none;
    cursor: pointer;
  }

  .step:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .pager {
    display: flex;
    flex: none;
    gap: 8px;
    align-items: center;
    padding: 4px 8px;
    border-top: 1px solid var(--vscode-panel-border);
  }

  .columns-menu {
    display: flex;
    flex: none;
    flex-direction: column;
    gap: 4px;
    max-height: 40vh;
    padding: 4px 8px;
    border-bottom: 1px solid var(--vscode-panel-border);
  }

  .columns-actions {
    display: flex;
    gap: 6px;
  }

  .columns-list {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 2px 12px;
    margin: 0;
    padding: 0;
    overflow: auto;
    list-style: none;
  }

  .columns-item {
    display: flex;
    gap: 4px;
    align-items: center;
    justify-content: space-between;
  }

  .columns-item label {
    display: flex;
    gap: 4px;
    align-items: center;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .pin-toggle {
    padding: 0 4px;
    background: none;
    border: none;
    opacity: 0.4;
    cursor: pointer;
  }

  .pin-toggle[aria-pressed='true'] {
    opacity: 1;
  }

  .pin-toggle:disabled {
    opacity: 0.2;
    cursor: default;
  }

  .note {
    color: var(--vscode-descriptionForeground);
    font-size: 0.9em;
  }

  .field {
    display: flex;
    gap: 4px;
    align-items: center;
    color: var(--vscode-descriptionForeground);
  }

  .control {
    padding: 1px 4px;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    font: inherit;
  }

  .control.number {
    width: 5em;
  }

  .range {
    color: var(--vscode-descriptionForeground);
    font-size: 0.9em;
  }

  .summary,
  .hint,
  .error {
    flex: none;
    margin: 4px 8px;
    font-size: 0.95em;
  }

  .summary,
  .hint {
    color: var(--vscode-descriptionForeground);
  }

  .badge {
    margin-left: 8px;
    padding: 0 6px;
    border-radius: 3px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    font-size: 0.9em;
  }

  .badge.readonly {
    background: transparent;
    border: 1px solid var(--vscode-widget-border, var(--vscode-contrastBorder, currentColor));
    color: var(--vscode-descriptionForeground);
  }

  .warn {
    margin-left: 6px;
    color: var(--vscode-editorWarning-foreground);
  }

  .error {
    color: var(--vscode-errorForeground);
  }

  .failed {
    flex: none;
    margin: 4px 8px;
  }

  .failed .error {
    margin: 0 0 2px;
    white-space: pre-wrap;
  }

  .where {
    display: flex;
    gap: 8px;
    align-items: center;
    margin: 0;
    color: var(--vscode-descriptionForeground);
    font-size: 0.9em;
  }

  .link {
    padding: 0;
    color: var(--vscode-textLink-foreground);
    background: none;
    border: none;
    font: inherit;
    text-decoration: underline;
    cursor: pointer;
  }
</style>

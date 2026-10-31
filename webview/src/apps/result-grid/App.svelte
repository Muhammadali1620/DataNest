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
    type SelectionTotals,
  } from '../../../../src/shared/protocols/result-grid';

  /** How long the selection must stay still before its totals are asked for. */
  const TOTALS_DELAY_MS = 150;
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
  import Icon from '../../components/Icon.svelte';
  import IconButton from '../../components/IconButton.svelte';
  import MenuButton from '../../components/MenuButton.svelte';
  import type { CodiconName } from '../../lib/codicons';
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

  /** What the Export menu offers, in its order: the everyday formats first. */
  const EXPORTS = ['csv', 'json', 'sql', 'markdown', 'xlsx'] as const;
  type ExportFormat = (typeof EXPORTS)[number];
  const EXPORT_LABELS: Readonly<Record<ExportFormat, MessageKey>> = {
    csv: 'grid.exportFormat.csv',
    json: 'grid.exportFormat.json',
    sql: 'grid.exportFormat.sql',
    markdown: 'grid.exportFormat.markdown',
    xlsx: 'grid.exportFormat.xlsx',
  };
  const EXPORT_ICONS: Readonly<Record<ExportFormat, CodiconName>> = {
    csv: 'table',
    json: 'json',
    sql: 'database',
    markdown: 'markdown',
    xlsx: 'file',
  };

  interface Props {
    rpc: RpcPeer<ResultGridProtocol['webview'], ResultGridProtocol['host']>;
    t: Translate;
  }

  const { rpc, t }: Props = $props();

  /** The modifier of the Run key binding as the user's keyboard labels it. */
  const RUN_MODIFIER = navigator.userAgent.includes('Mac') ? '⌘' : 'Ctrl';

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
  /** Totals of the selected cells (V10.2.4), for a selection of more than one cell. */
  let totals = $state<SelectionTotals | undefined>(undefined);
  let totalsTimer: ReturnType<typeof setTimeout> | undefined;
  /** Grows with every question, so an answer about an older selection is dropped. */
  let totalsAsked = 0;
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

  /** Asks for the totals a moment after the selection settles; one cell has none. */
  function scheduleTotals(tab: ResultTab | undefined, selection: SelectionInfo | undefined): void {
    clearTimeout(totalsTimer);
    const ask = ++totalsAsked;
    if (
      tab === undefined ||
      selection === undefined ||
      (selection.bottom === selection.top && selection.columns.length < 2)
    ) {
      totals = undefined;
      return;
    }
    totalsTimer = setTimeout(() => {
      void fetchTotals(tab.id, selection, ask);
    }, TOTALS_DELAY_MS);
  }

  async function fetchTotals(resultId: string, selection: SelectionInfo, ask: number) {
    try {
      const answer = await rpc.request('summarize', {
        resultId,
        top: selection.top,
        bottom: selection.bottom,
        columns: [...selection.columns],
      });
      if (ask === totalsAsked) {
        totals = answer.stale === true ? undefined : answer;
      }
    } catch {
      // Totals are a convenience: a failed answer (a closed panel) just leaves them out.
      if (ask === totalsAsked) {
        totals = undefined;
      }
    }
  }

  function totalsText(summary: SelectionTotals): string {
    const parts = [t('grid.totals.count', summary.values ?? 0)];
    if ((summary.numbers ?? 0) > 0) {
      const about = summary.approximate === true ? '≈ ' : '';
      parts.push(
        t('grid.totals.sum', `${about}${summary.sum ?? ''}`),
        t('grid.totals.average', `${about}${summary.average ?? ''}`),
        t('grid.totals.min', summary.min ?? ''),
        t('grid.totals.max', summary.max ?? ''),
      );
    }
    return parts.join(' · ');
  }

  /** Kinds of columns a file can be loaded into: bytes, text and JSON (V10.2.4). */
  function canLoadFile(tab: ResultTab | undefined, cell: CellRef | undefined): boolean {
    if (tab?.edit?.editable !== true || cell === undefined) {
      return false;
    }
    const kind = tab.edit.columns?.[cell.column]?.kind;
    return kind === 'binary' || kind === 'text' || kind === 'json';
  }

  async function saveValueFile(): Promise<void> {
    const tab = activeTab;
    const cell = focused;
    if (tab === undefined || cell === undefined) {
      return;
    }
    try {
      const answer = await rpc.request('saveValue', {
        resultId: tab.id,
        row: cell.row,
        column: cell.column,
      });
      // A closed dialog is the user's choice; a failed write was already reported.
      if (answer.error === 'no-value' || answer.error === 'too-large') {
        failure = t(`value.saveError.${answer.error}`);
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : t('value.saveFailed');
    }
  }

  async function loadValueFile(): Promise<void> {
    const tab = activeTab;
    const cell = focused;
    if (tab === undefined || cell === undefined) {
      return;
    }
    try {
      const answer = await rpc.request('loadValue', {
        resultId: tab.id,
        row: cell.row,
        column: cell.column,
      });
      if (!answer.ok && answer.cancelled !== true) {
        failure = t(`grid.editError.${answer.error ?? 'not-editable'}`);
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : t('grid.editFailed');
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
      if (found.resultId !== gridState?.activeId || search !== text || found.stale === true) {
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
      if (!sameResult) {
        // Edits, a sort or new rows change what the selected cells hold.
        scheduleTotals(tab, sameOrder ? selected : undefined);
      }
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
  {#if gridState?.running === true}
    <div class="progress-bar" role="progressbar" aria-label={t('grid.running')}></div>
  {/if}
  {#if gridState === undefined}
    <div class="empty" role="status">
      <Icon name="loading" size={20} spin />
      <p class="empty-title">{t('grid.loading')}</p>
    </div>
  {:else if gridState.tabs.length === 0}
    <div class="empty" role="status">
      <span class="empty-icon"><Icon name={gridState.running ? 'loading' : 'table'} size={28} spin={gridState.running} /></span>
      <p class="empty-title">{gridState.running ? t('grid.running') : t('grid.empty')}</p>
      {#if !gridState.running}
        <p class="empty-hint">{t('grid.emptyHint')} <kbd>{RUN_MODIFIER}</kbd>+<kbd>Enter</kbd></p>
      {/if}
      {#if gridState.running}
        <button
          type="button"
          class="button secondary"
          onclick={() => {
            rpc.emit('cancel', {});
          }}
        >
          <Icon name="debug-stop" />{t('grid.cancel')}
        </button>
      {/if}
    </div>
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
          <Icon
            name={tab.error !== undefined ? 'error' : tab.affectedRows !== undefined ? 'check' : 'table'}
            size={14}
          /><span class="tab-title">{tab.title}</span>
        </button>
      {/each}
    </div>

    {#if activeTab !== undefined && activeTab.error === undefined}
      {@const hasColumns = activeTab.columns.length > 0}
      <div class="toolbar-row">
        {#if hasColumns}
          <div class="find">
            <span class="find-icon"><Icon name="search" size={14} /></span>
            <input
              class="control find-input"
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
              <span class="hits" class:none={hitTotal === 0} role="status" data-testid="hits">
                {hitTotal === 0 ? t('grid.noMatches') : t('grid.matchOf', hitIndex + 1, hitTotal)}
              </span>
              <IconButton
                icon="arrow-up"
                label={t('grid.previousMatch')}
                disabled={hits.length === 0}
                onclick={() => {
                  stepHit(-1);
                }}
              />
              <IconButton
                icon="arrow-down"
                label={t('grid.nextMatch')}
                disabled={hits.length === 0}
                onclick={() => {
                  stepHit(1);
                }}
              />
            {/if}
          </div>
        {/if}
        <span class="spacer"></span>
        {#if copyNote !== undefined}
          <span class="note fade-in" data-testid="copy-note"><Icon name="check" size={14} />{copyNote}</span>
        {/if}
        <div class="toolbar" role="toolbar" aria-label={t('grid.toolbar')}>
          {#if activeTab.page !== undefined}
            {@const count = activeCount(activeTab.filter)}
            <IconButton
              icon={count > 0 ? 'filter-filled' : 'filter'}
              label={count > 0 ? t('filter.titleWithCount', count) : t('filter.title')}
              pressed={filterOpen}
              {count}
              data-testid="filter-toggle"
              onclick={() => {
                filterOpen = !filterOpen;
              }}
            />
          {/if}
          {#if hasColumns}
            <IconButton
              icon="list-selection"
              label={columnView.hidden.length > 0
                ? t('columns.titleHidden', columnView.hidden.length)
                : t('columns.title')}
              hint={t('columns.hint')}
              count={columnView.hidden.length}
              pressed={columnsOpen}
              data-testid="columns-toggle"
              onclick={() => {
                columnsOpen = !columnsOpen;
              }}
            />
            <IconButton
              icon="open-preview"
              label={t('value.title')}
              hint={t('value.toggleHint')}
              pressed={valueOpen}
              data-testid="value-toggle"
              onclick={toggleValue}
            />
            <IconButton
              icon="layout-sidebar-right"
              label={t('record.title')}
              hint={t('record.toggleHint')}
              pressed={recordOpen}
              data-testid="record-toggle"
              onclick={toggleRecord}
            />
            <span class="toolbar-separator"></span>
          {/if}
          {#if gridState.running}
            <IconButton
              icon="debug-stop"
              label={t('grid.cancel')}
              onclick={() => {
                rpc.emit('cancel', {});
              }}
            />
          {:else}
            {#if hasColumns}
              <IconButton
                icon="graph"
                label={t('grid.chart')}
                hint={t('grid.chartHint')}
                data-testid="chart"
                onclick={() => {
                  rpc.emit('chartResult', { resultId: activeTab.id });
                }}
              />
              <MenuButton
                icon="copy"
                label={t('grid.copyAs')}
                hint={t('grid.copyAsHint')}
                testid="copy-as"
                items={COPY_FORMATS.map((format) => ({
                  id: format,
                  label: t(`grid.copyFormat.${format}` as MessageKey),
                  disabled: format === 'update' && editColumns === undefined,
                }))}
                onSelect={(format: CopyFormat) => {
                  void copyAs(format);
                }}
              />
            {/if}
            <MenuButton
              icon="export"
              label={t('grid.export')}
              hint={t('grid.exportHint')}
              testid="export"
              items={EXPORTS.map((format, index) => ({
                id: format,
                label: t(EXPORT_LABELS[format]),
                icon: EXPORT_ICONS[format],
                separated: index === 2,
              }))}
              onSelect={(format: ExportFormat) => {
                rpc.emit('exportResult', { resultId: activeTab.id, format });
              }}
            />
          {/if}
        </div>
      </div>
    {/if}

    {#if columnsOpen && activeTab !== undefined && activeTab.error === undefined && activeTab.columns.length > 0}
      <div class="columns-menu fade-in" data-testid="columns-menu" role="group" aria-label={t('columns.title')}>
        <div class="columns-actions">
          <button
            type="button"
            class="button secondary"
            data-testid="columns-show-all"
            disabled={columnView.hidden.length === 0}
            onclick={() => {
              changeView(showAll(columnView));
            }}
          >
            <Icon name="eye" />{t('columns.showAll')}
          </button>
          <button type="button" class="button secondary" data-testid="columns-fit-all" onclick={fitAll}>
            <Icon name="word-wrap" />{t('columns.fitAll')}
          </button>
          <button
            type="button"
            class="button secondary"
            data-testid="columns-reset"
            disabled={!isCustomized(columnView)}
            onclick={() => {
              changeView(NO_VIEW);
            }}
          >
            <Icon name="discard" />{t('columns.reset')}
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
                <span class="column-name">{column.name === '' ? `#${index + 1}` : column.name}</span>
                {#if column.dataType !== undefined}<span class="column-type">{column.dataType}</span>{/if}
              </label>
              <IconButton
                class="pin-toggle"
                icon={isPinned(columnView, index) ? 'pinned' : 'pin'}
                label={t('columns.pin', column.name)}
                hint={t('columns.pinHint')}
                pressed={isPinned(columnView, index)}
                disabled={isHidden(columnView, index)}
                onclick={() => {
                  changeView(togglePinned(columnView, index));
                }}
              />
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
      <div class="empty"><p class="empty-title">{t('grid.empty')}</p></div>
    {:else if activeTab.error !== undefined}
      <div class="failed-wrap">
        <div class="notice error failed" role="alert" data-testid="error">
          <Icon name="error" />
          <div class="failed-body">
            <p class="error">{activeTab.error.message}</p>
            <p class="where">
              {#if activeTab.error.position !== undefined}
                <span>{t('grid.errorAt', activeTab.error.position + 1)}</span>
              {/if}
              <button
                type="button"
                class="link-button"
                onclick={() => {
                  rpc.emit('revealError', { resultId: activeTab.id });
                }}
              >
                {t('grid.goToError')}
              </button>
            </p>
          </div>
        </div>
      </div>
    {:else}
      {#if activeTab.columns.length > 0}
        {#if pendingCount(activeTab) > 0}
          <div class="changes fade-in" data-testid="changes-bar">
            <Icon name="edit" />
            <span class="changes-text">{t('grid.pending', pendingCount(activeTab))}</span>
            <span class="spacer"></span>
            <button
              type="button"
              class="button secondary"
              disabled={saving}
              onclick={() => {
                void onDiscard();
              }}
            >
              <Icon name="discard" />{t('grid.discard')}
            </button>
            <button
              type="button"
              class="button secondary"
              disabled={saving}
              onclick={() => {
                void onPreview();
              }}
            >
              <Icon name="code" />{t('grid.previewSql')}
            </button>
            <button
              type="button"
              class="button"
              disabled={saving}
              onclick={() => {
                void onSave();
              }}
            >
              <Icon name={saving ? 'loading' : 'save'} spin={saving} />{saving
                ? t('grid.saving')
                : t('grid.save', pendingCount(activeTab))}
            </button>
          </div>
        {/if}
        {#if saveProblem !== undefined}
          <div class="notice error save-problem" role="alert" data-testid="save-error">
            <Icon name="error" />
            <div>
              <p>{saveProblem.message}</p>
              {#if saveProblem.statement !== undefined}
                <p class="statement"><code>{saveProblem.statement}</code></p>
              {/if}
            </div>
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
              label={activeTab.title}
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
                scheduleTotals(activeTab, next);
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
              onSaveFile={focused === undefined ? undefined : saveValueFile}
              onLoadFile={canLoadFile(activeTab, focused) ? loadValueFile : undefined}
              {t}
            />
          {/if}
        </div>
      {:else}
        <div class="empty">
          <span class="empty-icon"><Icon name={activeTab.affectedRows !== undefined ? 'pass' : 'table'} size={28} /></span>
          <p class="empty-title">
            {activeTab.affectedRows !== undefined
              ? t('grid.affected', activeTab.affectedRows, activeTab.durationMs)
              : t('grid.rows', activeTab.rowCount, activeTab.durationMs)}
          </p>
        </div>
      {/if}
      {#if failure !== undefined}
        <div class="notice error failure" role="alert"><Icon name="error" /><span>{failure}</span></div>
      {/if}
      <footer class="status">
        <p class="summary" role="status" data-testid="summary">
          {#if activeTab.edit !== undefined}
            {#if activeTab.edit.editable}
              <span
                class="badge success"
                data-testid="edit-badge"
                title={activeTab.edit.keyless === true ? t('grid.editableKeyless') : ''}
              >
                <Icon name="edit" size={12} />{activeTab.edit.keyless === true
                  ? t('grid.editableByValues')
                  : t('grid.editable')}
              </span>
            {:else}
              <span
                class="badge outline"
                data-testid="edit-badge"
                title={activeTab.edit.reason === undefined ? '' : t(`grid.readOnly.${activeTab.edit.reason}`)}
              >
                <Icon name="lock" size={12} />{t('grid.readOnly')}
              </span>
            {/if}
          {/if}
          <span class="stat">
            {#if activeTab.affectedRows !== undefined}
              {t('grid.affected', activeTab.affectedRows, activeTab.durationMs)}
            {:else}
              {t('grid.rows', activeTab.rowCount, activeTab.durationMs)}
            {/if}
          </span>
          {#if activeTab.truncated}
            <span class="warn"><Icon name="warning" size={14} />{t('grid.truncated')}</span>
          {/if}
          {#if activeTab.changedCells + activeTab.insertedRows + activeTab.deletedRows > 0}
            <span class="warn" data-testid="changed-count">
              {t('grid.changedCells', activeTab.changedCells + activeTab.insertedRows + activeTab.deletedRows)}
            </span>
          {/if}
          {#if totals !== undefined && (totals.cells ?? 0) > 1}
            <span class="totals" data-testid="selection-totals">{totalsText(totals)}</span>
          {/if}
        </p>
        {#if activeTab.page !== undefined}
          {@const page = activeTab.page}
          {@const from = activeTab.rowCount === 0 ? 0 : page.offset + 1}
          {@const to = page.offset + activeTab.rowCount}
          {@const pages = pageCount(page)}
          <div class="pager" data-testid="pager">
            <IconButton
              icon="chevron-left"
              label={t('grid.previousPage')}
              disabled={page.offset === 0}
              onclick={() => {
                void goToPage(Math.max(0, page.offset - page.pageSize));
              }}
            />
            <span class="range" data-testid="range">
              {page.totalRows === undefined
                ? t('grid.rangeUnknown', from, to)
                : page.approximate === true
                  ? t('grid.rangeApproximate', from, to, page.totalRows)
                  : t('grid.range', from, to, page.totalRows)}
            </span>
            <IconButton
              icon="chevron-right"
              label={t('grid.nextPage')}
              disabled={!hasNextPage(page, activeTab.rowCount)}
              onclick={() => {
                void goToPage(page.offset + page.pageSize);
              }}
            />
            {#if page.approximate === true}
              <button
                type="button"
                class="link-button"
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
            <span class="toolbar-separator"></span>
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
              <span class="sr-only">{t('grid.pageSize')}</span>
              <select
                class="control"
                title={t('grid.pageSize')}
                data-testid="page-size"
                disabled={paging}
                value={page.pageSize}
                onchange={(event) => {
                  const size = Number(event.currentTarget.value);
                  void runPaging(() => rpc.request('pageSize', { resultId: activeTab.id, pageSize: size }));
                }}
              >
                {#each pageSizeChoices(page.pageSize) as size (size)}
                  <option value={size}>{t('grid.perPage', size)}</option>
                {/each}
              </select>
            </label>
            <IconButton
              icon="unfold"
              label={t('grid.loadAll')}
              hint={t('grid.loadAllHint')}
              data-testid="load-all"
              disabled={paging || isWholeTable(page, activeTab.rowCount)}
              onclick={() => {
                void runPaging(() => rpc.request('loadAll', { resultId: activeTab.id }));
              }}
            />
          </div>
        {/if}
      </footer>
    {/if}
  {/if}
</main>

<style>
  main {
    position: relative;
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

  .spacer {
    flex: 1;
  }

  /* Result tabs, drawn like the editor's panel titles. */
  .tabs {
    display: flex;
    flex: none;
    gap: 2px;
    align-items: stretch;
    height: 32px;
    padding: 0 8px;
    overflow-x: auto;
    border-bottom: 1px solid var(--dn-divider);
    scrollbar-width: thin;
  }

  .tab {
    display: inline-flex;
    flex: none;
    gap: 6px;
    align-items: center;
    max-width: 280px;
    padding: 0 10px;
    color: var(--vscode-panelTitle-inactiveForeground, var(--dn-muted));
    background: transparent;
    border: none;
    border-bottom: 1px solid transparent;
    margin-bottom: -1px;
    font-family: inherit;
    font-size: inherit;
    white-space: nowrap;
    cursor: pointer;
    transition: color var(--dn-duration) var(--dn-ease);
  }

  .tab:hover {
    color: var(--vscode-panelTitle-activeForeground, var(--vscode-foreground));
  }

  .tab.active {
    color: var(--vscode-panelTitle-activeForeground, var(--vscode-foreground));
    border-bottom-color: var(--vscode-panelTitle-activeBorder, var(--dn-accent));
  }

  .tab.failed {
    color: var(--vscode-errorForeground);
  }

  .tab-title {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .toolbar-row {
    display: flex;
    flex: none;
    gap: var(--dn-gap);
    align-items: center;
    min-height: 34px;
    padding: 4px 8px;
  }

  .find {
    position: relative;
    display: flex;
    gap: 2px;
    align-items: center;
    min-width: 0;
  }

  .find-icon {
    position: absolute;
    left: 7px;
    display: inline-flex;
    color: var(--dn-muted);
    pointer-events: none;
  }

  .find-input {
    width: 240px;
    min-width: 120px;
    padding-left: 26px;
  }

  .find-input::-webkit-search-cancel-button {
    cursor: pointer;
  }

  .hits {
    margin: 0 4px 0 6px;
    color: var(--dn-muted);
    font-size: var(--dn-font-small);
    white-space: nowrap;
  }

  .hits.none {
    color: var(--vscode-errorForeground);
  }

  .note {
    display: inline-flex;
    gap: 4px;
    align-items: center;
    color: var(--dn-success);
    font-size: var(--dn-font-small);
    white-space: nowrap;
  }

  /* The columns popover: hide, pin and fit. */
  .columns-menu {
    display: flex;
    flex: none;
    flex-direction: column;
    gap: 8px;
    max-height: 40vh;
    margin: 0 8px 6px;
    padding: 10px 12px;
    background: var(--dn-surface);
    border: 1px solid var(--dn-border);
    border-radius: var(--dn-radius-l);
  }

  .columns-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .columns-list {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 2px 16px;
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
    min-width: 0;
  }

  .columns-item label {
    display: flex;
    gap: 6px;
    align-items: center;
    min-width: 0;
    cursor: pointer;
  }

  .column-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .column-type {
    flex: none;
    color: var(--dn-muted);
    font-size: 11px;
  }

  .columns-item :global(.pin-toggle:not([aria-pressed='true'])) {
    opacity: 0.55;
  }

  /* Pending edits: a bar that says what is waiting and offers to save it. */
  .changes {
    display: flex;
    flex: none;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
    margin: 0 8px 6px;
    padding: 4px 4px 4px 10px;
    background: var(--vscode-editorWidget-background, var(--dn-surface));
    border: 1px solid var(--vscode-inputOption-activeBorder, var(--dn-border));
    border-radius: var(--dn-radius-l);
  }

  .changes-text {
    font-weight: 500;
  }

  .save-problem,
  .failure {
    flex: none;
    margin: 0 8px 6px;
  }

  .save-problem p {
    margin: 0;
  }

  .statement {
    margin-top: 2px;
    overflow-wrap: anywhere;
  }

  .failed-wrap {
    flex: 1;
    padding: 12px;
    overflow: auto;
  }

  .failed {
    max-width: 900px;
  }

  .failed-body {
    min-width: 0;
  }

  .failed .error {
    margin: 0 0 4px;
    font-family: var(--dn-mono);
    white-space: pre-wrap;
  }

  .where {
    display: flex;
    gap: 10px;
    align-items: center;
    margin: 0;
    color: var(--dn-muted);
    font-size: var(--dn-font-small);
  }

  /* Empty and waiting states, centred in the page. */
  .empty {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 8px;
    align-items: center;
    justify-content: center;
    padding: 24px;
    color: var(--dn-muted);
    text-align: center;
  }

  .empty-icon {
    display: inline-flex;
    padding: 14px;
    color: var(--dn-muted);
    background: var(--dn-surface);
    border: 1px solid var(--dn-border);
    border-radius: 50%;
  }

  .empty-title {
    margin: 0;
    color: var(--vscode-foreground);
    font-size: 14px;
  }

  .empty-hint {
    margin: 0;
    font-size: var(--dn-font-small);
  }

  /* The status bar: what the result is, and where in the table this page is. */
  .status {
    display: flex;
    flex: none;
    flex-wrap: wrap;
    gap: 4px 12px;
    align-items: center;
    justify-content: space-between;
    min-height: 30px;
    padding: 2px 8px;
    color: var(--dn-muted);
    border-top: 1px solid var(--dn-divider);
    font-size: var(--dn-font-small);
  }

  .summary {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 10px;
    align-items: center;
    min-width: 0;
    margin: 0;
  }

  .stat {
    white-space: nowrap;
  }

  .warn {
    display: inline-flex;
    gap: 4px;
    align-items: center;
    color: var(--dn-warning);
  }

  .totals {
    color: var(--vscode-foreground);
    white-space: nowrap;
  }

  .pager {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 4px;
    align-items: center;
  }

  .range {
    margin: 0 2px;
    white-space: nowrap;
  }

  .field {
    display: flex;
    gap: 4px;
    align-items: center;
    white-space: nowrap;
  }

  .field .control {
    min-height: 22px;
    padding: 1px 4px;
    font-size: var(--dn-font-small);
  }

  .control.number {
    width: 4.5em;
  }
</style>

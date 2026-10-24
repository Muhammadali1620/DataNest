<script lang="ts">
  import { onMount } from 'svelte';
  import type { CellValue } from '../../../../src/shared/cell-value';
  import {
    MAX_WINDOW_ROWS,
    type ResultGridProtocol,
    type ResultGridState,
    type ResultTab,
  } from '../../../../src/shared/protocols/result-grid';
  import type { RpcPeer } from '../../../../src/shared/rpc';
  import type { Translate } from '../../lib/i18n';
  import { toTsv } from '../../../../src/shared/tsv';
  import { keepWidths } from './columns';
  import Grid from './Grid.svelte';
  import { RowCache, windowFor } from './rows';
  import { selectionBox, type Selection } from './selection';

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
  /** Bumped when rows arrive, so the grid re-reads the cache. */
  let loaded = $state(0);

  /** Rows live here; the grid reads them through `rowAt`. */
  let cache = new RowCache();
  /** The window being fetched, so the same range is not asked for twice. */
  let pending: string | undefined;

  const activeTab = $derived<ResultTab | undefined>(
    gridState?.tabs.find((tab) => tab.id === gridState?.activeId),
  );

  function rowAt(index: number): readonly CellValue[] | undefined {
    // Reading `loaded` ties the grid's cells to the rows that have arrived.
    return loaded >= 0 ? cache.get(index) : undefined;
  }

  async function fetchRows(tab: ResultTab, firstIndex: number, count: number): Promise<void> {
    const range = windowFor(firstIndex, count, tab.rowCount);
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
        cache.put(window.offset, window.rows, window.rowCount);
        if (window.offset === 0 && window.rows.length > 0) {
          // The first rows are what the column widths are measured from.
          widths = keepWidths(widths, tab.columns, window.rows);
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
    const tab = activeTab;
    if (tab !== undefined && tab.error === undefined) {
      void fetchRows(tab, firstIndex, count);
    }
  }

  function resetFor(tab: ResultTab | undefined): void {
    cache = new RowCache();
    cache.reset(tab?.rowCount ?? 0);
    pending = undefined;
    failure = undefined;
    search = '';
    hits = [];
    hitTotal = 0;
    hitIndex = 0;
    revealRow = undefined;
    widths = tab === undefined ? [] : keepWidths([], tab.columns);
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
  async function copySelection(tab: ResultTab, selection: Selection): Promise<void> {
    const box = selectionBox(selection);
    const count = box.bottom - box.top + 1;
    failure = undefined;
    try {
      const window = await rpc.request('rows', {
        resultId: tab.id,
        offset: box.top,
        limit: Math.min(count, MAX_WINDOW_ROWS),
      });
      if (window.resultId !== gridState?.activeId) {
        return;
      }
      // Only the selected cells travel: headers are a separate action (V2.8).
      const rows = window.rows.map((row) => row.slice(box.left, box.right + 1));
      rpc.emit('copyText', { text: toTsv(rows) });
    } catch (error) {
      failure = error instanceof Error ? error.message : t('grid.copyFailed');
    }
  }

  function onCopy(selection: Selection): void {
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
      if (found.resultId !== gridState?.activeId) {
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
    widths = next;
  }

  onMount(() => {
    const subscription = rpc.on('state', (next) => {
      const previous = activeTab;
      gridState = next;
      const tab = next.tabs.find((candidate) => candidate.id === next.activeId);
      // Rows are kept only while the very same result in the very same order is
      // still on screen; sorting changes which row sits at which index.
      const sameResult =
        tab !== undefined &&
        previous?.id === tab.id &&
        previous.rowCount === tab.rowCount &&
        previous.sort?.column === tab.sort?.column &&
        previous.sort?.direction === tab.sort?.direction;
      if (!sameResult) {
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
      {/if}
    </div>

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
        <Grid
          resetKey={`${activeTab.id}:${activeTab.rowCount}:${activeTab.columns.length}`}
          sort={activeTab.sort}
          {onSort}
          {revealRow}
          columns={activeTab.columns}
          rowCount={activeTab.rowCount}
          {widths}
          {rowAt}
          {onVisible}
          {onResize}
          {onCopy}
          {t}
        />
      {/if}
      {#if activeTab.page !== undefined}
        {@const page = activeTab.page}
        {@const from = activeTab.rowCount === 0 ? 0 : page.offset + 1}
        {@const to = page.offset + activeTab.rowCount}
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
          <span class="range">
            {page.totalRows === undefined
              ? t('grid.rangeUnknown', from, to)
              : t('grid.range', from, to, page.totalRows)}
          </span>
          <button
            type="button"
            class="button secondary"
            disabled={page.totalRows !== undefined
              ? to >= page.totalRows
              : activeTab.rowCount < page.pageSize}
            onclick={() => {
              void goToPage(page.offset + page.pageSize);
            }}
          >
            {t('grid.nextPage')}
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

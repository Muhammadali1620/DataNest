<script lang="ts">
  import { onMount } from 'svelte';
  import type { CellValue } from '../../../../src/shared/cell-value';
  import type {
    ResultGridProtocol,
    ResultGridState,
    ResultTab,
  } from '../../../../src/shared/protocols/result-grid';
  import type { RpcPeer } from '../../../../src/shared/rpc';
  import type { Translate } from '../../lib/i18n';
  import { displayOf } from './cells';
  import { RowCache, windowFor } from './rows';

  interface Props {
    rpc: RpcPeer<ResultGridProtocol['webview'], ResultGridProtocol['host']>;
    t: Translate;
  }

  const { rpc, t }: Props = $props();

  /** How many rows the simple view shows at once; V1.19 makes this virtualized. */
  const PAGE_SIZE = 200;

  let gridState = $state<ResultGridState | undefined>(undefined);
  let loading = $state(false);
  let failure = $state<string | undefined>(undefined);
  /** What is on screen: rebuilt from the cache whenever a window arrives. */
  let rows = $state<{ index: number; cells: readonly CellValue[] | undefined }[]>([]);
  let loadedCount = $state(0);

  /** Rows live here; the snapshot above is what the view renders. */
  const cache = new RowCache();

  const activeTab = $derived<ResultTab | undefined>(
    gridState?.tabs.find((tab) => tab.id === gridState?.activeId),
  );

  function takeSnapshot(): void {
    const count = Math.min(cache.rowCount, PAGE_SIZE);
    const list: { index: number; cells: readonly CellValue[] | undefined }[] = [];
    for (let index = 0; index < count; index++) {
      list.push({ index, cells: cache.get(index) });
    }
    rows = list;
    loadedCount = cache.rowCount;
  }

  async function loadRows(tab: ResultTab): Promise<void> {
    const range = windowFor(0, PAGE_SIZE, tab.rowCount);
    if (range === undefined || cache.hasRange(range.offset, range.limit)) {
      return;
    }
    loading = true;
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
        takeSnapshot();
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : t('grid.loadFailed');
    } finally {
      loading = false;
    }
  }

  function selectTab(resultId: string): void {
    if (gridState === undefined || gridState.activeId === resultId) {
      return;
    }
    gridState = { ...gridState, activeId: resultId };
    rpc.emit('selectTab', { resultId });
    const tab = gridState.tabs.find((candidate) => candidate.id === resultId);
    cache.reset(tab?.rowCount ?? 0);
    takeSnapshot();
    if (tab) {
      void loadRows(tab);
    }
  }

  onMount(() => {
    const subscription = rpc.on('state', (next) => {
      const sameTab = gridState?.activeId === next.activeId;
      const previous = activeTab;
      gridState = next;
      const tab = next.tabs.find((candidate) => candidate.id === next.activeId);
      // Rows are kept only while the same result is still on screen.
      if (!sameTab || previous?.rowCount !== tab?.rowCount) {
        cache.reset(tab?.rowCount ?? 0);
        takeSnapshot();
      }
      if (tab !== undefined && tab.error === undefined) {
        void loadRows(tab);
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
      {/if}
    </div>

    {#if activeTab === undefined}
      <p class="hint">{t('grid.empty')}</p>
    {:else if activeTab.error !== undefined}
      <p class="error" role="alert" data-testid="error">{activeTab.error.message}</p>
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
        <div class="scroll">
          <table data-testid="grid">
            <thead>
              <tr>
                <th class="rownum" scope="col">#</th>
                {#each activeTab.columns as column, index (index)}
                  <th scope="col" title={column.dataType ?? column.name}>{column.name}</th>
                {/each}
              </tr>
            </thead>
            <tbody>
              {#each rows as row (row.index)}
                <tr>
                  <td class="rownum">{row.index + 1}</td>
                  {#if row.cells === undefined}
                    <td class="pending" colspan={activeTab.columns.length}>{t('grid.loading')}</td>
                  {:else}
                    {#each activeTab.columns as _column, column (column)}
                      {@const cell = displayOf(row.cells[column] ?? null)}
                      <td class:null={cell.isNull} class:numeric={cell.numeric} title={cell.text}>
                        {cell.text}
                      </td>
                    {/each}
                  {/if}
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        {#if loadedCount > rows.length}
          <p class="hint">{t('grid.moreRows', loadedCount - rows.length)}</p>
        {/if}
      {/if}
      {#if loading}
        <p class="hint" data-testid="loading">{t('grid.loading')}</p>
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

  .cancel {
    margin-left: auto;
    padding: 2px 10px;
    color: var(--vscode-button-secondaryForeground);
    background: var(--vscode-button-secondaryBackground);
    border: none;
    border-radius: 2px;
    cursor: pointer;
  }

  .summary,
  .hint,
  .error {
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

  .scroll {
    flex: 1;
    overflow: auto;
  }

  table {
    border-collapse: collapse;
    font-family: var(--vscode-editor-font-family);
    font-size: var(--vscode-editor-font-size);
  }

  th,
  td {
    max-width: 400px;
    padding: 2px 8px;
    overflow: hidden;
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
    border-right: 1px solid var(--vscode-panel-border);
    border-bottom: 1px solid var(--vscode-panel-border);
  }

  th {
    position: sticky;
    top: 0;
    background: var(--vscode-editorGroupHeader-tabsBackground);
    font-weight: 600;
  }

  td.numeric {
    text-align: right;
  }

  td.null {
    color: var(--vscode-descriptionForeground);
    font-style: italic;
  }

  td.pending {
    color: var(--vscode-descriptionForeground);
  }

  .rownum {
    color: var(--vscode-descriptionForeground);
    text-align: right;
    user-select: none;
  }
</style>

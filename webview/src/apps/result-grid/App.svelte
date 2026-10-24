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
  import { keepWidths } from './columns';
  import Grid from './Grid.svelte';
  import { RowCache, windowFor } from './rows';

  interface Props {
    rpc: RpcPeer<ResultGridProtocol['webview'], ResultGridProtocol['host']>;
    t: Translate;
  }

  const { rpc, t }: Props = $props();

  let gridState = $state<ResultGridState | undefined>(undefined);
  let failure = $state<string | undefined>(undefined);
  let widths = $state<number[]>([]);
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
      // Rows are kept only while the very same result is still on screen.
      const sameResult =
        tab !== undefined && previous?.id === tab.id && previous.rowCount === tab.rowCount;
      if (!sameResult) {
        resetFor(tab);
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
        <Grid
          columns={activeTab.columns}
          rowCount={activeTab.rowCount}
          {widths}
          {rowAt}
          {onVisible}
          {onResize}
          {t}
        />
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
</style>

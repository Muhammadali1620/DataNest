<script lang="ts">
  // The answer of an Elasticsearch request (V7.8): its status and what it holds, a search's
  // hits as a table, and the whole answer as text. The host formats everything.
  import { onMount } from 'svelte';
  import type {
    ElasticResultProtocol,
    ElasticResultState,
  } from '../../../../src/shared/protocols/elastic-result';
  import type { RpcPeer } from '../../../../src/shared/rpc';
  import type { Translate } from '../../lib/i18n';
  import { cellClass, groupDigits } from '../mongo-documents/documents-view';

  interface Props {
    rpc: RpcPeer<ElasticResultProtocol['webview'], ElasticResultProtocol['host']>;
    t: Translate;
  }

  const { rpc, t }: Props = $props();

  let answer = $state<ElasticResultState | undefined>(undefined);
  let view = $state<'table' | 'text'>('table');
  let selected = $state<number[]>([]);
  let error = $state<string | undefined>(undefined);

  const hasTable = $derived(answer !== undefined && answer.rows.length > 0);

  onMount(() => {
    const subscription = rpc.on('state', (next) => {
      answer = next;
      selected = [];
      error = undefined;
      if (next.rows.length === 0) {
        view = 'text';
      }
    });
    rpc.emit('ready', {});
    return () => {
      subscription.dispose();
    };
  });

  async function copy(rows: number[] | undefined): Promise<void> {
    try {
      await rpc.request('copy', rows === undefined ? {} : { rows });
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
  }

  function toggle(row: number): void {
    selected = selected.includes(row) ? selected.filter((one) => one !== row) : [...selected, row];
  }

  function summaryText(state: ElasticResultState): string | undefined {
    const summary = state.summary;
    switch (summary?.kind) {
      case undefined:
        return undefined;
      case 'hits': {
        const total = groupDigits(summary.total ?? '0');
        return t(
          summary.relation === 'gte' ? 'elastic.hitsAtLeast' : 'elastic.hits',
          total,
          summary.shown ?? 0,
        );
      }
      case 'count':
        return t('elastic.count', groupDigits(summary.total ?? '0'));
      case 'error':
        return summary.error ?? '';
      case 'empty':
        return t('elastic.empty');
    }
  }
</script>

<main>
  {#if answer === undefined}
    <p class="hint">{t('elastic.loading')}</p>
  {:else}
    <header>
      <h1><code>{answer.request}</code></h1>
      <p class="meta" data-testid="meta">
        <span class="status" class:failed={answer.status >= 400} data-testid="status">{answer.status}</span>
        <span>{answer.connectionName}</span>
        <span>{t('elastic.took', answer.tookMs)}</span>
        {#if answer.summary?.took !== undefined}
          <span>{t('elastic.serverTook', answer.summary.took)}</span>
        {/if}
      </p>
    </header>
    {#if summaryText(answer) !== undefined}
      <p class:error={answer.summary?.kind === 'error'} data-testid="summary">{summaryText(answer)}</p>
    {/if}
    {#if error !== undefined}
      <p class="error" role="alert">{error}</p>
    {/if}
    <section class="toolbar">
      {#if hasTable}
        <div class="tabs" role="tablist">
          <button
            type="button"
            role="tab"
            class="tab"
            aria-selected={view === 'table'}
            onclick={() => {
              view = 'table';
            }}>{t('elastic.table')}</button
          >
          <button
            type="button"
            role="tab"
            class="tab"
            aria-selected={view === 'text'}
            onclick={() => {
              view = 'text';
            }}>{t('elastic.text')}</button
          >
        </div>
      {/if}
      <span class="grow"></span>
      {#if selected.length > 0}
        <button type="button" class="button secondary" onclick={() => void copy(selected)}
          >{t('elastic.copyHits', selected.length)}</button
        >
      {/if}
      <button type="button" class="button secondary" onclick={() => void copy(undefined)}>{t('elastic.copyAll')}</button>
    </section>
    {#if view === 'table' && hasTable}
      <div class="scroll">
        <table class="hits">
          <thead>
            <tr>
              <th class="pick"></th>
              {#each answer.columns as column (column)}
                <th>{column}</th>
              {/each}
            </tr>
          </thead>
          <tbody>
            {#each answer.rows as row, index (index)}
              <tr class:selected={selected.includes(index)}>
                <td class="pick">
                  <input
                    type="checkbox"
                    checked={selected.includes(index)}
                    onchange={() => {
                      toggle(index);
                    }}
                    aria-label={t('elastic.select', index + 1)}
                  />
                </td>
                {#each row.cells as cell, column (column)}
                  {#if cell === null}
                    <td class="missing"></td>
                  {:else}
                    <td class={cellClass(cell.type === 'number' ? 'double' : cell.type === 'bool' ? 'bool' : cell.type)} title={cell.text}>{cell.text}</td>
                  {/if}
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else}
      <pre class="code" data-testid="text">{answer.text}</pre>
      {#if answer.truncated}
        <p class="hint">{t('elastic.truncated')}</p>
      {/if}
    {/if}
  {/if}
</main>

<style>
  main {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
  }
  h1 {
    font-size: 1.15em;
    margin: 0;
    word-break: break-all;
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    color: var(--vscode-descriptionForeground);
    margin: 4px 0 0;
  }
  .status {
    border: 1px solid var(--vscode-charts-green, var(--vscode-focusBorder));
    padding: 0 6px;
    border-radius: 3px;
    color: var(--vscode-foreground);
  }
  .status.failed {
    border-color: var(--vscode-errorForeground);
  }
  .toolbar {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .grow {
    flex: 1;
  }
  .hint {
    color: var(--vscode-descriptionForeground);
    margin: 0;
  }
  .error {
    color: var(--vscode-errorForeground);
    margin: 0;
  }
  .tabs {
    display: flex;
  }
  .tab {
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--vscode-foreground);
    padding: 4px 10px;
    cursor: pointer;
  }
  .tab[aria-selected='true'] {
    border-bottom-color: var(--vscode-focusBorder);
  }
  .scroll {
    overflow: auto;
    max-height: calc(100vh - 160px);
  }
  .hits {
    border-collapse: collapse;
    font-family: var(--vscode-editor-font-family, monospace);
  }
  .hits th,
  .hits td {
    text-align: left;
    padding: 2px 8px;
    border-bottom: 1px solid var(--vscode-panel-border, transparent);
    max-width: 320px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .hits thead th {
    position: sticky;
    top: 0;
    background: var(--vscode-editor-background);
  }
  .hits tbody tr.selected {
    background: var(--vscode-list-activeSelectionBackground);
  }
  .pick {
    width: 24px;
  }
  .number {
    text-align: right;
    color: var(--vscode-debugTokenExpression-number, var(--vscode-foreground));
  }
  .string {
    color: var(--vscode-debugTokenExpression-string, var(--vscode-foreground));
  }
  .null,
  .missing {
    color: var(--vscode-descriptionForeground);
    font-style: italic;
  }
  .bool {
    color: var(--vscode-debugTokenExpression-boolean, var(--vscode-foreground));
  }
  .code {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-editor-font-size, 13px);
    margin: 0;
    padding: 6px 8px;
    background: var(--vscode-textCodeBlock-background);
    overflow: auto;
  }
</style>

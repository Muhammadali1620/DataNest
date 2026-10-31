<script lang="ts">
  // The answer of an Elasticsearch request (V7.8): its status and what it holds, a search's
  // hits as a table, and the whole answer as text. The host formats everything.
  import { onMount } from 'svelte';
  import type {
    ElasticResultProtocol,
    ElasticResultState,
  } from '../../../../src/shared/protocols/elastic-result';
  import type { RpcPeer } from '../../../../src/shared/rpc';
  import Icon from '../../components/Icon.svelte';
  import IconButton from '../../components/IconButton.svelte';
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

  const allSelected = $derived(
    answer !== undefined && answer.rows.length > 0 && selected.length === answer.rows.length,
  );

  /** The box in the header: ticks every hit, or none. */
  function toggleAll(): void {
    selected = allSelected ? [] : (answer?.rows.map((_, index) => index) ?? []);
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
    <div class="empty">
      <span class="empty-icon"><Icon name="loading" spin size={24} /></span>
      <p class="empty-title">{t('elastic.loading')}</p>
    </div>
  {:else}
    {@const summary = summaryText(answer)}
    <header class="top">
      <span class="top-icon"><Icon name="search" size={18} /></span>
      <div class="top-text">
        <h1><code>{answer.request}</code></h1>
        <p class="meta" data-testid="meta">
          <span
            class="badge {answer.status >= 400 ? 'danger' : 'success'}"
            class:failed={answer.status >= 400}
            data-testid="status"><Icon name={answer.status >= 400 ? 'error' : 'pass'} size={12} />{answer.status}</span
          >
          <span class="fact"><Icon name="database" size={12} />{answer.connectionName}</span>
          <span class="fact"><Icon name="watch" size={12} />{t('elastic.took', answer.tookMs)}</span>
          {#if answer.summary?.took !== undefined}
            <span class="fact">{t('elastic.serverTook', answer.summary.took)}</span>
          {/if}
        </p>
      </div>
      <div class="toolbar">
        <IconButton icon="clippy" label={t('elastic.copyAll')} onclick={() => void copy(undefined)} />
      </div>
    </header>
    {#if summary !== undefined && answer.summary?.kind === 'error'}
      <p class="notice error problem" data-testid="summary"><Icon name="error" /><span class="message">{summary}</span></p>
    {/if}
    {#if error !== undefined}
      <p class="notice error problem" role="alert"><Icon name="error" /><span class="message">{error}</span></p>
    {/if}
    <div class="viewbar">
      {#if hasTable}
        <div class="tabs" role="tablist">
          <button
            type="button"
            role="tab"
            class="tab"
            class:active={view === 'table'}
            aria-selected={view === 'table'}
            onclick={() => {
              view = 'table';
            }}><Icon name="table" />{t('elastic.table')}</button
          >
          <button
            type="button"
            role="tab"
            class="tab"
            class:active={view === 'text'}
            aria-selected={view === 'text'}
            onclick={() => {
              view = 'text';
            }}><Icon name="json" />{t('elastic.text')}</button
          >
        </div>
      {:else}
        <span class="view-title"><Icon name="json" />{t('elastic.text')}</span>
      {/if}
      <span class="grow"></span>
      {#if selected.length > 0}
        <IconButton
          class="fade-in"
          icon="copy"
          label={t('elastic.copyHits', selected.length)}
          text={t('elastic.copyHits', selected.length)}
          onclick={() => void copy(selected)}
        />
      {/if}
    </div>
    {#if view === 'table' && hasTable}
      <div class="scroll">
        <table class="hits">
          <thead>
            <tr>
              <th class="pick">
                <input
                  type="checkbox"
                  checked={allSelected}
                  {@attach (box: HTMLInputElement) => {
                    box.indeterminate = selected.length > 0 && !allSelected;
                  }}
                  onchange={toggleAll}
                  aria-label={t('elastic.selectAll')}
                />
              </th>
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
      <div class="text-view">
        {#if answer.truncated}
          <p class="notice warning"><Icon name="warning" /><span>{t('elastic.truncated')}</span></p>
        {/if}
        <pre class="code" data-testid="text">{answer.text}</pre>
      </div>
    {/if}
    {#if summary !== undefined && answer.summary?.kind !== 'error'}
      <footer class="status">
        <span class="summary" data-testid="summary">{summary}</span>
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
  }

  .grow {
    flex: 1;
  }

  /* The request, its status and timing. */
  .top {
    display: flex;
    flex: none;
    flex-wrap: wrap;
    gap: var(--dn-gap) var(--dn-gap-m);
    align-items: center;
    padding: var(--dn-gap-m) var(--dn-gap-l);
    border-bottom: 1px solid var(--dn-divider);
  }

  .top-icon {
    display: inline-flex;
    padding: 7px;
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
    border-radius: var(--dn-radius-l);
  }

  .top-text {
    flex: 1;
    min-width: 0;
  }

  h1 {
    font-size: 14px;
    word-break: break-all;
  }

  h1 code {
    padding: 0;
    font-size: inherit;
    background: none;
  }

  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: var(--dn-gap-s) var(--dn-gap-m);
    align-items: center;
    margin: 4px 0 0;
    color: var(--dn-muted);
    font-size: var(--dn-font-small);
  }

  .fact {
    display: inline-flex;
    gap: 4px;
    align-items: center;
    white-space: nowrap;
  }

  .problem {
    flex: none;
    margin: var(--dn-gap) var(--dn-gap-l) 0;
  }

  .message {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  /* Hits or the whole answer, and what to copy. */
  .viewbar {
    display: flex;
    flex: none;
    gap: var(--dn-gap);
    align-items: center;
    min-height: 34px;
    padding: 0 var(--dn-gap) 0 var(--dn-gap-s);
    border-bottom: 1px solid var(--dn-divider);
  }

  .tabs {
    display: flex;
    gap: 2px;
    align-self: stretch;
  }

  .tab,
  .view-title {
    display: inline-flex;
    gap: 6px;
    align-items: center;
    padding: 0 10px;
    white-space: nowrap;
  }

  .tab {
    margin-bottom: -1px;
    color: var(--vscode-panelTitle-inactiveForeground, var(--dn-muted));
    background: transparent;
    border: none;
    border-bottom: 1px solid transparent;
    font-family: inherit;
    font-size: inherit;
    cursor: pointer;
    transition: color var(--dn-duration) var(--dn-ease);
  }

  .tab:hover,
  .tab.active {
    color: var(--vscode-panelTitle-activeForeground, var(--vscode-foreground));
  }

  .tab.active {
    border-bottom-color: var(--vscode-panelTitle-activeBorder, var(--dn-accent));
  }

  .view-title {
    color: var(--dn-muted);
  }

  /* The hits, drawn as the result grid draws its rows. */
  .scroll {
    --dn-header-background: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-editor-background));
    --dn-grid-line: var(--vscode-editorGroup-border, var(--dn-divider));
    flex: 1;
    min-height: 0;
    overflow: auto;
  }

  .hits {
    border-collapse: separate;
    border-spacing: 0;
    font-family: var(--dn-mono);
    font-size: var(--dn-font-small);
  }

  .hits th,
  .hits td {
    max-width: 320px;
    height: 22px;
    padding: 2px 8px;
    overflow: hidden;
    line-height: 18px;
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
    border-right: 1px solid var(--dn-grid-line);
  }

  .hits thead th {
    position: sticky;
    top: 0;
    z-index: 1;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    font-weight: 600;
    background: var(--dn-header-background);
    box-shadow: 0 1px 0 var(--dn-divider);
  }

  .hits tbody tr:nth-child(even) {
    background: var(--vscode-keybindingTable-rowsBackground, transparent);
  }

  .hits tbody tr:hover {
    background: var(--vscode-list-hoverBackground);
  }

  .hits tbody tr.selected {
    background: var(--vscode-list-inactiveSelectionBackground);
  }

  .pick {
    width: 30px;
    text-align: center;
  }

  .hits .pick input {
    width: 16px;
    height: 16px;
  }

  .number {
    color: var(--vscode-debugTokenExpression-number, var(--vscode-foreground));
    text-align: right;
  }

  .string {
    color: var(--vscode-debugTokenExpression-string, var(--vscode-foreground));
  }

  .null,
  .missing {
    color: var(--dn-muted);
    font-style: italic;
  }

  .bool {
    color: var(--vscode-debugTokenExpression-boolean, var(--vscode-foreground));
  }

  /* The whole answer as text. */
  .text-view {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--dn-gap);
    min-height: 0;
    padding: var(--dn-gap-m) var(--dn-gap-l);
  }

  .text-view .notice {
    flex: none;
    margin: 0;
  }

  .code {
    flex: 1;
    min-height: 0;
    margin: 0;
    padding: var(--dn-gap) var(--dn-gap-m);
    overflow: auto;
    font-size: var(--vscode-editor-font-size, 13px);
    background: var(--dn-surface);
    border: 1px solid var(--dn-border);
    border-radius: var(--dn-radius);
    user-select: text;
  }

  .status {
    display: flex;
    flex: none;
    align-items: center;
    min-height: 28px;
    padding: 2px var(--dn-gap-l);
    color: var(--dn-muted);
    border-top: 1px solid var(--dn-divider);
    font-size: var(--dn-font-small);
  }

  /* Waiting for the answer: centred. */
  .empty {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--dn-gap);
    align-items: center;
    justify-content: center;
    padding: var(--dn-gap-xl);
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
</style>

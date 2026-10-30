<script lang="ts">
  import { onMount } from 'svelte';
  import type {
    SchemaCompareDetail,
    SchemaCompareItem,
    SchemaCompareProtocol,
    SchemaCompareState,
  } from '../../../../src/shared/protocols/schema-compare';
  import type { RpcPeer } from '../../../../src/shared/rpc';
  import type { MessageKey } from '../../l10n/en';
  import type { Translate } from '../../lib/i18n';
  import { counts, defaultSelection, groupByKind, selectable } from './compare-view';

  interface Props {
    rpc: RpcPeer<SchemaCompareProtocol['webview'], SchemaCompareProtocol['host']>;
    t: Translate;
  }

  const { rpc, t }: Props = $props();

  let page = $state<SchemaCompareState | undefined>(undefined);
  let chosen = $state<string[]>([]);
  let showSame = $state(false);
  let current = $state<string | undefined>(undefined);
  let detail = $state<SchemaCompareDetail | undefined>(undefined);
  let detailError = $state<string | undefined>(undefined);
  let busy = $state(false);
  let ticket = 0;

  const items = $derived(page?.items ?? []);
  const groups = $derived(groupByKind(items, showSame));
  const tally = $derived(counts(items));
  const chosenCount = $derived(chosen.filter((id) => items.some((item) => item.id === id)).length);

  const KIND_KEYS: Record<SchemaCompareItem['kind'], MessageKey> = {
    table: 'compare.kind.table',
    view: 'compare.kind.view',
    function: 'compare.kind.function',
    procedure: 'compare.kind.procedure',
    trigger: 'compare.kind.trigger',
    sequence: 'compare.kind.sequence',
    event: 'compare.kind.event',
  };
  const STATUS_KEYS: Record<SchemaCompareItem['status'], MessageKey> = {
    added: 'compare.status.added',
    removed: 'compare.status.removed',
    changed: 'compare.status.changed',
    same: 'compare.status.same',
  };
  const CHANGE_KEYS: Record<'added' | 'removed' | 'changed', MessageKey> = {
    added: 'compare.change.added',
    removed: 'compare.change.removed',
    changed: 'compare.change.changed',
  };

  function applyState(next: SchemaCompareState): void {
    const before = page?.items;
    page = next;
    const sameItems =
      before?.length === next.items.length &&
      before.every((item, index) => item.id === next.items[index]?.id);
    if (!sameItems && next.loading === undefined) {
      chosen = defaultSelection(next.items);
      current = undefined;
      detail = undefined;
    }
  }

  async function show(id: string): Promise<void> {
    current = id;
    const mine = ++ticket;
    detailError = undefined;
    try {
      const answer = await rpc.request('detail', { id });
      if (mine === ticket) {
        detail = answer;
      }
    } catch (error) {
      if (mine === ticket) {
        detail = undefined;
        detailError = error instanceof Error ? error.message : String(error);
      }
    }
  }

  function toggle(id: string): void {
    chosen = chosen.includes(id) ? chosen.filter((one) => one !== id) : [...chosen, id];
  }

  function chooseAll(on: boolean): void {
    chosen = on ? items.filter(selectable).map((item) => item.id) : [];
  }

  async function openScript(): Promise<void> {
    busy = true;
    try {
      await rpc.request('openScript', { ids: chosen });
    } finally {
      busy = false;
    }
  }

  onMount(() => {
    const subscription = rpc.on('state', (next) => {
      applyState(next);
    });
    rpc.emit('ready', {});
    return () => {
      subscription.dispose();
    };
  });
</script>

<main>
  <header class="bar">
    <h1>{t('compare.title')}</h1>
    {#if page !== undefined}
      <span class="sides">
        <span class="side">{page.source}</span>
        <span class="arrow">→</span>
        <span class="side">{page.target}</span>
      </span>
      <span class="grow"></span>
      <button
        type="button"
        class="button secondary"
        disabled={page.loading !== undefined}
        onclick={() => {
          rpc.emit('swap', {});
        }}>{t('compare.swap')}</button
      >
      <button
        type="button"
        class="button secondary"
        disabled={page.loading !== undefined}
        onclick={() => {
          rpc.emit('refresh', {});
        }}>{t('compare.refresh')}</button
      >
      <button
        type="button"
        class="button"
        disabled={busy || chosenCount === 0 || page.loading !== undefined}
        onclick={() => void openScript()}>{t('compare.openScript', chosenCount)}</button
      >
    {/if}
  </header>

  {#if page === undefined}
    <p class="hint">{t('form.loading')}</p>
  {:else}
    <p class="hint">{t('compare.explain')}</p>
    {#if page.loading !== undefined}
      <p class="hint" role="status">
        {page.loading.total === 0
          ? t(page.loading.side === 'source' ? 'compare.readingSource' : 'compare.readingTarget')
          : t(
              page.loading.side === 'source' ? 'compare.progressSource' : 'compare.progressTarget',
              page.loading.done,
              page.loading.total,
            )}
      </p>
    {/if}
    {#if page.error !== undefined}
      <p class="error" role="alert">{page.error}</p>
    {/if}
    {#if page.loading === undefined && page.error === undefined}
      <div class="summary">
        <span class="status added">{t('compare.count.added', tally.added)}</span>
        <span class="status changed">{t('compare.count.changed', tally.changed)}</span>
        <span class="status removed">{t('compare.count.removed', tally.removed)}</span>
        <span class="hint">{t('compare.count.same', tally.same)}</span>
        <span class="grow"></span>
        <label class="inline"><input type="checkbox" bind:checked={showSame} /> {t('compare.showSame')}</label>
        <button type="button" class="link" onclick={() => {
          chooseAll(true);
        }}>{t('compare.chooseAll')}</button>
        <button type="button" class="link" onclick={() => {
          chooseAll(false);
        }}>{t('compare.chooseNone')}</button>
      </div>
      {#if groups.length === 0}
        <p class="hint">{t('compare.identical')}</p>
      {:else}
        <div class="layout">
          <div class="list" role="list">
            {#each groups as group (group.kind)}
              <h2>{t(KIND_KEYS[group.kind])} <span class="hint">({group.items.length})</span></h2>
              {#each group.items as item (item.id)}
                <div class="item" class:current={current === item.id} role="listitem">
                  <input
                    type="checkbox"
                    aria-label={t('compare.include', item.name)}
                    checked={chosen.includes(item.id)}
                    disabled={!selectable(item)}
                    onchange={() => {
                      toggle(item.id);
                    }}
                  />
                  <button type="button" class="pick" onclick={() => void show(item.id)}>
                    <span class="status {item.status}">{t(STATUS_KEYS[item.status])}</span>
                    <span class="name">{item.name}</span>
                    {#if item.context !== undefined}<span class="hint">{item.context}</span>{/if}
                    {#if item.hidden === true}<span class="hint">{t('compare.hidden')}</span>{/if}
                  </button>
                </div>
              {/each}
            {/each}
          </div>
          <section class="detail" aria-label={t('compare.details')}>
            {#if detailError !== undefined}
              <p class="error" role="alert">{detailError}</p>
            {:else if detail === undefined}
              <p class="hint">{t('compare.pick')}</p>
            {:else}
              {#if detail.hidden !== undefined}
                <p class="hint">{detail.hidden}</p>
              {/if}
              {#if detail.columns.length > 0}
                <h3>{t('compare.columns')}</h3>
                <table>
                  <tbody>
                    {#each detail.columns as change (change.name)}
                      <tr class={change.change}>
                        <th>{change.name}</th>
                        <td>{t(CHANGE_KEYS[change.change])}</td>
                        <td>
                          {#if change.before !== undefined}<span class="before">{change.before}</span>{/if}
                          {#if change.before !== undefined && change.after !== undefined}→{/if}
                          {#if change.after !== undefined}<span class="after">{change.after}</span>{/if}
                        </td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              {/if}
              {#if detail.keys.length > 0}
                <h3>{t('compare.keys')}</h3>
                <table>
                  <tbody>
                    {#each detail.keys as change, index (index)}
                      <tr class={change.change}>
                        <th>{change.name}</th>
                        <td>{t(CHANGE_KEYS[change.change])}</td>
                        <td>
                          {#if change.before !== undefined}<span class="before">{change.before}</span>{/if}
                          {#if change.before !== undefined && change.after !== undefined}→{/if}
                          {#if change.after !== undefined}<span class="after">{change.after}</span>{/if}
                        </td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              {/if}
              {#if detail.comment !== undefined}
                <h3>{t('compare.comment')}</h3>
                <p><span class="before">{detail.comment.before}</span> → <span class="after">{detail.comment.after}</span></p>
              {/if}
              {#if detail.notes.length > 0}
                <ul class="notes">
                  {#each detail.notes as note, index (index)}<li>{note}</li>{/each}
                </ul>
              {/if}
              {#if detail.diff.length > 0}
                <h3>{t('compare.definition')}</h3>
                <pre class="diff">{#each detail.diff as line, index (index)}<span class="line {line.op}"
                      >{line.op === 'add' ? '+ ' : line.op === 'remove' ? '- ' : '  '}{line.text}
</span>{/each}</pre>
              {/if}
              <h3>{t('compare.script')}</h3>
              {#if detail.script === ''}
                <p class="hint">{t('compare.noScript')}</p>
              {:else}
                <pre class="script">{detail.script}</pre>
              {/if}
            {/if}
          </section>
        </div>
      {/if}
    {/if}
  {/if}
</main>

<style>
  main {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 12px;
    height: 100vh;
  }
  .bar,
  .summary {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  h1 {
    font-size: 1.2em;
    margin: 0;
  }
  h2 {
    font-size: 1em;
    margin: 8px 0 2px;
  }
  h3 {
    font-size: 0.95em;
    margin: 10px 0 4px;
  }
  .sides {
    display: flex;
    gap: 6px;
    align-items: baseline;
  }
  .side {
    font-weight: 600;
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
    white-space: pre-wrap;
  }
  .inline {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .link {
    font: inherit;
    background: none;
    border: none;
    padding: 0;
    color: var(--vscode-textLink-foreground);
    cursor: pointer;
  }
  .layout {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(220px, 34%) minmax(0, 1fr);
    gap: 10px;
  }
  @media (max-width: 800px) {
    .layout {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: minmax(0, 1fr) minmax(0, 1fr);
    }
  }
  .list,
  .detail {
    overflow: auto;
    border: 1px solid var(--vscode-panel-border, transparent);
    padding: 4px 8px;
  }
  .item {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .item.current {
    background: var(--vscode-list-inactiveSelectionBackground);
  }
  .pick {
    font: inherit;
    display: flex;
    flex: 1;
    gap: 6px;
    align-items: baseline;
    background: none;
    border: none;
    color: inherit;
    text-align: left;
    padding: 2px 0;
    cursor: pointer;
    min-width: 0;
  }
  .name {
    overflow-wrap: anywhere;
  }
  .status {
    font-size: 0.8em;
    padding: 0 5px;
    border-radius: 6px;
    white-space: nowrap;
  }
  .status.added {
    background: rgba(115, 201, 145, 0.25);
  }
  .status.changed {
    background: rgba(204, 167, 0, 0.25);
  }
  .status.removed {
    background: rgba(241, 76, 76, 0.25);
  }
  .status.same {
    opacity: 0.7;
  }
  table {
    border-collapse: collapse;
    width: 100%;
    font-size: 0.9em;
  }
  th,
  td {
    text-align: left;
    vertical-align: top;
    padding: 2px 6px;
    border-bottom: 1px solid var(--vscode-panel-border, transparent);
    overflow-wrap: anywhere;
  }
  th {
    font-weight: 600;
  }
  .before {
    color: var(--vscode-gitDecoration-deletedResourceForeground, #c74e39);
  }
  .after {
    color: var(--vscode-gitDecoration-addedResourceForeground, #81b88b);
  }
  .notes {
    margin: 6px 0;
    padding-left: 18px;
    color: var(--vscode-descriptionForeground);
  }
  pre {
    margin: 0;
    padding: 6px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.9em;
    background: var(--vscode-textCodeBlock-background, transparent);
    overflow: auto;
    user-select: text;
  }
  .line {
    display: block;
    white-space: pre;
  }
  .line.add {
    background: var(--vscode-diffEditor-insertedLineBackground, rgba(155, 185, 85, 0.2));
  }
  .line.remove {
    background: var(--vscode-diffEditor-removedLineBackground, rgba(255, 0, 0, 0.2));
  }
  .script {
    white-space: pre-wrap;
  }
</style>

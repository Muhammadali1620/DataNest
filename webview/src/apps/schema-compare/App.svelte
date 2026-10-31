<script lang="ts">
  import { onMount } from 'svelte';
  import type {
    SchemaCompareDetail,
    SchemaCompareItem,
    SchemaCompareProtocol,
    SchemaCompareState,
  } from '../../../../src/shared/protocols/schema-compare';
  import type { RpcPeer } from '../../../../src/shared/rpc';
  import Icon from '../../components/Icon.svelte';
  import IconButton from '../../components/IconButton.svelte';
  import type { MessageKey } from '../../l10n/en';
  import type { CodiconName } from '../../lib/codicons';
  import type { Translate } from '../../lib/i18n';
  import { counts, defaultSelection, groupByKind, selectable } from './compare-view';

  interface Props {
    rpc: RpcPeer<SchemaCompareProtocol['webview'], SchemaCompareProtocol['host']>;
    t: Translate;
    /** On the Manager page the comparison fills its section, not the window. */
    embedded?: boolean;
  }

  const { rpc, t, embedded = false }: Props = $props();

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
  const currentItem = $derived(items.find((item) => item.id === current));

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
  /** Each state has its own sign as well as its colour. */
  const STATUS_ICONS: Record<SchemaCompareItem['status'], CodiconName> = {
    added: 'diff-added',
    removed: 'diff-removed',
    changed: 'diff-modified',
    same: 'check',
  };
  const KEY_ICONS: Record<SchemaCompareDetail['keys'][number]['kind'], CodiconName> = {
    primaryKey: 'key',
    index: 'list-ordered',
    foreignKey: 'link',
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

{#snippet changes(list: SchemaCompareDetail['columns'] | SchemaCompareDetail['keys'])}
  <table class="changes">
    <tbody>
      {#each list as change, index (index)}
        <tr class="status-{change.change}">
          <td class="sign"><Icon name={STATUS_ICONS[change.change]} size={14} /></td>
          <th scope="row">
            <span class="change-name">
              {#if 'kind' in change}<span class="key-kind"><Icon name={KEY_ICONS[change.kind]} size={14} /></span>{/if}{change.name}
            </span>
          </th>
          <td class="change-word">{t(CHANGE_KEYS[change.change])}</td>
          <td class="values">
            {#if change.before !== undefined}<del class="before">{change.before}</del>{/if}
            {#if change.before !== undefined && change.after !== undefined}<span class="to"
                ><Icon name="arrow-small-right" size={14} /></span
              >{/if}
            {#if change.after !== undefined}<ins class="after">{change.after}</ins>{/if}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
{/snippet}

<main class:embedded>
  {#if page?.loading !== undefined}
    <div class="progress-bar" aria-hidden="true"></div>
  {/if}
  <header class="top">
    <span class="top-icon"><Icon name="git-compare" size={18} /></span>
    <div class="top-text">
      <h1>{t('compare.title')}</h1>
      {#if page !== undefined}
        <p class="sides">
          <span class="side">{page.source}</span>
          <Icon name="arrow-right" size={14} />
          <span class="side">{page.target}</span>
        </p>
      {/if}
    </div>
    {#if page !== undefined}
      <div class="toolbar">
        <IconButton
          icon="arrow-swap"
          label={t('compare.swap')}
          disabled={page.loading !== undefined}
          onclick={() => {
            rpc.emit('swap', {});
          }}
        />
        <IconButton
          icon="refresh"
          label={t('compare.refresh')}
          disabled={page.loading !== undefined}
          onclick={() => {
            rpc.emit('refresh', {});
          }}
        />
        <span class="toolbar-separator"></span>
        <button
          type="button"
          class="button"
          disabled={busy || chosenCount === 0 || page.loading !== undefined}
          onclick={() => void openScript()}
          ><Icon name="go-to-file" />{t('compare.openScript', chosenCount)}</button
        >
      </div>
    {/if}
  </header>

  {#if page === undefined}
    <div class="empty">
      <span class="empty-icon"><Icon name="loading" spin size={24} /></span>
      <p class="empty-title">{t('form.loading')}</p>
    </div>
  {:else}
    {#if page.error !== undefined}
      <div class="notice error problem" role="alert"><Icon name="error" /><span class="message">{page.error}</span></div>
    {/if}
    {#if page.loading !== undefined}
      <div class="empty">
        <span class="empty-icon"><Icon name="loading" spin size={24} /></span>
        <p class="empty-title" role="status">
          {page.loading.total === 0
            ? t(page.loading.side === 'source' ? 'compare.readingSource' : 'compare.readingTarget')
            : t(
                page.loading.side === 'source' ? 'compare.progressSource' : 'compare.progressTarget',
                page.loading.done,
                page.loading.total,
              )}
        </p>
      </div>
    {:else if page.error === undefined}
      <div class="summary">
        <span class="badge marked status-added"><Icon name="diff-added" size={12} />{t('compare.count.added', tally.added)}</span>
        <span class="badge marked status-changed"><Icon name="diff-modified" size={12} />{t('compare.count.changed', tally.changed)}</span>
        <span class="badge marked status-removed"><Icon name="diff-removed" size={12} />{t('compare.count.removed', tally.removed)}</span>
        <span class="badge outline"><Icon name="check" size={12} />{t('compare.count.same', tally.same)}</span>
        <span class="grow"></span>
        <div class="toolbar">
          <IconButton
            icon="eye"
            label={t('compare.showSame')}
            pressed={showSame}
            onclick={() => {
              showSame = !showSame;
            }}
          />
          <span class="toolbar-separator"></span>
          <IconButton
            icon="check-all"
            label={t('compare.chooseAll')}
            onclick={() => {
              chooseAll(true);
            }}
          />
          <IconButton
            icon="clear-all"
            label={t('compare.chooseNone')}
            onclick={() => {
              chooseAll(false);
            }}
          />
        </div>
      </div>
      {#if groups.length === 0}
        <div class="empty">
          <span class="empty-icon"><Icon name="pass" size={24} /></span>
          <p class="empty-title">{t('compare.identical')}</p>
        </div>
      {:else}
        <div class="layout">
          <div class="list" role="list">
            {#each groups as group (group.kind)}
              <h2 class="group-title">
                {t(KIND_KEYS[group.kind])}<span class="group-count">{group.items.length}</span>
              </h2>
              {#each group.items as item (item.id)}
                <div class="item status-{item.status}" class:current={current === item.id} role="listitem">
                  <input
                    type="checkbox"
                    aria-label={t('compare.include', item.name)}
                    checked={chosen.includes(item.id)}
                    disabled={!selectable(item)}
                    onchange={() => {
                      toggle(item.id);
                    }}
                  />
                  <button
                    type="button"
                    class="pick"
                    aria-current={current === item.id ? 'true' : undefined}
                    onclick={() => void show(item.id)}
                  >
                    <span class="status-icon" title={t(STATUS_KEYS[item.status])}
                      ><Icon name={STATUS_ICONS[item.status]} /></span
                    >
                    <span class="sr-only">{t(STATUS_KEYS[item.status])}</span>
                    <span class="name">{item.name}</span>
                    {#if item.context !== undefined}<span class="context">{item.context}</span>{/if}
                    {#if item.hidden === true}<span class="badge outline hidden-badge"
                        ><Icon name="eye-closed" size={12} />{t('compare.hidden')}</span
                      >{/if}
                  </button>
                </div>
              {/each}
            {/each}
          </div>
          <section class="detail" aria-label={t('compare.details')}>
            {#if detailError !== undefined}
              <div class="notice error" role="alert"><Icon name="error" /><span class="message">{detailError}</span></div>
            {:else if detail === undefined}
              <div class="empty">
                <span class="empty-icon"><Icon name="diff" size={24} /></span>
                <p class="empty-hint">{t('compare.pick')}</p>
              </div>
            {:else}
              {#if currentItem !== undefined}
                <div class="detail-head">
                  <span class="detail-name">{currentItem.name}</span>
                  <span class="badge marked status-{currentItem.status}"
                    ><Icon name={STATUS_ICONS[currentItem.status]} size={12} />{t(STATUS_KEYS[currentItem.status])}</span
                  >
                  {#if currentItem.context !== undefined}<span class="context">{currentItem.context}</span>{/if}
                </div>
              {/if}
              {#if detail.hidden !== undefined}
                <div class="notice warning"><Icon name="eye-closed" /><span>{detail.hidden}</span></div>
              {/if}
              {#if detail.columns.length > 0}
                <h3 class="section-title"><Icon name="symbol-field" />{t('compare.columns')}</h3>
                {@render changes(detail.columns)}
              {/if}
              {#if detail.keys.length > 0}
                <h3 class="section-title"><Icon name="key" />{t('compare.keys')}</h3>
                {@render changes(detail.keys)}
              {/if}
              {#if detail.comment !== undefined}
                <h3 class="section-title"><Icon name="note" />{t('compare.comment')}</h3>
                <p class="comment">
                  <del class="before">{detail.comment.before}</del><span class="to"
                    ><Icon name="arrow-small-right" size={14} /></span
                  ><ins class="after">{detail.comment.after}</ins>
                </p>
              {/if}
              {#if detail.notes.length > 0}
                <ul class="notes">
                  {#each detail.notes as note, index (index)}<li><Icon name="info" size={14} /><span>{note}</span></li>{/each}
                </ul>
              {/if}
              {#if detail.diff.length > 0}
                <h3 class="section-title"><Icon name="file-code" />{t('compare.definition')}</h3>
                <pre class="code diff-lines">{#each detail.diff as line, index (index)}<span class="line {line.op}"
                      >{line.op === 'add' ? '+ ' : line.op === 'remove' ? '- ' : '  '}{line.text}
</span>{/each}</pre>
              {/if}
              <h3 class="section-title"><Icon name="code" />{t('compare.script')}</h3>
              {#if detail.script === ''}
                <p class="muted nothing">{t('compare.noScript')}</p>
              {:else}
                <pre class="code script">{detail.script}</pre>
              {/if}
            {/if}
          </section>
        </div>
      {/if}
    {/if}
    <footer class="status">
      <Icon name="info" size={14} />
      <span>{t('compare.explain')}</span>
    </footer>
  {/if}
</main>

<style>
  main {
    /* Diff colours of the theme: what the script adds, removes and changes. */
    --dn-added: var(--vscode-gitDecoration-addedResourceForeground, var(--dn-success));
    --dn-removed: var(--vscode-gitDecoration-deletedResourceForeground, var(--dn-danger));
    --dn-changed: var(--vscode-gitDecoration-modifiedResourceForeground, var(--dn-warning));
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100vh;
  }

  main.embedded {
    height: 100%;
  }

  .grow {
    flex: 1;
  }

  /* The page's title, what is compared, and its actions. */
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
  }

  .sides {
    display: flex;
    flex-wrap: wrap;
    gap: var(--dn-gap-s) var(--dn-gap);
    align-items: center;
    margin: 2px 0 0;
    color: var(--dn-muted);
    font-size: var(--dn-font-small);
  }

  .side {
    color: var(--vscode-foreground);
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .problem {
    flex: none;
    margin: var(--dn-gap-m) var(--dn-gap-l) 0;
  }

  .message {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  /* The counts, each with its sign, and what the list shows. */
  .summary .toolbar {
    margin-left: auto;
  }

  .summary {
    display: flex;
    flex: none;
    flex-wrap: wrap;
    gap: var(--dn-gap-s) var(--dn-gap);
    align-items: center;
    padding: var(--dn-gap) var(--dn-gap-l);
  }

  .badge.marked {
    background: transparent;
    border-color: currentColor;
  }

  .badge.status-added,
  .status-added > .sign,
  .item.status-added .status-icon {
    color: var(--dn-added);
  }

  .badge.status-removed,
  .status-removed > .sign,
  .item.status-removed .status-icon {
    color: var(--dn-removed);
  }

  .badge.status-changed,
  .status-changed > .sign,
  .item.status-changed .status-icon {
    color: var(--dn-changed);
  }

  .badge.status-same,
  .item.status-same .status-icon {
    color: var(--dn-muted);
  }

  .layout {
    display: grid;
    flex: 1;
    grid-template-columns: minmax(220px, 32%) minmax(0, 1fr);
    min-height: 0;
    border-top: 1px solid var(--dn-divider);
  }

  @media (max-width: 720px) {
    .layout {
      grid-template-rows: minmax(0, 2fr) minmax(0, 3fr);
      grid-template-columns: minmax(0, 1fr);
    }

    .list {
      border-right: none;
      border-bottom: 1px solid var(--dn-divider);
    }
  }

  /* Differences grouped by kind. */
  .list {
    padding: var(--dn-gap-s) 0 var(--dn-gap);
    overflow: auto;
    border-right: 1px solid var(--dn-divider);
  }

  .group-title {
    display: flex;
    gap: var(--dn-gap);
    align-items: center;
    margin: var(--dn-gap) var(--dn-gap-l) var(--dn-gap-s);
    color: var(--dn-muted);
    font-size: 11px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .group-count {
    font-weight: normal;
  }

  .item {
    display: flex;
    gap: var(--dn-gap);
    align-items: center;
    padding: 0 var(--dn-gap) 0 var(--dn-gap-l);
    transition: background-color var(--dn-duration) var(--dn-ease);
  }

  .item:hover {
    background: var(--vscode-list-hoverBackground);
  }

  .item.current {
    background: var(--vscode-list-inactiveSelectionBackground);
  }

  .pick {
    display: flex;
    flex: 1;
    gap: 6px;
    align-items: center;
    min-width: 0;
    min-height: 24px;
    padding: 2px 0;
    color: inherit;
    background: none;
    border: none;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .status-icon {
    display: inline-flex;
    flex: none;
  }

  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .context {
    flex: none;
    color: var(--dn-muted);
    font-size: var(--dn-font-small);
  }

  .hidden-badge {
    margin-left: auto;
  }

  /* One difference: its columns, keys, definition and script. */
  .detail {
    padding: var(--dn-gap-m) var(--dn-gap-l) var(--dn-gap-l);
    overflow: auto;
  }

  .detail-head {
    display: flex;
    flex-wrap: wrap;
    gap: var(--dn-gap);
    align-items: center;
    margin-bottom: var(--dn-gap-s);
  }

  .detail-name {
    font-size: 14px;
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .section-title {
    display: flex;
    gap: var(--dn-gap);
    align-items: center;
    margin: var(--dn-gap-l) 0 var(--dn-gap);
    font-size: 13px;
    font-weight: 600;
  }

  .section-title :global(.codicon-glyph) {
    color: var(--dn-muted);
  }

  .changes {
    width: 100%;
    border-collapse: collapse;
    border: 1px solid var(--dn-border);
    border-radius: var(--dn-radius);
  }

  .changes tr:nth-child(even) {
    background: var(--vscode-keybindingTable-rowsBackground, transparent);
  }

  .changes th,
  .changes td {
    padding: 3px 8px;
    text-align: left;
    vertical-align: top;
    line-height: 18px;
    overflow-wrap: anywhere;
  }

  .changes th {
    width: 1%;
    font-weight: 600;
    white-space: nowrap;
  }

  .change-name {
    display: inline-flex;
    gap: 6px;
    align-items: center;
  }

  .key-kind {
    display: inline-flex;
    color: var(--dn-muted);
  }

  .sign {
    width: 22px;
    padding-right: 0;
  }

  .sign :global(.codicon-glyph) {
    vertical-align: -3px;
  }

  .change-word {
    width: 1%;
    color: var(--dn-muted);
    white-space: nowrap;
  }

  .values {
    font-family: var(--dn-mono);
    font-size: var(--dn-font-small);
  }

  /* The old value is struck out and comes first: readable without colour too. */
  .before,
  .after {
    padding: 0 3px;
    border-radius: var(--dn-radius-s);
  }

  .before {
    background: var(--vscode-diffEditor-removedTextBackground, transparent);
    text-decoration-color: var(--dn-removed);
  }

  .after {
    background: var(--vscode-diffEditor-insertedTextBackground, transparent);
    text-decoration: none;
  }

  .to {
    display: inline-flex;
    margin: 0 4px;
    color: var(--dn-muted);
    vertical-align: -3px;
  }

  .comment {
    margin: 0;
  }

  .notes {
    display: flex;
    flex-direction: column;
    gap: var(--dn-gap-s);
    margin: var(--dn-gap-m) 0 0;
    padding: 0;
    color: var(--dn-muted);
    list-style: none;
  }

  .notes li {
    display: flex;
    gap: 6px;
    align-items: flex-start;
  }

  .notes :global(.codicon-glyph) {
    margin-top: 2px;
  }

  .code {
    margin: 0;
    padding: var(--dn-gap) var(--dn-gap-m);
    overflow: auto;
    font-size: var(--vscode-editor-font-size, 13px);
    line-height: 1.5;
    background: var(--dn-surface);
    border: 1px solid var(--dn-border);
    border-radius: var(--dn-radius);
    user-select: text;
  }

  .diff-lines {
    padding: var(--dn-gap) 0;
  }

  .line {
    display: block;
    padding: 0 var(--dn-gap-m);
    white-space: pre;
  }

  .line.add {
    background: var(--vscode-diffEditor-insertedLineBackground, transparent);
    box-shadow: inset 3px 0 var(--dn-added);
  }

  .line.remove {
    background: var(--vscode-diffEditor-removedLineBackground, transparent);
    box-shadow: inset 3px 0 var(--dn-removed);
  }

  .script {
    white-space: pre-wrap;
  }

  .nothing {
    margin: 0;
  }

  /* Waiting, nothing to show, nothing picked: centred. */
  .empty {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--dn-gap);
    align-items: center;
    justify-content: center;
    min-height: 100%;
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

  .empty-hint {
    margin: 0;
  }

  .status {
    display: flex;
    flex: none;
    gap: 6px;
    align-items: center;
    min-height: 28px;
    padding: 4px var(--dn-gap-l);
    color: var(--dn-muted);
    border-top: 1px solid var(--dn-divider);
    font-size: var(--dn-font-small);
  }

  .status :global(.codicon-glyph) {
    flex: none;
  }
</style>

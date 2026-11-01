<script lang="ts">
  import { onMount, tick } from 'svelte';
  import type { JsonNodeInfo, RedisKeyProtocol } from '../../../../src/shared/protocols/redis-key';
  import type { RpcPeer } from '../../../../src/shared/rpc';
  import Icon from '../../components/Icon.svelte';
  import IconButton from '../../components/IconButton.svelte';
  import type { Translate } from '../../lib/i18n';
  import { formatBytes } from './key-view';
  import {
    iconOf,
    isContainer,
    kindName,
    labelOf,
    type LoadedChildren,
    moveTo,
    rowsOf,
    summaryOf,
    toneColor,
    toneOf,
    treeKeyOf,
  } from './json-view';

  interface Props {
    rpc: RpcPeer<RedisKeyProtocol['webview'], RedisKeyProtocol['host']>;
    t: Translate;
    /** The document's root; it changes after every read of the key. */
    root: JsonNodeInfo;
    readOnly: boolean;
    /** Runs a change through the page, which shows its progress and failure. */
    act: (action: () => Promise<unknown>, after?: () => void) => Promise<void>;
    busy: boolean;
  }

  const { rpc, t, root, readOnly, act, busy }: Props = $props();

  const open = $state<Record<string, true | undefined>>({});
  let loaded = $state<Record<string, LoadedChildren | undefined>>({});
  let selected = $state('$');
  /** The text of the selected node; undefined while it is being read. */
  let detail = $state<{ text: string; truncated: boolean; tooLarge?: number } | undefined>(
    undefined,
  );
  let problem = $state<string | undefined>(undefined);
  let editing = $state(false);
  let draft = $state('');
  let confirming = $state(false);
  let copied = $state<'path' | 'value' | undefined>(undefined);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;

  const rows = $derived(rowsOf(root, open, loaded));
  const selectedIndex = $derived(
    rows.findIndex((row) => row.type === 'node' && row.node.path === selected),
  );
  const selectedRow = $derived(rows[selectedIndex]);
  const selectedNode = $derived(selectedRow?.type === 'node' ? selectedRow.node : undefined);
  const canEdit = $derived(
    !readOnly &&
      detail !== undefined &&
      detail.tooLarge === undefined &&
      !detail.truncated &&
      selectedNode !== undefined,
  );

  onMount(() => {
    // The root opens by itself, so the first level is there without a click.
    void toggle(root);
    void showDetail('$');
    return () => {
      clearTimeout(copyTimer);
    };
  });

  const countOf = (path: string): number => loaded[path]?.nodes.length ?? 0;
  const hasMore = (path: string): boolean => loaded[path]?.more === true;

  function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  async function loadChildren(path: string, offset: number): Promise<void> {
    try {
      const page = await rpc.request('jsonChildren', { path, offset });
      const before = offset === 0 ? [] : (loaded[path]?.nodes ?? []);
      loaded[path] = { nodes: [...before, ...page.nodes], total: page.total, more: page.more };
    } catch (error) {
      // A node that vanished since it was listed closes; anything else is shown.
      open[path] = undefined;
      problem = describe(error);
    }
  }

  async function toggle(node: JsonNodeInfo): Promise<void> {
    if (!isContainer(node)) {
      return;
    }
    if (open[node.path] === true) {
      open[node.path] = undefined;
      return;
    }
    open[node.path] = true;
    if (loaded[node.path] === undefined) {
      await loadChildren(node.path, 0);
    }
  }

  async function showDetail(path: string): Promise<void> {
    detail = undefined;
    try {
      const text = await rpc.request('jsonText', { path });
      if (selected === path) {
        detail = {
          text: text.text,
          truncated: text.truncated === true,
          ...(text.tooLarge === undefined ? {} : { tooLarge: text.tooLarge }),
        };
      }
    } catch (error) {
      if (selected !== path) {
        return;
      }
      if (path !== '$') {
        // The node is gone (an edit elsewhere); the document itself is what is left to show.
        await select('$');
        return;
      }
      problem = describe(error);
      detail = { text: '', truncated: false };
    }
  }

  async function select(path: string): Promise<void> {
    selected = path;
    editing = false;
    confirming = false;
    problem = undefined;
    await showDetail(path);
  }

  async function focusRow(index: number): Promise<void> {
    await tick();
    document.getElementById(`json-row-${String(index)}`)?.focus();
  }

  function onKey(event: KeyboardEvent, index: number): void {
    const key = treeKeyOf(event.key);
    const row = rows[index];
    if (key === undefined || row?.type !== 'node') {
      return;
    }
    event.preventDefault();
    if (key === 'open') {
      if (row.expandable && !row.open) {
        void toggle(row.node);
      } else if (row.open) {
        const next = moveTo(rows, index, 'next');
        const target = next === undefined ? undefined : rows[next];
        if (target?.type === 'node' && target.parent === row.node.path) {
          void select(target.node.path);
          void focusRow(next ?? index);
        }
      }
      return;
    }
    if (key === 'close') {
      if (row.open) {
        void toggle(row.node);
        return;
      }
      const parent = moveTo(rows, index, 'parent');
      const target = parent === undefined ? undefined : rows[parent];
      if (target?.type === 'node') {
        void select(target.node.path);
        void focusRow(parent ?? index);
      }
      return;
    }
    const target = moveTo(rows, index, key);
    const next = target === undefined ? undefined : rows[target];
    if (next?.type === 'node') {
      void select(next.node.path);
      void focusRow(target ?? index);
    }
  }

  /**
   * The key was read again (after a change or a refresh): what was opened is read again
   * too, as far as it was shown, and the selected node's text with it.
   */
  export async function reload(): Promise<void> {
    const paths = Object.keys(open).filter((path) => open[path] === true);
    const shown = Object.fromEntries(paths.map((path) => [path, loaded[path]?.nodes.length ?? 0]));
    loaded = {};
    problem = undefined;
    // Parents first: a node is read only if its parent still lists it.
    for (const path of paths.sort((a, b) => a.length - b.length)) {
      if (open[path] !== true) {
        continue;
      }
      await loadChildren(path, 0);
      while (hasMore(path) && countOf(path) < (shown[path] ?? 0)) {
        await loadChildren(path, countOf(path));
      }
    }
    await showDetail(selected);
  }

  async function copy(what: 'path' | 'value'): Promise<void> {
    const text = what === 'path' ? selected : (detail?.text ?? '');
    try {
      await rpc.request('copyText', { text });
      copied = what;
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => {
        copied = undefined;
      }, 1500);
    } catch (error) {
      problem = describe(error);
    }
  }

  function startEdit(): void {
    draft = detail?.text ?? '';
    editing = true;
  }

  function save(): void {
    const path = selected;
    void act(
      () => rpc.request('jsonSet', { path, text: draft }),
      () => {
        editing = false;
      },
    );
  }

  function remove(): void {
    const path = selected;
    void act(
      () => rpc.request('jsonDelete', { path }),
      () => {
        confirming = false;
        selected = '$';
      },
    );
  }
</script>

<div class="json" data-testid="json-view">
  <section class="tree-pane" aria-label={t('redis.json.tree')}>
    <div class="tree" role="tree" aria-label={t('redis.json.document')}>
      {#each rows as row, index (row.type === 'node' ? row.node.path : `${row.path}\u0000more`)}
        {#if row.type === 'node'}
          {@const tone = toneOf(row.node.kind)}
          <div
            id="json-row-{index}"
            class="row"
            class:selected={row.node.path === selected}
            role="treeitem"
            aria-level={row.depth + 1}
            aria-selected={row.node.path === selected}
            aria-expanded={row.expandable ? row.open : undefined}
            tabindex={row.node.path === selected ? 0 : -1}
            style="padding-left: {6 + row.depth * 16}px"
            onclick={() => void select(row.node.path)}
            ondblclick={() => void toggle(row.node)}
            onkeydown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                void select(row.node.path);
                void toggle(row.node);
              } else {
                onKey(event, index);
              }
            }}
          >
            <span class="twist">
              {#if row.expandable}
                <button
                  type="button"
                  class="twist-button"
                  tabindex="-1"
                  aria-label={row.open ? t('redis.json.collapse') : t('redis.json.expand')}
                  data-testid="twist"
                  onclick={(event) => {
                    event.stopPropagation();
                    void toggle(row.node);
                  }}
                >
                  <Icon name={row.loading ? 'loading' : row.open ? 'chevron-down' : 'chevron-right'} size={14} spin={row.loading} />
                </button>
              {/if}
            </span>
            <Icon name={iconOf(row.node.kind)} size={14} tone={toneColor(row.node.kind)} />
            <span class="name" class:root={row.node.path === '$'}>{labelOf(row.node, row.parentKind, t)}</span>
            <span class="value {tone}" title={summaryOf(row.node, t)}>{summaryOf(row.node, t)}</span>
          </div>
        {:else}
          <div class="row more" style="padding-left: {6 + row.depth * 16}px">
            <button
              type="button"
              class="button secondary small"
              disabled={busy}
              onclick={() => void loadChildren(row.path, row.shown)}
              ><Icon name="unfold" size={14} />{t('redis.json.more', row.shown, row.total)}</button
            >
          </div>
        {/if}
      {/each}
    </div>
  </section>

  <section class="detail" aria-label={t('redis.json.document')}>
    {#if selectedNode === undefined}
      <p class="hint">{t('redis.json.select')}</p>
    {:else}
      <header class="detail-head">
        <span class="kind {toneOf(selectedNode.kind)}">
          <Icon name={iconOf(selectedNode.kind)} size={14} tone={toneColor(selectedNode.kind)} />{kindName(selectedNode.kind, t)}
        </span>
        <code class="path" title={selected} data-testid="json-path">{selected}</code>
        <div class="actions-bar">
          <IconButton
            icon={copied === 'path' ? 'check' : 'copy'}
            label={t('redis.json.copyPath')}
            onclick={() => void copy('path')}
          />
          <IconButton
            icon={copied === 'value' ? 'check' : 'file-code'}
            label={t('redis.json.copyValue')}
            disabled={detail === undefined || detail.tooLarge !== undefined}
            onclick={() => void copy('value')}
          />
          {#if canEdit && !editing}
            <IconButton icon="edit" label={t('redis.json.edit')} disabled={busy} onclick={startEdit} />
          {/if}
          {#if !readOnly && selected !== '$' && !editing}
            <IconButton
              icon="trash"
              label={t('redis.json.delete')}
              disabled={busy}
              onclick={() => {
                confirming = true;
              }}
            />
          {/if}
        </div>
      </header>

      {#if confirming}
        <div class="notice warning confirm" role="alert" data-testid="json-confirm">
          <Icon name="warning" /><span class="grow">{t('redis.json.confirmDelete', selected)}</span>
          <button type="button" class="button danger small" disabled={busy} onclick={remove}>{t('redis.json.confirm')}</button>
          <button
            type="button"
            class="button secondary small"
            onclick={() => {
              confirming = false;
            }}>{t('redis.json.cancel')}</button
          >
        </div>
      {/if}

      {#if problem !== undefined}
        <div class="notice error" role="alert" data-testid="json-problem"><Icon name="error" /><span>{problem}</span></div>
      {/if}

      {#if detail === undefined}
        <p class="hint"><Icon name="loading" spin size={14} /> {t('redis.json.loading')}</p>
      {:else if detail.tooLarge !== undefined}
        <div class="notice warning" data-testid="json-too-large">
          <Icon name="warning" /><span>{t('redis.json.tooLarge', formatBytes(detail.tooLarge))}</span>
        </div>
      {:else if editing}
        <textarea
          class="control code editor"
          bind:value={draft}
          spellcheck="false"
          aria-label={t('redis.json.edit')}
        ></textarea>
        <footer class="edit-actions">
          <button type="button" class="button" disabled={busy} onclick={save}><Icon name="save" />{t('redis.json.save')}</button>
          <button
            type="button"
            class="button secondary"
            onclick={() => {
              editing = false;
            }}>{t('redis.json.cancel')}</button
          >
        </footer>
      {:else}
        <pre class="text" data-testid="json-text">{detail.text}</pre>
        {#if detail.truncated}
          <div class="notice warning"><Icon name="warning" /><span>{t('redis.json.truncated')}</span></div>
        {/if}
      {/if}
    {/if}
  </section>
</div>

<style>
  .json {
    display: flex;
    flex: 1;
    min-height: 0;
    border-top: 1px solid var(--dn-divider);
  }

  .tree-pane {
    display: flex;
    flex: 1 1 50%;
    flex-direction: column;
    min-width: 0;
    overflow: hidden;
  }

  .tree {
    flex: 1;
    min-height: 0;
    padding: var(--dn-gap-s) 0;
    overflow: auto;
  }

  .row {
    display: flex;
    gap: 6px;
    align-items: center;
    min-height: 24px;
    padding-right: var(--dn-gap-m);
    font-family: var(--dn-mono);
    font-size: var(--dn-font-small);
    white-space: nowrap;
    cursor: default;
  }

  .row:hover {
    background: var(--vscode-list-hoverBackground);
  }

  .row.selected,
  .row.selected:hover {
    color: var(--vscode-list-activeSelectionForeground);
    background: var(--vscode-list-activeSelectionBackground);
  }

  .row:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
  }

  .row.more {
    padding-top: 2px;
    padding-bottom: 2px;
  }

  .twist {
    display: inline-flex;
    flex: none;
    width: 16px;
  }

  .twist-button {
    display: inline-flex;
    padding: 0;
    color: inherit;
    background: transparent;
    border: none;
    cursor: pointer;
  }

  .name {
    flex: none;
    max-width: 45%;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .name.root {
    font-weight: 600;
  }

  .value {
    min-width: 0;
    overflow: hidden;
    color: var(--dn-muted);
    text-overflow: ellipsis;
  }

  /* Values wear the colour of their kind, as a code editor would draw them. */
  .row:not(.selected) .value.string {
    color: var(--vscode-charts-green);
  }

  .row:not(.selected) .value.number {
    color: var(--vscode-charts-orange);
  }

  .row:not(.selected) .value.boolean {
    color: var(--vscode-charts-blue);
  }

  .button.small {
    height: 22px;
    padding: 0 8px;
    font-size: var(--dn-font-small);
  }

  .detail {
    display: flex;
    flex: 1 1 50%;
    flex-direction: column;
    gap: var(--dn-gap);
    min-width: 0;
    min-height: 0;
    padding: var(--dn-gap) var(--dn-gap-m);
    overflow: auto;
    background: var(--vscode-sideBar-background, var(--dn-surface));
    border-left: 1px solid var(--dn-divider);
  }

  .detail-head {
    display: flex;
    flex: none;
    flex-wrap: wrap;
    gap: var(--dn-gap-s) var(--dn-gap);
    align-items: center;
  }

  .kind {
    display: inline-flex;
    gap: 4px;
    align-items: center;
    padding: 1px 8px;
    color: var(--dn-muted);
    border: 1px solid var(--dn-border);
    border-radius: 10px;
    font-size: 11px;
  }

  .path {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    font-family: var(--dn-mono);
    font-size: var(--dn-font-small);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .actions-bar {
    display: inline-flex;
    gap: 2px;
    margin-left: auto;
  }

  .text {
    flex: 1;
    min-height: 0;
    margin: 0;
    padding: var(--dn-gap);
    overflow: auto;
    font-family: var(--dn-mono);
    font-size: var(--vscode-editor-font-size, 13px);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    background: var(--vscode-editor-background);
    border: 1px solid var(--dn-border);
    border-radius: var(--dn-radius);
    user-select: text;
  }

  .editor {
    flex: 1;
    min-height: 160px;
    font-family: var(--dn-mono);
    font-size: var(--vscode-editor-font-size, 13px);
    resize: none;
  }

  .edit-actions {
    display: flex;
    flex: none;
    gap: var(--dn-gap);
  }

  .confirm {
    display: flex;
    gap: var(--dn-gap);
    align-items: center;
  }

  .grow {
    flex: 1;
    overflow-wrap: anywhere;
  }

  .hint {
    display: flex;
    gap: 6px;
    align-items: center;
    margin: 0;
    color: var(--dn-muted);
    font-size: var(--dn-font-small);
  }

  @media (max-width: 640px) {
    .json {
      flex-direction: column;
    }

    .detail {
      border-top: 1px solid var(--dn-divider);
      border-left: none;
    }
  }
</style>

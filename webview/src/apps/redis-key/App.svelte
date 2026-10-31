<script lang="ts">
  import { onMount } from 'svelte';
  import type { RedisKeyProtocol, RedisKeyState } from '../../../../src/shared/protocols/redis-key';
  import type { RedisValue } from '../../../../src/shared/redis-value';
  import type { RpcPeer } from '../../../../src/shared/rpc';
  import Icon from '../../components/Icon.svelte';
  import IconButton from '../../components/IconButton.svelte';
  import type { CodiconName } from '../../lib/codicons';
  import type { Translate } from '../../lib/i18n';
  import ItemEditor from './ItemEditor.svelte';
  import ValueEditor from './ValueEditor.svelte';
  import {
    cellText,
    formatBytes,
    formatTtl,
    itemKey,
    type PageItem,
    type PageRequest,
    parseTtlSeconds,
  } from './key-view';

  interface Props {
    rpc: RpcPeer<RedisKeyProtocol['webview'], RedisKeyProtocol['host']>;
    t: Translate;
  }

  const { rpc, t }: Props = $props();

  let keyState = $state<RedisKeyState | undefined>(undefined);
  /** The item in the editor: its key, `new` for a new one, or none. */
  let editing = $state<string | undefined>(undefined);
  let busy = $state(false);
  let error = $state<string | undefined>(undefined);
  let stringDraft = $state<RedisValue | undefined>(undefined);
  let ttlText = $state('');
  let filterText = $state('');
  let renameText = $state('');
  /** When the state arrived, so the TTL counts down between reads. */
  let receivedAt = $state(0);
  let now = $state(Date.now());
  /** Bumped on every state, so the value box starts over from the server's value. */
  let version = $state(0);

  const items = $derived<PageItem[]>((keyState?.items ?? []) as PageItem[]);
  const selected = $derived(
    editing === undefined || editing === 'new'
      ? undefined
      : items.find((item) => itemKey(item) === editing),
  );
  const ttlLeft = $derived(
    keyState?.ttlMs === null || keyState?.ttlMs === undefined
      ? undefined
      : keyState.ttlMs - (now - receivedAt),
  );
  const filterable = $derived(
    keyState?.type === 'hash' || keyState?.type === 'set' || keyState?.type === 'zset',
  );
  const editableType = $derived(
    ['string', 'hash', 'list', 'set', 'zset', 'stream'].includes(keyState?.type ?? ''),
  );

  onMount(() => {
    const subscription = rpc.on('state', (next) => {
      keyState = next;
      receivedAt = Date.now();
      now = receivedAt;
      version += 1;
      stringDraft = undefined;
      renameText = next.key.text;
      if (editing !== undefined && editing !== 'new') {
        // The edited item may have moved or gone; its editor closes then.
        const still = (next.items ?? []).some((item) => itemKey(item) === editing);
        if (!still) {
          editing = undefined;
        }
      }
    });
    const timer = setInterval(() => {
      now = Date.now();
    }, 1000);
    rpc.emit('ready', {});
    return () => {
      subscription.dispose();
      clearInterval(timer);
    };
  });

  async function run(action: () => Promise<unknown>, after?: () => void): Promise<void> {
    if (busy) {
      return;
    }
    busy = true;
    error = undefined;
    try {
      await action();
      after?.();
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    } finally {
      busy = false;
    }
  }

  function submit(request: PageRequest): void {
    void run(
      () => rpc.request(request.method, request.params),
      () => {
        editing = undefined;
      },
    );
  }

  /** Each Redis type has its own icon, next to its name. */
  function typeIcon(type: string): CodiconName {
    switch (type) {
      case 'string':
        return 'symbol-string';
      case 'hash':
        return 'symbol-structure';
      case 'list':
        return 'list-ordered';
      case 'set':
        return 'symbol-array';
      case 'zset':
        return 'sort-precedence';
      case 'stream':
        return 'pulse';
      default:
        return 'symbol-misc';
    }
  }

  function headerOf(type: string): string[] {
    switch (type) {
      case 'hash':
        return [t('redis.field'), t('redis.value')];
      case 'list':
        return ['#', t('redis.value')];
      case 'set':
        return [t('redis.member')];
      case 'zset':
        return [t('redis.member'), t('redis.score')];
      case 'stream':
        return [t('redis.entryId'), t('redis.fields')];
      default:
        return [];
    }
  }

  function cellsOf(item: PageItem): string[] {
    switch (keyState?.type ?? '') {
      case 'hash':
        return [cellText(item.field), cellText(item.value)];
      case 'list':
        return [String(item.index ?? ''), cellText(item.value)];
      case 'set':
        return [cellText(item.value)];
      case 'zset':
        return [cellText(item.value), item.score ?? ''];
      case 'stream':
        return [
          item.id ?? '',
          (item.fields ?? [])
            .map((pair) => `${cellText(pair.field, 40)}=${cellText(pair.value, 60)}`)
            .join(', '),
        ];
      default:
        return [];
    }
  }
</script>

<main>
  {#if busy}
    <div class="progress-bar" aria-hidden="true"></div>
  {/if}
  {#if keyState === undefined}
    <div class="empty">
      <span class="empty-icon"><Icon name="loading" spin size={24} /></span>
      <p class="empty-title">{t('redis.loading')}</p>
    </div>
  {:else}
    <header class="top">
      <span class="top-icon"><Icon name="key" size={18} /></span>
      <div class="top-text">
        <h1 title={keyState.key.text}>{keyState.key.text}</h1>
        <p class="meta" data-testid="meta">
          <span class="badge"><Icon name={typeIcon(keyState.type)} size={12} />{keyState.type}</span>
          {#if keyState.exists}
            <span
              class="badge outline"
              class:expiring={ttlLeft !== undefined}
              data-testid="ttl"
              ><Icon name="watch" size={12} />{ttlLeft === undefined
                ? t('redis.noTtl')
                : t('redis.ttl', formatTtl(ttlLeft))}</span
            >
          {/if}
          {#if keyState.readOnly}
            <span class="badge outline"><Icon name="lock" size={12} />{t('redis.readOnly')}</span>
          {/if}
          <span class="fact"><Icon name="database" size={12} />db{keyState.database} · {keyState.connectionName}</span>
          {#if keyState.length !== undefined}
            <span class="fact">{t(keyState.type === 'string' ? 'redis.bytes' : 'redis.items', keyState.length)}</span>
          {/if}
          {#if keyState.memory !== undefined}
            <span class="fact">{t('redis.memory', formatBytes(keyState.memory))}</span>
          {/if}
          {#if keyState.encoding !== undefined}
            <span class="fact mono">{keyState.encoding}</span>
          {/if}
        </p>
      </div>
      {#if keyState.exists}
        <div class="toolbar">
          <IconButton
            icon="refresh"
            label={t('redis.refresh')}
            disabled={busy}
            onclick={() => void run(() => rpc.request('refresh', {}))}
          />
          {#if !keyState.readOnly}
            <IconButton
              icon="trash"
              label={t('redis.deleteKey')}
              disabled={busy}
              onclick={() => void run(() => rpc.request('deleteKey', {}))}
            />
          {/if}
        </div>
      {/if}
    </header>

    {#if error !== undefined}
      <div class="notice error problem" role="alert" data-testid="error"><Icon name="error" /><span class="message">{error}</span></div>
    {/if}

    {#if !keyState.exists}
      <div class="empty">
        <span class="empty-icon"><Icon name="circle-slash" size={24} /></span>
        <p class="empty-title" data-testid="gone">{t('redis.gone')}</p>
        <button type="button" class="button secondary" disabled={busy} onclick={() => void run(() => rpc.request('refresh', {}))}
          ><Icon name="refresh" />{t('redis.refresh')}</button
        >
      </div>
    {:else}
      {#if !keyState.readOnly}
        <div class="keybar">
          <div class="group">
            <span class="group-icon" title={t('redis.setTtl')}><Icon name="watch" /></span>
            <input
              class="control ttl-input"
              bind:value={ttlText}
              placeholder={t('redis.seconds')}
              aria-label={t('redis.setTtl')}
              inputmode="numeric"
              onkeydown={(event) => {
                const seconds = parseTtlSeconds(ttlText);
                if (event.key === 'Enter' && seconds !== undefined) {
                  void run(() => rpc.request('setTtl', { seconds }), () => {
                    ttlText = '';
                  });
                }
              }}
            />
            <button
              type="button"
              class="button secondary"
              disabled={busy || parseTtlSeconds(ttlText) === undefined}
              onclick={() =>
                void run(() => rpc.request('setTtl', { seconds: parseTtlSeconds(ttlText) ?? 1 }), () => {
                  ttlText = '';
                })}>{t('redis.setTtl')}</button
            >
            {#if ttlLeft !== undefined}
              <button
                type="button"
                class="button secondary"
                disabled={busy}
                onclick={() => void run(() => rpc.request('setTtl', { seconds: null }))}
                >{t('redis.persist')}</button
              >
            {/if}
          </div>
          <span class="toolbar-separator"></span>
          <div class="group rename">
            <span class="group-icon" title={t('redis.rename')}><Icon name="edit" /></span>
            <input
              class="control grow mono"
              bind:value={renameText}
              aria-label={t('redis.newName')}
              spellcheck="false"
              onkeydown={(event) => {
                if (event.key === 'Enter' && renameText !== '' && renameText !== keyState?.key.text) {
                  void run(() => rpc.request('rename', { name: renameText }));
                }
              }}
            />
            <button
              type="button"
              class="button secondary"
              disabled={busy || renameText === '' || renameText === keyState.key.text}
              onclick={() => void run(() => rpc.request('rename', { name: renameText }))}
              >{t('redis.rename')}</button
            >
          </div>
        </div>
      {/if}

      {#if keyState.type === 'string' && keyState.value !== undefined}
        <div class="string">
          {#key version}
            <ValueEditor
              value={keyState.value}
              label={t('redis.value')}
              rows={12}
              grow
              readonly={keyState.readOnly}
              {t}
              onchange={(value: RedisValue | undefined) => {
                stringDraft = value;
              }}
            />
          {/key}
        </div>
        {#if !keyState.readOnly && keyState.value.truncated !== true}
          <footer class="actions">
            <button
              type="button"
              class="button"
              disabled={busy || stringDraft === undefined}
              onclick={() => {
                if (stringDraft !== undefined) {
                  const value = stringDraft;
                  void run(() => rpc.request('setString', { value }));
                }
              }}><Icon name="save" />{t('redis.save')}</button
            >
          </footer>
        {/if}
      {:else if !editableType}
        <div class="notice info problem" data-testid="unsupported"><Icon name="info" /><span>{t('redis.unsupported', keyState.type)}</span></div>
      {:else}
        <div class="listbar">
          {#if filterable}
            <div class="find">
              <span class="find-icon"><Icon name="search" size={14} /></span>
              <input
                class="control find-input"
                bind:value={filterText}
                placeholder={t('redis.filterHint')}
                aria-label={t('redis.filter')}
                spellcheck="false"
                onkeydown={(event) => {
                  if (event.key === 'Enter') {
                    void run(() => rpc.request('filter', { pattern: filterText }));
                  }
                }}
              />
            </div>
            <button
              type="button"
              class="button secondary"
              disabled={busy}
              onclick={() => void run(() => rpc.request('filter', { pattern: filterText }))}
              ><Icon name="filter" />{t('redis.filter')}</button
            >
          {/if}
          {#if keyState.filter !== undefined}
            <span class="badge outline filtered"><Icon name="filter-filled" size={12} />{t('redis.filtered', keyState.filter)}</span>
          {/if}
          {#if !keyState.readOnly}
            <button
              type="button"
              class="button add"
              onclick={() => {
                editing = 'new';
              }}><Icon name="add" />{t('redis.addItem')}</button
            >
          {/if}
        </div>

        <div class="body" class:editing={editing !== undefined}>
          <div class="items-area">
            {#if items.length === 0}
              <div class="empty">
                <span class="empty-icon"><Icon name="list-flat" size={24} /></span>
                <p class="empty-title">{t('redis.noItems')}</p>
              </div>
            {:else}
              <div class="scroll">
                <table class="items {keyState.type}" aria-label={t('redis.items', items.length)}>
                  <thead>
                    <tr>
                      {#each headerOf(keyState.type) as title (title)}
                        <th>{title}</th>
                      {/each}
                    </tr>
                  </thead>
                  <tbody>
                    {#each items as item (itemKey(item))}
                      <tr
                        class:selected={editing === itemKey(item)}
                        aria-selected={editing === itemKey(item)}
                        tabindex="0"
                        onclick={() => {
                          editing = itemKey(item);
                        }}
                        onkeydown={(event) => {
                          if (event.key === 'Enter') {
                            editing = itemKey(item);
                          }
                        }}
                      >
                        {#each cellsOf(item) as cell, index (index)}
                          <td>{cell}</td>
                        {/each}
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            {/if}
            {#if keyState.more === true}
              <footer class="status">
                <span>{t('redis.items', items.length)}</span>
                <button
                  type="button"
                  class="button secondary"
                  disabled={busy}
                  onclick={() => void run(() => rpc.request('loadMore', {}))}
                  ><Icon name="unfold" />{t('redis.loadMore', items.length)}</button
                >
              </footer>
            {/if}
          </div>

          {#if editing !== undefined}
            <aside class="panel fade-in">
              {#key editing}
                <ItemEditor
                  type={keyState.type}
                  item={selected}
                  readOnly={keyState.readOnly}
                  {busy}
                  {t}
                  onsubmit={submit}
                  oncancel={() => {
                    editing = undefined;
                  }}
                />
              {/key}
            </aside>
          {/if}
        </div>
      {/if}
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

  .mono {
    font-family: var(--dn-mono);
  }

  /* The key, what it is, and what can be done to it as a whole. */
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
    overflow: hidden;
    font-family: var(--dn-mono);
    font-size: 14px;
    text-overflow: ellipsis;
    white-space: nowrap;
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

  .badge.expiring {
    color: var(--dn-warning);
    border-color: currentColor;
  }

  .problem {
    flex: none;
    margin: var(--dn-gap-m) var(--dn-gap-l) 0;
  }

  .message {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  /* TTL and rename: small forms in one strip. */
  .keybar {
    display: flex;
    flex: none;
    flex-wrap: wrap;
    gap: var(--dn-gap) var(--dn-gap-s);
    align-items: center;
    padding: var(--dn-gap) var(--dn-gap-l);
    background: var(--vscode-sideBar-background, var(--dn-surface));
    border-bottom: 1px solid var(--dn-divider);
  }

  .group {
    display: flex;
    gap: 6px;
    align-items: center;
  }

  .group.rename {
    flex: 1 1 260px;
  }

  .group-icon {
    display: inline-flex;
    color: var(--dn-muted);
  }

  .keybar .control,
  .keybar .button,
  .listbar .control,
  .listbar .button,
  .status .button {
    min-height: 24px;
    padding-top: 2px;
    padding-bottom: 2px;
  }

  .ttl-input {
    width: 96px;
  }

  .rename .control {
    min-width: 0;
  }

  /* A string's value fills the page; its Save button is pinned below. */
  .string {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
    padding: var(--dn-gap-m) var(--dn-gap-l);
  }

  .actions {
    display: flex;
    flex: none;
    justify-content: flex-end;
    padding: var(--dn-gap) var(--dn-gap-l);
    border-top: 1px solid var(--dn-divider);
  }

  /* The items of a hash, list, set, sorted set or stream. */
  .listbar {
    display: flex;
    flex: none;
    flex-wrap: wrap;
    gap: var(--dn-gap);
    align-items: center;
    padding: var(--dn-gap) var(--dn-gap-l);
  }

  .find {
    position: relative;
    display: flex;
    flex: 0 1 280px;
    align-items: center;
    min-width: 140px;
  }

  .find-icon {
    position: absolute;
    left: 7px;
    display: inline-flex;
    color: var(--dn-muted);
    pointer-events: none;
  }

  .find-input {
    width: 100%;
    padding-left: 26px;
    font-family: var(--dn-mono);
  }

  .add {
    margin-left: auto;
  }

  .filtered {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .body {
    display: flex;
    flex: 1;
    min-height: 0;
    border-top: 1px solid var(--dn-divider);
  }

  .items-area {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
  }

  .panel {
    display: flex;
    flex: none;
    flex-direction: column;
    width: min(420px, 45%);
    min-height: 0;
    background: var(--vscode-sideBar-background, var(--dn-surface));
    border-left: 1px solid var(--dn-divider);
  }

  /* Narrow: the editor takes the place of the list while it is open. */
  @media (max-width: 640px) {
    .keybar .toolbar-separator {
      display: none;
    }

    .body.editing .items-area {
      display: none;
    }

    .panel {
      width: 100%;
      border-left: none;
    }
  }

  .scroll {
    --dn-header-background: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-editor-background));
    flex: 1;
    min-height: 0;
    overflow: auto;
  }

  .items {
    width: 100%;
    border-collapse: separate;
    border-spacing: 0;
    table-layout: fixed;
  }

  .items th,
  .items td {
    height: 22px;
    padding: 2px var(--dn-gap-l);
    overflow: hidden;
    line-height: 18px;
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .items td {
    font-family: var(--dn-mono);
    font-size: var(--dn-font-small);
  }

  .items th {
    position: sticky;
    top: 0;
    z-index: 1;
    font-weight: 600;
    background: var(--dn-header-background);
    box-shadow: 0 1px 0 var(--dn-divider);
  }

  .items.hash th:first-child,
  .items.zset th:last-child,
  .items.stream th:first-child {
    width: 35%;
  }

  .items.list th:first-child {
    width: 64px;
  }

  .items.list td:first-child {
    color: var(--dn-muted);
    text-align: right;
  }

  .items tbody tr {
    cursor: pointer;
  }

  .items tbody tr:nth-child(even) {
    background: var(--vscode-keybindingTable-rowsBackground, transparent);
  }

  .items tbody tr:hover {
    background: var(--vscode-list-hoverBackground);
  }

  .items tbody tr:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
  }

  .items tr.selected,
  .items tr.selected:hover {
    color: var(--vscode-list-activeSelectionForeground);
    background: var(--vscode-list-activeSelectionBackground);
  }

  .status {
    display: flex;
    flex: none;
    gap: var(--dn-gap-m);
    align-items: center;
    justify-content: space-between;
    min-height: 32px;
    padding: 3px var(--dn-gap-l);
    color: var(--dn-muted);
    border-top: 1px solid var(--dn-divider);
    font-size: var(--dn-font-small);
  }

  /* Waiting, gone and nothing to list: centred. */
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

<script lang="ts">
  import { onMount } from 'svelte';
  import type { RedisKeyProtocol, RedisKeyState } from '../../../../src/shared/protocols/redis-key';
  import type { RedisValue } from '../../../../src/shared/redis-value';
  import type { RpcPeer } from '../../../../src/shared/rpc';
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
  {#if keyState === undefined}
    <p class="hint">{t('redis.loading')}</p>
  {:else}
    <header>
      <h1 title={keyState.key.text}>{keyState.key.text}</h1>
      <p class="meta" data-testid="meta">
        <span class="badge">{keyState.type}</span>
        <span>db{keyState.database} · {keyState.connectionName}</span>
        {#if keyState.length !== undefined}
          <span>{t(keyState.type === 'string' ? 'redis.bytes' : 'redis.items', keyState.length)}</span>
        {/if}
        {#if keyState.memory !== undefined}
          <span>{t('redis.memory', formatBytes(keyState.memory))}</span>
        {/if}
        {#if keyState.encoding !== undefined}
          <span>{keyState.encoding}</span>
        {/if}
        {#if keyState.readOnly}
          <span class="badge">{t('redis.readOnly')}</span>
        {/if}
      </p>
    </header>

    {#if error !== undefined}
      <p class="error" role="alert" data-testid="error">{error}</p>
    {/if}

    {#if !keyState.exists}
      <p class="hint" data-testid="gone">{t('redis.gone')}</p>
      <button type="button" class="button secondary" onclick={() => void run(() => rpc.request('refresh', {}))}>
        {t('redis.refresh')}
      </button>
    {:else}
      <section class="toolbar">
        <span class="ttl" data-testid="ttl">
          {ttlLeft === undefined ? t('redis.noTtl') : t('redis.ttl', formatTtl(ttlLeft))}
        </span>
        {#if !keyState.readOnly}
          <input
            class="control small"
            bind:value={ttlText}
            placeholder={t('redis.seconds')}
            aria-label={t('redis.setTtl')}
            inputmode="numeric"
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
        {/if}
        <span class="grow"></span>
        <button type="button" class="button secondary" disabled={busy} onclick={() => void run(() => rpc.request('refresh', {}))}>
          {t('redis.refresh')}
        </button>
        {#if !keyState.readOnly}
          <button
            type="button"
            class="button secondary"
            disabled={busy}
            onclick={() => void run(() => rpc.request('deleteKey', {}))}>{t('redis.deleteKey')}</button
          >
        {/if}
      </section>

      {#if !keyState.readOnly}
        <section class="toolbar">
          <input
            class="control grow"
            bind:value={renameText}
            aria-label={t('redis.newName')}
            spellcheck="false"
          />
          <button
            type="button"
            class="button secondary"
            disabled={busy || renameText === '' || renameText === keyState.key.text}
            onclick={() => void run(() => rpc.request('rename', { name: renameText }))}
            >{t('redis.rename')}</button
          >
        </section>
      {/if}

      {#if keyState.type === 'string' && keyState.value !== undefined}
        {#key version}
          <ValueEditor
            value={keyState.value}
            label={t('redis.value')}
            rows={12}
            readonly={keyState.readOnly}
            {t}
            onchange={(value: RedisValue | undefined) => {
              stringDraft = value;
            }}
          />
        {/key}
        {#if !keyState.readOnly && keyState.value.truncated !== true}
          <div class="toolbar">
            <button
              type="button"
              class="button"
              disabled={busy || stringDraft === undefined}
              onclick={() => {
                if (stringDraft !== undefined) {
                  const value = stringDraft;
                  void run(() => rpc.request('setString', { value }));
                }
              }}>{t('redis.save')}</button
            >
          </div>
        {/if}
      {:else if !editableType}
        <p class="hint" data-testid="unsupported">{t('redis.unsupported', keyState.type)}</p>
      {:else}
        <section class="toolbar">
          {#if filterable}
            <input
              class="control grow"
              bind:value={filterText}
              placeholder={t('redis.filterHint')}
              aria-label={t('redis.filter')}
              onkeydown={(event) => {
                if (event.key === 'Enter') {
                  void run(() => rpc.request('filter', { pattern: filterText }));
                }
              }}
            />
            <button type="button" class="button secondary" disabled={busy} onclick={() => void run(() => rpc.request('filter', { pattern: filterText }))}>
              {t('redis.filter')}
            </button>
          {/if}
          {#if !keyState.readOnly}
            <button
              type="button"
              class="button"
              onclick={() => {
                editing = 'new';
              }}>{t('redis.addItem')}</button
            >
          {/if}
        </section>
        {#if keyState.filter !== undefined}
          <p class="hint">{t('redis.filtered', keyState.filter)}</p>
        {/if}

        {#if editing !== undefined}
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
        {/if}

        <table class="items" aria-label={t('redis.items', items.length)}>
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
        {#if items.length === 0}
          <p class="hint">{t('redis.noItems')}</p>
        {/if}
        {#if keyState.more === true}
          <button type="button" class="button secondary" disabled={busy} onclick={() => void run(() => rpc.request('loadMore', {}))}>
            {t('redis.loadMore', items.length)}
          </button>
        {/if}
      {/if}
    {/if}
  {/if}
</main>

<style>
  main {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px;
    max-width: 1100px;
  }
  h1 {
    font-size: 1.3em;
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
  .badge {
    border: 1px solid var(--vscode-focusBorder);
    padding: 0 6px;
    border-radius: 3px;
    color: var(--vscode-foreground);
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
  .small {
    width: 90px;
  }
  .hint {
    color: var(--vscode-descriptionForeground);
  }
  .error {
    color: var(--vscode-errorForeground);
  }
  .items {
    border-collapse: collapse;
    width: 100%;
    table-layout: fixed;
  }
  .items th,
  .items td {
    text-align: left;
    padding: 3px 8px;
    border-bottom: 1px solid var(--vscode-panel-border, transparent);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .items tbody tr {
    cursor: pointer;
  }
  .items tbody tr:hover {
    background: var(--vscode-list-hoverBackground);
  }
  .items tr.selected {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
  }
</style>

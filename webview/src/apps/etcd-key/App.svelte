<script lang="ts">
  import { onMount } from 'svelte';
  import type {
    EtcdKeyProtocol,
    EtcdKeyState,
  } from '../../../../src/shared/protocols/etcd-key';
  import type { RedisValue } from '../../../../src/shared/redis-value';
  import type { RpcPeer } from '../../../../src/shared/rpc';
  import Icon from '../../components/Icon.svelte';
  import IconButton from '../../components/IconButton.svelte';
  import type { Translate } from '../../lib/i18n';
  import ValueEditor from '../redis-key/ValueEditor.svelte';
  import { clock, clockTime, parseLeaseId, parseSeconds, secondsLeft, toneOf } from './lease-view';

  interface Props {
    rpc: RpcPeer<EtcdKeyProtocol['webview'], EtcdKeyProtocol['host']>;
    t: Translate;
  }

  const { rpc, t }: Props = $props();

  let keyState = $state<EtcdKeyState | undefined>(undefined);
  let busy = $state(false);
  let error = $state<string | undefined>(undefined);
  /** What the user typed in the value box; undefined while it is as the server has it. */
  let draft = $state<RedisValue | undefined>(undefined);
  let ttlText = $state('');
  let leaseText = $state('');
  /** When the state arrived, so the lease counts down between reads. */
  let receivedAt = $state(0);
  let now = $state(Date.now());
  /** Bumped when the server's value should replace what the box shows. */
  let version = $state(0);
  /** The revision the value box was filled at: a save is checked against it, not a later read. */
  let readRevision = $state('0');
  let watchPrefix = $state(false);

  const left = $derived(
    keyState?.lease === null || keyState?.lease === undefined
      ? undefined
      : secondsLeft(keyState.lease, now - receivedAt),
  );
  const tone = $derived(left === undefined ? undefined : toneOf(left));
  /** The key moved on while the user was typing: the text stays, the save will ask. */
  const stale = $derived(
    draft !== undefined && keyState !== undefined && keyState.modRevision !== readRevision,
  );
  /** The changes the watch saw, newest first. */
  const changes = $derived([...(keyState?.events ?? [])].reverse());

  onMount(() => {
    const subscription = rpc.on('state', (next) => {
      keyState = next;
      receivedAt = Date.now();
      now = receivedAt;
      // A refused save keeps the user's text in the box: only a fresh read replaces it.
      // A change seen by the watch does not erase what the user is typing either.
      const keepDraft = next.conflict === true || (next.watching === true && draft !== undefined);
      if (!keepDraft) {
        version += 1;
        draft = undefined;
        readRevision = next.modRevision;
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

  function save(overwrite: boolean): void {
    const state = keyState;
    const value = draft ?? state?.value;
    if (state === undefined || value === undefined) {
      return;
    }
    void run(() =>
      rpc.request('save', {
        value,
        modRevision: overwrite ? state.modRevision : readRevision,
        ...(overwrite ? { overwrite: true } : {}),
      }),
    );
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
          {#if keyState.exists}
            <span class="badge" title={t('etcd.createdAt', keyState.createRevision)}
              ><Icon name="history" size={12} />{t('etcd.revision', keyState.modRevision)}</span
            >
            <span class="badge outline"><Icon name="layers" size={12} />{t('etcd.version', keyState.version)}</span>
            <span class="fact">{t('redis.bytes', keyState.size)}</span>
          {/if}
          {#if keyState.readOnly}
            <span class="badge outline"><Icon name="lock" size={12} />{t('redis.readOnly')}</span>
          {/if}
          <span class="fact"><Icon name="server" size={12} />{keyState.connectionName}</span>
        </p>
      </div>
      <div class="toolbar">
        <IconButton
          icon="copy"
          label={t('etcd.copyKey')}
          disabled={busy}
          onclick={() => {
            const text = keyState?.key.text ?? '';
            void run(() => rpc.request('copyText', { text }));
          }}
        />
        <IconButton
          icon="refresh"
          label={t('redis.refresh')}
          disabled={busy}
          onclick={() => void run(() => rpc.request('refresh', {}))}
        />
        {#if keyState.exists && !keyState.readOnly}
          <IconButton
            icon="trash"
            label={t('redis.deleteKey')}
            disabled={busy}
            onclick={() => void run(() => rpc.request('deleteKey', {}))}
          />
        {/if}
      </div>
    </header>

    {#if error !== undefined}
      <div class="notice error problem" role="alert" data-testid="error"><Icon name="error" /><span class="message">{error}</span></div>
    {/if}

    {#if stale}
      <div class="notice warning problem" role="status" data-testid="stale">
        <Icon name="warning" /><span class="message">{t('etcd.staleDraft', keyState.modRevision)}</span>
      </div>
    {/if}

    {#if keyState.conflict === true}
      <div class="notice warning problem" role="alert" data-testid="conflict">
        <Icon name="warning" />
        <span class="message">{t('etcd.conflict', keyState.modRevision)}</span>
        <span class="conflict-actions">
          <button
            type="button"
            class="button secondary"
            disabled={busy}
            onclick={() => void run(() => rpc.request('refresh', {}))}>{t('etcd.loadServer')}</button
          >
          {#if !keyState.readOnly}
            <button type="button" class="button" disabled={busy} onclick={() => { save(true); }}
              >{t('etcd.overwrite')}</button
            >
          {/if}
        </span>
      </div>
    {/if}

    <div class="keybar" data-testid="watchbar">
      <span class="group-icon" title={t('etcd.watch')}><Icon name="broadcast" /></span>
      <button
        type="button"
        class="button secondary"
        class:active={keyState.watching === true}
        aria-pressed={keyState.watching === true}
        title={t('etcd.watchHint')}
        disabled={busy}
        onclick={() =>
          void run(() =>
            rpc.request('watch', { on: keyState?.watching !== true, prefix: watchPrefix }),
          )}
        ><Icon name={keyState.watching === true ? 'debug-stop' : 'broadcast'} />{keyState.watching === true
          ? t('etcd.watchStop')
          : t('etcd.watch')}</button
      >
      <label class="check">
        <input
          type="checkbox"
          checked={keyState.watching === true ? keyState.watchPrefix === true : watchPrefix}
          disabled={keyState.watching === true}
          onchange={(event) => {
            watchPrefix = event.currentTarget.checked;
          }}
        />{t('etcd.watchPrefix')}
      </label>
      {#if keyState.watching === true}
        <span class="fact" data-testid="watch-note"
          >{changes.length === 0 ? t('etcd.watchWaiting') : t('etcd.watchOn')}</span
        >
      {/if}
    </div>

    {#if keyState.watchNotice !== undefined}
      <div class="notice warning problem" role="status" data-testid="watch-notice">
        <Icon name="warning" /><span class="message">{keyState.watchNotice}</span>
      </div>
    {/if}

    {#if !keyState.exists}
      <div class="empty">
        <span class="empty-icon"><Icon name="circle-slash" size={24} /></span>
        <p class="empty-title" data-testid="gone">{t('etcd.gone')}</p>
        <div class="empty-actions">
          <button type="button" class="button secondary" disabled={busy} onclick={() => void run(() => rpc.request('refresh', {}))}
            ><Icon name="refresh" />{t('redis.refresh')}</button
          >
          {#if !keyState.readOnly}
            <button
              type="button"
              class="button"
              disabled={busy}
              onclick={() =>
                void run(() => rpc.request('save', { value: draft ?? { text: '' }, modRevision: '0' }))}
              ><Icon name="add" />{t('etcd.create')}</button
            >
          {/if}
        </div>
      </div>
    {:else}
      <div class="keybar" data-testid="lease">
        <span class="group-icon" title={t('etcd.lease')}><Icon name="watch" /></span>
        {#if keyState.lease !== null && tone !== undefined && left !== undefined}
          <span class="badge lease {tone}" data-testid="lease-badge" title={t('etcd.leaseId', keyState.lease.id)}>
            {#if left <= 0}{t('etcd.leaseEnded')}{:else}{t('etcd.leaseLeft', clock(left))}{/if}
          </span>
          <span class="fact mono">{keyState.lease.id}</span>
          {#if !keyState.readOnly}
            {#if left > 0 || keyState.keepingAlive === true}
              <button
                type="button"
                class="button secondary"
                class:active={keyState.keepingAlive === true}
                aria-pressed={keyState.keepingAlive === true}
                title={t('etcd.keepAliveHint')}
                disabled={busy}
                onclick={() =>
                  void run(() => rpc.request('keepAlive', { on: keyState?.keepingAlive !== true }))}
                ><Icon name="sync" spin={keyState.keepingAlive === true} />{t('etcd.keepAlive')}</button
              >
            {/if}
            <button
              type="button"
              class="button secondary"
              disabled={busy}
              onclick={() => void run(() => rpc.request('detachLease', {}))}>{t('etcd.detach')}</button
            >
            <button
              type="button"
              class="button secondary"
              disabled={busy}
              onclick={() => void run(() => rpc.request('revokeLease', {}))}>{t('etcd.revoke')}</button
            >
          {/if}
        {:else}
          <span class="fact">{t('etcd.noLease')}</span>
          {#if !keyState.readOnly}
            <span class="toolbar-separator"></span>
            <input
              class="control ttl-input"
              bind:value={ttlText}
              placeholder={t('redis.seconds')}
              aria-label={t('etcd.attachNew')}
              inputmode="numeric"
              onkeydown={(event) => {
                const ttl = parseSeconds(ttlText);
                if (event.key === 'Enter' && ttl !== undefined) {
                  void run(() => rpc.request('attachLease', { ttl }), () => {
                    ttlText = '';
                  });
                }
              }}
            />
            <button
              type="button"
              class="button secondary"
              disabled={busy || parseSeconds(ttlText) === undefined}
              onclick={() => {
                const ttl = parseSeconds(ttlText);
                if (ttl !== undefined) {
                  void run(() => rpc.request('attachLease', { ttl }), () => {
                    ttlText = '';
                  });
                }
              }}>{t('etcd.attachNew')}</button
            >
            <span class="toolbar-separator"></span>
            <input
              class="control id-input mono"
              bind:value={leaseText}
              placeholder={t('etcd.leaseIdHint')}
              aria-label={t('etcd.attachExisting')}
              spellcheck="false"
              onkeydown={(event) => {
                const id = parseLeaseId(leaseText);
                if (event.key === 'Enter' && id !== undefined) {
                  void run(() => rpc.request('attachLease', { id }), () => {
                    leaseText = '';
                  });
                }
              }}
            />
            <button
              type="button"
              class="button secondary"
              disabled={busy || parseLeaseId(leaseText) === undefined}
              onclick={() => {
                const id = parseLeaseId(leaseText);
                if (id !== undefined) {
                  void run(() => rpc.request('attachLease', { id }), () => {
                    leaseText = '';
                  });
                }
              }}>{t('etcd.attachExisting')}</button
            >
          {/if}
        {/if}
      </div>

      {#if keyState.value !== undefined}
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
                draft = value;
              }}
            />
          {/key}
        </div>
        {#if !keyState.readOnly && keyState.value.truncated !== true}
          <footer class="actions">
            <button
              type="button"
              class="button"
              disabled={busy || draft === undefined}
              onclick={() => {
                save(false);
              }}><Icon name="save" />{t('redis.save')}</button
            >
          </footer>
        {/if}
      {/if}
    {/if}

    {#if changes.length > 0}
      <section class="changes" data-testid="changes">
        <header class="changes-head">
          <span>{t('etcd.changes')} · {changes.length}</span>
          <button
            type="button"
            class="button secondary"
            disabled={busy}
            onclick={() => void run(() => rpc.request('clearEvents', {}))}>{t('etcd.changesClear')}</button
          >
        </header>
        <ul>
          {#each changes as change (`${change.at}:${change.revision}:${change.key}`)}
            <li class="change {change.type}">
              <span class="badge outline">{change.type === 'put' ? t('etcd.change.put') : t('etcd.change.delete')}</span>
              <span class="fact mono">{clockTime(change.at)}</span>
              <span class="fact">{t('etcd.revision', change.revision)}</span>
              {#if keyState.watchPrefix === true || change.key !== keyState.key.text}
                <span class="mono key" title={change.key}>{change.key}</span>
              {/if}
              {#if change.type === 'put'}
                <span class="mono preview" title={change.preview}>{change.preview}</span>
                <span class="fact">{t('redis.bytes', change.size)}</span>
              {/if}
            </li>
          {/each}
        </ul>
      </section>
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
    color: #fff;
    background: linear-gradient(135deg, #58a6ff, #2563eb);
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

  .problem {
    flex: none;
    margin: var(--dn-gap-m) var(--dn-gap-l) 0;
  }

  .message {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .conflict-actions {
    display: inline-flex;
    gap: var(--dn-gap-s);
    margin-left: auto;
  }

  /* The lease: how long the key has to live, and the forms to change that. */
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

  .keybar .control,
  .keybar .button {
    min-height: 24px;
    padding-top: 2px;
    padding-bottom: 2px;
  }

  .group-icon {
    display: inline-flex;
    color: var(--dn-muted);
  }

  .ttl-input {
    width: 96px;
  }

  .id-input {
    width: 180px;
  }

  .button.active {
    color: var(--vscode-charts-green);
    border-color: var(--vscode-charts-green);
  }

  .lease.ok {
    color: var(--dn-success, var(--vscode-charts-green));
    border-color: currentColor;
  }

  .lease.soon {
    color: var(--dn-warning);
    border-color: currentColor;
  }

  .lease.ended {
    color: var(--dn-danger);
    border-color: currentColor;
  }

  .check {
    display: inline-flex;
    gap: 4px;
    align-items: center;
    color: var(--dn-muted);
    font-size: var(--dn-font-small);
  }

  /* What the watch saw: the newest change on top, under the value. */
  .changes {
    flex: none;
    max-height: 32vh;
    overflow: auto;
    border-top: 1px solid var(--dn-divider);
  }

  .changes-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--dn-gap-s) var(--dn-gap-l);
    color: var(--dn-muted);
    font-size: var(--dn-font-small);
    background: var(--vscode-sideBar-background, var(--dn-surface));
  }

  .changes ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .change {
    display: flex;
    flex-wrap: wrap;
    gap: var(--dn-gap-s) var(--dn-gap-m);
    align-items: center;
    padding: 3px var(--dn-gap-l);
    border-top: 1px solid var(--dn-divider);
    font-size: var(--dn-font-small);
  }

  .change.put .badge {
    color: var(--vscode-charts-green);
  }

  .change.delete .badge {
    color: var(--dn-danger);
  }

  .change .key {
    max-width: 30ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .change .preview {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    color: var(--dn-muted);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* The value fills the page; its Save button is pinned below. */
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

  /* Waiting and gone: centred. */
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

  .empty-actions {
    display: flex;
    gap: var(--dn-gap-s);
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

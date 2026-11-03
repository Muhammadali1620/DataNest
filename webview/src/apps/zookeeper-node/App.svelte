<script lang="ts">
  import { onMount } from 'svelte';
  import type {
    ZnodeAclEntry,
    ZookeeperNodeProtocol,
    ZookeeperNodeState,
  } from '../../../../src/shared/protocols/zookeeper-node';
  import type { RedisValue } from '../../../../src/shared/redis-value';
  import type { RpcPeer } from '../../../../src/shared/rpc';
  import { hexId, permissionLetters } from '../../../../src/shared/zk-path';
  import DbMark from '../../components/DbMark.svelte';
  import Icon from '../../components/Icon.svelte';
  import IconButton from '../../components/IconButton.svelte';
  import type { Translate } from '../../lib/i18n';
  import ValueEditor from '../redis-key/ValueEditor.svelte';
  import AclEditor from './AclEditor.svelte';
  import { aclText, clockTime, KIND_TONE, timeText } from './node-view';

  interface Props {
    rpc: RpcPeer<ZookeeperNodeProtocol['webview'], ZookeeperNodeProtocol['host']>;
    t: Translate;
  }

  const { rpc, t }: Props = $props();

  let nodeState = $state<ZookeeperNodeState | undefined>(undefined);
  let busy = $state(false);
  let error = $state<string | undefined>(undefined);
  /** What the user typed in the value box; undefined while it is as the server has it. */
  let draft = $state<RedisValue | undefined>(undefined);
  /** The ACL editor is open (V13.27). */
  let editingAcl = $state(false);
  let childName = $state('');
  let childMode = $state<'persistent' | 'sequential' | 'container'>('persistent');
  /** Bumped when the server's value should replace what the box shows. */
  let version = $state(0);
  /** The version of the data the value box was filled at: a save is checked against it. */
  let readVersion = $state(0);

  /** The znode moved on while the user was typing: the text stays, the save will ask. */
  const stale = $derived(
    draft !== undefined && nodeState !== undefined && nodeState.version !== readVersion,
  );
  /** The changes the watch saw, newest first. */
  const changes = $derived([...(nodeState?.events ?? [])].reverse());

  /** What the last "give it to everything below" did, in one paragraph. */
  function aclTreeText(report: NonNullable<ZookeeperNodeState['aclTree']>): string {
    return [
      t('zk.aclTreeDone', report.changed),
      report.capped ? t('zk.aclTreeCapped') : undefined,
      report.failed > 0 ? t('zk.aclTreeFailed', report.failed) : undefined,
      report.failed > 0 ? report.failures.join('; ') : undefined,
    ]
      .filter((part): part is string => part !== undefined)
      .join(' ');
  }

  const kindLabel = $derived(
    nodeState === undefined
      ? ''
      : nodeState.kind === 'ephemeral'
        ? t('zk.kind.ephemeral')
        : nodeState.kind === 'container'
          ? t('zk.kind.container')
          : nodeState.kind === 'ttl'
            ? t('zk.kind.ttl')
            : t('zk.kind.persistent'),
  );

  onMount(() => {
    const subscription = rpc.on('state', (next) => {
      nodeState = next;
      // A fresh read closes the editor: a refused change shows the ACL as it is now.
      editingAcl = false;
      // A refused save keeps the user's text in the box: only a fresh read replaces it.
      // A change seen by the watch does not erase what the user is typing either.
      const keepDraft = next.conflict === true || (next.watching === true && draft !== undefined);
      if (!keepDraft) {
        version += 1;
        draft = undefined;
        readVersion = next.version;
      }
    });
    rpc.emit('ready', {});
    return () => {
      subscription.dispose();
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
    const state = nodeState;
    const value = draft ?? state?.value;
    if (state === undefined || value === undefined) {
      return;
    }
    void run(() =>
      rpc.request('save', {
        value,
        version: overwrite ? state.version : readVersion,
        ...(overwrite ? { overwrite: true } : {}),
      }),
    );
  }

  function saveAcl(acl: ZnodeAclEntry[], recursive: boolean): void {
    const state = nodeState;
    if (state === undefined) {
      return;
    }
    void run(() =>
      rpc.request('saveAcl', {
        acl,
        aversion: state.aversion,
        ...(recursive ? { recursive: true } : {}),
      }),
    );
  }

  function addChild(): void {
    const name = childName.trim();
    if (name === '') {
      return;
    }
    void run(
      () => rpc.request('createChild', { name, mode: childMode }),
      () => {
        childName = '';
      },
    );
  }
</script>

<main>
  {#if busy}
    <div class="progress-bar" aria-hidden="true"></div>
  {/if}
  {#if nodeState === undefined}
    <div class="empty">
      <span class="empty-icon"><Icon name="loading" spin size={24} /></span>
      <p class="empty-title">{t('redis.loading')}</p>
    </div>
  {:else}
    <header class="top">
      <span class="top-icon tile plain compact"><DbMark driver="zookeeper" size={26} /></span>
      <div class="top-text">
        <h1 title={nodeState.path}>{nodeState.path}</h1>
        <p class="meta" data-testid="meta">
          {#if nodeState.exists && nodeState.denied !== true}
            <span class="badge kind {KIND_TONE[nodeState.kind]}" data-testid="kind">{kindLabel}</span>
            <span class="badge outline"><Icon name="layers" size={12} />{t('zk.version', nodeState.version)}</span>
            <span class="fact">{t('redis.bytes', nodeState.size)}</span>
          {/if}
          {#if nodeState.readOnly}
            <span class="badge outline"><Icon name="lock" size={12} />{t('redis.readOnly')}</span>
          {/if}
          <span class="fact"><Icon name="server" size={12} />{nodeState.connectionName}</span>
        </p>
      </div>
      <div class="toolbar">
        <IconButton
          icon="copy"
          label={t('zk.copyPath')}
          disabled={busy}
          onclick={() => {
            const text = nodeState?.path ?? '';
            void run(() => rpc.request('copyText', { text }));
          }}
        />
        <IconButton
          icon="refresh"
          label={t('redis.refresh')}
          disabled={busy}
          onclick={() => void run(() => rpc.request('refresh', {}))}
        />
        {#if nodeState.exists && !nodeState.readOnly && nodeState.path !== '/'}
          <IconButton
            icon="trash"
            label={t('zk.deleteNode')}
            disabled={busy}
            onclick={() => void run(() => rpc.request('deleteNode', {}))}
          />
        {/if}
      </div>
    </header>

    {#if error !== undefined}
      <div class="notice error problem" role="alert" data-testid="error"><Icon name="error" /><span class="message">{error}</span></div>
    {/if}

    {#if stale}
      <div class="notice warning problem" role="status" data-testid="stale">
        <Icon name="warning" /><span class="message">{t('zk.staleDraft', nodeState.version)}</span>
      </div>
    {/if}

    {#if nodeState.conflict === true}
      <div class="notice warning problem" role="alert" data-testid="conflict">
        <Icon name="warning" />
        <span class="message">{t('zk.conflict', nodeState.version)}</span>
        <span class="conflict-actions">
          <button
            type="button"
            class="button secondary"
            disabled={busy}
            onclick={() => void run(() => rpc.request('refresh', {}))}>{t('zk.loadServer')}</button
          >
          {#if !nodeState.readOnly}
            <button type="button" class="button" disabled={busy} onclick={() => { save(true); }}
              >{t('zk.overwrite')}</button
            >
          {/if}
        </span>
      </div>
    {/if}

    {#if nodeState.aclTree !== undefined}
      <div
        class="notice {nodeState.aclTree.failed > 0 ? 'warning' : 'info'} problem"
        role="status"
        data-testid="acl-tree"
      >
        <Icon name={nodeState.aclTree.failed > 0 ? 'warning' : 'check'} />
        <span class="message">{aclTreeText(nodeState.aclTree)}</span>
      </div>
    {/if}

    {#if nodeState.aclConflict === true}
      <div class="notice warning problem" role="alert" data-testid="acl-conflict">
        <Icon name="warning" />
        <span class="message">{t('zk.aclConflict', nodeState.aversion)}</span>
      </div>
    {/if}

    <div class="watchbar" data-testid="watchbar">
      <span class="group-icon" title={t('zk.watch')}><Icon name="broadcast" /></span>
      <button
        type="button"
        class="button secondary"
        class:active={nodeState.watching === true}
        aria-pressed={nodeState.watching === true}
        title={t('zk.watchHint')}
        disabled={busy}
        onclick={() => void run(() => rpc.request('watch', { on: nodeState?.watching !== true }))}
        ><Icon name={nodeState.watching === true ? 'debug-stop' : 'broadcast'} />{nodeState.watching === true
          ? t('zk.watchStop')
          : t('zk.watch')}</button
      >
      {#if nodeState.watching === true}
        <span class="fact" data-testid="watch-note"
          >{changes.length === 0 ? t('zk.watchWaiting') : t('zk.watchOn')}</span
        >
      {/if}
    </div>

    {#if nodeState.watchNotice !== undefined}
      <div class="notice warning problem" role="status" data-testid="watch-notice">
        <Icon name="warning" /><span class="message">{nodeState.watchNotice}</span>
      </div>
    {/if}

    {#if !nodeState.exists}
      <div class="empty">
        <span class="empty-icon"><Icon name="circle-slash" size={24} /></span>
        <p class="empty-title" data-testid="gone">{t('zk.gone')}</p>
        <div class="empty-actions">
          <button type="button" class="button secondary" disabled={busy} onclick={() => void run(() => rpc.request('refresh', {}))}
            ><Icon name="refresh" />{t('redis.refresh')}</button
          >
          {#if !nodeState.readOnly}
            <button
              type="button"
              class="button"
              disabled={busy}
              onclick={() =>
                void run(() => rpc.request('save', { value: draft ?? { text: '' }, version: 0 }))}
              ><Icon name="add" />{t('zk.create')}</button
            >
          {/if}
        </div>
      </div>
    {:else}
      <div class="body">
        {#if nodeState.denied !== true}
        <section class="side" aria-label={t('zk.stat')}>
          <h2><Icon name="info" size={14} />{t('zk.stat')}</h2>
          <dl class="stat" data-testid="stat">
            <dt>czxid</dt><dd class="mono">{hexId(nodeState.czxid)}</dd>
            <dt>mzxid</dt><dd class="mono">{hexId(nodeState.mzxid)}</dd>
            <dt>pzxid</dt><dd class="mono">{hexId(nodeState.pzxid)}</dd>
            <dt>{t('zk.created')}</dt><dd>{timeText(nodeState.ctime)}</dd>
            <dt>{t('zk.modified')}</dt><dd>{timeText(nodeState.mtime)}</dd>
            <dt>version</dt><dd class="mono">{nodeState.version}</dd>
            <dt>cversion</dt><dd class="mono">{nodeState.cversion}</dd>
            <dt>aversion</dt><dd class="mono">{nodeState.aversion}</dd>
            {#if nodeState.kind === 'ephemeral'}
              <dt>{t('zk.owner')}</dt><dd class="mono">{hexId(nodeState.ephemeralOwner)}</dd>
            {/if}
          </dl>

          <h2>
            <Icon name="shield" size={14} />{t('zk.acl')}
            {#if !nodeState.readOnly && !editingAcl && nodeState.acl.length > 0}
              <IconButton
                icon="edit"
                label={t('zk.aclEdit')}
                disabled={busy}
                onclick={() => {
                  editingAcl = true;
                }}
              />
            {/if}
          </h2>
          {#if editingAcl}
            {#key nodeState.aversion}
              <AclEditor
                acl={nodeState.acl}
                below={nodeState.numChildren}
                {busy}
                {t}
                onsave={saveAcl}
                oncancel={() => {
                  editingAcl = false;
                }}
              />
            {/key}
          {:else if nodeState.acl.length === 0}
            <p class="hint" data-testid="acl-empty">{t('zk.aclEmpty')}</p>
          {:else}
            <ul class="acl" data-testid="acl">
              {#each nodeState.acl as entry, index (index)}
                <li><span class="mono perms">{permissionLetters(entry.perms)}</span><span class="mono">{aclText(entry)}</span></li>
              {/each}
            </ul>
          {/if}

          <h2><Icon name="folder" size={14} />{t('zk.children', nodeState.numChildren)}</h2>
          {#if nodeState.children.length === 0}
            <p class="hint">{t('zk.noChildren')}</p>
          {:else}
            <ul class="children" data-testid="children">
              {#each nodeState.children as name (name)}
                <li>
                  <button
                    type="button"
                    class="link"
                    disabled={busy}
                    title={t('zk.openChild', name)}
                    onclick={() => void run(() => rpc.request('openChild', { name }))}>{name}</button
                  >
                </li>
              {/each}
            </ul>
            {#if nodeState.moreChildren}
              <p class="hint">{t('zk.moreChildren', nodeState.children.length)}</p>
            {/if}
          {/if}
          {#if !nodeState.readOnly && nodeState.kind !== 'ephemeral'}
            <div class="add" data-testid="add-child">
              <input
                class="control"
                bind:value={childName}
                placeholder={t('zk.childName')}
                aria-label={t('zk.newChild')}
                spellcheck="false"
                onkeydown={(event) => {
                  if (event.key === 'Enter') {
                    addChild();
                  }
                }}
              />
              <select class="control" bind:value={childMode} aria-label={t('zk.mode')}>
                <option value="persistent">{t('zk.mode.persistent')}</option>
                <option value="sequential">{t('zk.mode.sequential')}</option>
                <option value="container">{t('zk.mode.container')}</option>
              </select>
              <button
                type="button"
                class="button secondary"
                disabled={busy || childName.trim() === ''}
                onclick={addChild}><Icon name="add" />{t('zk.add')}</button
              >
            </div>
          {/if}
        </section>
        {/if}

        <section class="data">
          {#if nodeState.denied === true}
            <div class="notice warning problem" data-testid="denied">
              <Icon name="lock" /><span class="message">{t('zk.denied')}</span>
            </div>
          {:else if nodeState.value !== undefined}
            <div class="string">
              {#key version}
                <ValueEditor
                  value={nodeState.value}
                  label={t('redis.value')}
                  rows={12}
                  grow
                  readonly={nodeState.readOnly}
                  {t}
                  onchange={(value: RedisValue | undefined) => {
                    draft = value;
                  }}
                />
              {/key}
            </div>
            {#if !nodeState.readOnly && nodeState.value.truncated !== true}
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
        </section>
      </div>
    {/if}

    {#if changes.length > 0}
      <section class="changes" data-testid="changes">
        <header class="changes-head">
          <span>{t('zk.changes')} · {changes.length}</span>
          <button
            type="button"
            class="button secondary"
            disabled={busy}
            onclick={() => void run(() => rpc.request('clearEvents', {}))}>{t('zk.changesClear')}</button
          >
        </header>
        <ul>
          {#each changes as change, index (`${change.at}:${change.kind}:${index}`)}
            <li class="change kind-{change.kind}">
              <span class="badge outline">{t(`zk.change.${change.kind}`)}</span>
              <span class="fact mono">{clockTime(change.at)}</span>
              {#if change.kind !== 'deleted'}
                <span class="fact">{t('zk.version', change.version)}</span>
                <span class="fact">{t('redis.bytes', change.size)}</span>
                <span class="fact">{t('zk.children', change.children)}</span>
              {/if}
            </li>
          {/each}
        </ul>
      </section>
    {/if}
  {/if}
</main>

<style>
  /* Watching: the switch, and what the page is doing about it. */
  .watchbar {
    display: flex;
    flex: none;
    flex-wrap: wrap;
    gap: var(--dn-gap) var(--dn-gap-s);
    align-items: center;
    padding: var(--dn-gap) var(--dn-gap-l);
    background: var(--vscode-sideBar-background, var(--dn-surface));
    border-bottom: 1px solid var(--dn-divider);
  }

  .watchbar .button {
    min-height: 24px;
    padding-top: 2px;
    padding-bottom: 2px;
  }

  .group-icon {
    display: inline-flex;
    color: var(--dn-muted);
  }

  .button.active {
    color: var(--dn-success);
    border-color: var(--vscode-charts-green);
  }

  /* What the watch saw: the newest change on top, under the znode. */
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

  .change.kind-created .badge,
  .change.kind-data .badge {
    color: var(--dn-success);
    background: transparent;
    border-color: currentColor;
  }

  .change.kind-children .badge {
    color: var(--dn-info);
    background: transparent;
    border-color: currentColor;
  }

  .change.kind-deleted .badge {
    color: var(--dn-danger);
    background: transparent;
    border-color: currentColor;
  }

  main {
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100vh;
  }

  .mono {
    font-family: var(--dn-mono);
  }

  /* The znode, what it is, and what can be done to it as a whole. */
  .top {
    display: flex;
    flex: none;
    flex-wrap: wrap;
    gap: var(--dn-gap) var(--dn-gap-m);
    align-items: center;
    padding: var(--dn-gap-m) var(--dn-gap-l);
    border-bottom: 1px solid var(--dn-divider);
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

  .kind.ephemeral,
  .kind.ttl {
    color: var(--dn-warning);
    background: transparent;
    border-color: currentColor;
  }

  .kind.container {
    color: var(--dn-purple);
    background: transparent;
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

  .conflict-actions {
    display: inline-flex;
    gap: var(--dn-gap-s);
    margin-left: auto;
  }

  /* The stat, ACL and children on the left; the data fills the rest. */
  .body {
    display: flex;
    flex: 1;
    min-height: 0;
  }

  .side {
    flex: none;
    width: 280px;
    padding: var(--dn-gap-m) var(--dn-gap-l);
    overflow: auto;
    background: var(--vscode-sideBar-background, var(--dn-surface));
    border-right: 1px solid var(--dn-divider);
  }

  .side h2 {
    display: flex;
    gap: 6px;
    align-items: center;
    margin: var(--dn-gap-m) 0 var(--dn-gap-s);
    color: var(--dn-muted);
    font-size: var(--dn-font-small);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .side h2:first-child {
    margin-top: 0;
  }

  .stat {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 2px var(--dn-gap-m);
    margin: 0;
    font-size: var(--dn-font-small);
  }

  .stat dt {
    color: var(--dn-muted);
  }

  .stat dd {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .hint {
    margin: 0;
    color: var(--dn-muted);
    font-size: var(--dn-font-small);
  }

  .acl,
  .children {
    margin: 0;
    padding: 0;
    list-style: none;
    font-size: var(--dn-font-small);
  }

  .acl li {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0 var(--dn-gap);
    align-items: baseline;
    overflow-wrap: anywhere;
  }

  .perms {
    color: var(--dn-success);
  }

  .children {
    max-height: 220px;
    overflow: auto;
  }

  .link {
    padding: 1px 0;
    color: var(--vscode-textLink-foreground);
    font-family: var(--dn-mono);
    text-align: left;
    background: none;
    border: none;
    cursor: pointer;
  }

  .link:hover {
    text-decoration: underline;
  }

  .add {
    display: flex;
    flex-wrap: wrap;
    gap: var(--dn-gap-s);
    margin-top: var(--dn-gap);
  }

  .add .control {
    min-width: 0;
    min-height: 24px;
    padding-top: 2px;
    padding-bottom: 2px;
  }

  .add input.control {
    flex: 1;
  }

  .data {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }

  /* The data fills the page; its Save button is pinned below. */
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

  @media (max-width: 720px) {
    .body {
      flex-direction: column;
    }

    .side {
      width: auto;
      max-height: 40%;
      border-right: none;
      border-bottom: 1px solid var(--dn-divider);
    }
  }
</style>

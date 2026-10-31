<script lang="ts">
  import { onMount } from 'svelte';
  import type { RedisInfoProtocol, RedisInfoState } from '../../../../src/shared/protocols/redis-info';
  import type { RpcPeer } from '../../../../src/shared/rpc';
  import Icon from '../../components/Icon.svelte';
  import IconButton from '../../components/IconButton.svelte';
  import type { Translate } from '../../lib/i18n';
  import { formatBytes } from '../redis-key/key-view';
  import { filterSections, formatPercent, formatUptime, shareOf } from './info-view';

  interface Props {
    rpc: RpcPeer<RedisInfoProtocol['webview'], RedisInfoProtocol['host']>;
    t: Translate;
  }

  const { rpc, t }: Props = $props();

  /** How often the page reads again while "Auto" is on. */
  const AUTO_MS = 5000;

  let infoState = $state<RedisInfoState | undefined>(undefined);
  let chosen = $state(0);
  let filter = $state('');
  let auto = $state(false);
  // Read by the timer, which Svelte's analysis does not see as a reader.
  const isAuto = (): boolean => auto;
  let busy = $state(false);
  let error = $state<string | undefined>(undefined);

  const node = $derived(infoState?.nodes[chosen] ?? infoState?.nodes[0]);
  const sections = $derived(node === undefined ? [] : filterSections(node, filter));
  const memoryShare = $derived(shareOf(node?.summary.usedMemory, node?.summary.maxMemory));

  async function refresh(): Promise<void> {
    if (busy) {
      return;
    }
    busy = true;
    try {
      await rpc.request('refresh', {});
      error = undefined;
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    } finally {
      busy = false;
    }
  }

  onMount(() => {
    const subscription = rpc.on('state', (next) => {
      infoState = next;
    });
    const timer = setInterval(() => {
      if (isAuto()) {
        void refresh();
      }
    }, AUTO_MS);
    rpc.emit('ready', {});
    return () => {
      subscription.dispose();
      clearInterval(timer);
    };
  });
</script>

<main>
  {#if busy}
    <div class="progress-bar" aria-hidden="true"></div>
  {/if}
  {#if infoState === undefined || node === undefined}
    <div class="empty">
      <span class="empty-icon"><Icon name="loading" spin size={24} /></span>
      <p class="empty-title">{t('info.loading')}</p>
    </div>
  {:else}
    <header class="top">
      <span class="top-icon"><Icon name="server" size={18} /></span>
      <div class="top-text">
        <h1>{infoState.connectionName}</h1>
        <p class="subtitle" data-testid="at">{t('info.at', new Date(infoState.at).toLocaleTimeString())}</p>
      </div>
      <div class="toolbar">
        <IconButton
          icon="sync"
          label={t('info.auto')}
          text={t('info.auto')}
          pressed={auto}
          onclick={() => {
            auto = !auto;
          }}
        />
        <IconButton icon="refresh" label={t('redis.refresh')} disabled={busy} onclick={() => void refresh()} />
      </div>
    </header>

    {#if infoState.nodes.length > 1}
      <div class="tabs" role="tablist">
        {#each infoState.nodes as one, index (one.name)}
          <button
            type="button"
            role="tab"
            class="tab"
            aria-selected={index === chosen}
            class:active={index === chosen}
            onclick={() => {
              chosen = index;
            }}><Icon name="server-process" />{one.name}</button
          >
        {/each}
      </div>
    {/if}

    <div class="content">
      {#if error !== undefined}
        <div class="notice error" role="alert"><Icon name="error" /><span class="message">{error}</span></div>
      {/if}

      <section class="stats" data-testid="cards">
        <div class="stat">
          <span class="label"><Icon name="tag" size={14} />{t('info.version')}</span><span class="value">{node.summary.version ?? '—'}</span>
        </div>
        <div class="stat">
          <span class="label"><Icon name="type-hierarchy" size={14} />{t('info.mode')}</span><span class="value"
            >{[node.summary.mode, node.summary.role].filter((part) => part !== undefined).join(' · ') || '—'}</span
          >
        </div>
        <div class="stat">
          <span class="label"><Icon name="history" size={14} />{t('info.uptime')}</span><span class="value"
            >{node.summary.uptimeSeconds === undefined ? '—' : formatUptime(node.summary.uptimeSeconds)}</span
          >
        </div>
        <div class="stat">
          <span class="label"><Icon name="person" size={14} />{t('info.clients')}</span><span class="value">{node.summary.clients ?? '—'}</span>
        </div>
        <div class="stat">
          <span class="label"><Icon name="dashboard" size={14} />{t('info.memory')}</span>
          <span class="value">
            {node.summary.usedMemory === undefined ? '—' : formatBytes(node.summary.usedMemory)}
            {#if node.summary.maxMemory !== undefined && node.summary.maxMemory > 0}
              <span class="of">/ {formatBytes(node.summary.maxMemory)}</span>
            {/if}
          </span>
          {#if memoryShare !== undefined}
            <span class="meter" class:high={memoryShare >= 0.9}><span style="width: {memoryShare * 100}%"></span></span>
          {/if}
        </div>
        <div class="stat">
          <span class="label"><Icon name="pulse" size={14} />{t('info.ops')}</span><span class="value">{node.summary.opsPerSecond ?? '—'}</span>
        </div>
        <div class="stat">
          <span class="label"><Icon name="target" size={14} />{t('info.hits')}</span><span class="value"
            >{node.summary.hitRate === undefined ? '—' : formatPercent(node.summary.hitRate)}</span
          >
          {#if node.summary.hitRate !== undefined}
            <span class="meter"><span style="width: {(shareOf(node.summary.hitRate, 1) ?? 0) * 100}%"></span></span>
          {/if}
        </div>
        <div class="stat">
          <span class="label"><Icon name="key" size={14} />{t('info.keys')}</span><span class="value">{node.summary.keys.toLocaleString()}</span>
        </div>
      </section>

      <div class="find">
        <span class="find-icon"><Icon name="search" size={14} /></span>
        <input
          class="control find-input"
          type="search"
          bind:value={filter}
          placeholder={t('info.filter')}
          aria-label={t('info.filter')}
          spellcheck="false"
        />
      </div>

      {#if sections.length === 0}
        <div class="empty">
          <span class="empty-icon"><Icon name="search" size={24} /></span>
          <p class="empty-title">{t('info.nothing')}</p>
        </div>
      {:else}
        <div class="sections">
          {#each sections as section (section.name)}
            <section class="card section">
              <header class="section-head">
                <h2>{section.name}</h2>
                <span class="count">{section.fields.length}</span>
              </header>
              <table>
                <tbody>
                  {#each section.fields as field (field[0])}
                    <tr><th scope="row">{field[0]}</th><td>{field[1]}</td></tr>
                  {/each}
                </tbody>
              </table>
            </section>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</main>

<style>
  main {
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100vh;
  }

  /* The server, when it was read, and how it is read again. */
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
    overflow-wrap: anywhere;
  }

  .subtitle {
    margin: 2px 0 0;
    color: var(--dn-muted);
    font-size: var(--dn-font-small);
  }

  /* One tab per server of a cluster, drawn like the editor's panel titles. */
  .tabs {
    display: flex;
    flex: none;
    gap: 2px;
    height: 32px;
    padding: 0 var(--dn-gap);
    overflow-x: auto;
    overflow-y: hidden;
    border-bottom: 1px solid var(--dn-divider);
    scrollbar-width: thin;
  }

  .tab {
    display: inline-flex;
    flex: none;
    gap: 6px;
    align-items: center;
    margin-bottom: -1px;
    padding: 0 10px;
    color: var(--vscode-panelTitle-inactiveForeground, var(--dn-muted));
    background: transparent;
    border: none;
    border-bottom: 1px solid transparent;
    font-family: inherit;
    font-size: inherit;
    white-space: nowrap;
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

  .content {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--dn-gap-m);
    min-height: 0;
    padding: var(--dn-gap-m) var(--dn-gap-l) var(--dn-gap-l);
    overflow-y: auto;
  }

  .message {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  /* The main numbers, each in a tile. */
  .stats {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: var(--dn-gap);
  }

  @media (min-width: 720px) {
    .stats {
      grid-template-columns: repeat(4, minmax(0, 1fr));
    }
  }

  .stat {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
    padding: 10px 12px;
    background: var(--dn-surface);
    border: 1px solid var(--dn-border);
    border-radius: var(--dn-radius-l);
  }

  .label {
    display: flex;
    gap: 6px;
    align-items: center;
    color: var(--dn-muted);
    font-size: var(--dn-font-small);
  }

  .value {
    overflow: hidden;
    font-size: 16px;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .of {
    color: var(--dn-muted);
    font-size: var(--dn-font-small);
    font-weight: normal;
  }

  /* A thin bar of how full: memory of its limit, hits of all reads. */
  .meter {
    height: 4px;
    margin-top: 2px;
    overflow: hidden;
    background: var(--vscode-scrollbarSlider-background, var(--dn-divider));
    border-radius: 2px;
  }

  .meter > span {
    display: block;
    height: 100%;
    background: var(--vscode-progressBar-background, var(--dn-accent));
    border-radius: 2px;
  }

  .meter.high > span {
    background: var(--dn-warning);
  }

  .find {
    position: relative;
    display: flex;
    align-items: center;
    max-width: 360px;
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
  }

  /* INFO sections: a card each, fields as name and value. */
  .sections {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
    gap: var(--dn-gap-m);
    align-items: start;
  }

  @media (max-width: 420px) {
    .sections {
      grid-template-columns: minmax(0, 1fr);
    }
  }

  .section {
    padding: 0;
    overflow: hidden;
  }

  .section-head {
    display: flex;
    gap: var(--dn-gap);
    align-items: baseline;
    padding: 8px 12px;
    border-bottom: 1px solid var(--dn-divider);
  }

  .count {
    color: var(--dn-muted);
    font-size: 11px;
    font-weight: normal;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-family: var(--dn-mono);
    font-size: var(--dn-font-small);
  }

  tr:nth-child(even) {
    background: var(--vscode-keybindingTable-rowsBackground, transparent);
  }

  th,
  td {
    padding: 3px 12px;
    text-align: left;
    vertical-align: top;
    line-height: 18px;
    word-break: break-all;
  }

  th {
    width: 45%;
    color: var(--dn-muted);
    font-weight: normal;
  }

  /* Waiting and nothing found: centred. */
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

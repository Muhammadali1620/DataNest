<script lang="ts">
  import { onMount } from 'svelte';
  import type { RedisInfoProtocol, RedisInfoState } from '../../../../src/shared/protocols/redis-info';
  import type { RpcPeer } from '../../../../src/shared/rpc';
  import type { Translate } from '../../lib/i18n';
  import { formatBytes } from '../redis-key/key-view';
  import { filterSections, formatPercent, formatUptime } from './info-view';

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
  {#if infoState === undefined || node === undefined}
    <p class="hint">{t('info.loading')}</p>
  {:else}
    <header class="bar">
      <h1>{infoState.connectionName}</h1>
      <span class="hint" data-testid="at">{t('info.at', new Date(infoState.at).toLocaleTimeString())}</span>
      <span class="grow"></span>
      <label class="check">
        <input type="checkbox" bind:checked={auto} />
        {t('info.auto')}
      </label>
      <button type="button" class="button secondary" disabled={busy} onclick={() => void refresh()}>
        {t('redis.refresh')}
      </button>
    </header>
    {#if error !== undefined}
      <p class="error" role="alert">{error}</p>
    {/if}
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
            }}>{one.name}</button
          >
        {/each}
      </div>
    {/if}

    <section class="cards" data-testid="cards">
      <div class="card"><span class="label">{t('info.version')}</span><span>{node.summary.version ?? '—'}</span></div>
      <div class="card">
        <span class="label">{t('info.mode')}</span><span>{[node.summary.mode, node.summary.role].filter((part) => part !== undefined).join(' · ') || '—'}</span>
      </div>
      <div class="card">
        <span class="label">{t('info.uptime')}</span><span>{node.summary.uptimeSeconds === undefined ? '—' : formatUptime(node.summary.uptimeSeconds)}</span>
      </div>
      <div class="card"><span class="label">{t('info.clients')}</span><span>{node.summary.clients ?? '—'}</span></div>
      <div class="card">
        <span class="label">{t('info.memory')}</span>
        <span>
          {node.summary.usedMemory === undefined ? '—' : formatBytes(node.summary.usedMemory)}
          {#if node.summary.maxMemory !== undefined && node.summary.maxMemory > 0}
            / {formatBytes(node.summary.maxMemory)}
          {/if}
        </span>
      </div>
      <div class="card"><span class="label">{t('info.ops')}</span><span>{node.summary.opsPerSecond ?? '—'}</span></div>
      <div class="card">
        <span class="label">{t('info.hits')}</span><span>{node.summary.hitRate === undefined ? '—' : formatPercent(node.summary.hitRate)}</span>
      </div>
      <div class="card"><span class="label">{t('info.keys')}</span><span>{node.summary.keys.toLocaleString()}</span></div>
    </section>

    <input class="control" bind:value={filter} placeholder={t('info.filter')} aria-label={t('info.filter')} />
    {#each sections as section (section.name)}
      <section class="section">
        <h2>{section.name}</h2>
        <table>
          <tbody>
            {#each section.fields as field (field[0])}
              <tr><th>{field[0]}</th><td>{field[1]}</td></tr>
            {/each}
          </tbody>
        </table>
      </section>
    {/each}
    {#if sections.length === 0}
      <p class="hint">{t('info.nothing')}</p>
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
  .bar {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  h1 {
    font-size: 1.3em;
    margin: 0;
  }
  h2 {
    font-size: 1.05em;
    margin: 8px 0 4px;
  }
  .grow {
    flex: 1;
  }
  .hint {
    color: var(--vscode-descriptionForeground);
  }
  .error {
    color: var(--vscode-errorForeground);
  }
  .tabs {
    display: flex;
    gap: 4px;
  }
  .tab {
    background: transparent;
    color: var(--vscode-foreground);
    border: 1px solid transparent;
    padding: 2px 8px;
    cursor: pointer;
  }
  .tab.active {
    border-bottom-color: var(--vscode-focusBorder);
  }
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
    gap: 8px;
  }
  .card {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px;
    border: 1px solid var(--vscode-panel-border, var(--vscode-focusBorder));
  }
  .label {
    color: var(--vscode-descriptionForeground);
    font-size: 0.9em;
  }
  table {
    border-collapse: collapse;
    width: 100%;
  }
  th,
  td {
    text-align: left;
    padding: 2px 8px;
    border-bottom: 1px solid var(--vscode-panel-border, transparent);
    font-family: var(--vscode-editor-font-family, monospace);
    word-break: break-all;
  }
  th {
    width: 40%;
    font-weight: normal;
    color: var(--vscode-descriptionForeground);
  }
</style>

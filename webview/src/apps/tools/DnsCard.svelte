<script lang="ts">
  import type { NetworkErrorCode, ToolsProtocol } from '../../../../src/shared/protocols/tools';
  import type { RpcPeer } from '../../../../src/shared/rpc';
  import {
    DNS_TYPES,
    DOH_HOSTS,
    DOH_PROVIDERS,
    type DnsType,
    type DohProvider,
  } from '../../../../src/shared/tools/doh';
  import { checkHost } from '../../../../src/shared/tools/validate';
  import Icon from '../../components/Icon.svelte';
  import type { Translate } from '../../lib/i18n';
  import Card from './Card.svelte';
  import { useToolsState } from './state';

  interface Props {
    rpc: RpcPeer<ToolsProtocol['webview'], ToolsProtocol['host']>;
    t: Translate;
  }

  const { rpc, t }: Props = $props();
  const remember = useToolsState();

  let host = $state(remember.get('net.dnsHost', 'localhost'));
  let mode = $state<'local' | 'doh'>(remember.get('net.dnsMode', 'local') === 'doh' ? 'doh' : 'local');
  let provider = $state<DohProvider>(
    DOH_PROVIDERS.find((item) => item === remember.get('net.dnsProvider', 'cloudflare')) ?? 'cloudflare',
  );
  let type = $state<DnsType>(DNS_TYPES.find((item) => item === remember.get('net.dnsType', 'A')) ?? 'A');
  let busy = $state(false);
  let problem = $state<string | undefined>(undefined);
  let error = $state<NetworkErrorCode | undefined>(undefined);
  let records = $state<{ type: string; data: string; ttl?: number | undefined }[] | undefined>(undefined);

  $effect(() => {
    remember.set('net.dnsHost', host);
    remember.set('net.dnsMode', mode);
    remember.set('net.dnsProvider', provider);
    remember.set('net.dnsType', type);
  });

  async function run(): Promise<void> {
    records = undefined;
    error = undefined;
    const checked = checkHost(host);
    problem = checked.ok ? undefined : t(`tools.host.${checked.reason}` as 'tools.host.empty');
    if (!checked.ok || busy) {
      return;
    }
    busy = true;
    try {
      if (mode === 'local') {
        const found = await rpc.request('dnsLookup', { host: checked.value });
        error = found.error;
        records = found.addresses.map((entry) => ({
          type: entry.family === 4 ? 'A' : 'AAAA',
          data: entry.address,
        }));
      } else {
        const found = await rpc.request('dohLookup', { host: checked.value, type, provider });
        error = found.error;
        records = found.records.map((entry) => ({ type: entry.type, data: entry.data, ttl: entry.ttl }));
      }
    } catch {
      error = 'failed';
      records = [];
    } finally {
      busy = false;
    }
  }
</script>

<Card title={t('tools.dns')} icon="globe" tone="purple">
  <div class="tl-row">
    <label class="grow">
      <span class="tl-label">{t('tools.host')}</span>
      <input class="control tl-mono" bind:value={host} data-testid="dns-host" onkeydown={(event) => { if (event.key === 'Enter') { void run(); } }} />
    </label>
    <button type="button" class="button" disabled={busy} data-testid="dns-run" onclick={() => { void run(); }}>
      <Icon name={busy ? 'loading' : 'search'} spin={busy} />{t('tools.lookup')}
    </button>
  </div>
  <div class="tl-row">
    <div>
      <span class="tl-label" id="dns-resolver">{t('tools.resolver')}</span>
      <div class="seg" role="group" aria-labelledby="dns-resolver">
        <button type="button" aria-pressed={mode === 'local'} data-testid="dns-mode-local" onclick={() => { mode = 'local'; }}>{t('tools.resolver.local')}</button>
        <button type="button" aria-pressed={mode === 'doh'} data-testid="dns-mode-doh" onclick={() => { mode = 'doh'; }}>{t('tools.resolver.doh')}</button>
      </div>
    </div>
    {#if mode === 'doh'}
      <label>
        <span class="tl-label">{t('tools.provider')}</span>
        <select class="control" bind:value={provider} data-testid="dns-provider">
          {#each DOH_PROVIDERS as item (item)}
            <option value={item}>{t(`tools.provider.${item}`)}</option>
          {/each}
        </select>
      </label>
      <label>
        <span class="tl-label">{t('tools.recordType')}</span>
        <select class="control" bind:value={type} data-testid="dns-type">
          {#each DNS_TYPES as item (item)}
            <option value={item}>{item}</option>
          {/each}
        </select>
      </label>
    {/if}
  </div>
  {#if mode === 'doh'}
    <p class="muted small" data-testid="doh-note"><Icon name="info" size={12} /> {t('tools.dohNote', DOH_HOSTS[provider])}</p>
  {/if}
  {#if problem !== undefined}
    <p class="tl-problem" role="alert" data-testid="dns-problem"><Icon name="error" size={14} />{problem}</p>
  {/if}
  {#if records !== undefined}
    <div class="tl-stack" data-testid="dns-result">
      {#if error !== undefined}
        <p class="tl-problem"><Icon name="error" size={14} />{t(`tools.error.${error}`)}</p>
      {/if}
      {#each records as entry, index (`${entry.type}:${entry.data}:${index}`)}
        <div class="tl-line">
          <span class="badge">{entry.type}</span>
          <span class="tl-mono data">{entry.data}</span>
          {#if entry.ttl !== undefined}<span class="muted small">TTL {entry.ttl}</span>{/if}
        </div>
      {/each}
    </div>
  {/if}
</Card>

<style>
  .grow {
    flex: 1;
    min-width: 160px;
  }

  .data {
    min-width: 0;
    overflow-wrap: anywhere;
  }
</style>

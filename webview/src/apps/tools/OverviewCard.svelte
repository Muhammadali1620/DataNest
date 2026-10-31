<script lang="ts">
  import type { InterfaceInfo, NetworkErrorCode, ToolsProtocol } from '../../../../src/shared/protocols/tools';
  import type { RpcPeer } from '../../../../src/shared/rpc';
  import Icon from '../../components/Icon.svelte';
  import type { Translate } from '../../lib/i18n';
  import Card from './Card.svelte';

  interface Props {
    rpc: RpcPeer<ToolsProtocol['webview'], ToolsProtocol['host']>;
    t: Translate;
    hostname: string | undefined;
    interfaces: readonly InterfaceInfo[];
    copy: (text: string) => void;
  }

  const { rpc, t, hostname, interfaces, copy }: Props = $props();

  let busy = $state(false);
  let result = $state<{ ipv4?: string | undefined; ipv6?: string | undefined; error?: NetworkErrorCode | undefined } | undefined>(undefined);

  // The first address of each family that is not a loopback: what the neighbours see.
  const local4 = $derived(interfaces.find((item) => !item.internal && item.family === 'IPv4')?.address);
  const local6 = $derived(interfaces.find((item) => !item.internal && item.family === 'IPv6')?.address);

  async function load(): Promise<void> {
    if (busy) {
      return;
    }
    busy = true;
    try {
      result = await rpc.request('publicIp', {});
    } catch {
      result = { error: 'failed' };
    } finally {
      busy = false;
    }
  }
</script>

<Card title={t('tools.overview')} icon="server-environment" tone="blue">
  {#snippet actions()}
    <button type="button" class="button secondary" disabled={busy} data-testid="ip-run" onclick={() => { void load(); }}>
      <Icon name={busy ? 'loading' : 'cloud'} spin={busy} />{t('tools.getInfo')}
    </button>
  {/snippet}
  <dl class="facts">
    <div>
      <dt class="tl-label">{t('tools.hostname')}</dt>
      <dd class="tl-mono" data-testid="hostname">{hostname ?? '-'}</dd>
    </div>
    <div>
      <dt class="tl-label">{t('tools.localIp')}</dt>
      <dd class="tl-mono">
        {#if local4 !== undefined}<span class="badge">IPv4 {local4}</span>{/if}
        {#if local6 !== undefined}<span class="badge outline">IPv6 {local6}</span>{/if}
        {#if local4 === undefined && local6 === undefined}-{/if}
      </dd>
    </div>
    <div>
      <dt class="tl-label">{t('tools.publicIpv4')}</dt>
      <dd class="tl-mono" data-testid="public-v4">
        {#if result?.ipv4 !== undefined}
          {result.ipv4}
          <button type="button" class="link-button" onclick={() => { copy(result?.ipv4 ?? ''); }}>{t('tools.copy')}</button>
        {:else}-{/if}
      </dd>
    </div>
    <div>
      <dt class="tl-label">{t('tools.publicIpv6')}</dt>
      <dd class="tl-mono" data-testid="public-v6">
        {#if result?.ipv6 !== undefined}
          {result.ipv6}
          <button type="button" class="link-button" onclick={() => { copy(result?.ipv6 ?? ''); }}>{t('tools.copy')}</button>
        {:else}-{/if}
      </dd>
    </div>
  </dl>
  {#if result?.error !== undefined}
    <p class="tl-problem" role="alert" data-testid="ip-problem"><Icon name="error" size={14} />{t(`tools.error.${result.error}`)}</p>
  {/if}
  <p class="muted small"><Icon name="info" size={12} /> {t('tools.publicNote', 'api.ipify.org, api6.ipify.org')}</p>
</Card>

<style>
  .facts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
    gap: 12px 16px;
    margin: 0;
  }

  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .facts .badge {
    margin: 0 4px 4px 0;
  }
</style>

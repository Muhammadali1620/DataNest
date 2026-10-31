<script lang="ts">
  import { onMount } from 'svelte';
  import type {
    InterfaceInfo,
    NetworkErrorCode,
    ToolsProtocol,
  } from '../../../../src/shared/protocols/tools';
  import type { RpcPeer } from '../../../../src/shared/rpc';
  import { summarize } from '../../../../src/shared/tools/ping-stats';
  import {
    checkHost,
    checkPort,
    MAX_PING_COUNT,
    MAX_TIMEOUT_MS,
    MIN_TIMEOUT_MS,
  } from '../../../../src/shared/tools/validate';
  import Icon from '../../components/Icon.svelte';
  import IconButton from '../../components/IconButton.svelte';
  import type { Translate } from '../../lib/i18n';
  import Card from './Card.svelte';
  import DnsCard from './DnsCard.svelte';
  import IcmpCard from './IcmpCard.svelte';
  import OverviewCard from './OverviewCard.svelte';
  import { useToolsState } from './state';

  interface Props {
    rpc: RpcPeer<ToolsProtocol['webview'], ToolsProtocol['host']>;
    t: Translate;
    copy?: (text: string) => void;
  }

  const { rpc, t, copy = () => undefined }: Props = $props();
  const remember = useToolsState();

  // ---- Interfaces
  let interfaces = $state<InterfaceInfo[]>([]);
  let hostname = $state<string | undefined>(undefined);
  let interfacesLoaded = $state(false);

  async function loadInterfaces(): Promise<void> {
    const answer = await rpc.request('interfaces', {});
    interfaces = answer.items;
    hostname = answer.hostname;
    interfacesLoaded = true;
  }

  /** Validates the form's host and port; the message is shown under the form. */
  function checkTarget(host: string, port: string | undefined): { host: string; port: number } | string {
    const checkedHost = checkHost(host);
    if (!checkedHost.ok) {
      return t(`tools.host.${checkedHost.reason}` as 'tools.host.empty');
    }
    if (port === undefined) {
      return { host: checkedHost.value, port: 0 };
    }
    const checkedPort = checkPort(port);
    if (!checkedPort.ok) {
      return t(`tools.port.${checkedPort.reason}` as 'tools.port.empty');
    }
    return { host: checkedHost.value, port: checkedPort.value };
  }

  const errorText = (code: NetworkErrorCode | undefined): string =>
    t(`tools.error.${code ?? 'failed'}`);

  // ---- Port check
  let portHost = $state(remember.get('net.portHost', '127.0.0.1'));
  let portNumber = $state(remember.get('net.portNumber', '3306'));
  let portTimeout = $state(remember.get('net.portTimeout', 3000));
  let portBusy = $state(false);
  let portProblem = $state<string | undefined>(undefined);
  let portResult = $state<{ open: boolean; ms?: number | undefined; error?: NetworkErrorCode | undefined } | undefined>(undefined);

  async function checkPortNow(): Promise<void> {
    portResult = undefined;
    const target = checkTarget(portHost, portNumber);
    portProblem = typeof target === 'string' ? target : undefined;
    if (typeof target === 'string' || portBusy) {
      return;
    }
    portBusy = true;
    try {
      portResult = await rpc.request('portCheck', { ...target, timeoutMs: portTimeout });
    } finally {
      portBusy = false;
    }
  }

  // ---- TCP ping
  let pingHost = $state(remember.get('net.tcpHost', '127.0.0.1'));
  let pingPort = $state(remember.get('net.tcpPort', '3306'));
  let pingCount = $state(remember.get('net.tcpCount', 4));
  let pingTimeout = $state(remember.get('net.tcpTimeout', 2000));
  let pingBusy = $state(false);
  let pingProblem = $state<string | undefined>(undefined);
  let pingResult = $state<{ attempts: { ok: boolean; ms?: number | undefined; error?: NetworkErrorCode | undefined }[]; error?: NetworkErrorCode | undefined } | undefined>(undefined);
  const pingSummary = $derived(pingResult === undefined ? undefined : summarize(pingResult.attempts));

  async function pingNow(): Promise<void> {
    pingResult = undefined;
    const target = checkTarget(pingHost, pingPort);
    pingProblem = typeof target === 'string' ? target : undefined;
    if (typeof target === 'string' || pingBusy) {
      return;
    }
    pingBusy = true;
    try {
      pingResult = await rpc.request('tcpPing', {
        ...target,
        count: Math.min(MAX_PING_COUNT, Math.max(1, Math.trunc(pingCount) || 1)),
        timeoutMs: pingTimeout,
      });
    } finally {
      pingBusy = false;
    }
  }

  $effect(() => {
    remember.set('net.portHost', portHost);
    remember.set('net.portNumber', portNumber);
    remember.set('net.portTimeout', portTimeout);
    remember.set('net.tcpHost', pingHost);
    remember.set('net.tcpPort', pingPort);
    remember.set('net.tcpCount', pingCount);
    remember.set('net.tcpTimeout', pingTimeout);
  });

  onMount(() => {
    void loadInterfaces();
  });
</script>

<div class="net">
    <OverviewCard {rpc} {t} {hostname} {interfaces} {copy} />
  <Card title={t('tools.interfaces')} icon="server-environment" tone="blue">
    {#snippet actions()}
      <IconButton icon="refresh" tone="teal" label={t('tools.refresh')} onclick={() => { void loadInterfaces(); }} />
    {/snippet}
    {#if interfaces.length > 0}
      <table class="tl-table" data-testid="interfaces">
        <thead>
          <tr><th>{t('tools.ifName')}</th><th>{t('tools.ifAddress')}</th><th>{t('tools.ifKind')}</th></tr>
        </thead>
        <tbody>
          {#each interfaces as item (`${item.name}:${item.address}`)}
            <tr>
              <td>{item.name}</td>
              <td class="tl-mono">{item.address}</td>
              <td>
                <span class="badge">{item.family}</span>
                {#if item.internal}<span class="badge outline">{t('tools.loopback')}</span>{/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {:else if interfacesLoaded}
      <p class="muted" data-testid="no-interfaces">{t('tools.noInterfaces')}</p>
    {/if}
  </Card>

  <Card title={t('tools.portCheck')} icon="plug" tone="green">
    <div class="tl-row">
      <label class="grow">
        <span class="tl-label">{t('tools.host')}</span>
        <input class="control tl-mono" bind:value={portHost} data-testid="port-host" />
      </label>
      <label class="narrow">
        <span class="tl-label">{t('tools.port')}</span>
        <input class="control tl-mono" inputmode="numeric" bind:value={portNumber} data-testid="port-number" />
      </label>
      <label class="narrow">
        <span class="tl-label">{t('tools.timeout')}</span>
        <input class="control" type="number" min={MIN_TIMEOUT_MS} max={MAX_TIMEOUT_MS} step="100" bind:value={portTimeout} />
      </label>
      <button type="button" class="button" disabled={portBusy} data-testid="port-run" onclick={() => { void checkPortNow(); }}>
        <Icon name={portBusy ? 'loading' : 'play'} spin={portBusy} />{t('tools.check')}
      </button>
    </div>
    {#if portProblem !== undefined}
      <p class="tl-problem" role="alert" data-testid="port-problem"><Icon name="error" size={14} />{portProblem}</p>
    {/if}
    {#if portResult !== undefined}
      <div class="tl-result" data-testid="port-result">
        {#if portResult.open}
          <span class="badge success"><Icon name="pass" size={12} />{t('tools.open')}</span>
          {#if portResult.ms !== undefined}<span class="muted">{t('tools.ms', portResult.ms)}</span>{/if}
        {:else}
          <span class="badge danger"><Icon name="error" size={12} />{t('tools.closed')}</span>
          <span class="muted">{errorText(portResult.error)}</span>
        {/if}
      </div>
    {/if}
  </Card>

    <DnsCard {rpc} {t} />
    <IcmpCard {rpc} {t} />
  <Card title={t('tools.tcpPing')} icon="broadcast" tone="orange">
    <div class="tl-row">
      <label class="grow">
        <span class="tl-label">{t('tools.host')}</span>
        <input class="control tl-mono" bind:value={pingHost} data-testid="ping-host" />
      </label>
      <label class="narrow">
        <span class="tl-label">{t('tools.port')}</span>
        <input class="control tl-mono" inputmode="numeric" bind:value={pingPort} data-testid="ping-port" />
      </label>
      <label class="narrow">
        <span class="tl-label">{t('tools.count')}</span>
        <input class="control" type="number" min="1" max={MAX_PING_COUNT} bind:value={pingCount} />
      </label>
      <label class="narrow">
        <span class="tl-label">{t('tools.timeout')}</span>
        <input class="control" type="number" min={MIN_TIMEOUT_MS} max={MAX_TIMEOUT_MS} step="100" bind:value={pingTimeout} />
      </label>
      <button type="button" class="button" disabled={pingBusy} data-testid="ping-run" onclick={() => { void pingNow(); }}>
        <Icon name={pingBusy ? 'loading' : 'play'} spin={pingBusy} />{t('tools.run')}
      </button>
    </div>
    <p class="muted small">{t('tools.tcpNote')}</p>
    {#if pingProblem !== undefined}
      <p class="tl-problem" role="alert" data-testid="ping-problem"><Icon name="error" size={14} />{pingProblem}</p>
    {/if}
    {#if pingResult?.error !== undefined}
      <p class="tl-problem" role="alert"><Icon name="error" size={14} />{errorText(pingResult.error)}</p>
    {/if}
    {#if pingResult !== undefined && pingSummary !== undefined && pingResult.error === undefined}
      <div class="tl-stack" data-testid="ping-result">
        <div class="tl-result">
          <span class="badge" class:success={pingSummary.lost === 0} class:danger={pingSummary.received === 0} class:warning={pingSummary.lost > 0 && pingSummary.received > 0}>
            {t('tools.received', pingSummary.received, pingSummary.sent)}
          </span>
          <span class="muted">{t('tools.loss', pingSummary.lossPercent)}</span>
          {#if pingSummary.avg !== undefined}
            <span class="muted" data-testid="ping-stats">
              {t('tools.minAvgMax', pingSummary.min ?? 0, pingSummary.avg, pingSummary.max ?? 0)}
            </span>
          {/if}
        </div>
        <ol class="attempts">
          {#each pingResult.attempts as attempt, index (index)}
            <li>
              {#if attempt.ok}
                <span class="ok"><Icon name="pass" size={12} /></span>{t('tools.ms', attempt.ms ?? 0)}
              {:else}
                <span class="bad"><Icon name="error" size={12} /></span>{errorText(attempt.error)}
              {/if}
            </li>
          {/each}
        </ol>
      </div>
    {/if}
  </Card>
</div>

<style>
  /* The cards flow down two newspaper columns, each at its own height: a short card never
     leaves a hole beside a tall one, and the columns balance themselves. One column when
     the page is narrow. */
  .net {
    columns: 440px 2;
    column-gap: 14px;
  }

  .net > :global(section) {
    margin-bottom: 14px;
    break-inside: avoid;
  }

  .grow {
    flex: 1;
    min-width: 160px;
  }

  .narrow {
    width: 96px;
  }

  label .control {
    width: 100%;
  }

  .attempts {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 14px;
    padding: 0;
    margin: 0;
    font-size: var(--dn-font-small);
    list-style: none;
  }

  .attempts li {
    display: inline-flex;
    gap: 5px;
    align-items: center;
  }

  .ok {
    display: inline-flex;
    color: var(--dn-success);
  }

  .bad {
    display: inline-flex;
    color: var(--dn-danger);
  }
</style>

<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import type { NetworkErrorCode, ToolsProtocol } from '../../../../src/shared/protocols/tools';
  import type { RpcPeer } from '../../../../src/shared/rpc';
  import { DOH_HOSTS, DOH_PROVIDERS, type DohProvider } from '../../../../src/shared/tools/doh';
  import { summarize } from '../../../../src/shared/tools/ping-stats';
  import {
    checkHost,
    MAX_PING_COUNT,
    MAX_TIMEOUT_MS,
    MIN_TIMEOUT_MS,
  } from '../../../../src/shared/tools/validate';
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

  let host = $state(remember.get('net.icmpHost', '8.8.8.8'));
  let count = $state(remember.get('net.icmpCount', 4));
  let timeout = $state(remember.get('net.icmpTimeout', 2000));
  let resolve = $state<'direct' | 'doh'>(remember.get('net.icmpResolve', 'direct') === 'doh' ? 'doh' : 'direct');
  let provider = $state<DohProvider>(
    DOH_PROVIDERS.find((item) => item === remember.get('net.icmpProvider', 'cloudflare')) ?? 'cloudflare',
  );

  let busy = $state(false);
  let problem = $state<string | undefined>(undefined);
  let missing = $state(false);
  let error = $state<NetworkErrorCode | undefined>(undefined);
  let lines = $state<{ text: string; reply: boolean }[]>([]);
  let attempts = $state<{ ok: boolean; ms?: number | undefined }[] | undefined>(undefined);
  const summary = $derived(attempts === undefined ? undefined : summarize(attempts));

  let runId = 0;
  let output: HTMLElement | undefined = $state();

  $effect(() => {
    remember.set('net.icmpHost', host);
    remember.set('net.icmpCount', count);
    remember.set('net.icmpTimeout', timeout);
    remember.set('net.icmpResolve', resolve);
    remember.set('net.icmpProvider', provider);
  });

  onMount(() => {
    const subscription = rpc.on('pingLine', (line) => {
      if (line.runId !== runId) {
        return;
      }
      lines = [...lines.slice(-199), { text: line.text, reply: line.reply }];
      queueMicrotask(() => {
        if (output !== undefined) {
          output.scrollTop = output.scrollHeight;
        }
      });
    });
    return () => {
      subscription.dispose();
    };
  });

  onDestroy(() => {
    if (busy) {
      void rpc.request('icmpCancel', { runId }).catch(() => undefined);
    }
  });

  async function run(): Promise<void> {
    if (busy) {
      return;
    }
    const checked = checkHost(host);
    problem = checked.ok ? undefined : t(`tools.host.${checked.reason}` as 'tools.host.empty');
    if (!checked.ok) {
      return;
    }
    runId += 1;
    lines = [];
    attempts = undefined;
    missing = false;
    error = undefined;
    busy = true;
    const mine = runId;
    try {
      const result = await rpc.request('icmpPing', {
        runId: mine,
        host: checked.value,
        count: Math.min(MAX_PING_COUNT, Math.max(1, Math.trunc(count) || 1)),
        timeoutMs: Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.trunc(timeout) || MIN_TIMEOUT_MS)),
        resolve,
        provider,
      });
      if (mine !== runId) {
        return;
      }
      missing = !result.available;
      error = result.error;
      attempts = result.available && result.error === undefined ? result.attempts : undefined;
    } catch {
      error = 'failed';
    } finally {
      if (mine === runId) {
        busy = false;
      }
    }
  }

  function stop(): void {
    void rpc.request('icmpCancel', { runId }).catch(() => undefined);
  }
</script>

<Card title={t('tools.ping')} icon="pulse" tone="orange">
  <div class="tl-row">
    <label class="grow">
      <span class="tl-label">{t('tools.host')}</span>
      <input class="control tl-mono" bind:value={host} data-testid="icmp-host" onkeydown={(event) => { if (event.key === 'Enter') { void run(); } }} />
    </label>
    <label class="narrow">
      <span class="tl-label">{t('tools.count')}</span>
      <input class="control" type="number" min="1" max={MAX_PING_COUNT} bind:value={count} data-testid="icmp-count" />
    </label>
    <label class="narrow">
      <span class="tl-label">{t('tools.timeout')}</span>
      <input class="control" type="number" min={MIN_TIMEOUT_MS} max={MAX_TIMEOUT_MS} step="100" bind:value={timeout} />
    </label>
    {#if busy}
      <button type="button" class="button danger" data-testid="icmp-stop" onclick={stop}>
        <Icon name="debug-stop" />{t('tools.stop')}
      </button>
    {:else}
      <button type="button" class="button" data-testid="icmp-run" onclick={() => { void run(); }}>
        <Icon name="play" />{t('tools.run')}
      </button>
    {/if}
  </div>
  <div class="tl-row">
    <div>
      <span class="tl-label" id="icmp-resolve">{t('tools.resolve')}</span>
      <div class="seg" role="group" aria-labelledby="icmp-resolve">
        <button type="button" aria-pressed={resolve === 'direct'} onclick={() => { resolve = 'direct'; }}>{t('tools.resolve.direct')}</button>
        <button type="button" aria-pressed={resolve === 'doh'} data-testid="icmp-doh" onclick={() => { resolve = 'doh'; }}>{t('tools.resolve.doh')}</button>
      </div>
    </div>
    {#if resolve === 'doh'}
      <label>
        <span class="tl-label">{t('tools.provider')}</span>
        <select class="control" bind:value={provider}>
          {#each DOH_PROVIDERS as item (item)}
            <option value={item}>{t(`tools.provider.${item}`)}</option>
          {/each}
        </select>
      </label>
    {/if}
  </div>
  {#if resolve === 'doh'}
    <p class="muted small"><Icon name="info" size={12} /> {t('tools.dohNote', DOH_HOSTS[provider])}</p>
  {/if}
  {#if problem !== undefined}
    <p class="tl-problem" role="alert" data-testid="icmp-problem"><Icon name="error" size={14} />{problem}</p>
  {/if}
  {#if missing}
    <p class="notice warning" role="alert" data-testid="icmp-missing"><Icon name="warning" size={14} />{t('tools.icmpMissing')}</p>
  {/if}
  {#if error !== undefined}
    <p class="tl-problem" role="alert" data-testid="icmp-error"><Icon name="error" size={14} />{t(`tools.error.${error}`)}</p>
  {/if}
  {#if lines.length > 0}
    <pre class="out tl-mono" bind:this={output} data-testid="icmp-output" aria-label={t('tools.pingOutput')}>{#each lines as line, index (index)}<span class:reply={line.reply}>{line.text}</span>
{/each}</pre>
  {/if}
  {#if summary !== undefined}
    <div class="tl-result" data-testid="icmp-result">
      <span class="badge" class:success={summary.lost === 0} class:danger={summary.received === 0} class:warning={summary.lost > 0 && summary.received > 0}>
        {t('tools.received', summary.received, summary.sent)}
      </span>
      <span class="muted">{t('tools.loss', summary.lossPercent)}</span>
      {#if summary.avg !== undefined}
        <span class="muted" data-testid="icmp-stats">{t('tools.minAvgMax', summary.min ?? 0, summary.avg, summary.max ?? 0)}</span>
      {/if}
    </div>
  {/if}
  <p class="muted small"><Icon name="info" size={12} /> {t('tools.icmpNote')}</p>
</Card>

<style>
  .grow {
    flex: 1;
    min-width: 150px;
  }

  .narrow {
    width: 90px;
  }

  .narrow .control {
    width: 100%;
    min-width: 0;
  }

  .out {
    max-height: 190px;
    padding: 8px 10px;
    margin: 0;
    overflow: auto;
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
    background: var(--dn-surface);
    border: 1px solid var(--dn-divider);
    border-radius: 10px;
  }

  .out span {
    color: var(--dn-muted);
  }

  .out span.reply {
    color: var(--vscode-foreground);
  }
</style>

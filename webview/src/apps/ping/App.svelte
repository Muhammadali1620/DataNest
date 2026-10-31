<script lang="ts">
  import { onMount } from 'svelte';
  import type { RpcPeer } from '../../../../src/shared/rpc';
  import type { PingProtocol } from '../../../../src/shared/protocols/ping';
  import { PING_MAX_TEXT_LENGTH } from '../../../../src/shared/protocols/ping';
  import Icon from '../../components/Icon.svelte';
  import type { Translate } from '../../lib/i18n';

  interface Props {
    rpc: RpcPeer<PingProtocol['webview'], PingProtocol['host']>;
    t: Translate;
  }

  const { rpc, t }: Props = $props();

  let text = $state('hello');
  let connected = $state(false);
  let busy = $state(false);
  let lines: string[] = $state([]);

  onMount(() => {
    const subscriptions = [
      rpc.handle('echo', ({ text: value }) => ({ text: value })),
      rpc.on('notice', ({ text: value }) => {
        connected = true;
        lines = [...lines, value];
      }),
    ];
    // Only now the page listens, so the host may start talking.
    rpc.emit('ready', {});
    return () => {
      for (const subscription of subscriptions) {
        subscription.dispose();
      }
    };
  });

  async function ping(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    busy = true;
    try {
      const { reply, count } = await rpc.request('ping', { text });
      lines = [...lines, t('ping.reply', count, reply)];
    } catch (error) {
      lines = [...lines, t('ping.error', error instanceof Error ? error.message : String(error))];
    } finally {
      busy = false;
    }
  }
</script>

<main>
  <header class="page-header">
    <span class="header-icon"><Icon name="plug" size={20} /></span>
    <h1>{t('ping.title')}</h1>
  </header>
  <section class="card">
    <p class="badge" class:outline={!connected} class:success={connected} data-testid="status"
      ><Icon name={connected ? 'pass' : 'loading'} spin={!connected} size={12} />{connected
        ? t('ping.connected')
        : t('ping.waiting')}</p
    >
    <form onsubmit={ping}>
      <label class="field">
        <span class="label">{t('ping.input')}</span>
        <input class="control" bind:value={text} maxlength={PING_MAX_TEXT_LENGTH} />
      </label>
      <button type="submit" class="button" disabled={busy}
        ><Icon name={busy ? 'loading' : 'send'} spin={busy} />{t('ping.send')}</button
      >
    </form>
    {#if lines.length > 0}
      <ul class="log" data-testid="log">
        {#each lines as line, index (index)}
          <li>{line}</li>
        {/each}
      </ul>
    {/if}
  </section>
</main>

<style>
  main {
    display: flex;
    flex-direction: column;
    gap: var(--dn-gap-m);
    max-width: 640px;
    padding: 18px 24px 24px;
  }

  .page-header {
    display: flex;
    gap: var(--dn-gap-m);
    align-items: center;
  }

  .header-icon {
    display: inline-flex;
    padding: 9px;
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
    border-radius: 10px;
  }

  .card {
    display: flex;
    flex-direction: column;
    gap: var(--dn-gap-m);
    align-items: flex-start;
  }

  .badge {
    margin: 0;
  }

  form {
    display: flex;
    gap: var(--dn-gap);
    align-items: flex-end;
    align-self: stretch;
  }

  .field {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 6px;
  }

  .label {
    font-weight: 600;
  }

  /* What came back, as a terminal shows it. */
  .log {
    align-self: stretch;
    margin: 0;
    padding: var(--dn-gap) var(--dn-gap-m);
    font-family: var(--dn-mono);
    font-size: var(--dn-font-small);
    line-height: 1.6;
    list-style: none;
    background: var(--vscode-terminal-background, var(--vscode-editor-background));
    border: 1px solid var(--dn-border);
    border-radius: var(--dn-radius);
  }
</style>

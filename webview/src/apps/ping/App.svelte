<script lang="ts">
  import { onMount } from 'svelte';
  import type { RpcPeer } from '../../../../src/shared/rpc';
  import type { PingProtocol } from '../../../../src/shared/protocols/ping';
  import { PING_MAX_TEXT_LENGTH } from '../../../../src/shared/protocols/ping';
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
  <h1>{t('ping.title')}</h1>
  <p data-testid="status">{connected ? t('ping.connected') : t('ping.waiting')}</p>
  <form onsubmit={ping}>
    <label>
      {t('ping.input')}
      <input bind:value={text} maxlength={PING_MAX_TEXT_LENGTH} />
    </label>
    <button type="submit" disabled={busy}>{t('ping.send')}</button>
  </form>
  <ul data-testid="log">
    {#each lines as line, index (index)}
      <li>{line}</li>
    {/each}
  </ul>
</main>

<style>
  main {
    padding: 12px 16px;
  }

  h1 {
    margin: 0 0 8px;
    font-size: 1.4em;
    font-weight: 600;
  }

  p {
    margin: 0 0 12px;
    color: var(--vscode-descriptionForeground);
  }

  form {
    display: flex;
    gap: 8px;
    align-items: end;
  }

  label {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  input {
    padding: 4px 6px;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
  }

  button {
    padding: 4px 12px;
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
    border: none;
    cursor: pointer;
  }

  button:hover {
    background: var(--vscode-button-hoverBackground);
  }

  button:disabled {
    opacity: 0.6;
    cursor: default;
  }

  ul {
    padding-left: 20px;
  }
</style>

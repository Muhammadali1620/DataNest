<script lang="ts">
  import { onMount, tick } from 'svelte';
  import type {
    ManagerLogEntry,
    ManagerProtocol,
  } from '../../../../src/shared/protocols/manager';
  import type { RpcPeer } from '../../../../src/shared/rpc';
  import Icon from '../../components/Icon.svelte';
  import IconButton from '../../components/IconButton.svelte';
  import type { Translate } from '../../lib/i18n';
  import { filterLog, logOutcome, logText, logTime } from './log-view';

  interface Props {
    rpc: RpcPeer<ManagerProtocol['webview'], ManagerProtocol['host']>;
    t: Translate;
  }

  const { rpc, t }: Props = $props();

  let entries = $state<ManagerLogEntry[]>([]);
  let loaded = $state(false);
  let error = $state<string | undefined>(undefined);
  let text = $state('');
  let errorsOnly = $state(false);
  let copied = $state(false);
  let scroller = $state<HTMLDivElement | undefined>(undefined);
  /** The newest line stays in view while the reader is at the bottom. */
  let follow = true;

  const shown = $derived(filterLog(entries, text, errorsOnly));
  const failed = $derived(entries.filter((entry) => !entry.ok).length);

  function describe(entry: ManagerLogEntry): string {
    const outcome = logOutcome(entry);
    return t(outcome.key, ...outcome.args);
  }

  async function load(): Promise<void> {
    try {
      entries = (await rpc.request('log.list', {})).entries;
      error = undefined;
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    } finally {
      loaded = true;
    }
    if (follow) {
      await tick();
      // Svelte clears the binding when the section goes away while the read was pending.
      if (scroller) {
        scroller.scrollTop = scroller.scrollHeight;
      }
    }
  }

  function scrolled(): void {
    if (scroller) {
      follow = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 24;
    }
  }

  async function clear(): Promise<void> {
    try {
      if ((await rpc.request('log.clear', {})).cleared) {
        await load();
      }
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
  }

  async function copy(): Promise<void> {
    await navigator.clipboard.writeText(logText(shown, describe));
    copied = true;
    setTimeout(() => {
      copied = false;
    }, 1500);
  }

  onMount(() => {
    const subscription = rpc.on('log.changed', () => {
      void load();
    });
    void load();
    return () => {
      subscription.dispose();
    };
  });
</script>

<section class="log" aria-label={t('manager.section.log')}>
  <div class="toolbar-row">
    <label class="find">
      <Icon name="search" size={14} />
      <input
        class="control"
        type="search"
        placeholder={t('manager.log.filter')}
        aria-label={t('manager.log.filter')}
        bind:value={text}
      />
    </label>
    <label class="check">
      <input type="checkbox" bind:checked={errorsOnly} />
      {t('manager.log.errors', failed)}
    </label>
    <span class="spacer"></span>
    <span class="muted small" aria-live="polite">{t('manager.log.count', shown.length, entries.length)}</span>
    <IconButton
      icon={copied ? 'check' : 'copy'}
      tone="blue"
      label={copied ? t('manager.log.copied') : t('manager.log.copy')}
      disabled={shown.length === 0}
      onclick={() => void copy()}
    />
    <IconButton
      icon="refresh"
      tone="green"
      label={t('manager.log.refresh')}
      onclick={() => void load()}
    />
    <IconButton
      icon="trash"
      tone="red"
      label={t('manager.log.clear')}
      disabled={entries.length === 0}
      onclick={() => void clear()}
    />
  </div>

  {#if error !== undefined}
    <div class="notice error" role="alert"><Icon name="error" /><span>{error}</span></div>
  {/if}

  {#if loaded && entries.length === 0}
    <div class="empty">
      <span class="empty-icon"><Icon name="output" size={22} /></span>
      <p class="empty-title">{t('manager.log.empty')}</p>
      <p class="muted">{t('manager.log.emptyHint')}</p>
    </div>
  {:else}
    <div
      class="lines"
      bind:this={scroller}
      onscroll={scrolled}
      role="log"
      aria-label={t('manager.section.log')}
      data-testid="log-lines"
    >
      {#each shown as entry (entry.id)}
        <article class="line" class:failed={!entry.ok} data-testid="log-line">
          <span class="time">{logTime(entry.at)}</span>
          <div class="body">
            <pre class="sql">{entry.sql}</pre>
            <span class="outcome" class:bad={!entry.ok}>
              <Icon name={entry.ok ? 'check' : 'error'} size={12} />
              {describe(entry)}{#if entry.runs > 1}<span class="runs">{t('manager.log.runs', entry.runs)}</span>{/if}
            </span>
            {#if entry.error !== undefined}
              <pre class="error-text">{entry.error}</pre>
            {/if}
          </div>
        </article>
      {/each}
      {#if loaded && shown.length === 0}
        <p class="muted none">{t('manager.log.noMatch')}</p>
      {/if}
    </div>
  {/if}
</section>

<style>
  .log {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }

  .toolbar-row {
    display: flex;
    flex: none;
    flex-wrap: wrap;
    gap: var(--dn-gap);
    align-items: center;
    padding: var(--dn-gap) var(--dn-gap-m);
    border-bottom: 1px solid var(--dn-divider);
  }

  .spacer {
    flex: 1;
  }

  .find {
    position: relative;
    display: flex;
    align-items: center;
    min-width: 200px;
    color: var(--dn-muted);
  }

  .find :global(.codicon-glyph) {
    position: absolute;
    left: 10px;
    pointer-events: none;
  }

  .find input {
    padding-left: 30px;
    border-radius: 999px;
  }

  .check {
    display: flex;
    gap: 6px;
    align-items: center;
    font-size: var(--dn-font-small);
  }

  .lines {
    flex: 1;
    min-height: 0;
    padding: var(--dn-gap) var(--dn-gap-m);
    overflow: auto;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 12px;
  }

  .line {
    display: flex;
    gap: var(--dn-gap-m);
    padding: 6px 0;
    border-bottom: 1px solid var(--dn-divider);
  }

  .time {
    flex: none;
    color: var(--dn-muted);
    white-space: nowrap;
  }

  .body {
    flex: 1;
    min-width: 0;
  }

  pre {
    margin: 0;
    font: inherit;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .sql {
    color: var(--vscode-textLink-foreground, var(--dn-accent));
  }

  .outcome {
    display: inline-flex;
    gap: 4px;
    align-items: center;
    margin-top: 2px;
    color: var(--dn-success);
  }

  .outcome.bad,
  .error-text {
    color: var(--dn-danger);
  }

  .runs {
    margin-left: 6px;
    color: var(--dn-muted);
  }

  .none {
    padding: var(--dn-gap-l);
    text-align: center;
  }
</style>

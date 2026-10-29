<script lang="ts">
  import { onMount, tick } from 'svelte';
  import type {
    ConsoleCommandDoc,
    ConsoleOutput,
    RedisConsoleProtocol,
    RedisConsoleState,
  } from '../../../../src/shared/protocols/redis-console';
  import type { RpcPeer } from '../../../../src/shared/rpc';
  import type { Translate } from '../../lib/i18n';
  import {
    commandOf,
    complete,
    History,
    keyPrefix,
    keyWord,
    suggestCommands,
    syntaxLine,
  } from './console-model';

  interface Props {
    rpc: RpcPeer<RedisConsoleProtocol['webview'], RedisConsoleProtocol['host']>;
    t: Translate;
  }

  const { rpc, t }: Props = $props();

  /** Entries the page keeps; older ones scroll away. */
  const MAX_ENTRIES = 1000;

  let consoleState = $state<RedisConsoleState | undefined>(undefined);
  let entries = $state<ConsoleOutput[]>([]);
  let input = $state('');
  let running = $state(false);
  let suggestions = $state<{ label: string; detail?: string; insert: string; words: number }[]>(
    [],
  );
  let active = $state(0);
  /** The user moved through the suggestions: Enter then takes one instead of running. */
  let navigated = false;
  let history = new History([]);
  let output = $state<HTMLElement | undefined>(undefined);
  let field = $state<HTMLTextAreaElement | undefined>(undefined);
  /** Bumped per keystroke; a key list that arrives late is dropped. */
  let typing = 0;

  const commands = $derived<readonly ConsoleCommandDoc[]>(consoleState?.commands ?? []);
  const current = $derived(commandOf(input, commands));

  onMount(() => {
    const subscriptions = [
      rpc.on('state', (next) => {
        consoleState = next;
        history = new History([...next.history]);
      }),
      rpc.on('output', (entry) => {
        entries = [...entries, entry].slice(-MAX_ENTRIES);
        void scrollDown();
      }),
      rpc.on('database', ({ database }) => {
        if (consoleState !== undefined) {
          consoleState = { ...consoleState, database };
        }
      }),
    ];
    rpc.emit('ready', {});
    return () => {
      for (const subscription of subscriptions) {
        subscription.dispose();
      }
    };
  });

  async function scrollDown(): Promise<void> {
    await tick();
    if (output !== undefined) {
      output.scrollTop = output.scrollHeight;
    }
  }

  async function suggest(): Promise<void> {
    const mine = ++typing;
    const names = suggestCommands(input, commands);
    if (names.length > 0) {
      navigated = false;
      suggestions = names.map((doc) => ({
        label: doc.name,
        ...(doc.summary === undefined ? {} : { detail: doc.summary }),
        insert: doc.name,
        words: doc.name.split(' ').length,
      }));
      active = 0;
      return;
    }
    const prefix = keyPrefix(input, commands);
    if (prefix === undefined || prefix === '') {
      suggestions = [];
      return;
    }
    try {
      const { keys } = await rpc.request('completeKeys', { prefix });
      if (mine === typing) {
        suggestions = keys.map((key) => ({ label: key, insert: keyWord(key), words: 1 }));
        active = 0;
      }
    } catch {
      // Without key names the console still works: nothing to suggest.
      suggestions = [];
    }
  }

  function accept(index: number): void {
    const chosen = suggestions[index];
    if (chosen === undefined) {
      return;
    }
    input = complete(input, chosen.insert, chosen.words);
    suggestions = [];
    navigated = false;
    field?.focus();
  }

  async function run(): Promise<void> {
    const text = input;
    if (text.trim() === '' || running) {
      return;
    }
    history.add(text.trim());
    input = '';
    suggestions = [];
    running = true;
    try {
      await rpc.request('run', { text });
    } catch (error) {
      entries = [
        ...entries,
        { command: text, lines: [`(error) ${error instanceof Error ? error.message : String(error)}`], error: true },
      ];
    } finally {
      running = false;
      void scrollDown();
    }
  }

  function keydown(event: KeyboardEvent): void {
    const open = suggestions.length > 0;
    if (open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      active = (active + step + suggestions.length) % suggestions.length;
      navigated = true;
      return;
    }
    if (open && (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey && navigated))) {
      event.preventDefault();
      accept(active);
      return;
    }
    if (event.key === 'Escape') {
      suggestions = [];
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void run();
      return;
    }
    if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !input.includes('\n')) {
      const next = event.key === 'ArrowUp' ? history.up(input) : history.down();
      if (next !== undefined) {
        event.preventDefault();
        input = next;
      }
      return;
    }
    if (event.key === 'l' && event.ctrlKey) {
      event.preventDefault();
      entries = [];
    }
  }
</script>

<main>
  {#if consoleState === undefined}
    <p class="hint">{t('console.loading')}</p>
  {:else}
    <header class="bar">
      <span data-testid="where">
        {consoleState.connectionName} · db{consoleState.database}{consoleState.mode === 'standalone'
          ? ''
          : ` · ${consoleState.mode}`}
      </span>
      {#if consoleState.readOnly}
        <span class="badge">{t('redis.readOnly')}</span>
      {/if}
      {#if consoleState.production}
        <span class="badge warn">{t('console.production')}</span>
      {/if}
      <span class="grow"></span>
      <button
        type="button"
        class="button secondary"
        disabled={!running}
        onclick={() => void rpc.request('stop', {})}>{t('console.stop')}</button
      >
      <button
        type="button"
        class="button secondary"
        onclick={() => {
          entries = [];
        }}>{t('console.clear')}</button
      >
    </header>

    <section class="output" bind:this={output} aria-live="polite" data-testid="output">
      {#if entries.length === 0}
        <p class="hint">{t('console.welcome')}</p>
      {/if}
      {#each entries as entry, index (index)}
        <div class="entry" class:failed={entry.error}>
          <div class="command">
            <span class="prompt">&gt;</span> {entry.command}
            {#if entry.ms !== undefined}<span class="time">{t('console.ms', entry.ms)}</span>{/if}
          </div>
          <pre>{entry.lines.join('\n')}</pre>
        </div>
      {/each}
    </section>

    <section class="input">
      {#if suggestions.length > 0}
        <ul class="suggestions" role="listbox" aria-label={t('console.suggestions')}>
          {#each suggestions as item, index (item.label)}
            <li
              role="option"
              aria-selected={index === active}
              class:active={index === active}
              onmousedown={(event) => {
                event.preventDefault();
                accept(index);
              }}
            >
              <span class="name">{item.label}</span>
              {#if item.detail !== undefined}<span class="detail">{item.detail}</span>{/if}
            </li>
          {/each}
        </ul>
      {/if}
      <textarea
        class="control code"
        rows="2"
        bind:this={field}
        bind:value={input}
        oninput={() => void suggest()}
        onkeydown={keydown}
        placeholder={t('console.placeholder')}
        aria-label={t('console.input')}
        spellcheck="false"
        autocomplete="off"
      ></textarea>
      <p class="syntax" data-testid="syntax">
        {#if current !== undefined}
          <code>{syntaxLine(current)}</code>
          {#if current.summary !== undefined}<span class="detail"> — {current.summary}</span>{/if}
        {:else}
          <span class="hint">{t('console.keys')}</span>
        {/if}
      </p>
    </section>
  {/if}
</main>

<style>
  main {
    display: flex;
    flex-direction: column;
    height: 100vh;
    box-sizing: border-box;
    padding: 8px 12px;
    gap: 8px;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .grow {
    flex: 1;
  }
  .badge {
    border: 1px solid var(--vscode-focusBorder);
    padding: 0 6px;
    border-radius: 3px;
  }
  .badge.warn {
    border-color: var(--vscode-errorForeground);
  }
  .output {
    flex: 1;
    overflow: auto;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-editor-font-size, 13px);
  }
  .entry {
    margin-bottom: 8px;
  }
  .command {
    color: var(--vscode-textLink-foreground);
  }
  .time {
    color: var(--vscode-descriptionForeground);
    margin-left: 8px;
  }
  .entry pre {
    margin: 2px 0 0 14px;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .entry.failed pre {
    color: var(--vscode-errorForeground);
  }
  .input {
    position: relative;
  }
  .code {
    width: 100%;
    box-sizing: border-box;
    font-family: var(--vscode-editor-font-family, monospace);
    resize: vertical;
  }
  .suggestions {
    position: absolute;
    bottom: 100%;
    left: 0;
    right: 0;
    max-height: 240px;
    overflow: auto;
    margin: 0;
    padding: 0;
    list-style: none;
    background: var(--vscode-editorSuggestWidget-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-editorSuggestWidget-border, var(--vscode-focusBorder));
    z-index: 1;
  }
  .suggestions li {
    padding: 2px 8px;
    cursor: pointer;
    display: flex;
    gap: 12px;
    white-space: nowrap;
    overflow: hidden;
  }
  .suggestions li.active {
    background: var(--vscode-editorSuggestWidget-selectedBackground, var(--vscode-list-activeSelectionBackground));
  }
  .name {
    font-family: var(--vscode-editor-font-family, monospace);
  }
  .detail,
  .hint {
    color: var(--vscode-descriptionForeground);
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .syntax {
    margin: 4px 0 0;
    min-height: 1.4em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>

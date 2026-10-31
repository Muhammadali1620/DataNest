<script lang="ts">
  import { onMount, tick } from 'svelte';
  import type {
    ConsoleCommandDoc,
    ConsoleOutput,
    RedisConsoleProtocol,
    RedisConsoleState,
  } from '../../../../src/shared/protocols/redis-console';
  import type { RpcPeer } from '../../../../src/shared/rpc';
  import Icon from '../../components/Icon.svelte';
  import IconButton from '../../components/IconButton.svelte';
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
  {#if running}
    <div class="progress-bar" aria-hidden="true"></div>
  {/if}
  {#if consoleState === undefined}
    <div class="empty">
      <span class="empty-icon"><Icon name="loading" spin size={24} /></span>
      <p class="empty-title">{t('console.loading')}</p>
    </div>
  {:else}
    <header class="bar">
      <span class="where-icon"><Icon name="terminal" /></span>
      <span class="where" data-testid="where">
        {consoleState.connectionName} · db{consoleState.database}{consoleState.mode === 'standalone'
          ? ''
          : ` · ${consoleState.mode}`}
      </span>
      {#if consoleState.readOnly}
        <span class="badge outline"><Icon name="lock" size={12} />{t('redis.readOnly')}</span>
      {/if}
      {#if consoleState.production}
        <span class="badge danger"><Icon name="flame" size={12} />{t('console.production')}</span>
      {/if}
      <span class="grow"></span>
      <div class="toolbar">
        <IconButton
          icon="debug-stop"
          label={t('console.stop')}
          disabled={!running}
          onclick={() => void rpc.request('stop', {})}
        />
        <IconButton
          icon="clear-all"
          label={t('console.clear')}
          hint={`${t('console.clear')} (Ctrl+L)`}
          onclick={() => {
            entries = [];
          }}
        />
      </div>
    </header>

    <section class="output" bind:this={output} aria-live="polite" data-testid="output">
      {#if entries.length === 0}
        <div class="welcome">
          <span class="empty-icon"><Icon name="terminal" size={24} /></span>
          <p class="welcome-text">{t('console.welcome')}</p>
        </div>
      {/if}
      {#each entries as entry, index (index)}
        <div class="entry" class:failed={entry.error}>
          <div class="command">
            <span class="prompt"><Icon name="chevron-right" size={14} /></span>
            <span class="command-text">{entry.command}</span>
            {#if entry.ms !== undefined}<span class="time">{t('console.ms', entry.ms)}</span>{/if}
          </div>
          <pre class="lines">{entry.lines.join('\n')}</pre>
        </div>
      {/each}
    </section>

    <section class="input">
      {#if suggestions.length > 0}
        <ul class="suggestions fade-in" role="listbox" aria-label={t('console.suggestions')}>
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
      <div class="line">
        <span class="prompt"><Icon name="chevron-right" /></span>
        <textarea
          class="code"
          rows="1"
          bind:this={field}
          bind:value={input}
          oninput={() => void suggest()}
          onkeydown={keydown}
          placeholder={t('console.placeholder')}
          aria-label={t('console.input')}
          spellcheck="false"
          autocomplete="off"
        ></textarea>
        <IconButton
          icon="play"
          label={t('console.run')}
          hint={`${t('console.run')} (Enter)`}
          disabled={running || input.trim() === ''}
          onclick={() => {
            void run();
            field?.focus();
          }}
        />
      </div>
      <p class="syntax" data-testid="syntax">
        {#if current !== undefined}
          <code>{syntaxLine(current)}</code>
          {#if current.summary !== undefined}<span class="detail"> — {current.summary}</span>{/if}
        {:else}
          <span class="detail">{t('console.keys')}</span>
        {/if}
      </p>
    </section>
  {/if}
</main>

<style>
  main {
    /* A terminal: the theme's terminal colours, the editor's font. */
    --dn-term-background: var(--vscode-terminal-background, var(--vscode-panel-background, var(--vscode-editor-background)));
    --dn-term-foreground: var(--vscode-terminal-foreground, var(--vscode-foreground));
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100vh;
    background: var(--dn-term-background);
  }

  .grow {
    flex: 1;
  }

  .bar {
    display: flex;
    flex: none;
    flex-wrap: wrap;
    gap: var(--dn-gap);
    align-items: center;
    min-height: 34px;
    padding: 4px var(--dn-gap) 4px var(--dn-gap-m);
    background: var(--vscode-editor-background);
    border-bottom: 1px solid var(--dn-divider);
  }

  .where-icon {
    display: inline-flex;
    color: var(--dn-muted);
  }

  .where {
    font-weight: 600;
  }

  /* The log: each command with its prompt and time, its answer below. */
  .output {
    flex: 1;
    min-height: 0;
    padding: var(--dn-gap) var(--dn-gap-m);
    overflow: auto;
    color: var(--dn-term-foreground);
    font-family: var(--dn-mono);
    font-size: var(--vscode-editor-font-size, 13px);
    line-height: 1.45;
  }

  .entry {
    padding: 4px 0 6px;
  }

  .entry + .entry {
    border-top: 1px solid var(--vscode-terminal-border, var(--dn-divider));
  }

  .command {
    display: flex;
    gap: 6px;
    align-items: center;
  }

  .prompt {
    display: inline-flex;
    flex: none;
    color: var(--vscode-terminal-ansiGreen, var(--dn-success));
  }

  .command-text {
    flex: 1;
    min-width: 0;
    font-weight: 600;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }

  .time {
    flex: none;
    color: var(--dn-muted);
    font-family: var(--vscode-font-family);
    font-size: 11px;
  }

  .lines {
    margin: 2px 0 0 20px;
    font: inherit;
    white-space: pre-wrap;
    word-break: break-all;
  }

  .entry.failed .prompt,
  .entry.failed .lines {
    color: var(--vscode-terminal-ansiRed, var(--dn-danger));
  }

  .welcome {
    display: flex;
    flex-direction: column;
    gap: var(--dn-gap);
    align-items: center;
    justify-content: center;
    min-height: 100%;
    padding: var(--dn-gap-xl);
    text-align: center;
  }

  .welcome-text {
    max-width: 460px;
    margin: 0;
    color: var(--dn-muted);
    font-family: var(--vscode-font-family);
  }

  /* The command line, pinned at the bottom. */
  .input {
    position: relative;
    flex: none;
    padding: 6px var(--dn-gap) 4px var(--dn-gap-m);
    background: var(--vscode-editor-background);
    border-top: 1px solid var(--dn-divider);
  }

  .line {
    display: flex;
    gap: 6px;
    align-items: flex-start;
    padding: 2px 2px 2px 6px;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--dn-border));
    border-radius: var(--dn-radius);
    transition: border-color var(--dn-duration) var(--dn-ease);
  }

  .line:focus-within {
    border-color: var(--vscode-focusBorder);
  }

  .line .prompt {
    margin-top: 3px;
  }

  .code {
    flex: 1;
    min-width: 0;
    min-height: 24px;
    max-height: 30vh;
    padding: 3px 0;
    color: var(--vscode-input-foreground);
    background: transparent;
    border: none;
    outline: none;
    font-family: var(--dn-mono);
    font-size: var(--vscode-editor-font-size, 13px);
    line-height: 18px;
    resize: none;
    field-sizing: content;
  }

  .code::placeholder {
    color: var(--vscode-input-placeholderForeground);
  }

  .suggestions {
    position: absolute;
    right: var(--dn-gap);
    bottom: calc(100% - 2px);
    left: var(--dn-gap-m);
    z-index: 1;
    max-height: 240px;
    margin: 0;
    padding: 4px;
    overflow: auto;
    color: var(--vscode-editorSuggestWidget-foreground, var(--vscode-foreground));
    list-style: none;
    background: var(--vscode-editorSuggestWidget-background, var(--dn-surface));
    border: 1px solid var(--vscode-editorSuggestWidget-border, var(--dn-border));
    border-radius: var(--dn-radius-l);
    box-shadow: var(--dn-shadow);
  }

  .suggestions li {
    display: flex;
    gap: 12px;
    align-items: baseline;
    padding: 2px 8px;
    overflow: hidden;
    border-radius: var(--dn-radius);
    white-space: nowrap;
    cursor: pointer;
  }

  .suggestions li:hover {
    background: var(--vscode-list-hoverBackground);
  }

  .suggestions li.active {
    color: var(--vscode-editorSuggestWidget-selectedForeground, var(--vscode-list-activeSelectionForeground));
    background: var(--vscode-editorSuggestWidget-selectedBackground, var(--vscode-list-activeSelectionBackground));
  }

  .name {
    font-family: var(--dn-mono);
  }

  .detail {
    overflow: hidden;
    color: var(--dn-muted);
    text-overflow: ellipsis;
  }

  .suggestions li.active .detail {
    color: inherit;
    opacity: 0.8;
  }

  .syntax {
    min-height: 18px;
    margin: 4px 0 0 2px;
    overflow: hidden;
    font-size: var(--dn-font-small);
    line-height: 18px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .syntax code {
    color: var(--vscode-textPreformat-foreground, var(--vscode-foreground));
  }

  /* Waiting for the server: centred. */
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

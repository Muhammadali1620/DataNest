<script lang="ts">
  import { untrack } from 'svelte';
  import Icon from '../../components/Icon.svelte';
  import IconButton from '../../components/IconButton.svelte';
  import type { Translate } from '../../lib/i18n';

  interface Props {
    /** The statement that produced the result on screen. */
    statement: string;
    /** True while a statement runs; the run button waits then. */
    running: boolean;
    /** Runs the text; resolves to the server's message when it failed. */
    onRun: (sql: string) => Promise<string | undefined>;
    /** The Run key's modifier as the user's keyboard labels it, for the tooltip. */
    modifier: string;
    t: Translate;
  }

  const { statement, running, onRun, modifier, t }: Props = $props();

  // The bar is created afresh for every result (a keyed block in the parent), so the
  // draft starts from the statement once and is never re-derived while the user types.
  let draft = $state(untrack(() => statement));
  let problem = $state<string | undefined>(undefined);
  let busy = $state(false);

  const changed = $derived(draft !== statement);
  const lines = $derived(Math.min(6, Math.max(1, draft.split('\n').length)));

  async function run(): Promise<void> {
    if (busy || running || draft.trim() === '') {
      return;
    }
    busy = true;
    problem = await onRun(draft);
    busy = false;
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void run();
    }
  }
</script>

<div class="sqlbar" data-testid="sql-bar">
  <div class="field-box" class:failed={problem !== undefined}>
    <span class="sql-icon"><Icon name="code" size={14} /></span>
    <textarea
      class="sql"
      rows={lines}
      spellcheck="false"
      aria-label={t('sql.label')}
      placeholder={t('sql.placeholder')}
      bind:value={draft}
      onkeydown={onKey}
      data-testid="sql-input"
    ></textarea>
    {#if changed}
      <IconButton
        icon="discard"
        tone="orange"
        label={t('sql.reset')}
        onclick={() => {
          draft = statement;
          problem = undefined;
        }}
      />
    {/if}
    <IconButton
      icon={busy || running ? 'loading' : 'play'}
      spin={busy || running}
      tone="green"
      label={t('sql.run')}
      hint={t('sql.runHint', modifier)}
      disabled={busy || running || draft.trim() === ''}
      data-testid="sql-run"
      onclick={() => {
        void run();
      }}
    />
  </div>
  {#if problem !== undefined}
    <p class="problem" role="alert" data-testid="sql-problem"><Icon name="error" size={14} />{problem}</p>
  {/if}
</div>

<style>
  .sqlbar {
    flex: none;
    padding: 8px 10px 0;
  }

  .field-box {
    display: flex;
    gap: 6px;
    align-items: flex-start;
    padding: 4px 6px 4px 10px;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--dn-border));
    border-radius: 12px;
    transition: border-color var(--dn-duration) var(--dn-ease);
  }

  .field-box:focus-within {
    border-color: var(--vscode-focusBorder);
  }

  .field-box.failed {
    border-color: var(--dn-danger);
  }

  .sql-icon {
    display: inline-flex;
    padding-top: 7px;
    color: var(--vscode-charts-green, var(--dn-success));
  }

  .sql {
    flex: 1;
    min-width: 0;
    padding: 4px 0;
    color: var(--vscode-input-foreground);
    background: transparent;
    border: none;
    outline: none;
    font-family: var(--dn-mono);
    font-size: 13px;
    line-height: 20px;
    resize: none;
  }

  .problem {
    display: flex;
    gap: 6px;
    align-items: center;
    margin: 6px 4px 0;
    color: var(--dn-danger);
    font-size: var(--dn-font-small);
  }
</style>

<script lang="ts">
  import type { RedisValue } from '../../../../src/shared/redis-value';
  import type { Translate } from '../../lib/i18n';
  import { initialMode, shownText, typedValue, type ValueMode } from './key-view';

  interface Props {
    /** The value as the server has it; the parent keys this component by item. */
    value: RedisValue;
    label: string;
    t: Translate;
    readonly?: boolean;
    rows?: number;
    /** What the user typed, as a value; undefined while hex does not parse. */
    onchange: (value: RedisValue | undefined) => void;
  }

  const { value, label, t, readonly = false, rows = 4, onchange }: Props = $props();

  // The component is recreated per item, so the first value is all it needs.
  // svelte-ignore state_referenced_locally
  let mode = $state<ValueMode>(initialMode(value));
  // svelte-ignore state_referenced_locally
  let typed = $state(shownText(value, mode));
  const broken = $derived(typedValue(typed, mode) === undefined);
  const locked = $derived(readonly || value.truncated === true);

  function switchTo(next: ValueMode): void {
    const current = typedValue(typed, mode);
    if (current === undefined || next === mode) {
      return;
    }
    mode = next;
    typed = shownText(current, next);
  }

  function input(event: Event & { currentTarget: HTMLTextAreaElement }): void {
    typed = event.currentTarget.value;
    onchange(typedValue(typed, mode));
  }
</script>

<div class="value">
  <div class="bar">
    <span class="label">{label}</span>
    <span class="modes" role="group" aria-label={t('redis.view')}>
      {#each ['text', 'json', 'hex'] as const as option (option)}
        <button
          type="button"
          class="mode"
          class:active={mode === option}
          aria-pressed={mode === option}
          disabled={broken}
          onclick={() => {
            switchTo(option);
          }}>{t(`redis.mode.${option}`)}</button
        >
      {/each}
    </span>
  </div>
  <textarea
    class="control code"
    {rows}
    value={typed}
    readonly={locked}
    aria-label={label}
    aria-invalid={broken}
    spellcheck="false"
    oninput={input}
  ></textarea>
  {#if value.truncated === true}
    <span class="hint" data-testid="truncated">{t('redis.truncated', value.size ?? 0)}</span>
  {:else if broken}
    <span class="error" role="alert">{t('redis.badHex')}</span>
  {/if}
</div>

<style>
  .value {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .modes {
    display: flex;
    gap: 2px;
  }
  .mode {
    background: transparent;
    color: var(--vscode-foreground);
    border: 1px solid transparent;
    padding: 1px 6px;
    cursor: pointer;
  }
  .mode.active {
    border-color: var(--vscode-focusBorder);
  }
  .code {
    font-family: var(--vscode-editor-font-family, monospace);
    resize: vertical;
    width: 100%;
    box-sizing: border-box;
  }
  .hint {
    color: var(--vscode-descriptionForeground);
  }
  .error {
    color: var(--vscode-errorForeground);
  }
</style>

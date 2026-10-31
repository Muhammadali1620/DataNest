<script lang="ts">
  import type { RedisValue } from '../../../../src/shared/redis-value';
  import Icon from '../../components/Icon.svelte';
  import type { Translate } from '../../lib/i18n';
  import { initialMode, shownText, typedValue, type ValueMode } from './key-view';

  interface Props {
    /** The value as the server has it; the parent keys this component by item. */
    value: RedisValue;
    label: string;
    t: Translate;
    readonly?: boolean;
    rows?: number;
    /** Fills the height it is given, for the value of a string key. */
    grow?: boolean;
    /** What the user typed, as a value; undefined while hex does not parse. */
    onchange: (value: RedisValue | undefined) => void;
  }

  const { value, label, t, readonly = false, rows = 4, grow = false, onchange }: Props = $props();

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

<div class="value" class:grow>
  <div class="bar">
    <span class="label">{label}</span>
    {#if locked}<span class="lock" title={t('redis.readOnly')}><Icon name="lock" size={12} /></span>{/if}
    <span class="modes" role="group" aria-label={t('redis.view')}>
      {#each ['text', 'json', 'hex'] as const as option (option)}
        <button
          type="button"
          class="mode"
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
    <p class="notice warning" data-testid="truncated"><Icon name="warning" /><span>{t('redis.truncated', value.size ?? 0)}</span></p>
  {:else if broken}
    <p class="problem" role="alert"><Icon name="error" size={14} /><span>{t('redis.badHex')}</span></p>
  {/if}
</div>

<style>
  .value {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-height: 0;
  }

  .value.grow {
    flex: 1;
  }

  .bar {
    display: flex;
    gap: 6px;
    align-items: center;
  }

  .label {
    color: var(--dn-muted);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .lock {
    display: inline-flex;
    color: var(--dn-muted);
  }

  /* Text, JSON or hex: a segmented switch like the editor's find options. */
  .modes {
    display: inline-flex;
    margin-left: auto;
    padding: 1px;
    border: 1px solid var(--dn-border);
    border-radius: var(--dn-radius);
  }

  .mode {
    height: 20px;
    padding: 0 8px;
    color: var(--dn-muted);
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--dn-radius-s);
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
    transition:
      color var(--dn-duration) var(--dn-ease),
      background-color var(--dn-duration) var(--dn-ease);
  }

  .mode:hover:not(:disabled) {
    color: var(--vscode-foreground);
    background: var(--dn-hover);
  }

  .mode[aria-pressed='true'] {
    color: var(--vscode-inputOption-activeForeground, var(--vscode-foreground));
    background: var(--vscode-inputOption-activeBackground, var(--dn-pressed));
    border-color: var(--vscode-inputOption-activeBorder, transparent);
  }

  .mode:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .code {
    width: 100%;
    font-family: var(--dn-mono);
    font-size: var(--vscode-editor-font-size, 13px);
    background: var(--dn-surface);
  }

  .grow .code {
    flex: 1;
    resize: none;
  }

  .notice {
    margin: 0;
  }

  .problem {
    display: flex;
    gap: 6px;
    align-items: center;
    margin: 0;
    color: var(--dn-danger);
    font-size: var(--dn-font-small);
  }
</style>

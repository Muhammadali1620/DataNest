<script lang="ts">
  // An ordered choice of columns: chips in key order, and a list to add the rest.
  import type { Translate } from '../../lib/i18n';

  interface Option {
    readonly value: string;
    readonly label: string;
  }

  interface Props {
    options: readonly Option[];
    selected: readonly string[];
    /** What the picker is for, used in its accessible names. */
    label: string;
    t: Translate;
    onchange: (selected: string[]) => void;
  }

  const { options, selected, label, t, onchange }: Props = $props();

  const labels = $derived(new Map(options.map((option) => [option.value, option.label])));
  const remaining = $derived(options.filter((option) => !selected.includes(option.value)));

  function add(value: string): void {
    if (value !== '' && !selected.includes(value)) {
      onchange([...selected, value]);
    }
  }

  function remove(value: string): void {
    onchange(selected.filter((item) => item !== value));
  }
</script>

<div class="picker">
  {#each selected as value (value)}
    {@const text = labels.get(value) ?? value}
    <span class="chip">
      {text}
      <button
        class="remove"
        aria-label={t('designer.pickRemove', text, label)}
        onclick={() => {
          remove(value);
        }}>✕</button
      >
    </span>
  {/each}
  {#if remaining.length > 0}
    <select
      class="control"
      aria-label={t('designer.pickAdd', label)}
      value=""
      onchange={(event) => {
        const select = event.currentTarget;
        add(select.value);
        select.value = '';
      }}
    >
      <option value="">{t('designer.pickPlaceholder')}</option>
      {#each remaining as option (option.value)}
        <option value={option.value}>{option.label}</option>
      {/each}
    </select>
  {/if}
</div>

<style>
  .picker {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 1px 2px 1px 6px;
    color: var(--vscode-badge-foreground);
    background: var(--vscode-badge-background);
    border-radius: 2px;
  }

  .remove {
    padding: 0 3px;
    color: inherit;
    background: none;
    border: none;
    cursor: pointer;
  }
</style>

<script lang="ts">
  // An ordered choice of columns: chips in key order, and a menu to add the rest.
  import Icon from '../../components/Icon.svelte';
  import MenuButton from '../../components/MenuButton.svelte';
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
    /** The test id of the add menu. */
    testid?: string | undefined;
  }

  const { options, selected, label, t, onchange, testid }: Props = $props();

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
  {#each selected as value, position (value)}
    {@const text = labels.get(value) ?? value}
    <span class="chip">
      {#if selected.length > 1}<span class="position" data-position={position + 1}></span>{/if}
      <span class="chip-text">{text}</span>
      <button
        type="button"
        class="remove"
        aria-label={t('designer.pickRemove', text, label)}
        title={t('designer.pickRemove', text, label)}
        onclick={() => {
          remove(value);
        }}><Icon name="close" size={12} /></button
      >
    </span>
  {/each}
  {#if remaining.length > 0}
    <MenuButton
      icon="add"
      label={t('designer.pickAdd', label)}
      align="start"
      {testid}
      items={remaining.map((option) => ({ id: option.value, label: option.label }))}
      onSelect={add}
    />
  {:else if selected.length === 0}
    <span class="muted small">{t('designer.pickNothing')}</span>
  {/if}
</div>

<style>
  .picker {
    display: flex;
    flex-wrap: wrap;
    gap: var(--dn-gap-s);
    align-items: center;
    min-height: var(--dn-control-height);
  }

  .chip {
    display: inline-flex;
    gap: var(--dn-gap-s);
    align-items: center;
    height: 22px;
    padding: 0 2px 0 8px;
    color: var(--vscode-badge-foreground);
    background: var(--vscode-badge-background);
    border: 1px solid var(--vscode-contrastBorder, transparent);
    border-radius: 11px;
    font-size: var(--dn-font-small);
    white-space: nowrap;
  }

  /* The place of a column in the key, drawn from an attribute: it is not part of the name. */
  .position::before {
    content: attr(data-position);
    opacity: 0.7;
    font-variant-numeric: tabular-nums;
  }

  .remove {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    padding: 0;
    color: inherit;
    background: none;
    border: none;
    border-radius: 50%;
    cursor: pointer;
    opacity: 0.8;
    transition: background-color var(--dn-duration) var(--dn-ease);
  }

  .remove:hover {
    background: var(--dn-hover);
    opacity: 1;
  }
</style>

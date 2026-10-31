<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import Icon from '../../components/Icon.svelte';
  import IconButton from '../../components/IconButton.svelte';
  import type { MessageKey } from '../../l10n/en';
  import type { Translate } from '../../lib/i18n';
  import { FILTER_OPERATORS, type FilterOperator, needsValue } from '../../../../src/shared/table-filter';
  import type { DistinctValues } from './column-filter';

  interface Props {
    columnName: string;
    /** Where the header's funnel is, so the popover opens under it. */
    anchor: { left: number; bottom: number };
    values: DistinctValues;
    /** What this column is filtered by now, to start from. */
    current: { operator: FilterOperator; value?: string | undefined } | undefined;
    /** Applies one condition, or removes the column's filter when undefined. */
    onApply: (condition: { operator: FilterOperator; value?: string } | undefined) => void;
    onClose: () => void;
    t: Translate;
  }

  const { columnName, anchor, values, current, onApply, onClose, t }: Props = $props();

  let operator = $state<FilterOperator>(untrack(() => current?.operator ?? 'contains'));
  let text = $state(untrack(() => current?.value ?? ''));
  let search = $state('');
  let input = $state<HTMLInputElement | undefined>(undefined);

  const shown = $derived(
    values.values.filter((value) => value.toLowerCase().includes(search.trim().toLowerCase())),
  );
  const valueless = $derived(!needsValue(operator));
  const canApply = $derived(valueless || text !== '');
  // Opens under the funnel but never outside the page.
  const left = $derived(Math.max(8, Math.min(anchor.left - 240, window.innerWidth - 328)));

  onMount(() => {
    input?.focus();
  });

  function apply(): void {
    if (!canApply) {
      return;
    }
    onApply(valueless ? { operator } : { operator, value: text });
  }

  function pick(value: string): void {
    onApply({ operator: 'eq', value });
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      apply();
    }
  }
</script>

<svelte:window
  onpointerdown={(event: PointerEvent) => {
    if (!(event.target as Element | null)?.closest('.col-filter, [data-testid="column-filter"]')) {
      onClose();
    }
  }}
/>

<div
  class="col-filter fade-in"
  role="dialog"
  aria-label={t('colfilter.title', columnName)}
  data-testid="column-filter-popover"
  tabindex="-1"
  style="top: {anchor.bottom + 6}px; left: {left}px;"
  onkeydown={onKey}
>
  <div class="head">
    <Icon name="filter" size={16} />
    <h2>{t('colfilter.title', columnName)}</h2>
    <span class="grow"></span>
    <IconButton icon="close" label={t('dialog.close')} onclick={onClose} />
  </div>

  <select class="control" aria-label={t('filter.operator')} bind:value={operator} data-testid="colfilter-operator">
    {#each FILTER_OPERATORS as item (item)}
      <option value={item}>{t(`filter.op.${item}` as MessageKey)}</option>
    {/each}
  </select>
  {#if !valueless}
    <input
      bind:this={input}
      class="control"
      type="text"
      bind:value={text}
      placeholder={t('colfilter.value')}
      aria-label={t('colfilter.value')}
      data-testid="colfilter-value"
    />
  {/if}

  {#if values.values.length > 0}
    <div class="values-head">
      <span>{t('colfilter.values')}</span>
      <input
        class="control small"
        type="search"
        bind:value={search}
        placeholder={t('colfilter.search')}
        aria-label={t('colfilter.search')}
      />
    </div>
    <ul class="values" data-testid="colfilter-values">
      {#each shown as value (value)}
        <li>
          <button type="button" class="value" title={value} onclick={() => { pick(value); }}>{value === '' ? t('colfilter.empty') : value}</button>
        </li>
      {/each}
      {#if shown.length === 0}<li class="none">{t('colfilter.noMatch')}</li>{/if}
    </ul>
    {#if values.more}<p class="more">{t('colfilter.more', values.values.length)}</p>{/if}
  {/if}

  <div class="foot">
    <button type="button" class="button secondary" data-testid="colfilter-clear" onclick={() => { onApply(undefined); }}>
      <Icon name="clear-all" />{t('colfilter.clear')}
    </button>
    <button type="button" class="button" disabled={!canApply} data-testid="colfilter-apply" onclick={apply}>
      <Icon name="filter" />{t('colfilter.apply')}
    </button>
  </div>
</div>

<style>
  .col-filter {
    position: fixed;
    z-index: 40;
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 320px;
    max-height: min(520px, 80vh);
    padding: 12px;
    background: var(--dn-surface);
    border: 1px solid var(--dn-border);
    border-radius: 14px;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
  }

  .head,
  .values-head,
  .foot {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  h2 {
    margin: 0;
    overflow: hidden;
    font-size: 13px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .grow {
    flex: 1;
  }

  .values-head {
    justify-content: space-between;
    color: var(--dn-muted);
    font-size: var(--dn-font-small);
  }

  .small {
    width: 140px;
    min-height: 24px;
  }

  .values {
    min-height: 0;
    margin: 0;
    padding: 4px;
    overflow: auto;
    list-style: none;
    border: 1px solid var(--dn-border);
    border-radius: 10px;
  }

  .value {
    display: block;
    width: 100%;
    padding: 4px 8px;
    overflow: hidden;
    color: inherit;
    font: inherit;
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
    background: none;
    border: none;
    border-radius: 6px;
    cursor: pointer;
  }

  .value:hover {
    background: var(--dn-hover);
  }

  .none,
  .more {
    margin: 0;
    padding: 4px 8px;
    color: var(--dn-muted);
    font-size: var(--dn-font-small);
  }

  .foot {
    justify-content: flex-end;
  }
</style>

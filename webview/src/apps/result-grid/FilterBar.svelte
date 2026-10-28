<script lang="ts">
  import { untrack } from 'svelte';
  import {
    FILTER_OPERATORS,
    MAX_FILTER_CONDITIONS,
    needsValue,
    type TableFilter,
  } from '../../../../src/shared/table-filter';
  import type { MessageKey } from '../../l10n/en';
  import type { Translate } from '../../lib/i18n';
  import {
    addCondition,
    type Draft,
    draftOf,
    draftProblems,
    filterOf,
    isUnchanged,
    removeCondition,
    updateCondition,
  } from './filter-model';

  interface Props {
    /** Columns of the table, for the column pickers; empty when none are known. */
    columns: readonly string[];
    /** The filter the rows on screen were read with. */
    applied: TableFilter | undefined;
    /** True while a request is in flight. */
    busy: boolean;
    /** Sends a filter, or null to remove it. */
    onApply: (filter: TableFilter | null) => void;
    t: Translate;
  }

  const { columns, applied, busy, onApply, t }: Props = $props();

  // The bar is created afresh for every result, so the draft starts from what is
  // applied once and is never re-derived from it while the user types.
  let draft = $state<Draft>(untrack(() => draftOf(applied)));

  const problems = $derived(draftProblems(draft));
  const unchanged = $derived(isUnchanged(draft, applied));
  const canApply = $derived(!busy && problems.size === 0 && !unchanged);
  const hasAnything = $derived(draft.conditions.length > 0 || draft.where.trim() !== '');

  function apply(): void {
    if (!canApply) {
      return;
    }
    const filter = filterOf(draft);
    onApply(filter.conditions.length === 0 && filter.where === undefined ? null : filter);
  }

  function clear(): void {
    draft = draftOf(undefined);
    if (applied !== undefined) {
      onApply(null);
    }
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      apply();
    }
  }
</script>

<div class="filter" data-testid="filter-bar" role="group" aria-label={t('filter.title')}>
  {#each draft.conditions as condition (condition.id)}
    <div class="row" data-testid="filter-row">
      {#if columns.length > 0}
        <select
          class="control"
          aria-label={t('filter.column')}
          value={condition.column}
          onchange={(event) => {
            draft = updateCondition(draft, condition.id, { column: event.currentTarget.value });
          }}
        >
          {#if !columns.includes(condition.column)}
            <option value={condition.column}>{condition.column}</option>
          {/if}
          {#each columns as name (name)}
            <option value={name}>{name}</option>
          {/each}
        </select>
      {:else}
        <input
          class="control"
          aria-label={t('filter.column')}
          value={condition.column}
          oninput={(event) => {
            draft = updateCondition(draft, condition.id, { column: event.currentTarget.value });
          }}
        />
      {/if}
      <select
        class="control"
        aria-label={t('filter.operator')}
        value={condition.operator}
        onchange={(event) => {
          const operator = FILTER_OPERATORS.find((item) => item === event.currentTarget.value);
          if (operator !== undefined) {
            draft = updateCondition(draft, condition.id, { operator });
          }
        }}
      >
        {#each FILTER_OPERATORS as operator (operator)}
          <option value={operator}>{t(`filter.op.${operator}` as MessageKey)}</option>
        {/each}
      </select>
      {#if needsValue(condition.operator)}
        <input
          class="control value"
          class:incomplete={problems.get(condition.id) === 'missing-value'}
          aria-label={t('filter.value')}
          placeholder={t('filter.value')}
          value={condition.value}
          oninput={(event) => {
            draft = updateCondition(draft, condition.id, { value: event.currentTarget.value });
          }}
          onkeydown={onKey}
        />
      {:else}
        <span class="value"></span>
      {/if}
      <button
        type="button"
        class="icon"
        aria-label={t('filter.removeCondition')}
        title={t('filter.removeCondition')}
        onclick={() => {
          draft = removeCondition(draft, condition.id);
        }}
      >
        ×
      </button>
    </div>
  {/each}
  <div class="row">
    <button
      type="button"
      class="action"
      data-testid="filter-add"
      disabled={draft.conditions.length >= MAX_FILTER_CONDITIONS}
      onclick={() => {
        draft = addCondition(draft, columns[0] ?? '');
      }}
    >
      {t('filter.addCondition')}
    </button>
    <input
      class="control where"
      data-testid="filter-where"
      aria-label={t('filter.where')}
      placeholder={t('filter.wherePlaceholder')}
      value={draft.where}
      oninput={(event) => {
        draft = { ...draft, where: event.currentTarget.value };
      }}
      onkeydown={onKey}
    />
    <button
      type="button"
      class="primary"
      data-testid="filter-apply"
      disabled={!canApply}
      onclick={apply}
    >
      {t('filter.apply')}
    </button>
    <button
      type="button"
      class="action"
      data-testid="filter-clear"
      disabled={busy || (!hasAnything && applied === undefined)}
      onclick={clear}
    >
      {t('filter.clear')}
    </button>
  </div>
</div>

<style>
  .filter {
    display: flex;
    flex: none;
    flex-direction: column;
    gap: 4px;
    padding: 4px 8px;
    border-bottom: 1px solid var(--vscode-panel-border);
  }

  .row {
    display: flex;
    gap: 6px;
    align-items: center;
  }

  .control {
    padding: 2px 4px;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    font: inherit;
  }

  .control:focus {
    outline: 1px solid var(--vscode-focusBorder);
  }

  .control.incomplete {
    border-color: var(--vscode-inputValidation-warningBorder, var(--vscode-editorWarning-foreground));
  }

  .value {
    flex: 1;
    min-width: 80px;
  }

  .where {
    flex: 1;
    min-width: 120px;
    font-family: var(--vscode-editor-font-family, monospace);
  }

  .icon,
  .action {
    padding: 2px 10px;
    color: var(--vscode-button-secondaryForeground);
    background: var(--vscode-button-secondaryBackground);
    border: none;
    border-radius: 2px;
    cursor: pointer;
  }

  .primary {
    padding: 2px 10px;
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
    border: none;
    border-radius: 2px;
    cursor: pointer;
  }

  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>

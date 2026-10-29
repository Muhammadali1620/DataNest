<script lang="ts">
  import {
    DESIGN_LIMITS,
    type DesignProblem,
    type TableDesign,
  } from '../../../../src/shared/table-design';
  import type { Translate } from '../../lib/i18n';
  import ColumnPicker from './ColumnPicker.svelte';
  import {
    addIndex,
    indexProblems,
    problemMessage,
    removeIndex,
    updateIndex,
  } from './design-model';

  interface Props {
    design: TableDesign;
    /** False where indexes cannot be unique (ClickHouse): the column is left out. */
    unique?: boolean;
    problems: readonly DesignProblem[];
    showProblems: boolean;
    t: Translate;
    onchange: (design: TableDesign) => void;
  }

  const { design, unique = true, problems, showProblems, t, onchange }: Props = $props();

  const columnOptions = $derived(
    design.columns.map((column, index) => ({
      value: column.id,
      label: column.name.trim() === '' ? `#${index + 1}` : column.name,
    })),
  );

  function visible(id: string): DesignProblem[] {
    return indexProblems(problems, id).filter(
      (problem) => showProblems || problem.kind === 'duplicate-index',
    );
  }
</script>

{#if design.indexes.length === 0}
  <p class="hint">{t('designer.noIndexes')}</p>
{:else}
  <table class="items">
    <thead>
      <tr>
        <th>{t('designer.index.name')}</th>
        <th>{t('designer.index.columns')}</th>
        {#if unique}
          <th>{t('designer.index.unique')}</th>
        {/if}
        <th></th>
      </tr>
    </thead>
    <tbody>
      {#each design.indexes as index (index.id)}
        {@const own = visible(index.id)}
        <tr>
          <td>
            <input
              class="control"
              value={index.name}
              maxlength={DESIGN_LIMITS.name}
              aria-label={t('designer.fieldLabel', t('designer.index.name'), index.name)}
              aria-invalid={own.some((p) => p.kind === 'index-name' || p.kind === 'duplicate-index')}
              oninput={(event) => {
                onchange(updateIndex(design, index.id, { name: event.currentTarget.value }));
              }}
            />
          </td>
          <td>
            <ColumnPicker
              options={columnOptions}
              selected={index.columns}
              label={t('designer.fieldLabel', t('designer.index.columns'), index.name)}
              {t}
              onchange={(columns: string[]) => {
                onchange(updateIndex(design, index.id, { columns }));
              }}
            />
          </td>
          {#if unique}
            <td class="check">
              <input
                type="checkbox"
                checked={index.unique}
                aria-label={t('designer.fieldLabel', t('designer.index.unique'), index.name)}
                onchange={(event) => {
                  onchange(updateIndex(design, index.id, { unique: event.currentTarget.checked }));
                }}
              />
            </td>
          {/if}
          <td>
            <button
              class="icon"
              aria-label={t('designer.removeIndex', index.name)}
              onclick={() => {
                onchange(removeIndex(design, index.id));
              }}>✕</button
            >
          </td>
        </tr>
        {#if own.length > 0}
          <tr>
            <td colspan="4">
              {#each own as problem, number (number)}
                <span class="error" role="alert">{t(problemMessage(problem))}</span>
              {/each}
            </td>
          </tr>
        {/if}
      {/each}
    </tbody>
  </table>
{/if}

<div>
  <button
    class="button secondary"
    onclick={() => {
      onchange(addIndex(design));
    }}>{t('designer.addIndex')}</button
  >
</div>

<style>
  .items {
    width: 100%;
    border-collapse: collapse;
  }

  th {
    padding: 4px;
    color: var(--vscode-descriptionForeground);
    font-weight: normal;
    text-align: left;
  }

  td {
    padding: 2px 4px;
    vertical-align: middle;
  }

  .check {
    text-align: center;
  }

  .icon {
    padding: 0 4px;
    color: var(--vscode-foreground);
    background: none;
    border: none;
    cursor: pointer;
  }

  .hint {
    color: var(--vscode-descriptionForeground);
  }

  .error {
    display: block;
    color: var(--vscode-errorForeground);
    font-size: 0.9em;
  }
</style>

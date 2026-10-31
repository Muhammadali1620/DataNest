<script lang="ts">
  import {
    DESIGN_LIMITS,
    type DesignProblem,
    type TableDesign,
  } from '../../../../src/shared/table-design';
  import Icon from '../../components/Icon.svelte';
  import IconButton from '../../components/IconButton.svelte';
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
  <div class="empty">
    <span class="empty-icon"><Icon name="list-ordered" size={24} /></span>
    <p class="empty-title">{t('designer.noIndexes')}</p>
    <p class="empty-hint">{t('designer.noIndexesHint')}</p>
  </div>
{:else}
  <div class="scroll">
    <table class="design-table">
      <thead>
        <tr>
          <th>{t('designer.index.name')}</th>
          <th>{t('designer.index.columns')}</th>
          {#if unique}
            <th class="flag">{t('designer.index.unique')}</th>
          {/if}
          <th class="tools-cell"><span class="sr-only">{t('designer.col.remove')}</span></th>
        </tr>
      </thead>
      <tbody>
        {#each design.indexes as index (index.id)}
          {@const own = visible(index.id)}
          <tr>
            <td class="name-cell">
              <input
                class="control"
                value={index.name}
                maxlength={DESIGN_LIMITS.name}
                aria-label={t('designer.fieldLabel', t('designer.index.name'), index.name)}
                aria-invalid={own.some(
                  (p) => p.kind === 'index-name' || p.kind === 'duplicate-index',
                )}
                autocomplete="off"
                spellcheck="false"
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
                testid={`index-columns-${index.id}`}
                {t}
                onchange={(columns: string[]) => {
                  onchange(updateIndex(design, index.id, { columns }));
                }}
              />
            </td>
            {#if unique}
              <td class="flag">
                <input
                  type="checkbox"
                  checked={index.unique}
                  aria-label={t('designer.fieldLabel', t('designer.index.unique'), index.name)}
                  onchange={(event) => {
                    onchange(
                      updateIndex(design, index.id, { unique: event.currentTarget.checked }),
                    );
                  }}
                />
              </td>
            {/if}
            <td class="tools-cell">
              <IconButton
                icon="trash"
                label={t('designer.removeIndex', index.name)}
                onclick={() => {
                  onchange(removeIndex(design, index.id));
                }}
              />
            </td>
          </tr>
          {#if own.length > 0}
            <tr class="problems">
              <td colspan={unique ? 4 : 3}>
                {#each own as problem, number (number)}
                  <span class="field-error" role="alert">
                    <Icon name="error" size={14} /><span>{t(problemMessage(problem))}</span>
                  </span>
                {/each}
              </td>
            </tr>
          {/if}
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<div class="add">
  <button
    type="button"
    class="button secondary"
    onclick={() => {
      onchange(addIndex(design));
    }}><Icon name="add" />{t('designer.addIndex')}</button
  >
</div>

<style>
  td {
    padding: 3px 4px;
    vertical-align: middle;
    border-top: 1px solid var(--dn-divider);
  }

  .problems td {
    padding-top: 0;
    padding-bottom: 6px;
    border-top: none;
  }

  .name-cell {
    width: 30%;
    min-width: 160px;
  }

  .name-cell .control {
    width: 100%;
  }

  .flag {
    width: 1%;
    padding-right: 12px;
    padding-left: 12px;
    text-align: center;
  }

  .tools-cell {
    width: 1%;
  }
</style>

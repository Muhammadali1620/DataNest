<script lang="ts">
  import {
    DESIGN_LIMITS,
    type DesignProblem,
    REFERENTIAL_ACTIONS,
    type ReferentialAction,
    type TableDesign,
  } from '../../../../src/shared/table-design';
  import type { Translate } from '../../lib/i18n';
  import ColumnPicker from './ColumnPicker.svelte';
  import {
    addForeignKey,
    keyProblems,
    problemMessage,
    removeForeignKey,
    updateForeignKey,
  } from './design-model';

  interface Props {
    design: TableDesign;
    /** Tables of the scope a key may point at; the designed table is added here. */
    tables: readonly string[];
    /** Columns of the referenced tables, as far as they are known yet. */
    targetColumns: ReadonlyMap<string, readonly string[]>;
    problems: readonly DesignProblem[];
    showProblems: boolean;
    t: Translate;
    onchange: (design: TableDesign) => void;
    /** Asks for the columns of a table the page has not seen yet. */
    onneedcolumns: (table: string) => void;
  }

  const {
    design,
    tables,
    targetColumns,
    problems,
    showProblems,
    t,
    onchange,
    onneedcolumns,
  }: Props = $props();

  const self = $derived(design.name.trim());
  const columnOptions = $derived(
    design.columns.map((column, index) => ({
      value: column.id,
      label: column.name.trim() === '' ? `#${index + 1}` : column.name,
    })),
  );
  const tableOptions = $derived(
    self === '' || tables.includes(self) ? tables : [self, ...tables],
  );

  /** A key may point at the table being designed; its columns come from the page. */
  function targetOptions(table: string): { value: string; label: string }[] {
    const names =
      table === self
        ? design.columns.map((column) => column.name.trim()).filter((name) => name !== '')
        : (targetColumns.get(table) ?? []);
    return names.map((name) => ({ value: name, label: name }));
  }

  function visible(id: string): DesignProblem[] {
    return keyProblems(problems, id).filter(
      (problem) => showProblems || problem.kind === 'duplicate-key',
    );
  }

  $effect(() => {
    // Ask once per referenced table; the parent keeps what arrives.
    for (const key of design.foreignKeys) {
      const table = key.targetTable;
      if (table !== '' && table !== self && !targetColumns.has(table)) {
        onneedcolumns(table);
      }
    }
  });
</script>

{#if design.foreignKeys.length === 0}
  <p class="hint">{t('designer.noKeys')}</p>
{:else}
  {#each design.foreignKeys as key (key.id)}
    {@const own = visible(key.id)}
    <fieldset class="key">
      <div class="row">
        <label>
          <span>{t('designer.index.name')}</span>
          <input
            class="control"
            value={key.name}
            maxlength={DESIGN_LIMITS.name}
            aria-label={t('designer.fieldLabel', t('designer.index.name'), key.name)}
            oninput={(event) => {
              onchange(updateForeignKey(design, key.id, { name: event.currentTarget.value }));
            }}
          />
        </label>
        <button
          class="icon"
          aria-label={t('designer.removeKey', key.name)}
          onclick={() => {
            onchange(removeForeignKey(design, key.id));
          }}>✕</button
        >
      </div>
      <div class="row">
        <span class="caption">{t('designer.index.columns')}</span>
        <ColumnPicker
          options={columnOptions}
          selected={key.columns}
          label={t('designer.fieldLabel', t('designer.index.columns'), key.name)}
          {t}
          onchange={(columns: string[]) => {
            onchange(updateForeignKey(design, key.id, { columns }));
          }}
        />
      </div>
      <div class="row">
        <label>
          <span>{t('designer.key.target')}</span>
          <select
            class="control"
            aria-label={t('designer.fieldLabel', t('designer.key.target'), key.name)}
            value={key.targetTable}
            onchange={(event) => {
              onchange(
                updateForeignKey(design, key.id, { targetTable: event.currentTarget.value }),
              );
            }}
          >
            <option value="">{t('designer.key.pickTable')}</option>
            {#each tableOptions as table (table)}
              <option value={table}
                >{table === self ? t('designer.key.thisTable', table) : table}</option
              >
            {/each}
          </select>
        </label>
      </div>
      {#if key.targetTable !== ''}
        <div class="row">
          <span class="caption">{t('designer.key.targetColumns')}</span>
          <ColumnPicker
            options={targetOptions(key.targetTable)}
            selected={key.targetColumns}
            label={t('designer.fieldLabel', t('designer.key.targetColumns'), key.name)}
            {t}
            onchange={(columns: string[]) => {
              onchange(updateForeignKey(design, key.id, { targetColumns: columns }));
            }}
          />
        </div>
      {/if}
      <div class="row">
        {#each [['onDelete', 'designer.key.onDelete'], ['onUpdate', 'designer.key.onUpdate']] as const as [field, caption] (field)}
          <label>
            <span>{t(caption)}</span>
            <select
              class="control"
              aria-label={t('designer.fieldLabel', t(caption), key.name)}
              value={key[field]}
              onchange={(event) => {
                onchange(
                  updateForeignKey(design, key.id, {
                    [field]: event.currentTarget.value as ReferentialAction,
                  }),
                );
              }}
            >
              {#each REFERENTIAL_ACTIONS as action (action)}
                <option value={action}>{action}</option>
              {/each}
            </select>
          </label>
        {/each}
      </div>
      {#each own as problem, number (number)}
        <span class="error" role="alert">{t(problemMessage(problem))}</span>
      {/each}
    </fieldset>
  {/each}
{/if}

<div>
  <button
    class="button secondary"
    onclick={() => {
      onchange(addForeignKey(design));
    }}>{t('designer.addKey')}</button
  >
</div>

<style>
  .key {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 0 0 8px;
    padding: 8px;
    border: 1px solid var(--vscode-panel-border, var(--vscode-input-border, transparent));
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
  }

  label {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .caption {
    color: var(--vscode-descriptionForeground);
  }

  .icon {
    margin-left: auto;
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

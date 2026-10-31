<script lang="ts">
  import {
    DESIGN_LIMITS,
    type DesignProblem,
    REFERENTIAL_ACTIONS,
    type ReferentialAction,
    type TableDesign,
  } from '../../../../src/shared/table-design';
  import Icon from '../../components/Icon.svelte';
  import IconButton from '../../components/IconButton.svelte';
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
  <div class="empty">
    <span class="empty-icon"><Icon name="references" size={24} /></span>
    <p class="empty-title">{t('designer.noKeys')}</p>
    <p class="empty-hint">{t('designer.noKeysHint')}</p>
  </div>
{:else}
  <div class="keys">
    {#each design.foreignKeys as key (key.id)}
      {@const own = visible(key.id)}
      <fieldset class="key" class:invalid={own.length > 0}>
        <legend class="sr-only">{key.name}</legend>
        <div class="key-head">
          <Icon name="references" />
          <input
            class="control key-name"
            value={key.name}
            maxlength={DESIGN_LIMITS.name}
            aria-label={t('designer.fieldLabel', t('designer.index.name'), key.name)}
            autocomplete="off"
            spellcheck="false"
            oninput={(event) => {
              onchange(updateForeignKey(design, key.id, { name: event.currentTarget.value }));
            }}
          />
          <span class="spacer"></span>
          <IconButton
            icon="trash"
            label={t('designer.removeKey', key.name)}
            onclick={() => {
              onchange(removeForeignKey(design, key.id));
            }}
          />
        </div>

        <!-- From these columns of this table to those of the referenced one. -->
        <div class="link">
          <div class="end">
            <span class="caption">{t('designer.index.columns')}</span>
            <ColumnPicker
              options={columnOptions}
              selected={key.columns}
              label={t('designer.fieldLabel', t('designer.index.columns'), key.name)}
              testid={`key-columns-${key.id}`}
              {t}
              onchange={(columns: string[]) => {
                onchange(updateForeignKey(design, key.id, { columns }));
              }}
            />
          </div>
          <span class="arrow"><Icon name="arrow-right" /></span>
          <div class="end">
            <label class="caption" for={`key-target-${key.id}`}>{t('designer.key.target')}</label>
            <select
              id={`key-target-${key.id}`}
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
            {#if key.targetTable !== ''}
              <span class="caption">{t('designer.key.targetColumns')}</span>
              <ColumnPicker
                options={targetOptions(key.targetTable)}
                selected={key.targetColumns}
                label={t('designer.fieldLabel', t('designer.key.targetColumns'), key.name)}
                testid={`key-targets-${key.id}`}
                {t}
                onchange={(columns: string[]) => {
                  onchange(updateForeignKey(design, key.id, { targetColumns: columns }));
                }}
              />
            {/if}
          </div>
        </div>

        <div class="actions">
          {#each [['onDelete', 'designer.key.onDelete'], ['onUpdate', 'designer.key.onUpdate']] as const as [field, caption] (field)}
            <label class="action">
              <span class="caption">{t(caption)}</span>
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
          <span class="field-error" role="alert">
            <Icon name="error" size={14} /><span>{t(problemMessage(problem))}</span>
          </span>
        {/each}
      </fieldset>
    {/each}
  </div>
{/if}

<div class="add">
  <button
    type="button"
    class="button secondary"
    onclick={() => {
      onchange(addForeignKey(design));
    }}><Icon name="add" />{t('designer.addKey')}</button
  >
</div>

<style>
  .keys {
    display: flex;
    flex-direction: column;
    gap: var(--dn-gap);
  }

  .key {
    display: flex;
    flex-direction: column;
    gap: var(--dn-gap-m);
    min-width: 0;
    margin: 0;
    padding: var(--dn-gap-m);
    background: var(--vscode-editor-background);
    border: 1px solid var(--dn-border);
    border-radius: var(--dn-radius);
  }

  .key.invalid {
    border-left: 3px solid var(--dn-danger);
  }

  .key-head {
    display: flex;
    gap: var(--dn-gap);
    align-items: center;
  }

  .key-head > :global(.codicon-glyph) {
    color: var(--dn-muted);
  }

  .key-name {
    width: min(320px, 100%);
    font-weight: 600;
  }

  .spacer {
    flex: 1;
  }

  .link {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
    gap: var(--dn-gap-m);
    align-items: start;
  }

  .end {
    display: flex;
    flex-direction: column;
    gap: var(--dn-gap-s);
    min-width: 0;
  }

  .end select {
    max-width: 100%;
    margin-bottom: var(--dn-gap-s);
  }

  .arrow {
    display: inline-flex;
    padding-top: 22px;
    color: var(--dn-muted);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--dn-gap-m);
  }

  .action {
    display: flex;
    flex-direction: column;
    gap: var(--dn-gap-s);
    min-width: 160px;
  }

  .caption {
    color: var(--dn-muted);
    font-size: var(--dn-font-small);
  }

  @media (max-width: 560px) {
    .link {
      grid-template-columns: 1fr;
    }

    .arrow {
      display: none;
    }
  }
</style>

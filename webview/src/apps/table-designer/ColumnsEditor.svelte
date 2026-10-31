<script lang="ts">
  import type { DriverId } from '../../../../src/shared/connection';
  import type { TableDesignerState } from '../../../../src/shared/protocols/table-designer';
  import {
    type ColumnDesign,
    DESIGN_LIMITS,
    type DesignProblem,
    type TableDesign,
  } from '../../../../src/shared/table-design';
  import Icon from '../../components/Icon.svelte';
  import IconButton from '../../components/IconButton.svelte';
  import type { MessageKey } from '../../l10n/en';
  import type { Translate } from '../../lib/i18n';
  import {
    addColumn,
    columnProblems,
    moveColumn,
    problemMessage,
    removeColumn,
    updateColumn,
  } from './design-model';

  interface Props {
    design: TableDesign;
    driver: DriverId;
    features: TableDesignerState['features'];
    problems: readonly DesignProblem[];
    showProblems: boolean;
    /** False where existing columns cannot change places (PostgreSQL). */
    canReorder: boolean;
    /**
     * A stored table on a database that cannot move a column in place: the buttons ask the
     * host for a script that rebuilds the table (named by the column's stored name).
     */
    rebuild?: {
      readonly busy: boolean;
      /** Unsaved edits: the script is built from the stored table, so they must go first. */
      readonly dirty: boolean;
      readonly move: (column: string, direction: 'up' | 'down') => void;
    };
    t: Translate;
    onchange: (design: TableDesign) => void;
  }

  const { design, driver, features, problems, showProblems, canReorder, rebuild, t, onchange }: Props =
    $props();

  type Patch = Partial<Omit<ColumnDesign, 'id' | 'original'>>;

  function update(id: string, patch: Patch): void {
    onchange(updateColumn(design, id, patch, driver));
  }

  /** A column without a name yet is called by its position. */
  function labelOf(column: ColumnDesign, index: number): string {
    return column.name.trim() === '' ? `#${index + 1}` : column.name;
  }

  function cell(key: MessageKey, column: ColumnDesign, index: number): string {
    return t('designer.cellLabel', t(key), labelOf(column, index));
  }

  /**
   * Problems are shown at once when something is wrong with what was typed; a
   * field that is merely still empty waits for the first save attempt.
   */
  function visibleProblems(id: string): DesignProblem[] {
    return columnProblems(problems, id).filter(
      (problem) => showProblems || (problem.kind !== 'column-name' && problem.kind !== 'column-type'),
    );
  }

  const listId = 'designer-types';
  /** Every column of the table: the problems row spans them all. */
  const width = $derived(8 + (features.columnComments ? 1 : 0) + (features.autoIncrement ? 1 : 0));
</script>

<datalist id={listId}>
  {#each features.types as type (type)}
    <option value={type}></option>
  {/each}
</datalist>

<div class="scroll">
  <table class="design-table">
    <thead>
      <tr>
        <th class="tools-cell"><span class="sr-only">{t('designer.col.order')}</span></th>
        <th>{t('designer.col.name')}</th>
        <th>{t('designer.col.type')}</th>
        <th title={t('designer.lengthHint')}>
          <span class="head-hint">{t('designer.col.length')}<Icon name="info" size={12} /></span>
        </th>
        <th class="flag" title={t('designer.col.notNullHint')}>{t('designer.col.notNull')}</th>
        <th title={t('designer.defaultHint')}>
          <span class="head-hint">{t('designer.col.default')}<Icon name="info" size={12} /></span>
        </th>
        <th class="flag" title={t('designer.col.primaryKeyHint')}>{t('designer.col.primaryKey')}</th>
        {#if features.autoIncrement}
          <th class="flag" title={t('designer.col.autoIncrementHint')}>
            {t('designer.col.autoIncrement')}
          </th>
        {/if}
        {#if features.columnComments}
          <th>{t('designer.col.comment')}</th>
        {/if}
        <th class="tools-cell"><span class="sr-only">{t('designer.col.remove')}</span></th>
      </tr>
    </thead>
    <tbody>
      {#each design.columns as column, index (column.id)}
        {@const own = visibleProblems(column.id)}
        <tr class:invalid={own.length > 0} class:key={column.primaryKey}>
          <td class="tools-cell">
            <span class="order">
              {#if column.primaryKey}
                <span class="key-mark" title={t('designer.col.primaryKeyHint')}>
                  <Icon name="key" size={14} />
                </span>
              {/if}
              {#if rebuild !== undefined && column.original !== undefined}
                <IconButton
                  icon="arrow-up"
                  label={t('designer.rebuildUp', labelOf(column, index))}
                  hint={rebuild.dirty ? t('designer.rebuildSaveFirst') : t('designer.rebuildHint')}
                  disabled={index === 0 || rebuild.busy || rebuild.dirty}
                  onclick={() => {
                    rebuild.move(column.original ?? '', 'up');
                  }}
                />
                <IconButton
                  icon="arrow-down"
                  label={t('designer.rebuildDown', labelOf(column, index))}
                  hint={rebuild.dirty ? t('designer.rebuildSaveFirst') : t('designer.rebuildHint')}
                  disabled={index === design.columns.length - 1 || rebuild.busy || rebuild.dirty}
                  onclick={() => {
                    rebuild.move(column.original ?? '', 'down');
                  }}
                />
              {:else if canReorder}
                <IconButton
                  icon="arrow-up"
                  label={t('designer.moveUp', labelOf(column, index))}
                  disabled={index === 0}
                  onclick={() => {
                    onchange(moveColumn(design, column.id, -1));
                  }}
                />
                <IconButton
                  icon="arrow-down"
                  label={t('designer.moveDown', labelOf(column, index))}
                  disabled={index === design.columns.length - 1}
                  onclick={() => {
                    onchange(moveColumn(design, column.id, 1));
                  }}
                />
              {/if}
            </span>
          </td>
          <td>
            <input
              class="control name"
              value={column.name}
              maxlength={DESIGN_LIMITS.name}
              aria-label={cell('designer.col.name', column, index)}
              aria-invalid={own.some((p) => p.kind === 'column-name' || p.kind === 'duplicate-column')}
              autocomplete="off"
              spellcheck="false"
              oninput={(event) => {
                update(column.id, { name: event.currentTarget.value });
              }}
            />
          </td>
          <td>
            <input
              class="control"
              list={listId}
              value={column.type}
              maxlength={DESIGN_LIMITS.type}
              aria-label={cell('designer.col.type', column, index)}
              aria-invalid={own.some((p) => p.kind === 'column-type')}
              autocomplete="off"
              spellcheck="false"
              oninput={(event) => {
                update(column.id, { type: event.currentTarget.value });
              }}
            />
          </td>
          <td>
            <!-- The example shows only in the field being typed in, not on every row. -->
            <input
              class="control short focus-hint"
              value={column.length}
              maxlength={DESIGN_LIMITS.length}
              placeholder={t('designer.lengthHint')}
              aria-label={cell('designer.col.length', column, index)}
              autocomplete="off"
              spellcheck="false"
              oninput={(event) => {
                update(column.id, { length: event.currentTarget.value });
              }}
            />
          </td>
          <td class="flag">
            <input
              type="checkbox"
              checked={!column.nullable}
              disabled={column.primaryKey}
              aria-label={cell('designer.col.notNull', column, index)}
              onchange={(event) => {
                update(column.id, { nullable: !event.currentTarget.checked });
              }}
            />
          </td>
          <td>
            <input
              class="control focus-hint"
              value={column.defaultValue}
              maxlength={DESIGN_LIMITS.defaultValue}
              placeholder={t('designer.defaultHint')}
              aria-label={cell('designer.col.default', column, index)}
              autocomplete="off"
              spellcheck="false"
              oninput={(event) => {
                update(column.id, { defaultValue: event.currentTarget.value });
              }}
            />
          </td>
          <td class="flag">
            <input
              type="checkbox"
              checked={column.primaryKey}
              aria-label={cell('designer.col.primaryKey', column, index)}
              onchange={(event) => {
                update(column.id, { primaryKey: event.currentTarget.checked });
              }}
            />
          </td>
          {#if features.autoIncrement}
            <td class="flag">
              <input
                type="checkbox"
                checked={column.autoIncrement}
                aria-label={cell('designer.col.autoIncrement', column, index)}
                aria-invalid={own.some((p) => p.kind === 'auto-increment')}
                onchange={(event) => {
                  update(column.id, { autoIncrement: event.currentTarget.checked });
                }}
              />
            </td>
          {/if}
          {#if features.columnComments}
            <td>
              <input
                class="control"
                value={column.comment}
                maxlength={DESIGN_LIMITS.comment}
                aria-label={cell('designer.col.comment', column, index)}
                oninput={(event) => {
                  update(column.id, { comment: event.currentTarget.value });
                }}
              />
            </td>
          {/if}
          <td class="tools-cell">
            <IconButton
              icon="trash"
              label={t('designer.removeColumn', labelOf(column, index))}
              onclick={() => {
                onchange(removeColumn(design, column.id));
              }}
            />
          </td>
        </tr>
        {#if own.length > 0}
          <tr class="problems">
            <td></td>
            <td colspan={width - 1}>
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

<div class="add">
  <button
    type="button"
    class="button secondary"
    onclick={() => {
      onchange(addColumn(design, driver));
    }}><Icon name="add" />{t('designer.addColumn')}</button
  >
</div>

<style>
  th[title] {
    cursor: help;
  }

  .head-hint {
    display: inline-flex;
    gap: 4px;
    align-items: center;
  }

  td {
    padding: 2px 4px;
    vertical-align: middle;
  }

  tbody tr:not(.problems) {
    transition: background-color var(--dn-duration) var(--dn-ease);
  }

  tbody tr:not(.problems):hover td {
    background: var(--dn-hover);
  }

  tbody tr:not(.problems) td:first-child {
    border-radius: var(--dn-radius) 0 0 var(--dn-radius);
  }

  tbody tr:not(.problems) td:last-child {
    border-radius: 0 var(--dn-radius) var(--dn-radius) 0;
  }

  td .control {
    width: 100%;
    min-width: 90px;
  }

  td .control.short {
    min-width: 64px;
  }

  .name {
    font-weight: 500;
  }

  .key .name {
    font-weight: 600;
  }

  /* An example is a hint for the field being filled, so it shows only there. */
  .focus-hint:not(:focus)::placeholder {
    color: transparent;
  }

  .flag {
    width: 1%;
    padding-right: 8px;
    padding-left: 8px;
    text-align: center;
  }

  .tools-cell {
    width: 1%;
    white-space: nowrap;
  }

  .order {
    display: inline-flex;
    gap: 0;
    align-items: center;
    min-width: 66px;
  }

  .key-mark {
    display: inline-flex;
    justify-content: center;
    width: 18px;
    color: var(--dn-warning);
  }

  /* Without the mark, the arrows stay where they are on every row. */
  .order > :global(.icon-button:first-child) {
    margin-left: 18px;
  }

  .problems td {
    padding-top: 0;
    padding-bottom: 6px;
  }
</style>

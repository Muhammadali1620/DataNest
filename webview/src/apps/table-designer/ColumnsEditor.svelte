<script lang="ts">
  import type { DriverId } from '../../../../src/shared/connection';
  import type { TableDesignerState } from '../../../../src/shared/protocols/table-designer';
  import {
    type ColumnDesign,
    DESIGN_LIMITS,
    type DesignProblem,
    type TableDesign,
  } from '../../../../src/shared/table-design';
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
    t: Translate;
    onchange: (design: TableDesign) => void;
  }

  const { design, driver, features, problems, showProblems, canReorder, t, onchange }: Props =
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
</script>

<datalist id={listId}>
  {#each features.types as type (type)}
    <option value={type}></option>
  {/each}
</datalist>

<table class="columns">
  <thead>
    <tr>
      <th></th>
      <th>{t('designer.col.name')}</th>
      <th>{t('designer.col.type')}</th>
      <th>{t('designer.col.length')}</th>
      <th>{t('designer.col.notNull')}</th>
      <th>{t('designer.col.default')}</th>
      <th>{t('designer.col.primaryKey')}</th>
      {#if features.autoIncrement}
        <th>{t('designer.col.autoIncrement')}</th>
      {/if}
      {#if features.columnComments}
        <th>{t('designer.col.comment')}</th>
      {/if}
      <th></th>
    </tr>
  </thead>
  <tbody>
    {#each design.columns as column, index (column.id)}
      {@const own = visibleProblems(column.id)}
      <tr class:invalid={own.length > 0}>
        <td class="order">
          {#if canReorder}
          <button
            class="icon"
            disabled={index === 0}
            aria-label={t('designer.moveUp', labelOf(column, index))}
            onclick={() => {
              onchange(moveColumn(design, column.id, -1));
            }}>▲</button
          >
          <button
            class="icon"
            disabled={index === design.columns.length - 1}
            aria-label={t('designer.moveDown', labelOf(column, index))}
            onclick={() => {
              onchange(moveColumn(design, column.id, 1));
            }}>▼</button
          >
          {/if}
        </td>
        <td>
          <input
            class="control"
            value={column.name}
            maxlength={DESIGN_LIMITS.name}
            aria-label={cell('designer.col.name', column, index)}
            aria-invalid={own.some((p) => p.kind === 'column-name' || p.kind === 'duplicate-column')}
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
            oninput={(event) => {
              update(column.id, { type: event.currentTarget.value });
            }}
          />
        </td>
        <td>
          <input
            class="control short"
            value={column.length}
            maxlength={DESIGN_LIMITS.length}
            placeholder={t('designer.lengthHint')}
            aria-label={cell('designer.col.length', column, index)}
            oninput={(event) => {
              update(column.id, { length: event.currentTarget.value });
            }}
          />
        </td>
        <td class="check">
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
            class="control"
            value={column.defaultValue}
            maxlength={DESIGN_LIMITS.defaultValue}
            placeholder={t('designer.defaultHint')}
            aria-label={cell('designer.col.default', column, index)}
            oninput={(event) => {
              update(column.id, { defaultValue: event.currentTarget.value });
            }}
          />
        </td>
        <td class="check">
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
          <td class="check">
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
        <td>
          <button
            class="icon"
            aria-label={t('designer.removeColumn', labelOf(column, index))}
            onclick={() => {
              onchange(removeColumn(design, column.id));
            }}>✕</button
          >
        </td>
      </tr>
      {#if own.length > 0}
        <tr class="problems">
          <td></td>
          <td colspan={7 + (features.columnComments ? 1 : 0) + (features.autoIncrement ? 1 : 0)}>
            {#each own as problem, number (number)}
              <span class="error" role="alert">{t(problemMessage(problem))}</span>
            {/each}
          </td>
        </tr>
      {/if}
    {/each}
  </tbody>
</table>

<div>
  <button
    class="button secondary"
    onclick={() => {
      onchange(addColumn(design, driver));
    }}>{t('designer.addColumn')}</button
  >
</div>

<style>
  .columns {
    width: 100%;
    border-collapse: collapse;
  }

  th {
    padding: 4px;
    color: var(--vscode-descriptionForeground);
    font-weight: normal;
    text-align: left;
    white-space: nowrap;
  }

  td {
    padding: 2px 4px;
    vertical-align: middle;
  }

  td .control {
    width: 100%;
    min-width: 80px;
  }

  td .control.short {
    min-width: 60px;
  }

  .check {
    text-align: center;
  }

  .order {
    white-space: nowrap;
  }

  .icon {
    padding: 0 4px;
    color: var(--vscode-foreground);
    background: none;
    border: none;
    cursor: pointer;
  }

  .icon:disabled {
    opacity: 0.3;
    cursor: default;
  }

  .problems td {
    padding-top: 0;
  }

  .error {
    display: block;
    color: var(--vscode-errorForeground);
    font-size: 0.9em;
  }
</style>

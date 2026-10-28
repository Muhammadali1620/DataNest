<script lang="ts">
  import type { EditInput } from '../../../../src/shared/cell-input';
  import type { CellValue } from '../../../../src/shared/cell-value';
  import type { ResultColumnInfo } from '../../../../src/shared/protocols/result-grid';
  import type { Translate } from '../../lib/i18n';
  import { displayOf } from './cells';
  import {
    controlFor,
    type EditColumn,
    initialText,
    isEditableColumn,
  } from './edit-model';

  interface Props {
    /** The row shown, or undefined when no cell is focused. */
    row: number | undefined;
    rowCount: number;
    /** Changes whenever the row's values may have changed, so open edits start over. */
    rowKey: string;
    columns: readonly ResultColumnInfo[];
    /** The row's cells; undefined while it is being fetched. */
    cells: readonly CellValue[] | undefined;
    editColumns: readonly (EditColumn | null)[] | undefined;
    changeAt: (row: number, column: number) => 'value' | 'default' | undefined;
    stateAt: (row: number) => 'inserted' | 'deleted' | undefined;
    onEdit: (row: number, column: number, input: EditInput) => Promise<string | undefined>;
    /** Moves to the previous (-1) or next (+1) row. */
    onStep: (delta: number) => void;
    onClose: () => void;
    t: Translate;
  }

  const {
    row,
    rowCount,
    rowKey,
    columns,
    cells,
    editColumns,
    changeAt,
    stateAt,
    onEdit,
    onStep,
    onClose,
    t,
  }: Props = $props();

  /** What the user has typed per column and not yet sent. */
  let drafts = $state<Record<number, string>>({});
  let errors = $state<Record<number, string | undefined>>({});

  function reset(_key: string): void {
    drafts = {};
    errors = {};
  }

  // Reading only the key (never the drafts) keeps this out of a write loop.
  $effect(() => {
    reset(rowKey);
  });

  const rowState = $derived(row === undefined ? undefined : stateAt(row));

  function editable(index: number): EditColumn | undefined {
    const column = editColumns?.[index];
    return rowState !== 'deleted' && isEditableColumn(column) ? column : undefined;
  }

  function valueOf(index: number): string {
    return drafts[index] ?? initialText(cells?.[index] ?? null);
  }

  async function send(index: number, input: EditInput): Promise<void> {
    if (row === undefined) {
      return;
    }
    const problem = await onEdit(row, index, input);
    errors = { ...errors, [index]: problem };
    if (problem === undefined) {
      const { [index]: _sent, ...rest } = drafts;
      drafts = rest;
    }
  }

  /** Sends the typed text when it differs from what the cell holds. */
  async function commit(index: number): Promise<void> {
    const draft = drafts[index];
    if (draft === undefined || draft === initialText(cells?.[index] ?? null)) {
      return;
    }
    await send(index, { kind: 'text', text: draft });
  }

  function onKey(event: KeyboardEvent, index: number, multiline: boolean): void {
    if (event.key === 'Enter' && !(multiline && event.shiftKey)) {
      event.preventDefault();
      void commit(index);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      const { [index]: _dropped, ...rest } = drafts;
      drafts = rest;
      errors = { ...errors, [index]: undefined };
    }
  }
</script>

<aside class="panel" aria-label={t('record.title')} data-testid="record-panel">
  <header class="head">
    <strong>{t('record.title')}</strong>
    {#if row !== undefined}
      <span class="meta" data-testid="record-position">{t('record.position', row + 1, rowCount)}</span>
      {#if rowState === 'inserted'}<span class="tag new">{t('record.new')}</span>{/if}
      {#if rowState === 'deleted'}<span class="tag gone">{t('record.deleted')}</span>{/if}
    {/if}
    <span class="spacer"></span>
    <button
      type="button"
      class="step"
      aria-label={t('record.previous')}
      title={t('record.previous')}
      data-testid="record-previous"
      disabled={row === undefined || row <= 0}
      onclick={() => {
        onStep(-1);
      }}
    >
      ↑
    </button>
    <button
      type="button"
      class="step"
      aria-label={t('record.next')}
      title={t('record.next')}
      data-testid="record-next"
      disabled={row === undefined || row >= rowCount - 1}
      onclick={() => {
        onStep(1);
      }}
    >
      ↓
    </button>
    <button
      type="button"
      class="step"
      aria-label={t('value.close')}
      title={t('value.close')}
      onclick={onClose}
    >
      ×
    </button>
  </header>

  {#if row === undefined}
    <p class="hint" data-testid="record-empty">{t('record.none')}</p>
  {:else if cells === undefined}
    <p class="hint">{t('grid.loading')}</p>
  {:else}
    <div class="fields">
      {#each columns as column, index (index)}
        {@const info = editable(index)}
        {@const control = info === undefined ? undefined : controlFor(info)}
        {@const mark = changeAt(row, index)}
        {@const cell = cells[index] ?? null}
        <div class="field" class:changed={mark !== undefined} data-testid="record-field">
          <label class="name" for={`record-${index}`} title={column.dataType}>
            {column.name === '' ? `#${index + 1}` : column.name}
            {#if column.dataType !== undefined}<span class="type">{column.dataType}</span>{/if}
          </label>
          {#if control === undefined || info === undefined}
            {@const shown = displayOf(cell)}
            <div class="readonly" class:null={shown.isNull} id={`record-${index}`} data-testid="record-value">
              {shown.text}
            </div>
          {:else}
            {#if control.type === 'select'}
              <select
                id={`record-${index}`}
                class="control"
                value={valueOf(index)}
                onchange={(event) => {
                  drafts = { ...drafts, [index]: event.currentTarget.value };
                  void commit(index);
                }}
              >
                {#if !control.options.includes(valueOf(index))}
                  <option value={valueOf(index)} disabled>
                    {cell === null ? 'NULL' : valueOf(index)}
                  </option>
                {/if}
                {#each control.options as option (option)}
                  <option value={option}>{option}</option>
                {/each}
              </select>
            {:else if info.kind === 'text' || info.kind === 'json'}
              <textarea
                id={`record-${index}`}
                class="control"
                rows="1"
                placeholder={cell === null && drafts[index] === undefined
                  ? 'NULL'
                  : control.placeholder}
                value={valueOf(index)}
                oninput={(event) => {
                  drafts = { ...drafts, [index]: event.currentTarget.value };
                }}
                onkeydown={(event) => {
                  onKey(event, index, true);
                }}
                onblur={() => {
                  void commit(index);
                }}
              ></textarea>
            {:else}
              <input
                id={`record-${index}`}
                class="control"
                type={control.inputType}
                placeholder={cell === null && drafts[index] === undefined
                  ? 'NULL'
                  : control.placeholder}
                value={valueOf(index)}
                aria-invalid={errors[index] !== undefined}
                oninput={(event) => {
                  drafts = { ...drafts, [index]: event.currentTarget.value };
                }}
                onkeydown={(event) => {
                  onKey(event, index, false);
                }}
                onblur={() => {
                  void commit(index);
                }}
              />
            {/if}
            <span class="tools">
              {#if mark === 'default'}<span class="tag">{t('grid.defaultLabel')}</span>{/if}
              {#if info.nullable}
                <button
                  type="button"
                  class="mini"
                  title={t('grid.setNull')}
                  data-testid="record-null"
                  disabled={cell === null && mark !== 'default'}
                  onclick={() => {
                    void send(index, { kind: 'null' });
                  }}
                >
                  NULL
                </button>
              {/if}
              <button
                type="button"
                class="mini"
                title={t('grid.setDefault')}
                data-testid="record-default"
                onclick={() => {
                  void send(index, { kind: 'default' });
                }}
              >
                DEFAULT
              </button>
            </span>
          {/if}
          {#if errors[index] !== undefined}
            <p class="problem" role="alert" data-testid="record-error">{errors[index]}</p>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</aside>

<style>
  .panel {
    display: flex;
    flex: none;
    flex-direction: column;
    width: 360px;
    min-width: 0;
    overflow: hidden;
    border-left: 1px solid var(--vscode-panel-border);
  }

  .head {
    display: flex;
    flex: none;
    gap: 6px;
    align-items: center;
    padding: 4px 8px;
  }

  .meta,
  .hint,
  .type {
    color: var(--vscode-descriptionForeground);
  }

  .hint {
    padding: 4px 8px;
  }

  .spacer {
    flex: 1;
  }

  .step {
    padding: 1px 8px;
    color: var(--vscode-button-secondaryForeground);
    background: var(--vscode-button-secondaryBackground);
    border: none;
    border-radius: 2px;
    cursor: pointer;
  }

  .step:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .tag {
    padding: 0 6px;
    color: var(--vscode-badge-foreground);
    background: var(--vscode-badge-background);
    border-radius: 8px;
    font-size: 0.85em;
  }

  .tag.new {
    background: var(--vscode-gitDecoration-addedResourceForeground, var(--vscode-badge-background));
  }

  .tag.gone {
    background: var(--vscode-errorForeground);
  }

  .fields {
    flex: 1;
    min-height: 0;
    padding: 0 8px 8px;
    overflow: auto;
  }

  .field {
    display: grid;
    gap: 2px;
    padding: 4px 0;
    border-bottom: 1px solid var(--vscode-panel-border);
  }

  .field.changed {
    border-left: 3px solid var(--vscode-gitDecoration-modifiedResourceForeground, orange);
    padding-left: 6px;
  }

  .name {
    display: flex;
    gap: 6px;
    align-items: baseline;
    overflow: hidden;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .type {
    font-size: 0.85em;
    font-weight: 400;
  }

  .control {
    box-sizing: border-box;
    width: 100%;
    padding: 2px 4px;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    font: inherit;
    resize: vertical;
  }

  textarea.control {
    min-height: 1.6em;
    field-sizing: content;
    max-height: 12em;
  }

  .control:focus {
    outline: 1px solid var(--vscode-focusBorder);
  }

  .control[aria-invalid='true'] {
    border-color: var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground));
  }

  .readonly {
    padding: 2px 4px;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
    user-select: text;
  }

  .readonly.null {
    color: var(--vscode-descriptionForeground);
    font-style: italic;
  }

  .tools {
    display: flex;
    gap: 4px;
    justify-content: flex-end;
  }

  .mini {
    padding: 0 6px;
    color: var(--vscode-button-secondaryForeground);
    background: var(--vscode-button-secondaryBackground);
    border: none;
    border-radius: 2px;
    font-size: 0.8em;
    cursor: pointer;
  }

  .mini:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .problem {
    margin: 0;
    color: var(--vscode-errorForeground);
  }
</style>

<script lang="ts">
  import type { EditInput } from '../../../../src/shared/cell-input';
  import type { CellValue } from '../../../../src/shared/cell-value';
  import type { ResultColumnInfo } from '../../../../src/shared/protocols/result-grid';
  import type { Translate } from '../../lib/i18n';
  import { displayOf } from './cells';
  import { controlFor, type EditColumn, type EditorControl, initialText, isEditableColumn } from './edit-model';
  import {
    MIN_COLUMN_WIDTH,
    ROW_NUMBER_WIDTH,
    resizedWidths,
  } from './columns';
  import {
    type CellRef,
    extendTo,
    isFocused,
    isNavigationKey,
    isSelected,
    navigate,
    selectAll,
    selectCell,
    type Selection,
  } from './selection';
  import { columnGeometry, columnLayout, rangeOf, rowGeometry } from './virtual';

  interface Props {
    columns: readonly ResultColumnInfo[];
    rowCount: number;
    /** Widths per column; the parent owns them so they survive a tab switch. */
    widths: readonly number[];
    /** A row that has arrived, or undefined while it is being fetched. */
    rowAt: (index: number) => readonly CellValue[] | undefined;
    /** Called with the range that should be on screen. */
    onVisible: (firstIndex: number, count: number) => void;
    /** Called while a column separator is dragged, with the new width. */
    onResize: (index: number, width: number) => void;
    /** Called when the user asks to copy the selection. */
    onCopy: (selection: Selection) => void;
    /** Changes whenever a different result is shown; the selection then starts over. */
    resetKey: string;
    /** How the result is ordered, so the header can show it. */
    sort?: { column: number; direction: 'asc' | 'desc' } | undefined;
    /** Called when a header is clicked; the host does the ordering. */
    onSort: (column: number) => void;
    /** Row to scroll to and select, e.g. the next search hit. */
    revealRow?: number | undefined;
    /** How each column is edited; undefined means the whole result is read-only. */
    editColumns?: readonly (EditColumn | null)[] | undefined;
    /** How a cell was changed and not yet saved. */
    changeAt: (row: number, column: number) => 'value' | 'default' | undefined;
    /** Sends an edit to the host; resolves to the reason it was refused, if it was. */
    onEdit: (row: number, column: number, input: EditInput) => Promise<string | undefined>;
    t: Translate;
  }

  const {
    columns,
    rowCount,
    widths,
    rowAt,
    onVisible,
    onResize,
    onCopy,
    resetKey,
    sort,
    onSort,
    revealRow,
    editColumns,
    changeAt,
    onEdit,
    t,
  }: Props = $props();

  /** One row is exactly this tall, which is what makes the arithmetic simple. */
  const ROW_HEIGHT = 22;

  /**
   * Until the browser reports a size, one screenful is assumed: the first rows
   * then load right away instead of waiting for the first layout pass.
   */
  const ASSUMED_HEIGHT = 20 * ROW_HEIGHT;
  const ASSUMED_WIDTH = 800;

  let viewport = $state<HTMLDivElement | undefined>(undefined);
  let scrollTop = $state(0);
  let scrollLeft = $state(0);
  let viewportHeight = $state(0);
  let viewportWidth = $state(0);

  const height = $derived(viewportHeight > 0 ? viewportHeight : ASSUMED_HEIGHT);
  const width = $derived(viewportWidth > 0 ? viewportWidth : ASSUMED_WIDTH);
  const layout = $derived(columnLayout(widths));
  const rows = $derived(rowGeometry(scrollTop, height, ROW_HEIGHT, rowCount));
  const visibleColumns = $derived(columnGeometry(scrollLeft, width, layout));
  const rowIndexes = $derived(rangeOf(rows.firstIndex, rows.lastIndex));
  const columnIndexes = $derived(rangeOf(visibleColumns.firstIndex, visibleColumns.lastIndex));

  // Asking for rows is a side effect of what is on screen, not of rendering.
  $effect(() => {
    if (rows.lastIndex >= rows.firstIndex) {
      onVisible(rows.firstIndex, rows.lastIndex - rows.firstIndex + 1);
    }
  });

  $effect(() => {
    const element = viewport;
    if (element === undefined) {
      return undefined;
    }
    const measure = (): void => {
      viewportHeight = element.clientHeight;
      viewportWidth = element.clientWidth;
    };
    measure();
    // Not every host provides ResizeObserver (older webviews, test environments);
    // the window's own resize event is a good enough fallback.
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => {
        window.removeEventListener('resize', measure);
      };
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  });

  function onScroll(): void {
    if (viewport) {
      scrollTop = viewport.scrollTop;
      scrollLeft = viewport.scrollLeft;
    }
  }

  function widthOf(index: number): number {
    return widths[index] ?? MIN_COLUMN_WIDTH;
  }

  interface Drag {
    readonly index: number;
    readonly startX: number;
    readonly startWidth: number;
  }

  let drag = $state<Drag | undefined>(undefined);

  let selection = $state<Selection | undefined>(undefined);
  /** True while the pointer is down on a cell, which extends the selection. */
  let selecting = $state(false);

  const bounds = $derived({ rowCount, columnCount: columns.length });
  const pageRows = $derived(Math.max(1, Math.floor(height / ROW_HEIGHT) - 1));

  /** A different result means different cells, so the old selection is dropped. */
  function clearSelection(_key: string): void {
    selection = undefined;
  }

  // Reading only the key (never the selection) keeps this out of a write loop.
  $effect(() => {
    clearSelection(resetKey);
  });

  /**
   * Selects a row the parent asked to reveal, e.g. a search hit. It must not read
   * `selection` back: an effect that both reads and writes one piece of state
   * loops forever in Svelte 5.
   */
  function reveal(row: number | undefined): void {
    if (row === undefined) {
      return;
    }
    const cell = selectCell({ row, column: 0 }, { rowCount, columnCount: columns.length });
    selection = cell;
    if (cell !== undefined) {
      scrollTo(cell.focus);
    }
  }

  $effect(() => {
    reveal(revealRow);
  });

  interface Editing {
    readonly row: number;
    readonly column: number;
    readonly control: EditorControl;
    text: string;
    error: string | undefined;
  }

  /** The cell being typed into, if any. */
  let editing = $state<Editing | undefined>(undefined);
  /** Why the last NULL/DEFAULT action failed. */
  let actionError = $state<string | undefined>(undefined);

  function editColumn(column: number): EditColumn | undefined {
    const info = editColumns?.[column];
    return isEditableColumn(info) ? info : undefined;
  }

  const focusCell = $derived(selection?.focus);
  const focusColumn = $derived(focusCell === undefined ? undefined : editColumn(focusCell.column));
  const canSetNull = $derived(focusColumn?.nullable === true);
  const canSetDefault = $derived(focusColumn !== undefined);

  function startEdit(row: number, column: number): void {
    const info = editColumn(column);
    const cells = rowAt(row);
    if (info === undefined || cells === undefined) {
      return;
    }
    actionError = undefined;
    editing = {
      row,
      column,
      control: controlFor(info),
      text: initialText(cells[column] ?? null),
      error: undefined,
    };
  }

  function cancelEdit(): void {
    editing = undefined;
    viewport?.focus();
  }

  async function commitEdit(): Promise<void> {
    const current = editing;
    if (current === undefined) {
      return;
    }
    const problem = await onEdit(current.row, current.column, { kind: 'text', text: current.text });
    if (problem === undefined) {
      // Only close the editor this very edit opened; the user may have moved on.
      if (editing === current) {
        editing = undefined;
        viewport?.focus();
      }
    } else if (editing === current) {
      current.error = problem;
    }
  }

  function onEditorKey(event: KeyboardEvent): void {
    // The editor owns the keyboard; the grid's navigation and copy must not see it.
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.preventDefault();
      void commitEdit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancelEdit();
    }
  }

  async function setFocused(input: EditInput): Promise<void> {
    const focus = selection?.focus;
    if (focus === undefined || editColumn(focus.column) === undefined) {
      return;
    }
    actionError = await onEdit(focus.row, focus.column, input);
    viewport?.focus();
  }

  /** Puts the caret in a freshly shown editor. */
  function focusOnMount(element: HTMLElement): void {
    element.focus();
    if (element instanceof HTMLInputElement && element.type === 'text') {
      element.select();
    }
  }

  function startSelect(event: PointerEvent, row: number, column: number): void {
    if (event.button !== 0) {
      return;
    }
    selecting = true;
    selection = event.shiftKey
      ? extendTo(selection, { row, column }, bounds)
      : selectCell({ row, column }, bounds);
    viewport?.focus();
  }

  function overCell(row: number, column: number): void {
    if (selecting) {
      selection = extendTo(selection, { row, column }, bounds);
    }
  }

  function endSelect(): void {
    selecting = false;
  }

  function onKeyDown(event: KeyboardEvent): void {
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && (event.key === 'c' || event.key === 'C')) {
      if (selection !== undefined) {
        event.preventDefault();
        onCopy(selection);
      }
      return;
    }
    if (modifier && (event.key === 'a' || event.key === 'A')) {
      event.preventDefault();
      selection = selectAll(bounds);
      return;
    }
    if ((event.key === 'Enter' || event.key === 'F2') && selection !== undefined) {
      event.preventDefault();
      startEdit(selection.focus.row, selection.focus.column);
      return;
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && selection !== undefined) {
      event.preventDefault();
      void setFocused({ kind: 'null' });
      return;
    }
    if (!isNavigationKey(event.key)) {
      return;
    }
    event.preventDefault();
    selection = navigate(selection, event.key, bounds, {
      extend: event.shiftKey,
      jump: modifier,
      pageRows,
    });
    scrollToFocus();
  }

  /** Keeps the focused cell on screen after a keyboard move. */
  function scrollToFocus(): void {
    const focus = selection?.focus;
    if (focus !== undefined) {
      scrollTo(focus);
    }
  }

  function scrollTo(focus: CellRef): void {
    if (viewport === undefined) {
      return;
    }
    const top = focus.row * ROW_HEIGHT;
    const bottom = top + ROW_HEIGHT;
    if (top < viewport.scrollTop) {
      viewport.scrollTop = top;
    } else if (bottom > viewport.scrollTop + height - ROW_HEIGHT) {
      // The header covers one row's worth at the top of the viewport.
      viewport.scrollTop = bottom - height + ROW_HEIGHT;
    }
    const left = layout.offsets[focus.column] ?? 0;
    const right = layout.offsets[focus.column + 1] ?? left;
    if (left < viewport.scrollLeft) {
      viewport.scrollLeft = left;
    } else if (right > viewport.scrollLeft + width - ROW_NUMBER_WIDTH) {
      viewport.scrollLeft = right - width + ROW_NUMBER_WIDTH;
    }
  }

  function startResize(event: PointerEvent, index: number): void {
    event.preventDefault();
    drag = { index, startX: event.clientX, startWidth: widthOf(index) };
    const target = event.currentTarget;
    // Pointer capture keeps the drag alive when the pointer leaves the grip. It is
    // an enhancement: not every host implements it, and the drag works without it.
    if (target instanceof HTMLElement && typeof target.setPointerCapture === 'function') {
      target.setPointerCapture(event.pointerId);
    }
  }

  function moveResize(event: PointerEvent): void {
    if (drag === undefined) {
      return;
    }
    // The width follows the pointer from where the drag began, so a fast drag
    // cannot drift away from the separator.
    const from = [...widths];
    from[drag.index] = drag.startWidth;
    const next = resizedWidths(from, drag.index, event.clientX - drag.startX)[drag.index];
    if (next !== undefined) {
      onResize(drag.index, next);
    }
  }

  function endResize(): void {
    drag = undefined;
  }

  /** Double-clicking the separator makes the column fit its header again. */
  function autoFit(index: number): void {
    const name = columns[index]?.name ?? '';
    onResize(index, Math.max(MIN_COLUMN_WIDTH, Math.round(name.length * 7.2 + 18)));
  }
</script>

<div
  class="viewport"
  bind:this={viewport}
  onscroll={onScroll}
  onkeydown={onKeyDown}
  onpointerup={endSelect}
  onpointerleave={endSelect}
  role="grid"
  aria-rowcount={rowCount}
  aria-colcount={columns.length}
  tabindex="0"
  data-testid="grid"
>
  <div class="canvas" style="height: {rows.totalHeight}px; width: {layout.totalWidth + ROW_NUMBER_WIDTH}px;">
    <div class="header" role="row" style="width: {layout.totalWidth + ROW_NUMBER_WIDTH}px;">
      <div class="cell rownum head" style="width: {ROW_NUMBER_WIDTH}px;" role="columnheader">#</div>
      <div class="spacer" style="width: {visibleColumns.leftPadding}px;"></div>
      {#each columnIndexes as index (index)}
        <div
          class="cell head"
          role="columnheader"
          aria-colindex={index + 1}
          aria-sort={sort?.column === index
            ? sort.direction === 'asc'
              ? 'ascending'
              : 'descending'
            : 'none'}
          style="width: {widthOf(index)}px;"
          title={columns[index]?.dataType ?? columns[index]?.name ?? ''}
        >
          <button
            type="button"
            class="name"
            onclick={() => {
              onSort(index);
            }}
          >
            {columns[index]?.name ?? ''}
            {#if sort?.column === index}
              <span class="arrow" aria-hidden="true">{sort.direction === 'asc' ? '▲' : '▼'}</span>
            {/if}
          </button>
          <span
            class="grip"
            role="separator"
            aria-label={t('grid.resize', columns[index]?.name ?? '')}
            aria-orientation="vertical"
            onpointerdown={(event) => {
              startResize(event, index);
            }}
            onpointermove={moveResize}
            onpointerup={endResize}
            onpointercancel={endResize}
            ondblclick={() => {
              autoFit(index);
            }}
          ></span>
        </div>
      {/each}
    </div>

    {#each rowIndexes as index (index)}
      {@const cells = rowAt(index)}
      <div
        class="row"
        role="row"
        aria-rowindex={index + 1}
        style="top: {index * ROW_HEIGHT}px; width: {layout.totalWidth + ROW_NUMBER_WIDTH}px;"
      >
        <div class="cell rownum" style="width: {ROW_NUMBER_WIDTH}px;" role="rowheader">
          {index + 1}
        </div>
        <div class="spacer" style="width: {visibleColumns.leftPadding}px;"></div>
        {#if cells === undefined}
          <div class="cell pending" style="width: {layout.totalWidth - visibleColumns.leftPadding}px;" role="gridcell">
            {t('grid.loading')}
          </div>
        {:else}
          {#each columnIndexes as column (column)}
            {@const cell = displayOf(cells[column] ?? null)}
            {@const mark = changeAt(index, column)}
            {@const editor = editing?.row === index && editing.column === column ? editing : undefined}
            <div
              class="cell"
              role="gridcell"
              aria-colindex={column + 1}
              aria-selected={isSelected(selection, index, column)}
              tabindex={-1}
              class:null={cell.isNull}
              class:numeric={cell.numeric}
              class:selected={isSelected(selection, index, column)}
              class:focused={isFocused(selection, index, column)}
              class:changed={mark !== undefined}
              class:defaulted={mark === 'default'}
              class:editing={editor !== undefined}
              style="width: {widthOf(column)}px;"
              title={cell.truncated || cell.flattened ? cell.text : undefined}
              onpointerdown={(event) => {
                if (editor === undefined) {
                  startSelect(event, index, column);
                }
              }}
              onpointerenter={() => {
                overCell(index, column);
              }}
              ondblclick={() => {
                startEdit(index, column);
              }}
            >
              {#if editor === undefined}
                {mark === 'default' ? t('grid.defaultLabel') : cell.text}
              {:else if editor.control.type === 'select'}
                <select
                  class="editor"
                  use:focusOnMount
                  bind:value={editor.text}
                  onkeydown={onEditorKey}
                  onchange={() => {
                    void commitEdit();
                  }}
                  onblur={cancelEdit}
                >
                  {#if editor.text === '' || !editor.control.options.includes(editor.text)}
                    <option value={editor.text} disabled>{editor.text}</option>
                  {/if}
                  {#each editor.control.options as option (option)}
                    <option value={option}>{option}</option>
                  {/each}
                </select>
              {:else}
                <input
                  class="editor"
                  type={editor.control.inputType}
                  placeholder={editor.control.placeholder}
                  use:focusOnMount
                  bind:value={editor.text}
                  onkeydown={onEditorKey}
                  onblur={cancelEdit}
                  aria-invalid={editor.error !== undefined}
                />
              {/if}
              {#if editor?.error !== undefined}
                <span class="tip" role="alert" data-testid="edit-error">{editor.error}</span>
              {/if}
            </div>
          {/each}
        {/if}
      </div>
    {/each}
  </div>
</div>

{#if editColumns !== undefined}
  <div class="editbar" data-testid="editbar">
    <button
      type="button"
      class="action"
      disabled={!canSetNull}
      onclick={() => {
        void setFocused({ kind: 'null' });
      }}
    >
      {t('grid.setNull')}
    </button>
    <button
      type="button"
      class="action"
      disabled={!canSetDefault}
      onclick={() => {
        void setFocused({ kind: 'default' });
      }}
    >
      {t('grid.setDefault')}
    </button>
    <span class="hint">{t('grid.editHint')}</span>
    {#if actionError !== undefined}
      <span class="problem" role="alert" data-testid="action-error">{actionError}</span>
    {/if}
  </div>
{/if}

<style>
  .viewport {
    position: relative;
    flex: 1;
    overflow: auto;
    outline: none;
  }

  .canvas {
    position: relative;
    /* The header sits inside the canvas so it scrolls sideways with the rows. */
    padding-top: 22px;
  }

  .header {
    position: absolute;
    top: 0;
    left: 0;
    z-index: 1;
    display: flex;
    height: 22px;
    background: var(--vscode-editorGroupHeader-tabsBackground);
  }

  .row {
    position: absolute;
    left: 0;
    display: flex;
    height: 22px;
  }

  .row:hover {
    background: var(--vscode-list-hoverBackground);
  }

  .cell {
    flex: none;
    padding: 2px 8px;
    overflow: hidden;
    line-height: 18px;
    white-space: nowrap;
    text-overflow: ellipsis;
    border-right: 1px solid var(--vscode-panel-border);
    box-sizing: border-box;
  }

  .head {
    position: relative;
    font-weight: 600;
    border-bottom: 1px solid var(--vscode-panel-border);
  }

  .name {
    display: flex;
    gap: 4px;
    align-items: center;
    width: 100%;
    padding: 0;
    overflow: hidden;
    color: inherit;
    background: none;
    border: none;
    font: inherit;
    font-weight: 600;
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: pointer;
  }

  .arrow {
    flex: none;
    font-size: 0.8em;
    opacity: 0.8;
  }

  .grip {
    position: absolute;
    top: 0;
    right: -3px;
    width: 7px;
    height: 100%;
    cursor: col-resize;
    touch-action: none;
  }

  .grip:hover {
    background: var(--vscode-focusBorder);
  }

  .rownum {
    position: sticky;
    left: 0;
    z-index: 1;
    color: var(--vscode-descriptionForeground);
    text-align: right;
    background: var(--vscode-editor-background);
    user-select: none;
  }

  .head.rownum {
    z-index: 2;
    background: var(--vscode-editorGroupHeader-tabsBackground);
  }

  .spacer {
    flex: none;
  }

  .numeric {
    text-align: right;
  }

  .null {
    color: var(--vscode-descriptionForeground);
    font-style: italic;
  }

  .selected {
    background: var(--vscode-list-inactiveSelectionBackground);
  }

  .viewport:focus-visible .selected {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
  }

  .focused {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
  }

  .changed {
    background: var(--vscode-diffEditor-insertedTextBackground, rgba(80, 160, 80, 0.25));
  }

  .defaulted {
    font-style: italic;
  }

  .cell.editing {
    position: relative;
    overflow: visible;
    padding: 0;
    z-index: 3;
  }

  .editor {
    width: 100%;
    height: 100%;
    padding: 0 6px;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-focusBorder);
    box-sizing: border-box;
    font: inherit;
  }

  .tip {
    position: absolute;
    top: 100%;
    left: 0;
    z-index: 4;
    padding: 2px 8px;
    color: var(--vscode-inputValidation-errorForeground, var(--vscode-foreground));
    background: var(--vscode-inputValidation-errorBackground);
    border: 1px solid var(--vscode-inputValidation-errorBorder);
    white-space: nowrap;
  }

  .editbar {
    display: flex;
    flex: none;
    gap: 8px;
    align-items: center;
    padding: 3px 8px;
    border-top: 1px solid var(--vscode-panel-border);
  }

  .action {
    padding: 1px 8px;
    color: var(--vscode-button-secondaryForeground);
    background: var(--vscode-button-secondaryBackground);
    border: none;
    border-radius: 2px;
    cursor: pointer;
  }

  .action:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .hint {
    color: var(--vscode-descriptionForeground);
  }

  .problem {
    color: var(--vscode-errorForeground);
  }

  .pending {
    color: var(--vscode-descriptionForeground);
  }
</style>

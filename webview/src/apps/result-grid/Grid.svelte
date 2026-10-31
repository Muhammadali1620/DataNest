<script lang="ts">
  import { untrack } from 'svelte';
  import type { EditInput } from '../../../../src/shared/cell-input';
  import type { RowAction } from '../../../../src/shared/row-action';
  import type { CellValue } from '../../../../src/shared/cell-value';
  import type { ResultColumnInfo } from '../../../../src/shared/protocols/result-grid';
  import type { Translate } from '../../lib/i18n';
  import Icon from '../../components/Icon.svelte';
  import IconButton from '../../components/IconButton.svelte';
  import { displayOf } from './cells';
  import { typeIcon } from './column-type';
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
    selectionBox,
    type Selection,
    type SelectionInfo,
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
    onCopy: (selection: SelectionInfo) => void;
    /** Changes whenever a different result is shown; the selection then starts over. */
    resetKey: string;
    /** How the result is ordered, so the header can show it. */
    sort?: { column: number; direction: 'asc' | 'desc' } | undefined;
    /** Called when a header is clicked; the host does the ordering. */
    onSort: (column: number) => void;
    /** Row to scroll to and select, e.g. the next search hit. */
    revealRow?: number | undefined;
    /** Column that stays focused when a row is revealed; the first one by default. */
    revealColumn?: number | undefined;
    /** How each column is edited; undefined means the whole result is read-only. */
    editColumns?: readonly (EditColumn | null)[] | undefined;
    /** How a cell was changed and not yet saved. */
    changeAt: (row: number, column: number) => 'value' | 'default' | undefined;
    /** Whether a row is new or marked for deletion. */
    stateAt: (row: number) => 'inserted' | 'deleted' | undefined;
    /** Asks the host to add, duplicate, delete or restore rows. */
    onRowAction: (action: RowAction, rows: number[]) => Promise<void>;
    /** Saves the pending changes; bound to Ctrl+S. */
    onSave: () => Promise<void>;
    /** Sends an edit to the host; resolves to the reason it was refused, if it was. */
    onEdit: (row: number, column: number, input: EditInput) => Promise<string | undefined>;
    /** Called when the focused cell changes, e.g. so the value panel can follow it. */
    onFocusChange?: ((cell: CellRef | undefined) => void) | undefined;
    /** Called when the selected cells change, so "Copy as" knows what to copy. */
    onSelectionChange?: ((selection: SelectionInfo | undefined) => void) | undefined;
    /** Result columns in the order they are drawn, hidden ones left out; all of them by default. */
    order?: readonly number[] | undefined;
    /** How many of the leading `order` columns stay put while the rest scrolls. */
    pinnedCount?: number | undefined;
    /** Called to fit a column to its content, with the rows that are on screen. */
    onFit?: ((index: number, rows: readonly (readonly CellValue[])[]) => void) | undefined;
    /** Called for F4, which opens or closes the value panel. */
    onToggleValue?: (() => void) | undefined;
    /** The table a foreign key column leads to, or undefined when the column is not a key. */
    linkTarget?: ((column: number) => string | undefined) | undefined;
    /** Called to open the row a foreign key cell points at. */
    onFollow?: ((row: number, column: number) => void) | undefined;
    /** Called for Shift+F4, which opens or closes the record card. */
    onToggleRecord?: (() => void) | undefined;
    /** What screen readers call the grid, e.g. the statement that produced it. */
    label?: string | undefined;
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
    revealColumn,
    editColumns,
    changeAt,
    stateAt,
    onEdit,
    onRowAction,
    onSave,
    onFocusChange,
    onSelectionChange,
    order: orderProp,
    pinnedCount,
    onFit,
    onToggleValue,
    onToggleRecord,
    linkTarget,
    onFollow,
    label,
    t,
  }: Props = $props();

  /** Prefix of the cells' ids, unique per grid, for `aria-activedescendant`. */
  const uid = $props.id();

  /** A step of a keyboard resize; Shift makes it bigger. */
  const RESIZE_STEP = 16;

  /** One row is exactly this tall, which is what makes the arithmetic simple. */
  const ROW_HEIGHT = 22;

  /** The header row is a little taller than a data row; rows are placed below it. */
  const HEADER_HEIGHT = 26;

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
  /** Result columns in drawing order; every one of them unless the user hid some. */
  const order = $derived<readonly number[]>(orderProp ?? columns.map((_, index) => index));
  const pinned = $derived(Math.max(0, Math.min(pinnedCount ?? 0, order.length)));
  /** The result column drawn at a position. */
  function orig(position: number): number {
    return order[position] ?? position;
  }
  const layout = $derived(columnLayout(order.map((index) => widths[index] ?? MIN_COLUMN_WIDTH)));
  const rows = $derived(rowGeometry(scrollTop, height, ROW_HEIGHT, rowCount));
  const visibleColumns = $derived(columnGeometry(scrollLeft, width, layout));
  const rowIndexes = $derived(rangeOf(rows.firstIndex, rows.lastIndex));
  /** Pinned columns are always drawn; the others only while they are near the viewport. */
  const pinnedPositions = $derived(rangeOf(0, pinned - 1));
  const scrollStart = $derived(Math.max(visibleColumns.firstIndex, pinned));
  const scrollPositions = $derived(rangeOf(scrollStart, visibleColumns.lastIndex));
  /** Empty space between the pinned columns and the first scrolled one. */
  const scrollPadding = $derived(
    Math.max(0, (layout.offsets[scrollStart] ?? 0) - (layout.offsets[pinned] ?? 0)),
  );

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

  const bounds = $derived({ rowCount, columnCount: order.length });
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
    const wanted = untrack(() => revealColumn);
    const cell = selectCell(
      { row, column: wanted === undefined ? 0 : Math.max(0, untrack(() => order).indexOf(wanted)) },
      { rowCount, columnCount: untrack(() => order).length },
    );
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

  function cellId(row: number, position: number): string {
    return `${uid}-r${row}-c${position}`;
  }

  /**
   * The focused cell for screen readers: DOM focus stays on the grid (one tab stop),
   * and this names the cell they should read. Only a drawn cell can be named.
   */
  const activeCell = $derived.by(() => {
    const focus = selection?.focus;
    if (focus === undefined || !rowIndexes.includes(focus.row)) {
      return undefined;
    }
    const drawn = focus.column < pinned || scrollPositions.includes(focus.column);
    return drawn ? cellId(focus.row, focus.column) : undefined;
  });

  /** The focused cell in the result's own column numbers. */
  const focusCell = $derived(
    selection === undefined
      ? undefined
      : { row: selection.focus.row, column: orig(selection.focus.column) },
  );
  // The callback only writes the parent's state, so this effect never reads what it sets.
  $effect(() => {
    const cell = focusCell;
    untrack(() => {
      onFocusChange?.(cell);
    });
  });

  $effect(() => {
    const current = selection;
    untrack(() => {
      onSelectionChange?.(current === undefined ? undefined : infoOf(current));
    });
  });

  /** The selection as rows and the result columns it covers, hidden ones excluded. */
  function infoOf(current: Selection): SelectionInfo {
    const box = selectionBox(current);
    return {
      top: box.top,
      bottom: box.bottom,
      columns: Array.from({ length: box.right - box.left + 1 }, (_, offset) =>
        orig(box.left + offset),
      ),
    };
  }

  const focusColumn = $derived(focusCell === undefined ? undefined : editColumn(focusCell.column));
  const canSetNull = $derived(focusColumn?.nullable === true);
  const canSetDefault = $derived(focusColumn !== undefined);

  /** The rows the selection touches, top to bottom. */
  const selectedRows = $derived.by(() => {
    if (selection === undefined) {
      return [];
    }
    const box = selectionBox(selection);
    return Array.from({ length: box.bottom - box.top + 1 }, (_, offset) => box.top + offset);
  });
  const canDelete = $derived(selectedRows.some((row) => stateAt(row) !== 'deleted'));
  const canRestore = $derived(selectedRows.some((row) => stateAt(row) === 'deleted'));

  function rowAction(action: RowAction): void {
    const rows =
      action === 'revert'
        ? selectedRows
        : action === 'restore'
        ? selectedRows.filter((row) => stateAt(row) === 'deleted')
        : action === 'delete'
          ? selectedRows.filter((row) => stateAt(row) !== 'deleted')
          : action === 'duplicate'
            ? selectedRows
            : [];
    if (action !== 'add' && rows.length === 0) {
      return;
    }
    void onRowAction(action, rows);
  }

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
    const focus = focusCell;
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

  /** `position` is where the cell is drawn; the result's own column number is `orig(position)`. */
  function startSelect(event: PointerEvent, row: number, position: number): void {
    if (event.button !== 0) {
      return;
    }
    if ((event.ctrlKey || event.metaKey) && follow(row, orig(position))) {
      selection = selectCell({ row, column: position }, bounds);
      viewport?.focus();
      return;
    }
    selecting = true;
    selection = event.shiftKey
      ? extendTo(selection, { row, column: position }, bounds)
      : selectCell({ row, column: position }, bounds);
    viewport?.focus();
  }

  /** Opens the row a foreign key cell points at; false when this cell is not such a link. */
  function follow(row: number, column: number): boolean {
    const cell = rowAt(row)?.[column];
    if (onFollow === undefined || linkTarget?.(column) === undefined || cell === null) {
      return false;
    }
    onFollow(row, column);
    return true;
  }

  function overCell(row: number, position: number): void {
    if (selecting) {
      selection = extendTo(selection, { row, column: position }, bounds);
    }
  }

  function endSelect(): void {
    selecting = false;
  }

  function onKeyDown(event: KeyboardEvent): void {
    const modifier = event.ctrlKey || event.metaKey;
    // Shift+Alt with arrows acts on the focused column, like its header does for the
    // mouse; VS Code binds these only in text editors, so a page may use them.
    if (event.shiftKey && event.altKey && !modifier && focusCell !== undefined) {
      const column = focusCell.column;
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        onSort(column);
        return;
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        const step = event.key === 'ArrowLeft' ? -RESIZE_STEP : RESIZE_STEP;
        onResize(column, Math.max(MIN_COLUMN_WIDTH, widthOf(column) + step));
        return;
      }
    }
    if (event.key === 'F12' && selection !== undefined) {
      event.preventDefault();
      follow(focusCell?.row ?? 0, focusCell?.column ?? 0);
      return;
    }
    if (event.key === 'F4' && event.shiftKey && onToggleRecord !== undefined) {
      event.preventDefault();
      onToggleRecord();
      return;
    }
    if (event.key === 'F4' && onToggleValue !== undefined) {
      event.preventDefault();
      onToggleValue();
      return;
    }
    if (modifier && (event.key === 'c' || event.key === 'C')) {
      if (selection !== undefined) {
        event.preventDefault();
        onCopy(infoOf(selection));
      }
      return;
    }
    if (modifier && (event.key === 's' || event.key === 'S') && editColumns !== undefined) {
      event.preventDefault();
      void onSave();
      return;
    }
    if (modifier && (event.key === 'a' || event.key === 'A')) {
      event.preventDefault();
      selection = selectAll(bounds);
      return;
    }
    if ((event.key === 'Enter' || event.key === 'F2') && selection !== undefined) {
      event.preventDefault();
      startEdit(focusCell?.row ?? 0, focusCell?.column ?? 0);
      return;
    }
    if (editColumns !== undefined && event.key === 'Insert') {
      event.preventDefault();
      rowAction('add');
      return;
    }
    if (editColumns !== undefined && modifier && event.key === 'Delete') {
      event.preventDefault();
      rowAction('delete');
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
    } else if (bottom > viewport.scrollTop + height - HEADER_HEIGHT) {
      // The header covers the top of the viewport.
      viewport.scrollTop = bottom - height + HEADER_HEIGHT;
    }
    if (focus.column < pinned) {
      // Pinned columns never scroll out of sight.
      return;
    }
    const pinnedWidth = layout.offsets[pinned] ?? 0;
    const left = layout.offsets[focus.column] ?? 0;
    const right = layout.offsets[focus.column + 1] ?? left;
    if (left - pinnedWidth < viewport.scrollLeft) {
      viewport.scrollLeft = left - pinnedWidth;
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

  /** Double-clicking the separator fits the column to what is on screen. */
  function autoFit(index: number): void {
    if (onFit !== undefined) {
      const rowsOnScreen = rowIndexes.flatMap((row) => {
        const cells = rowAt(row);
        return cells === undefined ? [] : [cells];
      });
      onFit(index, rowsOnScreen);
      return;
    }
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
  aria-label={label}
  aria-describedby={`${uid}-keys`}
  aria-rowcount={rowCount + 1}
  aria-colcount={order.length + 1}
  aria-multiselectable="true"
  aria-readonly={editColumns === undefined}
  aria-activedescendant={activeCell}
  tabindex="0"
  data-testid="grid"
>
  <p class="sr-only" id={`${uid}-keys`}>{t('grid.keys')}</p>
  <div class="canvas" style="height: {rows.totalHeight + HEADER_HEIGHT}px; width: {layout.totalWidth + ROW_NUMBER_WIDTH}px;">
    <div class="header" role="row" aria-rowindex={1} style="width: {layout.totalWidth + ROW_NUMBER_WIDTH}px; height: {HEADER_HEIGHT}px;">
      <div class="cell rownum head" style="width: {ROW_NUMBER_WIDTH}px;" role="columnheader" aria-colindex={1}>#</div>
      {#each pinnedPositions as position (position)}
        {@render headCell(position)}
      {/each}
      <div class="spacer" style="width: {scrollPadding}px;"></div>
      {#each scrollPositions as position (position)}
        {@render headCell(position)}
      {/each}
    </div>

    {#each rowIndexes as index (index)}
      {@const cells = rowAt(index)}
      <div
        class="row"
        class:odd={index % 2 === 1}
        class:inserted={stateAt(index) === 'inserted'}
        class:deleted={stateAt(index) === 'deleted'}
        role="row"
        aria-rowindex={index + 2}
        style="top: {HEADER_HEIGHT + index * ROW_HEIGHT}px; width: {layout.totalWidth + ROW_NUMBER_WIDTH}px;"
      >
        <div class="cell rownum" style="width: {ROW_NUMBER_WIDTH}px;" role="rowheader" aria-colindex={1}>
          {#if stateAt(index) === 'inserted'}
            <span class="mark" aria-hidden="true">+</span><span class="sr-only">{t('grid.rowNew')}</span>
          {:else if stateAt(index) === 'deleted'}
            <span class="mark" aria-hidden="true">−</span><span class="sr-only">{t('grid.rowDeleted')}</span>
          {/if}
          {index + 1}
        </div>
        {#if cells === undefined}
          <div class="cell pending" style="width: {layout.totalWidth}px;" role="gridcell" aria-colindex={2}>
            {t('grid.loading')}
          </div>
        {:else}
          {#each pinnedPositions as position (position)}
            {@render dataCell(index, cells, position)}
          {/each}
          <div class="spacer" style="width: {scrollPadding}px;"></div>
          {#each scrollPositions as position (position)}
            {@render dataCell(index, cells, position)}
          {/each}
        {/if}
      </div>
    {/each}
  </div>
</div>

{#snippet headCell(position: number)}
  {@const index = orig(position)}
  <div
    class="cell head"
    class:pinned={position < pinned}
    role="columnheader"
    aria-colindex={position + 2}
    data-column={index}
    aria-sort={sort?.column === index ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
    style="width: {widthOf(index)}px;{position < pinned
      ? ` left: ${ROW_NUMBER_WIDTH + (layout.offsets[position] ?? 0)}px;`
      : ''}"
    title={columns[index]?.dataType ?? columns[index]?.name ?? ''}
  >
    <!-- Out of the tab order: the grid is one stop, and Shift+Alt+↑ sorts from a cell. -->
    <button
      type="button"
      class="name"
      tabindex="-1"
      onclick={() => {
        onSort(index);
      }}
    >
      {#if position < pinned}<span class="pin"><Icon name="pinned" size={12} /></span>{/if}
      <span class="type" data-kind={typeIcon(columns[index]?.dataType)}
        ><Icon name={typeIcon(columns[index]?.dataType)} size={14} /></span
      >
      <span class="label">{columns[index]?.name ?? ''}</span>
      {#if sort?.column === index}
        <span class="arrow"><Icon name={sort.direction === 'asc' ? 'arrow-up' : 'arrow-down'} size={14} /></span>
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
{/snippet}

{#snippet dataCell(index: number, cells: readonly CellValue[], position: number)}
  {@const column = orig(position)}
  {@const cell = displayOf(cells[column] ?? null)}
  {@const mark = changeAt(index, column)}
  {@const editor = editing?.row === index && editing.column === column ? editing : undefined}
  <div
    class="cell"
    role="gridcell"
    id={cellId(index, position)}
    aria-colindex={position + 2}
    data-column={column}
    aria-selected={isSelected(selection, index, position)}
    tabindex={-1}
    class:null={cell.isNull}
    class:numeric={cell.numeric}
    class:selected={isSelected(selection, index, position)}
    class:focused={isFocused(selection, index, position)}
    class:changed={mark !== undefined}
    class:defaulted={mark === 'default'}
    class:editing={editor !== undefined}
    class:pinned={position < pinned}
    class:link={!cell.isNull && linkTarget?.(column) !== undefined}
    style="width: {widthOf(column)}px;{position < pinned
      ? ` left: ${ROW_NUMBER_WIDTH + (layout.offsets[position] ?? 0)}px;`
      : ''}"
    title={!cell.isNull && linkTarget?.(column) !== undefined
      ? t('grid.followLink', linkTarget(column) ?? '')
      : cell.truncated || cell.flattened
        ? cell.text
        : undefined}
    onpointerdown={(event) => {
      if (editor === undefined) {
        startSelect(event, index, position);
      }
    }}
    onpointerenter={() => {
      overCell(index, position);
    }}
    ondblclick={() => {
      startEdit(index, column);
    }}
  >
    {#if editor === undefined}
      {mark === 'default' ? t('grid.defaultLabel') : cell.text}
      {#if mark !== undefined}<span class="sr-only">{t('grid.cellChanged')}</span>{/if}
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
{/snippet}

{#if editColumns !== undefined}
  <div class="editbar" data-testid="editbar" role="toolbar" aria-label={t('grid.editToolbar')}>
    <IconButton
      icon="circle-slash"
      label={t('grid.setNull')}
      text={t('grid.setNull')}
      disabled={!canSetNull}
      onclick={() => {
        void setFocused({ kind: 'null' });
      }}
    />
    <IconButton
      icon="symbol-constant"
      label={t('grid.setDefault')}
      text={t('grid.setDefault')}
      disabled={!canSetDefault}
      onclick={() => {
        void setFocused({ kind: 'default' });
      }}
    />
    <span class="toolbar-separator"></span>
    <IconButton
      icon="add"
      label={t('grid.addRow')}
      text={t('grid.addRow')}
      onclick={() => {
        rowAction('add');
      }}
    />
    <IconButton
      icon="copy"
      label={t('grid.duplicateRows')}
      text={t('grid.duplicateRows')}
      disabled={selectedRows.length === 0}
      onclick={() => {
        rowAction('duplicate');
      }}
    />
    <IconButton
      icon="trash"
      label={t('grid.deleteRows')}
      text={t('grid.deleteRows')}
      disabled={!canDelete}
      onclick={() => {
        rowAction('delete');
      }}
    />
    <IconButton
      icon="history"
      label={t('grid.restoreRows')}
      text={t('grid.restoreRows')}
      disabled={!canRestore}
      onclick={() => {
        rowAction('restore');
      }}
    />
    <IconButton
      icon="discard"
      label={t('grid.revertRows')}
      text={t('grid.revertRows')}
      disabled={selectedRows.length === 0}
      onclick={() => {
        rowAction('revert');
      }}
    />
    {#if actionError !== undefined}
      <span class="problem" role="alert" data-testid="action-error">{actionError}</span>
    {/if}
    <span class="hint" title={t('grid.editHint')}>
      <Icon name="question" size={14} /><span class="sr-only">{t('grid.editHint')}</span>
    </span>
  </div>
{/if}

<style>
  .viewport {
    /* Opaque, so rows scrolling under the sticky header do not show through. */
    --dn-header-background: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-editor-background));
    --dn-grid-line: var(--vscode-editorGroup-border, var(--dn-divider));
    position: relative;
    flex: 1;
    overflow: auto;
    outline: none;
  }

  .canvas {
    position: relative;
  }

  /*
   * The header sits inside the canvas so it scrolls sideways with the rows, and sticks
   * to the top when they scroll down; rows are placed absolutely below it.
   */
  .header {
    position: sticky;
    top: 0;
    z-index: 3;
    display: flex;
    background: var(--dn-header-background);
    box-shadow: 0 1px 0 var(--dn-divider);
  }

  .row {
    position: absolute;
    left: 0;
    display: flex;
    height: 22px;
  }

  .row.odd {
    background: var(--vscode-keybindingTable-rowsBackground, transparent);
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
    border-right: 1px solid var(--dn-grid-line);
    box-sizing: border-box;
  }

  .head {
    position: relative;
    display: flex;
    align-items: center;
    padding: 0 8px;
    font-weight: 600;
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

  .name .label {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .name .type {
    display: inline-flex;
    flex: none;
    color: var(--dn-muted);
    font-weight: normal;
  }

  /* One colour per kind of value: numbers, text, dates and keys tell apart at a glance. */
  .name .type[data-kind='symbol-numeric'] {
    color: var(--vscode-charts-blue, var(--dn-info));
  }

  .name .type[data-kind='symbol-string'] {
    color: var(--vscode-charts-green, var(--dn-success));
  }

  .name .type[data-kind='calendar'] {
    color: var(--vscode-charts-orange, var(--dn-warning));
  }

  .name .type[data-kind='symbol-boolean'] {
    color: var(--vscode-terminal-ansiMagenta, var(--dn-muted));
  }

  .name .type[data-kind='symbol-key'] {
    color: var(--vscode-charts-yellow, var(--dn-warning));
  }

  .name .type[data-kind='json'],
  .name .type[data-kind='symbol-array'] {
    color: var(--vscode-charts-purple, var(--dn-muted));
  }

  .name .type[data-kind='globe'],
  .name .type[data-kind='symbol-enum'] {
    color: var(--vscode-terminal-ansiCyan, var(--dn-muted));
  }

  .name .type[data-kind='file-media'] {
    color: var(--vscode-charts-red, var(--dn-muted));
  }

  .arrow {
    display: inline-flex;
    flex: none;
    color: var(--dn-accent);
  }

  .pin {
    display: inline-flex;
    flex: none;
    color: var(--dn-muted);
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

  .grip::after {
    position: absolute;
    top: 4px;
    bottom: 4px;
    left: 3px;
    width: 1px;
    content: '';
    background: transparent;
    transition: background-color var(--dn-duration) var(--dn-ease);
  }

  .grip:hover::after {
    top: 0;
    bottom: 0;
    left: 2px;
    width: 3px;
    background: var(--vscode-sash-hoverBorder, var(--vscode-focusBorder));
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

  /* A new or deleted row says so by a sign too, not only by its colour. */
  .rownum .mark {
    float: left;
    font-weight: bold;
  }

  .row.inserted .rownum .mark {
    color: var(--vscode-gitDecoration-addedResourceForeground, currentColor);
  }

  .row.deleted .rownum .mark {
    color: var(--vscode-gitDecoration-deletedResourceForeground, currentColor);
  }

  .cell.pinned {
    position: sticky;
    z-index: 1;
    background: var(--vscode-editor-background);
  }

  .head.pinned {
    z-index: 2;
    background: var(--dn-header-background);
  }

  .row:hover .cell.pinned {
    background: var(--vscode-list-hoverBackground);
  }

  .row.inserted .cell.pinned {
    background: var(--vscode-diffEditor-insertedLineBackground, rgba(80, 160, 80, 0.12));
  }

  .head.rownum {
    z-index: 2;
    justify-content: flex-end;
    color: var(--dn-muted);
    font-weight: normal;
    background: var(--dn-header-background);
  }

  .spacer {
    flex: none;
  }

  .numeric {
    text-align: right;
  }

  .null {
    color: var(--dn-muted);
    font-style: italic;
    opacity: 0.8;
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

  .row.inserted {
    background: var(--vscode-diffEditor-insertedLineBackground, rgba(80, 160, 80, 0.12));
  }

  .row.deleted .cell:not(.rownum) {
    color: var(--vscode-disabledForeground);
    text-decoration: line-through;
    background: var(--vscode-diffEditor-removedLineBackground, rgba(200, 80, 80, 0.15));
  }

  .changed {
    background: var(--vscode-diffEditor-insertedTextBackground, rgba(80, 160, 80, 0.25));
  }

  .defaulted {
    font-style: italic;
  }

  .cell.link::after {
    float: right;
    margin-left: 4px;
    /* The icon font's link-external glyph. */
    content: '\eb14';
    font: normal normal normal 12px/18px codicon;
    opacity: 0.5;
  }

  .cell.link:hover::after {
    opacity: 1;
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
    border-radius: 0;
    box-sizing: border-box;
    font: inherit;
    outline: none;
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
    flex-wrap: wrap;
    gap: 2px;
    align-items: center;
    padding: 3px 6px;
    border-top: 1px solid var(--dn-divider);
    font-size: var(--dn-font-small);
  }

  .hint {
    display: inline-flex;
    margin-left: auto;
    padding: 0 4px;
    color: var(--dn-muted);
    cursor: help;
  }

  .problem {
    color: var(--vscode-errorForeground);
  }

  .pending {
    color: var(--vscode-descriptionForeground);
  }
</style>

<script lang="ts">
  import { untrack } from 'svelte';
  import type { EditInput } from '../../../../src/shared/cell-input';
  import type { RowAction } from '../../../../src/shared/row-action';
  import type { CellValue } from '../../../../src/shared/cell-value';
  import type { ResultColumnInfo } from '../../../../src/shared/protocols/result-grid';
  import type { Translate } from '../../lib/i18n';
  import Icon from '../../components/Icon.svelte';
  import ContextMenu from '../../components/ContextMenu.svelte';
  import IconButton from '../../components/IconButton.svelte';
  import type { ContextEntry } from '../../components/menu';
  import type { FilterOperator } from '../../../../src/shared/table-filter';
  import { cellText } from '../../../../src/shared/cell-text';
  import { displayOf } from './cells';
  import { typeIcon } from './column-type';
  import { controlFor, type EditColumn, type EditorControl, initialText, isEditableColumn } from './edit-model';
  import { MIN_COLUMN_WIDTH, resizedWidths } from './columns';
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
  import { columnGeometry, columnLayout, rangeOf, type RowGap, rowGeometry, rowTop } from './virtual';
  import {
    DEFAULT_VIEW,
    type GridView,
    gutterWidth,
    headerHeight,
    isTicked,
    NO_TICKS,
    tickedCount,
    tickedRows,
    type Ticks,
    toggleAllTicks,
    toggleTick,
  } from './grid-view';

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
    /** Row height, text size, lines and the gutter; the defaults when absent. */
    view?: GridView | undefined;
    /** Called when a header's up or down arrow is pressed; the host orders. */
    onSortDirection?: ((column: number, direction: 'asc' | 'desc') => void) | undefined;
    /** Called to filter one column from its header; absent when the result cannot be filtered. */
    onFilterColumn?: ((column: number, anchor: HTMLElement) => void) | undefined;
    /** Columns with a condition in the applied filter, for the header's funnel. */
    filteredColumns?: ReadonlySet<number> | undefined;
    /** Called when a header is dropped before another column: the host-free column order. */
    onMoveColumn?: ((from: number, before: number | undefined) => void) | undefined;
    /** Called to open the form that adds a row with the fields filled in. */
    onInsertDialog?: (() => void) | undefined;
    /** Called to open a cell's value in the dialog (the magnifier on the cell). */
    onOpenDialog?: ((row: number, column: number) => void) | undefined;
    /** Called to load a file into a cell or save its value to a file (the cell menu). */
    onCellFile?: ((action: 'load' | 'save', cell: CellRef) => void) | undefined;
    /** Called to filter the table by what a cell holds; absent when it cannot be filtered. */
    onFilterValue?:
      | ((column: number, condition: { operator: FilterOperator; value?: string }) => void)
      | undefined;
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
    view: viewProp,
    onSortDirection,
    onFilterColumn,
    filteredColumns,
    onOpenDialog,
    onCellFile,
    onFilterValue,
    onInsertDialog,
    onMoveColumn,
    t,
  }: Props = $props();

  /** Prefix of the cells' ids, unique per grid, for `aria-activedescendant`. */
  const uid = $props.id();

  /** A step of a keyboard resize; Shift makes it bigger. */
  const RESIZE_STEP = 16;

  const view = $derived(viewProp ?? DEFAULT_VIEW);

  /** One row is exactly this tall, which is what makes the arithmetic simple. */
  const ROW_HEIGHT = $derived(view.rowHeight);

  /** The header row (name over type) is taller than a data row; rows are placed below it. */
  const HEADER_HEIGHT = $derived(headerHeight(view));

  /** The gutter holds the row's check box and number; its width follows the digits. */
  const ROW_NUMBER_WIDTH = $derived(gutterWidth(view, String(rowCount).length));

  /**
   * Until the browser reports a size, one screenful is assumed: the first rows
   * then load right away instead of waiting for the first layout pass.
   */
  const ASSUMED_HEIGHT = $derived(20 * ROW_HEIGHT);
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
  /** The column being dragged by its header, and the one it would land before. */
  let dragging = $state<number | undefined>(undefined);
  let dropBefore = $state<number | undefined>(undefined);

  /** The row whose details are open under it (one at a time), and how much room they take. */
  let expanded = $state<number | undefined>(undefined);
  const detailHeight = $derived(Math.min(340, order.length * 24 + 24));
  const gap = $derived<RowGap | undefined>(
    expanded === undefined ? undefined : { row: expanded, extra: detailHeight },
  );
  const rows = $derived(rowGeometry(scrollTop, height, ROW_HEIGHT, rowCount, undefined, gap));
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
    expanded = undefined;
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

  /** Rows ticked in the gutter; they win over the selection when there are any. */
  let ticks = $state<Ticks>(NO_TICKS);
  const tickCount = $derived(tickedCount(ticks, rowCount));
  const actionRows = $derived(tickCount > 0 ? tickedRows(ticks, rowCount) : selectedRows);
  const canDelete = $derived(actionRows.some((row) => stateAt(row) !== 'deleted'));
  const canRestore = $derived(actionRows.some((row) => stateAt(row) === 'deleted'));

  function clearTicks(_key: string): void {
    ticks = NO_TICKS;
  }

  // Reading only the key keeps this out of a write loop, like the selection's reset.
  $effect(() => {
    clearTicks(resetKey);
  });

  function rowAction(action: RowAction): void {
    const rows =
      action === 'revert'
        ? actionRows
        : action === 'restore'
          ? actionRows.filter((row) => stateAt(row) === 'deleted')
          : action === 'delete'
            ? actionRows.filter((row) => stateAt(row) !== 'deleted')
            : action === 'duplicate'
              ? actionRows
              : [];
    if (action !== 'add' && rows.length === 0) {
      return;
    }
    void onRowAction(action, rows);
  }

  type CellAction =
    | 'copy'
    | 'edit'
    | 'duplicate'
    | 'dialog'
    | 'setNull'
    | 'setEmpty'
    | 'loadFile'
    | 'saveFile'
    | 'filterEq'
    | 'filterNe'
    | 'filterMenu'
    | 'filterNull'
    | 'filterNotNull'
    | 'filterContains'
    | 'filterNotContains';

  /** The right-click menu of a cell: where it is, and which cell it belongs to. */
  let cellMenu = $state<{ x: number; y: number; row: number; column: number } | undefined>(
    undefined,
  );

  function openCellMenu(event: MouseEvent, row: number, position: number): void {
    if (editing !== undefined) {
      return;
    }
    event.preventDefault();
    // A click outside the selection moves the selection to the cell, as in a file manager.
    if (!isSelected(selection, row, position)) {
      selection = selectCell({ row, column: position }, bounds);
    }
    viewport?.focus();
    cellMenu = { x: event.clientX, y: event.clientY, row, column: orig(position) };
  }

  /** A value short enough to sit in a menu line. */
  function shortValue(value: CellValue | undefined): string {
    const text = cellText(value ?? null).replace(/\s+/gu, ' ');
    return text.length > 24 ? `${text.slice(0, 24)}…` : text;
  }

  const cellEntries = $derived.by((): ContextEntry<CellAction>[] => {
    const menu = cellMenu;
    if (menu === undefined) {
      return [];
    }
    const value = rowAt(menu.row)?.[menu.column];
    const info = editColumn(menu.column);
    const editable = info !== undefined && stateAt(menu.row) !== 'deleted';
    const isNull = value === null || value === undefined;
    const name = columns[menu.column]?.name ?? '';
    const entries: ContextEntry<CellAction>[] = [
      { id: 'copy', label: t('cellMenu.copy'), icon: 'copy', tone: 'blue', keys: 'Ctrl+C' },
      { id: 'edit', label: t('cellMenu.edit'), icon: 'edit', tone: 'orange', disabled: !editable, keys: 'F2' },
      { id: 'duplicate', label: t('cellMenu.duplicate'), icon: 'files', tone: 'green', disabled: editColumns === undefined },
    ];
    if (onOpenDialog !== undefined) {
      entries.push({ id: 'dialog', label: t('cellMenu.dialog'), icon: 'open-preview', tone: 'teal' });
    }
    entries.push(
      { id: 'setNull', label: t('cellMenu.setNull'), icon: 'circle-slash', tone: 'purple', separated: true, disabled: !editable || !info.nullable },
      { id: 'setEmpty', label: t('cellMenu.setEmpty'), icon: 'symbol-string', tone: 'purple', disabled: !editable },
    );
    if (onCellFile !== undefined) {
      entries.push(
        { id: 'loadFile', label: t('cellMenu.loadFile'), icon: 'cloud-upload', tone: 'teal', separated: true, disabled: !editable },
        { id: 'saveFile', label: t('cellMenu.saveFile'), icon: 'save', tone: 'green', disabled: isNull },
      );
    }
    if (onFilterValue !== undefined) {
      const quoted = shortValue(value);
      entries.push(
        {
          id: 'filterEq',
          label: isNull ? t('cellMenu.filterNull', name) : t('cellMenu.filterEq', name, quoted),
          icon: 'filter',
          tone: 'orange',
          separated: true,
        },
        {
          id: 'filterNe',
          label: isNull ? t('cellMenu.filterNotNull', name) : t('cellMenu.filterNe', name, quoted),
          icon: 'filter-filled',
          tone: 'orange',
        },
        {
          id: 'filterMenu',
          label: t('cellMenu.filterBy'),
          icon: 'target',
          tone: 'pink',
          children: [
            { id: 'filterNull', label: t('cellMenu.isNull', name), icon: 'circle-slash' },
            { id: 'filterNotNull', label: t('cellMenu.isNotNull', name), icon: 'circle-filled' },
            { id: 'filterContains', label: t('cellMenu.contains', name, quoted), icon: 'whole-word', disabled: isNull },
            { id: 'filterNotContains', label: t('cellMenu.notContains', name, quoted), icon: 'case-sensitive', disabled: isNull },
          ],
        },
      );
    }
    return entries;
  });

  function runCellAction(action: CellAction): void {
    const menu = cellMenu;
    if (menu === undefined) {
      return;
    }
    const value = rowAt(menu.row)?.[menu.column];
    const text = cellText(value ?? null);
    switch (action) {
      case 'copy':
        if (selection !== undefined) {
          onCopy(infoOf(selection));
        }
        break;
      case 'edit':
        startEdit(menu.row, menu.column);
        break;
      case 'duplicate':
        rowAction('duplicate');
        break;
      case 'dialog':
        onOpenDialog?.(menu.row, menu.column);
        break;
      case 'setNull':
        void setFocused({ kind: 'null' });
        break;
      case 'setEmpty':
        void setFocused({ kind: 'text', text: '' });
        break;
      case 'loadFile':
        onCellFile?.('load', { row: menu.row, column: menu.column });
        break;
      case 'saveFile':
        onCellFile?.('save', { row: menu.row, column: menu.column });
        break;
      case 'filterEq':
        onFilterValue?.(menu.column, value === null || value === undefined ? { operator: 'isNull' } : { operator: 'eq', value: text });
        break;
      case 'filterNe':
        onFilterValue?.(menu.column, value === null || value === undefined ? { operator: 'notNull' } : { operator: 'ne', value: text });
        break;
      case 'filterNull':
        onFilterValue?.(menu.column, { operator: 'isNull' });
        break;
      case 'filterNotNull':
        onFilterValue?.(menu.column, { operator: 'notNull' });
        break;
      case 'filterContains':
        onFilterValue?.(menu.column, { operator: 'contains', value: text });
        break;
      case 'filterMenu':
        break;
      case 'filterNotContains':
        onFilterValue?.(menu.column, { operator: 'notContains', value: text });
        break;
    }
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
    const top = rowTop(focus.row, ROW_HEIGHT, gap);
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
    onResize(index, Math.max(MIN_COLUMN_WIDTH, Math.round(name.length * 8.4 + 26)));
  }
</script>

{#if editColumns !== undefined}
  <div class="editbar" data-testid="editbar" role="toolbar" aria-label={t('grid.editToolbar')}>
    <IconButton
      icon="circle-slash"
      tone="yellow"
      label={t('grid.setNull')}
      disabled={!canSetNull}
      onclick={() => {
        void setFocused({ kind: 'null' });
      }}
    />
    <IconButton
      icon="symbol-constant"
      tone="purple"
      label={t('grid.setDefault')}
      disabled={!canSetDefault}
      onclick={() => {
        void setFocused({ kind: 'default' });
      }}
    />
    <span class="toolbar-separator"></span>
    <IconButton
      icon="add"
      tone="green"
      label={t('grid.addRow')}
      onclick={() => {
        rowAction('add');
      }}
    />
    {#if onInsertDialog !== undefined}
      <IconButton
        icon="new-file"
        tone="green"
        label={t('grid.insertDialog')}
        data-testid="insert-dialog-open"
        onclick={onInsertDialog}
      />
    {/if}
    <IconButton
      icon="copy"
      tone="blue"
      label={t('grid.duplicateRows')}
      disabled={actionRows.length === 0}
      onclick={() => {
        rowAction('duplicate');
      }}
    />
    <IconButton
      icon="trash"
      tone="red"
      label={t('grid.deleteRows')}
      disabled={!canDelete}
      onclick={() => {
        rowAction('delete');
      }}
    />
    <IconButton
      icon="history"
      tone="teal"
      label={t('grid.restoreRows')}
      disabled={!canRestore}
      onclick={() => {
        rowAction('restore');
      }}
    />
    <IconButton
      icon="discard"
      tone="orange"
      label={t('grid.revertRows')}
      disabled={actionRows.length === 0}
      onclick={() => {
        rowAction('revert');
      }}
    />
    {#if tickCount > 0}
      <span class="badge" data-testid="tick-count">{t('grid.ticked', tickCount)}</span>
    {/if}
    {#if actionError !== undefined}
      <span class="problem" role="alert" data-testid="action-error">{actionError}</span>
    {/if}
    <span class="hint" title={t('grid.editHint')}>
      <Icon name="question" size={14} /><span class="sr-only">{t('grid.editHint')}</span>
    </span>
  </div>
{/if}

<div
  class="viewport lines-{view.lines} align-{view.align}"
  style="--dn-row-height: {view.rowHeight}px; --dn-grid-font: {view.fontSize}px;{view.font === 'mono'
    ? ' font-family: var(--dn-mono);'
    : ''}"
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
      <div class="cell rownum head" style="width: {ROW_NUMBER_WIDTH}px;" role="columnheader" aria-colindex={1}>
        <span class="expander-space"></span>
        {#if view.checkboxes}
          <input
            type="checkbox"
            class="tick"
            title={t('grid.tickAll')}
            aria-label={t('grid.tickAll')}
            data-testid="tick-all"
            checked={rowCount > 0 && tickCount === rowCount}
            indeterminate={tickCount > 0 && tickCount < rowCount}
            onchange={() => {
              ticks = toggleAllTicks(ticks, rowCount);
            }}
          />
        {:else if view.rowNumbers}#{/if}
      </div>
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
        class:ticked={isTicked(ticks, index)}
        class:inserted={stateAt(index) === 'inserted'}
        class:deleted={stateAt(index) === 'deleted'}
        role="row"
        aria-rowindex={index + 2}
        style="top: {HEADER_HEIGHT + rowTop(index, ROW_HEIGHT, gap)}px; width: {layout.totalWidth + ROW_NUMBER_WIDTH}px;"
      >
        <div class="cell rownum" style="width: {ROW_NUMBER_WIDTH}px;" role="rowheader" aria-colindex={1}>
          <button
            type="button"
            class="expander"
            class:open={expanded === index}
            tabindex="-1"
            title={expanded === index ? t('grid.collapseRow') : t('grid.expandRow')}
            aria-label={expanded === index ? t('grid.collapseRow') : t('grid.expandRow')}
            aria-expanded={expanded === index}
            data-testid="row-expand"
            onclick={() => {
              expanded = expanded === index ? undefined : index;
            }}
          >
            <Icon name="chevron-right" size={14} />
          </button>
          {#if view.checkboxes}
            <input
              type="checkbox"
              class="tick"
              title={t('grid.tickRow', index + 1)}
              aria-label={t('grid.tickRow', index + 1)}
              data-testid="tick-row"
              checked={isTicked(ticks, index)}
              onchange={() => {
                ticks = toggleTick(ticks, index);
              }}
            />
          {/if}
          {#if stateAt(index) === 'inserted'}
            <span class="mark" aria-hidden="true">+</span><span class="sr-only">{t('grid.rowNew')}</span>
          {:else if stateAt(index) === 'deleted'}
            <span class="mark" aria-hidden="true">−</span><span class="sr-only">{t('grid.rowDeleted')}</span>
          {/if}
          {#if view.rowNumbers}<span class="num">{index + 1}</span>{/if}
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
    {#if expanded !== undefined}
      {@const cells = rowAt(expanded)}
      {#if cells !== undefined}
        <div
          class="detail"
          role="group"
          aria-label={t('grid.rowDetails', expanded + 1)}
          data-testid="row-detail"
          style="top: {HEADER_HEIGHT + rowTop(expanded, ROW_HEIGHT) + ROW_HEIGHT}px; left: {scrollLeft}px; width: {width}px; height: {detailHeight}px;"
        >
          <dl>
            {#each order as column (column)}
              {@const shown = displayOf(cells[column] ?? null)}
              <dt>{columns[column]?.name ?? ''}</dt>
              <dd class:null={shown.isNull} title={shown.truncated ? shown.text : undefined}>{shown.text}</dd>
            {/each}
          </dl>
        </div>
      {/if}
    {/if}
  </div>
</div>

{#snippet headCell(position: number)}
  {@const index = orig(position)}
  <div
    class="cell head"
    class:pinned={position < pinned}
    class:drop-target={dropBefore === index}
    role="columnheader"
    tabindex="-1"
    aria-colindex={position + 2}
    data-column={index}
    aria-sort={sort?.column === index ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
    style="width: {widthOf(index)}px;{position < pinned
      ? ` left: ${ROW_NUMBER_WIDTH + (layout.offsets[position] ?? 0)}px;`
      : ''}"
    title={columns[index]?.dataType ?? columns[index]?.name ?? ''}
    ondragover={(event) => {
      if (dragging !== undefined && dragging !== index) {
        event.preventDefault();
        dropBefore = index;
      }
    }}
    ondragleave={() => {
      if (dropBefore === index) {
        dropBefore = undefined;
      }
    }}
    ondrop={(event) => {
      event.preventDefault();
      if (dragging !== undefined) {
        onMoveColumn?.(dragging, index);
      }
      dragging = undefined;
      dropBefore = undefined;
    }}
  >
    <!-- Out of the tab order: the grid is one stop, and Shift+Alt+↑ sorts from a cell. -->
    <button
      type="button"
      class="name"
      class:draggable={view.draggableColumns}
      draggable={view.draggableColumns && onMoveColumn !== undefined}
      ondragstart={(event) => {
        dragging = index;
        const transfer = event.dataTransfer;
        // A test environment may have no data transfer at all.
        transfer?.setData('text/plain', columns[index]?.name ?? '');
        if (transfer) {
          transfer.effectAllowed = 'move';
        }
      }}
      ondragend={() => {
        dragging = undefined;
        dropBefore = undefined;
      }}
      tabindex="-1"
      onclick={() => {
        onSort(index);
      }}
    >
      {#if position < pinned}<span class="pin"><Icon name="pinned" size={12} /></span>{/if}
      <span class="type" data-kind={typeIcon(columns[index]?.dataType)}
        ><Icon name={typeIcon(columns[index]?.dataType)} size={14} /></span
      >
      <span class="label-box">
        <span class="label">{columns[index]?.name ?? ''}</span>{#if editColumns?.[index]?.nullable === false}<span class="required" title={t('grid.notNull')} data-testid="not-null" aria-hidden="true">*</span><span class="sr-only">{t('grid.notNull')}</span>{/if}
        {#if columns[index]?.dataType !== undefined}<span class="dtype">{columns[index].dataType}</span>{/if}
      </span>
    </button>
    <span class="head-tools">
      <span class="sorter" role="group" aria-label={t('grid.sortBy', columns[index]?.name ?? '')}>
        <button
          type="button"
          class="mini"
          class:on={sort?.column === index && sort.direction === 'asc'}
          tabindex="-1"
          title={t('grid.sortAsc')}
          aria-label={t('grid.sortAsc')}
          aria-pressed={sort?.column === index && sort.direction === 'asc'}
          data-testid="sort-asc"
          onclick={() => {
            onSortDirection?.(index, 'asc');
          }}
        >
          <Icon name="chevron-up" size={12} />
        </button>
        <button
          type="button"
          class="mini"
          class:on={sort?.column === index && sort.direction === 'desc'}
          tabindex="-1"
          title={t('grid.sortDesc')}
          aria-label={t('grid.sortDesc')}
          aria-pressed={sort?.column === index && sort.direction === 'desc'}
          data-testid="sort-desc"
          onclick={() => {
            onSortDirection?.(index, 'desc');
          }}
        >
          <Icon name="chevron-down" size={12} />
        </button>
      </span>
      {#if onFilterColumn !== undefined}
        <button
          type="button"
          class="mini funnel"
          class:on={filteredColumns?.has(index) === true}
          tabindex="-1"
          title={t('grid.filterColumn', columns[index]?.name ?? '')}
          aria-label={t('grid.filterColumn', columns[index]?.name ?? '')}
          data-testid="column-filter"
          onclick={(event) => {
            onFilterColumn(index, event.currentTarget);
          }}
        >
          <Icon name={filteredColumns?.has(index) === true ? 'filter-filled' : 'filter'} size={14} />
        </button>
      {/if}
    </span>
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
    oncontextmenu={(event) => {
      openCellMenu(event, index, position);
    }}
  >
    {#if editor === undefined}
      {mark === 'default' ? t('grid.defaultLabel') : cell.text}
      {#if mark !== undefined}<span class="sr-only">{t('grid.cellChanged')}</span>{/if}
      {#if !cell.isNull && onFollow !== undefined && linkTarget?.(column) !== undefined}
        <button
          type="button"
          class="zoom jump"
          tabindex="-1"
          title={t('grid.followLink', linkTarget(column) ?? '')}
          aria-label={t('grid.followLink', linkTarget(column) ?? '')}
          data-testid="cell-link"
          onpointerdown={(event) => {
            event.stopPropagation();
          }}
          ondblclick={(event) => {
            event.stopPropagation();
          }}
          onclick={(event) => {
            event.stopPropagation();
            onFollow(index, column);
          }}
        >
          <Icon name="link-external" size={14} />
        </button>
      {/if}
      {#if onOpenDialog !== undefined && !cell.isNull && !cell.numeric}
        <button
          type="button"
          class="zoom"
          tabindex="-1"
          title={t('grid.viewInDialog')}
          aria-label={t('grid.viewInDialog')}
          data-testid="cell-dialog"
          onpointerdown={(event) => {
            event.stopPropagation();
          }}
          ondblclick={(event) => {
            event.stopPropagation();
          }}
          onclick={(event) => {
            event.stopPropagation();
            onOpenDialog(index, column);
          }}
        >
          <Icon name="zoom-in" size={14} />
        </button>
      {/if}
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

{#if cellMenu !== undefined}
  <ContextMenu
    x={cellMenu.x}
    y={cellMenu.y}
    items={cellEntries}
    label={t('cellMenu.title')}
    onSelect={runCellAction}
    onClose={() => {
      cellMenu = undefined;
      viewport?.focus();
    }}
  />
{/if}

<style>
  .viewport {
    font-size: var(--dn-grid-font, 14px);
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
    height: var(--dn-row-height, 32px);
  }

  .row.odd {
    background: var(--vscode-keybindingTable-rowsBackground, transparent);
  }

  .row:hover {
    background: var(--vscode-list-hoverBackground);
  }

  .cell {
    flex: none;
    padding: 0 12px;
    overflow: hidden;
    line-height: calc(var(--dn-row-height, 32px) - 1px);
    white-space: nowrap;
    text-overflow: ellipsis;
    border-bottom: 1px solid transparent;
    box-sizing: border-box;
  }

  .cell:not(.pinned):not(.rownum):not(.head) {
    position: relative;
  }

  /* Lines are the user's choice: none, between rows (the default) or a full grid. */
  .viewport.lines-rows .cell:not(.head),
  .viewport.lines-all .cell:not(.head) {
    border-bottom-color: var(--dn-grid-line);
  }

  .viewport.lines-all .cell,
  .viewport.lines-columns .cell {
    border-right: 1px solid var(--dn-grid-line);
  }

  .viewport.lines-columns .cell:not(.head) {
    border-bottom-color: transparent;
  }

  .head.drop-target {
    box-shadow: inset 3px 0 0 var(--vscode-focusBorder);
  }

  .name.draggable {
    cursor: grab;
  }

  .viewport.align-left .cell:not(.rownum):not(.head),
  .viewport.align-left .numeric {
    text-align: left;
  }

  .viewport.align-center .cell:not(.rownum):not(.head) {
    text-align: center;
  }

  .viewport.align-right .cell:not(.rownum):not(.head) {
    text-align: right;
  }

  .head {
    position: relative;
    display: flex;
    align-items: center;
    padding: 0 8px 0 12px;
    font-weight: 600;
    line-height: 1.25;
  }

  .label-box {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
    text-align: left;
  }

  .label-box .label,
  .label-box .dtype {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* The type under the name, quieter and smaller, so a header reads at a glance. */
  .dtype {
    color: var(--dn-muted);
    font-size: 0.82em;
    font-weight: normal;
  }

  .name {
    display: flex;
    flex: 1;
    gap: 4px;
    align-items: center;
    min-width: 0;
    height: 100%;
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

  /* A NOT NULL column: the mark is red and sits right after the name. */
  .name .required {
    flex: none;
    color: var(--dn-danger, var(--vscode-errorForeground));
    font-weight: 700;
    line-height: 1;
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

  .head-tools {
    display: flex;
    flex: none;
    gap: 2px;
    align-items: center;
    padding-right: 6px;
  }

  .sorter {
    display: flex;
    flex-direction: column;
  }

  /* Small round buttons in the header; faint until the header is pointed at. */
  .mini {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 16px;
    padding: 0;
    color: var(--dn-muted);
    background: transparent;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    opacity: 0.55;
    transition:
      opacity var(--dn-duration) var(--dn-ease),
      background-color var(--dn-duration) var(--dn-ease);
  }

  .funnel {
    width: 22px;
    height: 22px;
    border-radius: 11px;
  }

  .head:hover .mini,
  .mini.on {
    opacity: 1;
  }

  .mini:hover {
    color: var(--vscode-foreground);
    background: var(--dn-hover);
  }

  .mini.on {
    color: var(--vscode-focusBorder);
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
    display: flex;
    gap: 6px;
    align-items: center;
    justify-content: flex-start;
    padding: 0 8px;
    color: var(--vscode-descriptionForeground);
    font-size: 0.92em;
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
    justify-content: flex-start;
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
    gap: 4px;
    align-items: center;
    padding: 4px 10px;
    border-bottom: 1px solid var(--dn-divider);
    font-size: var(--dn-font-small);
  }

  /* Row check boxes: round, in the accent colour; the editor's own box is a square. */
  .tick {
    flex: none;
    width: 16px;
    height: 16px;
    margin: 0;
    cursor: pointer;
    accent-color: var(--vscode-focusBorder);
    border-radius: 50%;
  }

  .expander {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    padding: 0;
    color: var(--dn-muted);
    background: none;
    border: none;
    border-radius: 9px;
    cursor: pointer;
    transition: transform var(--dn-duration) var(--dn-ease);
  }

  .expander:hover {
    color: var(--vscode-foreground);
    background: var(--dn-hover);
  }

  .expander.open {
    color: var(--vscode-focusBorder);
    transform: rotate(90deg);
  }

  .expander-space {
    flex: none;
    width: 18px;
  }

  /* The open row's fields, top to bottom, under the row. */
  .detail {
    position: absolute;
    z-index: 1;
    overflow: auto;
    padding: 10px 16px 10px 56px;
    background: color-mix(in srgb, var(--vscode-focusBorder) 7%, var(--vscode-editor-background));
    border-bottom: 1px solid var(--dn-grid-line);
    box-sizing: border-box;
  }

  .detail dl {
    display: grid;
    grid-template-columns: minmax(120px, max-content) 1fr;
    gap: 2px 20px;
    margin: 0;
    font-size: 0.95em;
    line-height: 20px;
  }

  .detail dt {
    color: var(--dn-muted);
    text-align: right;
  }

  .detail dd {
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .tick:checked,
  .tick:indeterminate {
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
    border-color: var(--vscode-button-background);
  }

  /* A ticked row is tinted across, so what an action will touch can be seen. */
  .row.ticked,
  .row.ticked .rownum,
  .row.ticked .cell.pinned {
    background: color-mix(in srgb, var(--vscode-focusBorder) 14%, var(--vscode-editor-background));
  }

  /* The magnifier that opens a value in the dialog, over the end of the cell. */
  .zoom {
    position: absolute;
    top: 50%;
    right: 6px;
    display: none;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    padding: 0;
    color: var(--vscode-foreground);
    background: var(--dn-surface);
    border: 1px solid var(--dn-border);
    border-radius: 11px;
    box-shadow: var(--dn-shadow);
    cursor: pointer;
    transform: translateY(-50%);
  }

  .cell:hover .zoom,
  .cell.focused .zoom {
    display: inline-flex;
  }

  /* The jump to a related row sits left of the magnifier when a cell has both. */
  .zoom.jump {
    color: var(--vscode-charts-blue, var(--vscode-focusBorder));
  }

  .zoom.jump:has(+ .zoom) {
    right: 34px;
  }

  .zoom:hover {
    color: var(--vscode-focusBorder);
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

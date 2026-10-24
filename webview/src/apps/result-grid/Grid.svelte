<script lang="ts">
  import type { CellValue } from '../../../../src/shared/cell-value';
  import type { ResultColumnInfo } from '../../../../src/shared/protocols/result-grid';
  import type { Translate } from '../../lib/i18n';
  import { displayOf } from './cells';
  import {
    MIN_COLUMN_WIDTH,
    ROW_NUMBER_WIDTH,
    resizedWidths,
  } from './columns';
  import {
    columnGeometry,
    columnLayout,
    rangeOf,
    rowGeometry,
  } from './virtual';

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
    t: Translate;
  }

  const { columns, rowCount, widths, rowAt, onVisible, onResize, t }: Props = $props();

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

  function startResize(event: PointerEvent, index: number): void {
    event.preventDefault();
    drag = { index, startX: event.clientX, startWidth: widthOf(index) };
    const target = event.currentTarget;
    if (target instanceof HTMLElement) {
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
  role="grid"
  aria-rowcount={rowCount}
  aria-colcount={columns.length}
  tabindex="-1"
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
          style="width: {widthOf(index)}px;"
          title={columns[index]?.dataType ?? columns[index]?.name ?? ''}
        >
          <span class="name">{columns[index]?.name ?? ''}</span>
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
            <div
              class="cell"
              role="gridcell"
              aria-colindex={column + 1}
              class:null={cell.isNull}
              class:numeric={cell.numeric}
              style="width: {widthOf(column)}px;"
              title={cell.truncated || cell.flattened ? cell.text : undefined}
            >
              {cell.text}
            </div>
          {/each}
        {/if}
      </div>
    {/each}
  </div>
</div>

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
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
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

  .pending {
    color: var(--vscode-descriptionForeground);
  }
</style>

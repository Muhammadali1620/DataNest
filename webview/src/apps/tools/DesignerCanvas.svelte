<script lang="ts">
  import {
    addShape,
    angleToPoint,
    boxOf,
    centreOf,
    type Design,
    drawnBox,
    duplicateShapes,
    type Handle,
    newPath,
    newText,
    nextId,
    type PathShape,
    type Point,
    pick,
    removeShapes,
    replaceShape,
    resizeBy,
    rotateTo,
    type Shape,
    shapeFromDrag,
    snap,
    translate,
  } from '../../../../src/shared/tools/svg-design/model';
  import type { Translate } from '../../lib/i18n';
  import type { Pen, Tool } from './designer-types';

  interface Props {
    t: Translate;
    /** The drawing as committed. */
    design: Design;
    selected: readonly string[];
    tool: Tool;
    zoom: number;
    /** Grid step in drawing units; 0 for no snapping. */
    grid: number;
    pen: Pen;
    onSelect: (ids: string[]) => void;
    /** A change that is not final yet (a drag); undefined when it is over. */
    onPreview: (design: Design | undefined) => void;
    /** A finished change; `key` lets steps of one kind that follow each other become one. */
    onCommit: (design: Design, key?: string) => void;
    onTool: (tool: Tool) => void;
    onUndo: () => void;
    onRedo: () => void;
  }

  const { t, design, selected, tool, zoom, grid, pen, onSelect, onPreview, onCommit, onTool, onUndo, onRedo }: Props = $props();

  let svg = $state<SVGSVGElement | undefined>(undefined);
  /** Points of a path being drawn, and where the pointer is now. */
  let pathPoints = $state<Point[]>([]);
  let pointer = $state<Point | undefined>(undefined);
  let announcement = $state('');

  type Drag =
    | { kind: 'move'; start: Point; base: Design; ids: ReadonlySet<string> }
    | { kind: 'resize'; handle: Handle; start: Point; base: Design; id: string }
    | { kind: 'rotate'; base: Design; id: string }
    | { kind: 'create'; tool: 'rect' | 'circle' | 'ellipse' | 'line'; start: Point; base: Design; id: string };
  let drag: Drag | undefined;
  let lastPreview: Design | undefined;

  function preview(next: Design | undefined): void {
    lastPreview = next;
    onPreview(next);
  }

  const selectedSet = $derived(new Set(selected));
  const single = $derived(selected.length === 1 ? design.shapes.find((shape) => shape.id === selected[0]) : undefined);

  /** Keeps the pointer's moves coming to the canvas while a drag leaves it. */
  function capture(pointerId: number): void {
    try {
      svg?.setPointerCapture(pointerId);
    } catch {
      // A pointer that is already gone cannot be captured; the drag still works on the canvas.
    }
  }

  function release(pointerId: number): void {
    try {
      if (svg?.hasPointerCapture(pointerId) === true) {
        svg.releasePointerCapture(pointerId);
      }
    } catch {
      // Nothing was captured.
    }
  }

  function toPoint(event: { clientX: number; clientY: number }): Point {
    const rect = svg?.getBoundingClientRect();
    const scale = rect !== undefined && rect.width > 0 ? rect.width / design.width : zoom;
    return {
      x: (event.clientX - (rect?.left ?? 0)) / scale,
      y: (event.clientY - (rect?.top ?? 0)) / scale,
    };
  }

  const snapped = (point: Point): Point => ({ x: snap(point.x, grid), y: snap(point.y, grid) });
  const tolerance = $derived(6 / zoom);
  const handleSize = $derived(9 / zoom);

  function finishPath(close: boolean): void {
    if (pathPoints.length >= 2) {
      const id = nextId(design);
      const filled = close && pathPoints.length >= 3;
      onCommit(addShape(design, newPath(id, pathPoints, filled, pen)));
      onSelect([id]);
    }
    pathPoints = [];
    pointer = undefined;
    onTool('select');
  }

  function onDown(event: PointerEvent): void {
    if (event.button !== 0) {
      return;
    }
    svg?.focus();
    const raw = toPoint(event);
    const handle = (event.target as Element).closest('[data-handle]')?.getAttribute('data-handle');
    if (tool === 'select') {
      if (single !== undefined && handle !== undefined && handle !== null) {
        capture(event.pointerId);
        drag =
          handle === 'rotate'
            ? { kind: 'rotate', base: design, id: single.id }
            : { kind: 'resize', handle: handle as Handle, start: raw, base: design, id: single.id };
        return;
      }
      const id = pick(design, raw, tolerance);
      if (id === undefined) {
        if (!event.shiftKey) {
          onSelect([]);
        }
        return;
      }
      const ids = event.shiftKey
        ? selectedSet.has(id)
          ? selected.filter((item) => item !== id)
          : [...selected, id]
        : selectedSet.has(id)
          ? [...selected]
          : [id];
      onSelect(ids);
      capture(event.pointerId);
      drag = { kind: 'move', start: raw, base: design, ids: new Set(ids) };
      return;
    }
    const start = snapped(raw);
    if (tool === 'text') {
      const id = nextId(design);
      onCommit(addShape(design, newText(id, start, t('tools.des.newText'), { ...pen, fill: pen.fill === 'none' ? pen.stroke : pen.fill })));
      onSelect([id]);
      onTool('select');
      return;
    }
    if (tool === 'path') {
      const first = pathPoints[0];
      if (first !== undefined && pathPoints.length >= 3 && Math.hypot(first.x - start.x, first.y - start.y) <= tolerance * 1.5) {
        finishPath(true);
      } else {
        pathPoints = [...pathPoints, start];
      }
      return;
    }
    capture(event.pointerId);
    drag = { kind: 'create', tool, start, base: design, id: nextId(design) };
  }

  function onMove(event: PointerEvent): void {
    const raw = toPoint(event);
    pointer = snapped(raw);
    if (drag === undefined) {
      return;
    }
    if (drag.kind === 'move') {
      let dx = raw.x - drag.start.x;
      let dy = raw.y - drag.start.y;
      const moving = drag.ids;
      const lead = drag.base.shapes.find((shape) => moving.has(shape.id));
      if (lead !== undefined && grid > 0) {
        const box = drawnBox(lead);
        dx = snap(box.x + dx, grid) - box.x;
        dy = snap(box.y + dy, grid) - box.y;
      }
      const ids = drag.ids;
      preview({ ...drag.base, shapes: drag.base.shapes.map((shape) => (ids.has(shape.id) ? translate(shape, dx, dy) : shape)) });
    } else if (drag.kind === 'resize') {
      const id = drag.id;
      const target = drag.base.shapes.find((shape) => shape.id === id);
      if (target !== undefined) {
        const at = snapped(raw);
        const start = snapped(drag.start);
        preview(replaceShape(drag.base, resizeBy(target, drag.handle, at.x - start.x, at.y - start.y, event.shiftKey)));
      }
    } else if (drag.kind === 'rotate') {
      const id = drag.id;
      const target = drag.base.shapes.find((shape) => shape.id === id);
      if (target !== undefined) {
        const angle = angleToPoint(target, raw);
        preview(replaceShape(drag.base, rotateTo(target, event.shiftKey ? Math.round(angle / 15) * 15 : angle)));
      }
    } else {
      preview(addShape(drag.base, shapeFromDrag(drag.tool, drag.id, drag.start, snapped(raw), pen, event.shiftKey)));
    }
  }

  function onUp(event: PointerEvent): void {
    const current = drag;
    drag = undefined;
    release(event.pointerId);
    if (current === undefined) {
      return;
    }
    const shown = lastPreview;
    preview(undefined);
    if (current.kind === 'create') {
      const shape = shapeFromDrag(current.tool, current.id, current.start, snapped(toPoint(event)), pen, event.shiftKey);
      const box = boxOf(shape);
      // A click without a drag draws nothing.
      if (Math.max(box.w, box.h) >= 2) {
        onCommit(addShape(current.base, shape));
        onSelect([current.id]);
      }
      onTool('select');
    } else if (shown !== undefined) {
      // Exactly what the drag showed last is what it did.
      onCommit(shown);
    }
  }

  function onKey(event: KeyboardEvent): void {
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (mod && key === 'z') {
      event.preventDefault();
      if (event.shiftKey) {
        onRedo();
      } else {
        onUndo();
      }
    } else if (mod && key === 'y') {
      event.preventDefault();
      onRedo();
    } else if (mod && key === 'a') {
      event.preventDefault();
      onSelect(design.shapes.map((shape) => shape.id));
    } else if (mod && key === 'd') {
      event.preventDefault();
      if (selected.length > 0) {
        const copy = duplicateShapes(design, selectedSet);
        onCommit(copy.design);
        onSelect(copy.ids);
      }
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      if (selected.length > 0) {
        event.preventDefault();
        onCommit(removeShapes(design, selectedSet));
        onSelect([]);
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      pathPoints = [];
      pointer = undefined;
      onSelect([]);
      onTool('select');
    } else if (event.key === 'Enter' && tool === 'path') {
      event.preventDefault();
      finishPath(event.shiftKey);
    } else if (event.key.startsWith('Arrow') && selected.length > 0) {
      event.preventDefault();
      const step = event.shiftKey ? 10 : 1;
      const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
      const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
      onCommit({ ...design, shapes: design.shapes.map((shape) => (selectedSet.has(shape.id) ? translate(shape, dx, dy) : shape)) }, 'nudge');
      announcement = t('tools.des.moved', dx, dy);
    }
  }

  function onWheel(event: WheelEvent): void {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
    }
  }

  function isPath(shape: Shape): shape is PathShape {
    return shape.kind === 'path';
  }

  function transformOf(shape: Shape): string | undefined {
    if (shape.rotation === 0) {
      return undefined;
    }
    const c = centreOf(boxOf(shape));
    return `rotate(${shape.rotation} ${c.x} ${c.y})`;
  }

  const HANDLE_SPOTS: readonly { handle: Handle; fx: number; fy: number }[] = [
    { handle: 'nw', fx: 0, fy: 0 },
    { handle: 'n', fx: 0.5, fy: 0 },
    { handle: 'ne', fx: 1, fy: 0 },
    { handle: 'e', fx: 1, fy: 0.5 },
    { handle: 'se', fx: 1, fy: 1 },
    { handle: 's', fx: 0.5, fy: 1 },
    { handle: 'sw', fx: 0, fy: 1 },
    { handle: 'w', fx: 0, fy: 0.5 },
  ];
</script>

<!-- A drawing surface: one focusable canvas with its own keys, like the ER diagram. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<svg
  bind:this={svg}
  class="canvas"
  class:crosshair={tool !== 'select'}
  viewBox="0 0 {design.width} {design.height}"
  width={design.width * zoom}
  height={design.height * zoom}
  role="application"
  tabindex="0"
  aria-label={t('tools.des.canvas')}
  aria-describedby="tools-des-help"
  data-testid="des-canvas"
  onpointerdown={onDown}
  onpointermove={onMove}
  onpointerup={onUp}
  onpointercancel={onUp}
  ondblclick={() => { if (tool === 'path') { finishPath(false); } }}
  onkeydown={onKey}
  onwheel={onWheel}
>
  <defs>
    <pattern id="tools-des-checker" width="16" height="16" patternUnits="userSpaceOnUse">
      <rect width="8" height="8" class="check-a" />
      <rect x="8" y="8" width="8" height="8" class="check-a" />
    </pattern>
  </defs>
  <rect width={design.width} height={design.height} fill="url(#tools-des-checker)" />
  {#if design.background !== 'none'}
    <rect width={design.width} height={design.height} fill={design.background} />
  {/if}
  {#each design.shapes as shape (shape.id)}
    {@const transform = transformOf(shape)}
    {#if shape.kind === 'rect'}
      <rect x={shape.x} y={shape.y} width={shape.w} height={shape.h} rx={shape.radius} fill={shape.fill} stroke={shape.stroke === 'none' ? undefined : shape.stroke} stroke-width={shape.stroke === 'none' ? undefined : shape.strokeWidth} opacity={shape.opacity} {transform} data-shape={shape.id} />
    {:else if shape.kind === 'circle' || shape.kind === 'ellipse'}
      <ellipse cx={shape.cx} cy={shape.cy} rx={shape.rx} ry={shape.ry} fill={shape.fill} stroke={shape.stroke === 'none' ? undefined : shape.stroke} stroke-width={shape.stroke === 'none' ? undefined : shape.strokeWidth} opacity={shape.opacity} {transform} data-shape={shape.id} />
    {:else if shape.kind === 'line'}
      <line x1={shape.x1} y1={shape.y1} x2={shape.x2} y2={shape.y2} stroke={shape.stroke === 'none' ? undefined : shape.stroke} stroke-width={shape.strokeWidth} opacity={shape.opacity} {transform} data-shape={shape.id} />
    {:else if shape.kind === 'text'}
      <text x={shape.x} y={shape.y} font-size={shape.fontSize} font-family="sans-serif" fill={shape.fill} stroke={shape.stroke === 'none' ? undefined : shape.stroke} stroke-width={shape.stroke === 'none' ? undefined : shape.strokeWidth} opacity={shape.opacity} {transform} data-shape={shape.id}>{shape.text}</text>
    {:else if isPath(shape)}
      {@const points = shape.points.map((p) => `${p.x},${p.y}`).join(' ')}
      {#if shape.closed}
        <polygon {points} fill={shape.fill} stroke={shape.stroke === 'none' ? undefined : shape.stroke} stroke-width={shape.stroke === 'none' ? undefined : shape.strokeWidth} opacity={shape.opacity} {transform} data-shape={shape.id} />
      {:else}
        <polyline {points} fill="none" stroke={shape.stroke === 'none' ? undefined : shape.stroke} stroke-width={shape.strokeWidth} opacity={shape.opacity} {transform} data-shape={shape.id} />
      {/if}
    {/if}
  {/each}

  {#each design.shapes.filter((shape) => selectedSet.has(shape.id)) as shape (shape.id)}
    {@const box = boxOf(shape)}
    <rect class="outline" x={box.x} y={box.y} width={box.w} height={box.h} transform={transformOf(shape)} vector-effect="non-scaling-stroke" />
  {/each}

  {#if single !== undefined && tool === 'select'}
    {@const box = boxOf(single)}
    {@const c = centreOf(box)}
    <g transform={single.rotation === 0 ? undefined : `rotate(${single.rotation} ${c.x} ${c.y})`}>
      <line class="stem" x1={c.x} y1={box.y} x2={c.x} y2={box.y - 22 / zoom} vector-effect="non-scaling-stroke" />
      <circle class="knob" data-handle="rotate" data-testid="des-handle-rotate" cx={c.x} cy={box.y - 22 / zoom} r={handleSize * 0.6} />
      {#each HANDLE_SPOTS as spot (spot.handle)}
        <rect
          class="knob square"
          data-handle={spot.handle}
          data-testid={`des-handle-${spot.handle}`}
          x={box.x + box.w * spot.fx - handleSize / 2}
          y={box.y + box.h * spot.fy - handleSize / 2}
          width={handleSize}
          height={handleSize}
        />
      {/each}
    </g>
  {/if}

  {#if tool === 'path' && pathPoints.length > 0}
    <polyline class="draft" fill="none" points={[...pathPoints, ...(pointer === undefined ? [] : [pointer])].map((p) => `${p.x},${p.y}`).join(' ')} vector-effect="non-scaling-stroke" />
    {#each pathPoints as point, index (index)}
      <circle class="knob" cx={point.x} cy={point.y} r={handleSize * 0.5} />
    {/each}
  {/if}
</svg>
<span class="sr-only" role="status" data-testid="des-announce">{announcement}</span>

<style>
  .canvas {
    display: block;
    max-width: none;
    touch-action: none;
    background: var(--vscode-editor-background);
    border: 1px solid var(--dn-border);
    user-select: none;
  }

  .canvas:focus-visible {
    outline: 2px solid var(--vscode-focusBorder);
    outline-offset: 2px;
  }

  .crosshair {
    cursor: crosshair;
  }

  .check-a {
    fill: color-mix(in srgb, var(--vscode-foreground) 10%, transparent);
  }

  .outline {
    fill: none;
    stroke: var(--dn-accent);
    stroke-dasharray: 5 3;
    stroke-width: 1;
    pointer-events: none;
  }

  .stem {
    stroke: var(--dn-accent);
    stroke-width: 1;
  }

  .knob {
    fill: var(--vscode-editor-background);
    stroke: var(--dn-accent);
    stroke-width: 1.5;
    vector-effect: non-scaling-stroke;
  }

  .draft {
    stroke: var(--dn-accent);
    stroke-dasharray: 5 3;
    stroke-width: 1.5;
    pointer-events: none;
  }
</style>

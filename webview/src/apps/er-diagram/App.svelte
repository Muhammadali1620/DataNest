<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import {
    ER_DETAILS,
    type ErDetails,
    type ErDiagramProtocol,
    type ErDiagramState,
  } from '../../../../src/shared/protocols/er-diagram';
  import type { RpcPeer } from '../../../../src/shared/rpc';
  import type { Translate } from '../../lib/i18n';
  import {
    BOX,
    charMeasure,
    type DiagramColors,
    type Measure,
    measureBoxes,
    placeScene,
    sceneToSvg,
  } from './diagram-view';
  import { layoutDiagram, type Point } from './layout';
  import { svgToPng } from './picture';
  import { clampZoom, fitView, zoomAt, type View } from './view-math';

  interface Props {
    rpc: RpcPeer<ErDiagramProtocol['webview'], ErDiagramProtocol['host']>;
    t: Translate;
    measure?: Measure;
    toPng?: (svg: string, width: number, height: number) => Promise<string>;
    colors?: () => DiagramColors;
  }

  const { rpc, t, measure = charMeasure, toPng = svgToPng, colors = themeColors }: Props = $props();

  let page = $state<ErDiagramState | undefined>(undefined);
  let loading = $state<{ done: number; total: number } | undefined>(undefined);
  let failure = $state<string | undefined>(undefined);
  let details = $state<ErDetails>('all');
  let positions = $state<Record<string, Point>>({});
  let view = $state<View>({ x: 20, y: 20, zoom: 1 });
  let selected = $state<string | undefined>(undefined);
  let query = $state('');
  let width = $state(0);
  let height = $state(0);
  let busy = $state(false);
  let canvas = $state<HTMLDivElement | undefined>(undefined);
  /** A fit asked for before the canvas had a size; done once it has one. */
  let fitPending = false;

  const measured = $derived(
    page === undefined ? new Map() : measureBoxes(page.tables, details, measure),
  );
  const scene = $derived(
    placeScene(measured, page?.relations ?? [], new Map(Object.entries(positions)), details),
  );
  /** Tables tied to the selected one, which stay bright while the rest fades. */
  const related = $derived.by((): readonly string[] | undefined => {
    if (selected === undefined || page === undefined) {
      return undefined;
    }
    const ids = [selected];
    for (const relation of page.relations) {
      if (relation.from === selected) {
        ids.push(relation.to);
      }
      if (relation.to === selected) {
        ids.push(relation.from);
      }
    }
    return ids;
  });
  const matches = $derived.by(() => {
    const needle = query.trim().toLowerCase();
    if (needle === '' || page === undefined) {
      return [];
    }
    return page.tables
      .filter((table) => table.label.toLowerCase().includes(needle))
      .map((table) => table.id);
  });

  function applyState(next: ErDiagramState): void {
    page = next;
    details = next.details;
    loading = undefined;
    failure = undefined;
    if (selected !== undefined && !next.tables.some((table) => table.id === selected)) {
      selected = undefined;
    }
    if (next.positions.length > 0) {
      positions = Object.fromEntries(next.positions.map(({ id, x, y }) => [id, { x, y }]));
      return;
    }
    arrange(next);
  }

  /** Lays every box out again and tells the host, so a reload keeps it. */
  function arrange(source: ErDiagramState | undefined = page): void {
    if (source === undefined) {
      return;
    }
    const boxes = [...measureBoxes(source.tables, details, measure)].map(([id, box]) => ({
      id,
      width: box.width,
      height: box.height,
    }));
    const placed = layoutDiagram(
      boxes,
      source.relations.map((relation) => ({ from: relation.from, to: relation.to })),
    );
    positions = Object.fromEntries(placed);
    rpc.emit('positions', {
      positions: [...placed].map(([id, at]) => ({ id, x: at.x, y: at.y })),
    });
    fit();
  }

  function fit(): void {
    fitPending = width === 0 || height === 0;
    view = fitView(scene.bounds, width, height);
  }

  $effect(() => {
    const element = canvas;
    if (element === undefined) {
      return undefined;
    }
    const measureCanvas = (): void => {
      width = element.clientWidth;
      height = element.clientHeight;
      if (fitPending && width > 0 && height > 0) {
        fit();
      }
    };
    // Untracked: the effect depends on the element only, never on what it measures.
    untrack(measureCanvas);
    // Not every host provides ResizeObserver (test environments); the window's own
    // resize event is a good enough fallback.
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measureCanvas);
      return () => {
        window.removeEventListener('resize', measureCanvas);
      };
    }
    const observer = new ResizeObserver(measureCanvas);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  });

  function zoomBy(factor: number): void {
    view = zoomAt(view, view.zoom * factor, width / 2, height / 2);
  }

  /** Boxes change size with the detail, so they are laid out again rather than overlap. */
  function setDetails(next: ErDetails): void {
    details = next;
    rpc.emit('details', { details: next });
    arrange();
  }

  function refresh(): void {
    loading = { done: 0, total: 0 };
    failure = undefined;
    rpc.emit('refresh', {});
  }

  /** Centres the next table whose name matches the search. */
  function nextMatch(): void {
    if (matches.length === 0) {
      return;
    }
    const at = selected === undefined ? -1 : matches.indexOf(selected);
    const id = matches[(at + 1) % matches.length];
    const box = scene.boxes.find((candidate) => candidate.table.id === id);
    if (id === undefined || box === undefined) {
      return;
    }
    selected = id;
    view = {
      ...view,
      x: width / 2 - (box.x + box.width / 2) * view.zoom,
      y: height / 2 - (box.y + box.height / 2) * view.zoom,
    };
  }

  // Dragging a box or the whole picture.
  type Drag =
    | { kind: 'box'; id: string; startX: number; startY: number; from: Point; moved: boolean }
    | { kind: 'pan'; startX: number; startY: number; from: View };
  let drag: Drag | undefined;

  function startBoxDrag(event: PointerEvent, id: string): void {
    if (event.button !== 0) {
      return;
    }
    event.stopPropagation();
    const from = positions[id] ?? { x: 0, y: 0 };
    drag = { kind: 'box', id, startX: event.clientX, startY: event.clientY, from, moved: false };
    selected = id;
  }

  function startPan(event: PointerEvent): void {
    if (event.button !== 0) {
      return;
    }
    drag = { kind: 'pan', startX: event.clientX, startY: event.clientY, from: view };
    selected = undefined;
  }

  function onPointerMove(event: PointerEvent): void {
    if (drag === undefined) {
      return;
    }
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (drag.kind === 'pan') {
      view = { ...drag.from, x: drag.from.x + dx, y: drag.from.y + dy };
      return;
    }
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 3) {
      return;
    }
    drag.moved = true;
    positions[drag.id] = {
      x: Math.round(drag.from.x + dx / view.zoom),
      y: Math.round(drag.from.y + dy / view.zoom),
    };
  }

  function onPointerUp(): void {
    if (drag?.kind === 'box' && drag.moved) {
      const at = positions[drag.id];
      if (at !== undefined) {
        rpc.emit('positions', { positions: [{ id: drag.id, x: at.x, y: at.y }] });
      }
    }
    drag = undefined;
  }

  function onWheel(event: WheelEvent): void {
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      const rect = (event.currentTarget as Element).getBoundingClientRect();
      view = zoomAt(
        view,
        view.zoom * Math.exp(-event.deltaY / 300),
        event.clientX - rect.left,
        event.clientY - rect.top,
      );
      return;
    }
    view = { ...view, x: view.x - event.deltaX, y: view.y - event.deltaY };
  }

  function onKey(event: KeyboardEvent): void {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) {
      return;
    }
    if (event.key === '+' || event.key === '=') {
      zoomBy(1.2);
    } else if (event.key === '-') {
      zoomBy(1 / 1.2);
    } else if (event.key === '0') {
      fit();
    } else if (event.key === 'Escape') {
      selected = undefined;
    } else if (event.key === 'Enter' && selected !== undefined) {
      openTable(selected);
    } else {
      return;
    }
    event.preventDefault();
  }

  function openTable(id: string): void {
    const table = page?.tables.find((candidate) => candidate.id === id);
    if (table !== undefined && table.external !== true) {
      rpc.emit('openTable', { id });
    }
  }

  async function save(format: 'svg' | 'png'): Promise<void> {
    busy = true;
    try {
      const svg = sceneToSvg(scene, colors());
      const size = /width="(\d+)" height="(\d+)"/u.exec(svg);
      const data =
        format === 'svg'
          ? svg
          : await toPng(svg, Number(size?.[1] ?? 0), Number(size?.[2] ?? 0));
      await rpc.request('save', { format, data });
      failure = undefined;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
    }
  }

  onMount(() => {
    const subscriptions = [
      rpc.on('loading', (next) => {
        loading = next;
      }),
      rpc.on('state', (next) => {
        applyState(next);
      }),
      rpc.on('failed', ({ message }) => {
        loading = undefined;
        failure = message;
      }),
    ];
    rpc.emit('ready', {});
    return () => {
      for (const subscription of subscriptions) {
        subscription.dispose();
      }
    };
  });

  /** The theme's colours, so the saved picture looks like the page. */
  function themeColors(): DiagramColors {
    const style = getComputedStyle(document.body);
    const pick = (name: string, fallback: string): string =>
      style.getPropertyValue(name).trim() || fallback;
    return {
      background: pick('--vscode-editor-background', '#ffffff'),
      box: pick('--vscode-editorWidget-background', '#f3f3f3'),
      header: pick('--vscode-sideBarSectionHeader-background', '#e6e6e6'),
      border: pick('--vscode-editorWidget-border', '#c8c8c8'),
      text: pick('--vscode-foreground', '#333333'),
      muted: pick('--vscode-descriptionForeground', '#717171'),
      key: pick('--vscode-charts-orange', '#d18616'),
      line: pick('--vscode-descriptionForeground', '#717171'),
      font: pick('--vscode-font-family', 'sans-serif'),
    };
  }

  const zoomLabel = $derived(`${Math.round(view.zoom * 100)}%`);
  const dim = (id: string): boolean => related !== undefined && !related.includes(id);
</script>

<svelte:window onpointermove={onPointerMove} onpointerup={onPointerUp} />

<main>
  <header class="bar">
    <h1>{page === undefined ? t('er.loading') : t('er.title', page.scope)}</h1>
    {#if page !== undefined}
      <span class="hint">{t('er.counts', page.tables.length, page.relations.length)}</span>
      <span class="grow"></span>
      <label class="inline">
        {t('er.details')}
        <select
          class="control"
          value={details}
          onchange={(event) => {
            setDetails(event.currentTarget.value as ErDetails);
          }}
        >
          {#each ER_DETAILS as option (option)}
            <option value={option}>{t(`er.details.${option}`)}</option>
          {/each}
        </select>
      </label>
      <input
        class="control search"
        type="search"
        placeholder={t('er.search')}
        aria-label={t('er.search')}
        bind:value={query}
        onkeydown={(event) => {
          if (event.key === 'Enter') {
            nextMatch();
          }
        }}
      />
      <button type="button" class="button secondary" title={t('er.zoomOut')} onclick={() => {
          zoomBy(1 / 1.2);
        }}
        >−</button
      >
      <button
        type="button"
        class="button secondary zoom"
        title={t('er.zoomReset')}
        onclick={() => {
          view = clampZoom({ ...view, zoom: 1 });
        }}>{zoomLabel}</button
      >
      <button type="button" class="button secondary" title={t('er.zoomIn')} onclick={() => {
          zoomBy(1.2);
        }}
        >+</button
      >
      <button type="button" class="button secondary" onclick={fit}>{t('er.fit')}</button>
      <button type="button" class="button secondary" onclick={() => {
          arrange();
        }}>{t('er.arrange')}</button>
      <button type="button" class="button secondary" disabled={loading !== undefined} onclick={refresh}
        >{t('er.refresh')}</button
      >
      <button type="button" class="button secondary" disabled={busy} onclick={() => void save('svg')}
        >{t('er.saveSvg')}</button
      >
      <button type="button" class="button secondary" disabled={busy} onclick={() => void save('png')}
        >{t('er.savePng')}</button
      >
    {/if}
  </header>

  {#if failure !== undefined}
    <p class="error" role="alert">{failure}</p>
  {/if}
  {#if loading !== undefined}
    <p class="hint" role="status">
      {loading.total === 0 ? t('er.loading') : t('er.progress', loading.done, loading.total)}
    </p>
  {/if}

  {#if page?.tables.length === 0}
    <p class="hint">{t('er.empty')}</p>
  {:else if page !== undefined}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
    <div
      class="canvas"
      tabindex="0"
      role="application"
      aria-label={t('er.title', page.scope)}
      bind:this={canvas}
      onpointerdown={startPan}
      onwheel={onWheel}
      onkeydown={onKey}
    >
      <svg width="100%" height="100%">
        <g transform="translate({view.x} {view.y}) scale({view.zoom})">
          {#each scene.lines as line, index (index)}
            {@const lit =
              selected !== undefined &&
              (line.relation.from === selected || line.relation.to === selected)}
            <g class="line" class:lit class:faded={related !== undefined && !lit}>
              <title>{line.relation.name}: {line.relation.columns.join(', ')} → {line.relation.targetColumns.join(', ')}</title>
              <path class="wire" d={line.path} />
              <path d={line.many} />
              <path d={line.one} />
              {#if line.optionalRing !== undefined}
                <circle class="ring" cx={line.optionalRing.x} cy={line.optionalRing.y} r="3.5" />
              {/if}
            </g>
          {/each}
          {#each scene.boxes as box (box.table.id)}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <g
              class="box"
              class:external={box.table.external === true}
              class:selected={selected === box.table.id}
              class:match={matches.includes(box.table.id)}
              class:faded={dim(box.table.id)}
              data-table={box.table.id}
              transform="translate({box.x} {box.y})"
              onpointerdown={(event) => {
                startBoxDrag(event, box.table.id);
              }}
              ondblclick={() => {
                openTable(box.table.id);
              }}
            >
              <title>{box.table.label}</title>
              <rect class="frame" width={box.width} height={box.height} rx="4" />
              <rect class="head" width={box.width} height={BOX.header} rx="4" />
              <text class="label" x={BOX.padding} y={BOX.header / 2 + 4}>{box.text.label}</text>
              {#each box.text.rows as row, index (index)}
                {@const y = BOX.header + index * BOX.row + BOX.row / 2 + 4}
                <g class="row">
                  <title>{row.title}</title>
                  {#if row.mark !== ''}
                    <text class="mark" class:pk={row.mark === 'PK'} x={BOX.padding} {y}>{row.mark}</text>
                  {/if}
                  <text x={BOX.padding + BOX.icon} {y}>{row.name}</text>
                  {#if row.type !== ''}
                    <text class="type" x={box.width - BOX.padding} {y} text-anchor="end">{row.type}</text>
                  {/if}
                </g>
              {/each}
            </g>
          {/each}
        </g>
      </svg>
    </div>
    <p class="hint footer">{t('er.help')}</p>
  {/if}
</main>

<style>
  main {
    display: flex;
    flex-direction: column;
    height: 100vh;
    padding: 8px 12px;
    gap: 6px;
  }
  .bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }
  h1 {
    font-size: 1.2em;
    margin: 0 8px 0 0;
  }
  .grow {
    flex: 1;
  }
  .inline {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .search {
    width: 160px;
  }
  .zoom {
    min-width: 56px;
  }
  .hint {
    color: var(--vscode-descriptionForeground);
    margin: 0;
  }
  .error {
    color: var(--vscode-errorForeground);
    margin: 0;
  }
  .canvas {
    flex: 1;
    min-height: 200px;
    overflow: hidden;
    border: 1px solid var(--vscode-panel-border, transparent);
    cursor: grab;
    touch-action: none;
    user-select: none;
  }
  .canvas:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
  }
  svg {
    display: block;
    font-size: 12px;
    font-family: var(--vscode-font-family);
  }
  .box {
    cursor: move;
  }
  .frame {
    fill: var(--vscode-editorWidget-background);
    stroke: var(--vscode-editorWidget-border, var(--vscode-panel-border));
  }
  .head {
    fill: var(--vscode-sideBarSectionHeader-background, var(--vscode-editorWidget-background));
    stroke: var(--vscode-editorWidget-border, var(--vscode-panel-border));
  }
  .external .frame,
  .external .head {
    stroke-dasharray: 4 3;
  }
  .selected .frame,
  .selected .head {
    stroke: var(--vscode-focusBorder);
    stroke-width: 2;
  }
  .match .frame {
    stroke: var(--vscode-editor-findMatchBorder, var(--vscode-focusBorder));
    stroke-width: 2;
  }
  text {
    fill: var(--vscode-foreground);
  }
  .label {
    font-weight: bold;
  }
  .type {
    fill: var(--vscode-descriptionForeground);
  }
  .mark {
    font-size: 9px;
    font-weight: bold;
    fill: var(--vscode-charts-blue, #3794ff);
  }
  .mark.pk {
    fill: var(--vscode-charts-orange, #d18616);
  }
  .line path,
  .line circle {
    fill: none;
    stroke: var(--vscode-descriptionForeground);
    stroke-width: 1.3;
  }
  .line .ring {
    fill: var(--vscode-editor-background);
  }
  .line.lit path,
  .line.lit circle {
    stroke: var(--vscode-focusBorder);
    stroke-width: 2;
  }
  .faded {
    opacity: 0.3;
  }
  .footer {
    font-size: 0.9em;
  }
</style>

<script lang="ts">
  import type { TableAction } from '../../../../src/shared/table-actions';
  import { onMount, untrack } from 'svelte';
  import {
    ER_DETAILS,
    type ErDetails,
    type ErDiagramProtocol,
    type ErDiagramState,
  } from '../../../../src/shared/protocols/er-diagram';
  import type { RpcPeer } from '../../../../src/shared/rpc';
  import Icon from '../../components/Icon.svelte';
  import IconButton from '../../components/IconButton.svelte';
  import MenuButton from '../../components/MenuButton.svelte';
  import TableBar from '../../components/TableBar.svelte';
  import BootBar from '../../components/BootBar.svelte';
  import { CODICONS } from '../../lib/codicons';
  import type { Translate } from '../../lib/i18n';
  import {
    BOX,
    charMeasure,
    type DiagramColors,
    headerPath,
    type Measure,
    measureBoxes,
    placeScene,
    sceneToSvg,
  } from './diagram-view';
  import { layoutDiagram, type Point } from './layout';
  import { cssColor, svgToPng } from './picture';
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
  /** The table the camera goes over once the boxes are placed and the canvas has a size. */
  let focusId: string | undefined;

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
    focusId = next.focus;
    if (next.positions.length > 0) {
      positions = Object.fromEntries(next.positions.map(({ id, x, y }) => [id, { x, y }]));
      focusNow();
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
    if (!fitPending) {
      focusNow();
    }
  }

  /** The whole diagram is there; the camera stands over the table it was opened from. */
  function focusNow(): void {
    if (focusId === undefined || width === 0 || height === 0) {
      return;
    }
    const id = focusId;
    focusId = undefined;
    const box = scene.boxes.find((candidate) => candidate.table.id === id);
    if (box === undefined) {
      return;
    }
    selected = id;
    view = clampZoom({
      zoom: 1,
      x: width / 2 - (box.x + box.width / 2),
      y: height / 2 - (box.y + box.height / 2),
    });
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
      } else if (focusId !== undefined) {
        focusNow();
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
    if (id !== undefined) {
      centerOn(id);
    }
  }

  /** Selects a table and moves the view so it sits in the middle. */
  function centerOn(id: string): void {
    const box = scene.boxes.find((candidate) => candidate.table.id === id);
    if (box === undefined) {
      return;
    }
    selected = id;
    view = {
      ...view,
      x: width / 2 - (box.x + box.width / 2) * view.zoom,
      y: height / 2 - (box.y + box.height / 2) * view.zoom,
    };
  }

  /** Tables in name order, which is how the keyboard walks through them. */
  const byName = $derived(
    [...scene.boxes]
      .sort((left, right) => left.table.label.localeCompare(right.table.label))
      .map((box) => box.table.id),
  );

  /** The next (or previous) table by name, round the end, from the selected one. */
  function step(delta: 1 | -1): void {
    if (byName.length === 0) {
      return;
    }
    const at = selected === undefined ? -1 : byName.indexOf(selected);
    const next = at === -1 ? (delta === 1 ? 0 : byName.length - 1) : at + delta;
    const id = byName[(next + byName.length) % byName.length];
    if (id !== undefined) {
      centerOn(id);
    }
  }

  /** What a screen reader says about the selected table: its name, columns and keys. */
  const announcement = $derived.by(() => {
    const table = page?.tables.find((candidate) => candidate.id === selected);
    if (table === undefined) {
      return '';
    }
    const relations = page?.relations ?? [];
    const out = relations.filter((relation) => relation.from === table.id).length;
    const into = relations.filter((relation) => relation.to === table.id).length;
    return t('er.selected', table.label, table.columns.length, out, into);
  });

  /** Pixels one arrow key moves the picture; Shift moves five times as far. */
  const PAN_STEP = 40;

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
    const pan = event.shiftKey ? PAN_STEP * 5 : PAN_STEP;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      view = { ...view, x: view.x + (event.key === 'ArrowLeft' ? pan : -pan) };
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      view = { ...view, y: view.y + (event.key === 'ArrowUp' ? pan : -pan) };
    } else if (event.key === ']' || event.key === 'n') {
      step(1);
    } else if (event.key === '[' || event.key === 'p') {
      step(-1);
    } else if (event.key === '+' || event.key === '=') {
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
      rpc.on('focus', ({ id }) => {
        focusId = id;
        selected = undefined;
        focusNow();
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

  /**
   * The theme's colours, so the saved picture looks like the page: the canvas defines
   * them (see the styles below) and the browser resolves them to plain colours.
   */
  function themeColors(): DiagramColors {
    const host = canvas ?? document.body;
    const pick = (name: string, fallback: string): string =>
      cssColor(`var(${name})`, fallback, host);
    return {
      background: pick('--vscode-editor-background', '#ffffff'),
      box: pick('--er-box', '#f3f3f3'),
      header: pick('--er-head', '#e6e6e6'),
      border: pick('--er-border', '#c8c8c8'),
      text: pick('--vscode-foreground', '#333333'),
      muted: pick('--dn-muted', '#717171'),
      key: pick('--er-primary', '#d18616'),
      line: pick('--er-line', '#717171'),
      font:
        getComputedStyle(document.body).getPropertyValue('--vscode-font-family').trim() ||
        'sans-serif',
    };
  }

  /** The key marks are the editor's icons, drawn as text in the icon font. */
  const MARKS = {
    PK: String.fromCodePoint(CODICONS.key),
    FK: String.fromCodePoint(CODICONS.link),
  } as const;
  /** Dots of the background grid, in diagram pixels; they move and scale with the view. */
  const GRID = 20;

  const zoomLabel = $derived(`${Math.round(view.zoom * 100)}%`);
  const dim = (id: string): boolean => related !== undefined && !related.includes(id);
</script>

<svelte:window onpointermove={onPointerMove} onpointerup={onPointerUp} />

<main>
  {#if page === undefined}
    <BootBar {t} />
  {/if}
  {#if page?.tableBar !== undefined}
    <TableBar
      {t}
      active="er"
      isView={page.tableBar.isView}
      onAction={(action: TableAction) => {
        rpc.emit('tableNav', { action, dirty: false });
      }}
    />
  {/if}
  {#if page !== undefined && loading !== undefined}
    <div class="progress-bar" role="progressbar" aria-label={t('er.loading')}></div>
  {/if}
  {#if page === undefined}
    {#if failure !== undefined}
      <div class="empty">
        <div class="notice error" role="alert"><Icon name="error" /><span>{failure}</span></div>
        <button type="button" class="button secondary" onclick={refresh}>
          <Icon name="refresh" />{t('er.retry')}
        </button>
      </div>
    {:else}
      <div class="empty" role="status">
        <Icon name="loading" size={20} spin />
        <p class="empty-title">
          {loading === undefined || loading.total === 0
            ? t('er.loading')
            : t('er.progress', loading.done, loading.total)}
        </p>
        {#if loading !== undefined && loading.total > 0}
          <span class="meter" aria-hidden="true">
            <span style="transform: scaleX({loading.done / loading.total})"></span>
          </span>
        {/if}
      </div>
    {/if}
  {:else}
    {@const hasTables = page.tables.length > 0}
    <header class="toolbar-row">
      <div class="title">
        <Icon name="type-hierarchy" />
        <h1 title={t('er.title', page.scope)}>{t('er.title', page.scope)}</h1>
      </div>
      <span class="spacer"></span>
      {#if hasTables}
        <div class="find">
          <span class="find-icon"><Icon name="search" size={14} /></span>
          <input
            class="control find-input"
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
          {#if query.trim() !== ''}
            <span class="hits" class:none={matches.length === 0} aria-live="polite" data-testid="er-hits">
              {matches.length === 0 ? t('er.noMatches') : t('er.matches', matches.length)}
            </span>
          {/if}
        </div>
        <label class="details">
          <span class="sr-only">{t('er.details')}</span>
          <select
            class="control"
            title={t('er.details')}
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
      {/if}
      <div class="toolbar" role="toolbar" aria-label={t('er.toolbar')}>
        {#if hasTables}
          <IconButton
            icon="zoom-out"
            label={t('er.zoomOut')}
            onclick={() => {
              zoomBy(1 / 1.2);
            }}
          />
          <button
            type="button"
            class="icon-button zoom"
            title={t('er.zoomReset')}
            aria-label={`${t('er.zoomReset')}: ${zoomLabel}`}
            onclick={() => {
              view = clampZoom({ ...view, zoom: 1 });
            }}>{zoomLabel}</button
          >
          <IconButton
            icon="zoom-in"
            label={t('er.zoomIn')}
            onclick={() => {
              zoomBy(1.2);
            }}
          />
          <IconButton icon="screen-full" label={t('er.fit')} hint={t('er.fitHint')} onclick={fit} />
          <span class="toolbar-separator"></span>
          <IconButton
            icon="layout"
            label={t('er.arrange')}
            hint={t('er.arrangeHint')}
            onclick={() => {
              arrange();
            }}
          />
        {/if}
        <IconButton
          icon="refresh"
          label={t('er.refresh')}
          hint={t('er.refreshHint')}
          disabled={loading !== undefined}
          onclick={refresh}
        />
        {#if hasTables}
          <span class="toolbar-separator"></span>
          <MenuButton
            icon="export"
            label={t('er.export')}
            testid="er-export"
            disabled={busy}
            items={[
              { id: 'svg', label: t('er.saveSvg'), icon: 'file-code' },
              { id: 'png', label: t('er.savePng'), icon: 'file-media' },
            ]}
            onSelect={(format: 'svg' | 'png') => {
              void save(format);
            }}
          />
        {/if}
      </div>
    </header>

    {#if failure !== undefined}
      <div class="notice error problem fade-in" role="alert"><Icon name="error" /><span>{failure}</span></div>
    {/if}

    {#if !hasTables}
      <div class="empty">
        <span class="empty-icon"><Icon name="type-hierarchy" size={28} /></span>
        <p class="empty-title">{t('er.empty')}</p>
        <p class="empty-hint">{t('er.emptyHint')}</p>
      </div>
    {:else}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
      <div
        class="canvas"
        tabindex="0"
        role="application"
        aria-label={t('er.title', page.scope)}
        aria-describedby="er-help"
        style="background-position: {view.x}px {view.y}px; background-size: {GRID * view.zoom}px {GRID *
          view.zoom}px"
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
              {@const isSelected = selected === box.table.id}
              {@const isMatch = matches.includes(box.table.id)}
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <g
                class="box"
                class:external={box.table.external === true}
                class:selected={isSelected}
                class:match={isMatch}
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
                {#if isSelected || isMatch}
                  <rect
                    class="halo"
                    x="-4"
                    y="-4"
                    width={box.width + 8}
                    height={box.height + 8}
                    rx={BOX.radius + 3}
                  />
                {/if}
                <rect class="frame" width={box.width} height={box.height} rx={BOX.radius} />
                <path class="head" d={headerPath(0, 0, box.width)} />
                <text class="label" x={BOX.padding} y={BOX.header / 2 + 4}>{box.text.label}</text>
                {#each box.text.rows as row, index (index)}
                  {@const y = BOX.header + index * BOX.row + BOX.row / 2 + 4}
                  <g class="row">
                    <title>{row.title}</title>
                    {#if row.mark !== ''}
                      <text
                        class="mark"
                        class:primary={row.mark === 'PK'}
                        data-mark={row.mark}
                        aria-hidden="true"
                        x={BOX.padding - 2}
                        y={y + 1}>{MARKS[row.mark]}</text
                      >
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
    {/if}

    <footer class="status">
      <span class="stat">{t('er.counts', page.tables.length, page.relations.length)}</span>
      {#if loading !== undefined}
        <span class="stat">
          {loading.total === 0 ? t('er.loading') : t('er.progress', loading.done, loading.total)}
        </span>
      {/if}
      <span class="selected-info" role="status" data-testid="er-announce">{announcement}</span>
      <span class="spacer"></span>
      {#if hasTables}
        <span class="legend">
          <span class="legend-item"><span class="legend-mark primary"><Icon name="key" size={12} /></span>{t('er.legend.primary')}</span>
          <span class="legend-item"><span class="legend-mark foreign"><Icon name="link" size={12} /></span>{t('er.legend.foreign')}</span>
          <span class="legend-item"><span class="legend-external"></span>{t('er.legend.external')}</span>
        </span>
        <span class="help" title={`${t('er.help')}\n${t('er.keys')}`}>
          <Icon name="question" size={14} /><span class="sr-only" id="er-help">{t('er.help')} {t('er.keys')}</span>
        </span>
      {/if}
    </footer>
  {/if}
</main>

<style>
  main {
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100vh;
  }

  .spacer {
    flex: 1;
  }

  /* One row of tools over the diagram, as the result page has. */
  .toolbar-row {
    display: flex;
    flex: none;
    flex-wrap: wrap;
    gap: 4px var(--dn-gap);
    align-items: center;
    min-height: 36px;
    padding: 4px 8px;
    border-bottom: 1px solid var(--dn-divider);
  }

  .title {
    display: flex;
    gap: 6px;
    align-items: center;
    min-width: 0;
    color: var(--dn-muted);
  }

  h1 {
    overflow: hidden;
    color: var(--vscode-foreground);
    font-size: 13px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .find {
    position: relative;
    display: flex;
    gap: 6px;
    align-items: center;
    min-width: 0;
  }

  .find-icon {
    position: absolute;
    left: 7px;
    display: inline-flex;
    color: var(--dn-muted);
    pointer-events: none;
  }

  .find-input {
    width: 180px;
    min-width: 120px;
    padding-left: 26px;
  }

  .hits {
    color: var(--dn-muted);
    font-size: var(--dn-font-small);
    white-space: nowrap;
  }

  .hits.none {
    color: var(--dn-danger);
  }

  .details select {
    min-height: 24px;
    padding-top: 2px;
    padding-bottom: 2px;
  }

  .zoom {
    min-width: 44px;
    font-size: var(--dn-font-small);
    font-variant-numeric: tabular-nums;
  }

  .problem {
    flex: none;
    margin: 8px 8px 0;
  }

  /* Empty, loading and failed states, centred in the page. */
  .empty {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--dn-gap);
    align-items: center;
    justify-content: center;
    padding: var(--dn-gap-xl);
    color: var(--dn-muted);
    text-align: center;
  }

  .empty .notice {
    max-width: 640px;
    text-align: left;
  }

  .empty-icon {
    display: inline-flex;
    padding: 14px;
    background: var(--dn-surface);
    border: 1px solid var(--dn-border);
    border-radius: 50%;
  }

  .empty-title {
    margin: 0;
    color: var(--vscode-foreground);
    font-size: 14px;
  }

  .empty-hint {
    margin: 0;
    font-size: var(--dn-font-small);
  }

  .meter {
    width: 200px;
    height: 2px;
    overflow: hidden;
    background: var(--dn-divider);
    border-radius: 1px;
  }

  .meter span {
    display: block;
    height: 100%;
    background: var(--vscode-progressBar-background, var(--dn-accent));
    transform-origin: left;
    transition: transform var(--dn-duration) var(--dn-ease);
  }

  /*
   * The diagram. Its colours are named here once: the page draws with them and the
   * saved picture reads them back (themeColors), so both look the same.
   */
  .canvas {
    --er-box: var(--dn-surface);
    --er-head: color-mix(in srgb, var(--dn-accent) 14%, var(--dn-surface));
    --er-border: var(--vscode-editorWidget-border, var(--dn-divider));
    --er-line: var(--dn-muted);
    --er-primary: var(--dn-warning);
    --er-foreign: var(--dn-info);

    flex: 1;
    min-height: 160px;
    overflow: hidden;
    background-color: var(--vscode-editor-background);
    background-image: radial-gradient(
      circle,
      color-mix(in srgb, var(--dn-muted) 28%, transparent) 1px,
      transparent 1.2px
    );
    cursor: grab;
    touch-action: none;
    user-select: none;
  }

  .canvas:active {
    cursor: grabbing;
  }

  .canvas:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
  }

  svg {
    display: block;
    font-family: var(--vscode-font-family);
    font-size: 12px;
  }

  .box {
    cursor: move;
    transition: opacity var(--dn-duration) var(--dn-ease);
  }

  .frame {
    fill: var(--er-box);
    stroke: var(--er-border);
  }

  .head {
    fill: var(--er-head);
    stroke: var(--er-border);
  }

  .external .frame,
  .external .head {
    stroke-dasharray: 4 3;
  }

  .halo {
    fill: none;
    stroke: var(--vscode-editor-findMatchBorder, var(--dn-accent));
    stroke-dasharray: 4 3;
    stroke-width: 1.5;
  }

  .selected .halo {
    stroke: var(--dn-accent);
    stroke-dasharray: none;
    stroke-opacity: 0.45;
    stroke-width: 3;
  }

  .selected .frame,
  .selected .head {
    stroke: var(--dn-accent);
    stroke-width: 1.5;
  }

  .selected .head {
    fill: color-mix(in srgb, var(--dn-accent) 30%, var(--er-box));
  }

  text {
    fill: var(--vscode-foreground);
  }

  .label {
    font-weight: 600;
  }

  .type {
    fill: var(--dn-muted);
  }

  .mark {
    font-family: codicon;
    font-size: 13px;
    fill: var(--er-foreign);
  }

  .mark.primary {
    fill: var(--er-primary);
  }

  .line path,
  .line circle {
    fill: none;
    stroke: var(--er-line);
    stroke-width: 1.3;
    transition: opacity var(--dn-duration) var(--dn-ease);
  }

  .line .ring {
    fill: var(--vscode-editor-background);
  }

  .line.lit path,
  .line.lit circle {
    stroke: var(--dn-accent);
    stroke-width: 2;
  }

  .faded {
    opacity: 0.25;
  }

  /* The status bar: what the diagram holds, the chosen table, the key marks. */
  .status {
    display: flex;
    flex: none;
    flex-wrap: wrap;
    gap: 4px 12px;
    align-items: center;
    min-height: 26px;
    padding: 2px 8px;
    color: var(--dn-muted);
    border-top: 1px solid var(--dn-divider);
    font-size: var(--dn-font-small);
  }

  .stat,
  .selected-info {
    white-space: nowrap;
  }

  .selected-info {
    overflow: hidden;
    color: var(--vscode-foreground);
    text-overflow: ellipsis;
  }

  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 12px;
    align-items: center;
  }

  .legend-item {
    display: inline-flex;
    gap: 4px;
    align-items: center;
    white-space: nowrap;
  }

  .legend-mark.primary {
    display: inline-flex;
    color: var(--dn-warning);
  }

  .legend-mark.foreign {
    display: inline-flex;
    color: var(--dn-info);
  }

  .legend-external {
    width: 14px;
    height: 10px;
    border: 1px dashed var(--vscode-editorWidget-border, var(--dn-muted));
    border-radius: var(--dn-radius-s);
  }

  .help {
    display: inline-flex;
    padding: 0 2px;
    cursor: help;
  }

  /* Beside a narrow editor the legend gives way to the diagram's own tooltips. */
  @media (max-width: 640px) {
    .legend {
      display: none;
    }

    .find-input {
      width: 140px;
    }
  }
</style>

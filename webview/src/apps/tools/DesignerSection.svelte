<script lang="ts">
  import type { ToolsProtocol } from '../../../../src/shared/protocols/tools';
  import type { RpcPeer } from '../../../../src/shared/rpc';
  import { bytesToBase64 } from '../../../../src/shared/tools/bytes';
  import { svgToDataUrl } from '../../../../src/shared/tools/image-data';
  import {
    boxOf,
    commit,
    type Design,
    duplicateShapes,
    emptyDesign,
    fitTo,
    type History,
    type Order,
    redo,
    removeShapes,
    reorder,
    replacePresent,
    replaceShape,
    resizeCanvas,
    type Shape,
    startHistory,
    translate,
    undo,
  } from '../../../../src/shared/tools/svg-design/model';
  import { parseSvg, toSvg } from '../../../../src/shared/tools/svg-design/svg';
  import Icon from '../../components/Icon.svelte';
  import IconButton from '../../components/IconButton.svelte';
  import type { CodiconName } from '../../lib/codicons';
  import type { Translate } from '../../lib/i18n';
  import Card from './Card.svelte';
  import DesignerCanvas from './DesignerCanvas.svelte';
  import type { Pen, Tool } from './designer-types';
  import type { ImageApi } from './image-api';

  interface Props {
    rpc: RpcPeer<ToolsProtocol['webview'], ToolsProtocol['host']>;
    t: Translate;
    copy: (text: string) => void;
    images: ImageApi;
    /** The text in the SVG editor, to bring into the designer. */
    editorSvg: string;
    /** Puts the drawing into the SVG editor and shows it. */
    sendToEditor: (svg: string) => void;
    save: (dataUrl: string | undefined, name: string, extension: string) => Promise<void>;
  }

  const { rpc, t, copy, images, editorSvg, sendToEditor, save }: Props = $props();

  const TOOLS: readonly { id: Tool; icon: CodiconName }[] = [
    { id: 'select', icon: 'move' },
    { id: 'rect', icon: 'primitive-square' },
    { id: 'circle', icon: 'circle-large' },
    { id: 'ellipse', icon: 'circle' },
    { id: 'line', icon: 'graph-line' },
    { id: 'path', icon: 'type-hierarchy-sub' },
    { id: 'text', icon: 'whole-word' },
  ];

  const ORDERS: readonly { id: Order; icon: CodiconName }[] = [
    { id: 'front', icon: 'fold-up' },
    { id: 'forward', icon: 'arrow-up' },
    { id: 'backward', icon: 'arrow-down' },
    { id: 'back', icon: 'fold-down' },
  ];

  const ZOOMS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];

  let history = $state<History>(startHistory(emptyDesign(480, 320)));
  let draft = $state<Design | undefined>(undefined);
  let selected = $state<string[]>([]);
  let tool = $state<Tool>('select');
  let zoom = $state(1);
  let snapOn = $state(false);
  let gridStep = $state(10);
  let note = $state<string | undefined>(undefined);
  let problem = $state<string | undefined>(undefined);
  let fileInput = $state<HTMLInputElement | undefined>(undefined);

  // What new shapes get; also what the style fields show when nothing is selected.
  let fill = $state('#409eff');
  let stroke = $state('#1f4f8f');
  let noFill = $state(false);
  let noStroke = $state(false);
  let strokeWidth = $state(2);
  let opacity = $state(100);

  const design = $derived(history.present);
  const shown = $derived(draft ?? design);
  const grid = $derived(snapOn ? Math.max(1, gridStep) : 0);
  const pen = $derived<Pen>({
    fill: noFill ? 'none' : fill,
    stroke: noStroke ? 'none' : stroke,
    strokeWidth,
    opacity: opacity / 100,
  });
  const chosen = $derived(shown.shapes.filter((shape) => selected.includes(shape.id)));
  const single = $derived(chosen.length === 1 ? chosen[0] : undefined);
  const box = $derived(single === undefined ? undefined : boxOf(single));

  // Ids that an undo took away leave the selection.
  $effect(() => {
    const ids = new Set(design.shapes.map((shape) => shape.id));
    if (selected.some((id) => !ids.has(id))) {
      selected = selected.filter((id) => ids.has(id));
    }
  });

  // The style fields follow the one selected shape.
  $effect(() => {
    if (single !== undefined) {
      noFill = single.fill === 'none';
      noStroke = single.stroke === 'none';
      if (single.fill !== 'none') {
        fill = hexOf(single.fill);
      }
      if (single.stroke !== 'none') {
        stroke = hexOf(single.stroke);
      }
      strokeWidth = single.strokeWidth;
      opacity = Math.round(single.opacity * 100);
    }
  });

  let lastKey: string | undefined;
  let lastAt = 0;

  /** A finished change; two with the same key in a row (a colour dragged) are one step. */
  function put(next: Design, key?: string): void {
    const now = Date.now();
    history = key !== undefined && key === lastKey && now - lastAt < 1500 ? replacePresent(history, next) : commit(history, next);
    lastKey = key;
    lastAt = now;
    draft = undefined;
  }

  function hexOf(colour: string): string {
    const match = /^#([0-9a-f]{3})$/iu.exec(colour);
    if (match?.[1] !== undefined) {
      return `#${match[1].split('').map((d) => d + d).join('')}`;
    }
    return /^#[0-9a-f]{6}$/iu.test(colour) ? colour : '#000000';
  }

  /** The same change for every selected shape, and for what new shapes get. */
  function restyle(patch: Partial<Pick<Shape, 'fill' | 'stroke' | 'strokeWidth' | 'opacity'>>, key: string): void {
    if (selected.length > 0) {
      put({ ...design, shapes: design.shapes.map((shape) => (selected.includes(shape.id) ? ({ ...shape, ...patch }) : shape)) }, key);
    }
  }

  function edit(change: (shape: Shape) => Shape, key: string): void {
    if (single !== undefined) {
      put(replaceShape(design, change(single)), key);
    }
  }

  function setBox(next: Partial<{ x: number; y: number; w: number; h: number }>): void {
    if (single === undefined || box === undefined) {
      return;
    }
    const to = { ...box, ...next };
    if (![to.x, to.y, to.w, to.h].every(Number.isFinite)) {
      return;
    }
    const moved = next.w === undefined && next.h === undefined ? translate(single, to.x - box.x, to.y - box.y) : fitTo(single, to);
    put(replaceShape(design, moved), 'box');
  }

  function pickShapes(ids: string[]): void {
    selected = ids;
  }

  function showDraft(next: Design | undefined): void {
    draft = next;
  }

  function pickTool(next: Tool): void {
    tool = next;
  }

  function doUndo(): void {
    history = undo(history);
    lastKey = undefined;
  }

  function doRedo(): void {
    history = redo(history);
    lastKey = undefined;
  }

  function duplicate(): void {
    const copyOf = duplicateShapes(design, new Set(selected));
    put(copyOf.design);
    selected = copyOf.ids;
  }

  function remove(): void {
    put(removeShapes(design, new Set(selected)));
    selected = [];
  }

  function order(how: Order): void {
    put(reorder(design, new Set(selected), how));
  }

  function zoomBy(step: 1 | -1): void {
    const at = ZOOMS.findIndex((value) => value >= zoom);
    const next = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, (at < 0 ? ZOOMS.length - 1 : at) + step))];
    zoom = next ?? 1;
  }

  // ---- Files

  async function importFile(file: File | undefined): Promise<void> {
    if (file === undefined) {
      return;
    }
    importText(await file.text());
  }

  function importText(text: string): void {
    const parsed = parseSvg(text);
    if (parsed === undefined) {
      problem = t('tools.svg.notSvg');
      return;
    }
    problem = undefined;
    note = parsed.skipped > 0 ? t('tools.des.skipped', parsed.skipped) : t('tools.des.imported');
    put(parsed.design);
    selected = [];
  }

  async function saveSvg(): Promise<void> {
    const answer = await rpc.request('saveFile', {
      suggestedName: 'drawing',
      extension: 'svg',
      base64: bytesToBase64(new TextEncoder().encode(toSvg(design))),
    });
    note = answer.ok ? t('tools.img.saved') : answer.error === 'cancelled' ? undefined : t('tools.img.saveFailed');
  }

  async function savePng(): Promise<void> {
    const png = await images.render(svgToDataUrl(toSvg(design)), {
      width: design.width,
      height: design.height,
      format: 'png',
      quality: 1,
    });
    if (png === undefined) {
      problem = t('tools.img.unsupported', 'PNG');
      return;
    }
    problem = undefined;
    await save(png, 'drawing', 'png');
  }

  function label(shape: Shape, index: number): string {
    return shape.kind === 'text' ? `${t('tools.des.kind.text')} “${shape.text}”` : `${t(`tools.des.kind.${shape.kind}`)} ${index + 1}`;
  }

  const num = (event: Event & { currentTarget: HTMLInputElement }): number => event.currentTarget.valueAsNumber;
</script>

<div class="designer">
  <p id="tools-des-help" class="sr-only">{t('tools.des.help')}</p>

  <div class="top tl-row" role="toolbar" aria-label={t('tools.des.actions')}>
    <IconButton icon="discard" tone="blue" label={t('tools.des.undo')} disabled={history.past.length === 0} data-testid="des-undo" onclick={doUndo} />
    <IconButton icon="redo" tone="blue" label={t('tools.des.redo')} disabled={history.future.length === 0} data-testid="des-redo" onclick={doRedo} />
    <span class="sep"></span>
    <IconButton icon="copy" tone="purple" label={t('tools.des.duplicate')} disabled={selected.length === 0} data-testid="des-duplicate" onclick={duplicate} />
    <IconButton icon="trash" tone="red" label={t('tools.des.delete')} disabled={selected.length === 0} data-testid="des-delete" onclick={remove} />
    <span class="sep"></span>
    {#each ORDERS as item (item.id)}
      <IconButton icon={item.icon} tone="teal" label={t(`tools.des.order.${item.id}`)} disabled={selected.length === 0} data-testid={`des-order-${item.id}`} onclick={() => { order(item.id); }} />
    {/each}
    <span class="sep"></span>
    <IconButton icon="zoom-out" label={t('tools.des.zoomOut')} data-testid="des-zoom-out" onclick={() => { zoomBy(-1); }} />
    <span class="muted zoom" data-testid="des-zoom">{Math.round(zoom * 100)}%</span>
    <IconButton icon="zoom-in" label={t('tools.des.zoomIn')} data-testid="des-zoom-in" onclick={() => { zoomBy(1); }} />
    <label class="tl-check">
      <input type="checkbox" bind:checked={snapOn} data-testid="des-snap" />{t('tools.des.snap')}
    </label>
    {#if snapOn}
      <input class="control step" type="number" min="1" max="200" bind:value={gridStep} aria-label={t('tools.des.gridStep')} data-testid="des-grid" />
    {/if}
  </div>

  <div class="work">
    <div class="tools" role="toolbar" aria-orientation="vertical" aria-label={t('tools.des.tools')}>
      {#each TOOLS as item (item.id)}
        <IconButton
          icon={item.icon}
          tone={tool === item.id ? 'blue' : undefined}
          label={t(`tools.des.tool.${item.id}`)}
          pressed={tool === item.id}
          data-testid={`des-tool-${item.id}`}
          onclick={() => { tool = item.id; }}
        />
      {/each}
    </div>

    <div class="scroller">
      <DesignerCanvas
        {t}
        design={shown}
        {selected}
        {tool}
        {zoom}
        {grid}
        {pen}
        onSelect={pickShapes}
        onPreview={showDraft}
        onCommit={put}
        onTool={pickTool}
        onUndo={doUndo}
        onRedo={doRedo}
      />
    </div>

    <div class="side">
      <Card title={t('tools.des.style')} icon="paintcan" tone="orange">
        <div class="tl-row">
          <label class="tl-check">
            <input class="color" type="color" value={hexOf(fill)} disabled={noFill} aria-label={t('tools.des.fill')} data-testid="des-fill"
              oninput={(event) => { fill = event.currentTarget.value; restyle({ fill }, 'fill'); }} />{t('tools.des.fill')}
          </label>
          <label class="tl-check">
            <input type="checkbox" bind:checked={noFill} data-testid="des-nofill" onchange={() => { restyle({ fill: noFill ? 'none' : fill }, 'nofill'); }} />{t('tools.des.none')}
          </label>
        </div>
        <div class="tl-row">
          <label class="tl-check">
            <input class="color" type="color" value={hexOf(stroke)} disabled={noStroke} aria-label={t('tools.des.stroke')} data-testid="des-stroke"
              oninput={(event) => { stroke = event.currentTarget.value; restyle({ stroke }, 'stroke'); }} />{t('tools.des.stroke')}
          </label>
          <label class="tl-check">
            <input type="checkbox" bind:checked={noStroke} data-testid="des-nostroke" onchange={() => { restyle({ stroke: noStroke ? 'none' : stroke }, 'nostroke'); }} />{t('tools.des.none')}
          </label>
        </div>
        <div class="tl-row">
          <label class="num">
            <span class="tl-label">{t('tools.des.strokeWidth')}</span>
            <input class="control" type="number" min="0" max="200" step="0.5" bind:value={strokeWidth} data-testid="des-width"
              oninput={() => { restyle({ strokeWidth: Math.max(0, strokeWidth) }, 'width'); }} />
          </label>
          <label class="num">
            <span class="tl-label">{t('tools.des.opacity', opacity)}</span>
            <input type="range" min="0" max="100" bind:value={opacity} data-testid="des-opacity" aria-label={t('tools.des.opacity', opacity)}
              oninput={() => { restyle({ opacity: opacity / 100 }, 'opacity'); }} />
          </label>
        </div>
      </Card>

      {#if single !== undefined && box !== undefined}
        <Card title={t('tools.des.shape')} icon="symbol-ruler" tone="teal">
          <div class="tl-row" data-testid="des-box">
            {#each ['x', 'y', 'w', 'h'] as const as side (side)}
              <label class="num small">
                <span class="tl-label">{t(`tools.crop.${side}`)}</span>
                <input class="control" type="number" value={Math.round(box[side] * 10) / 10} data-testid={`des-box-${side}`}
                  oninput={(event) => { setBox({ [side]: num(event) }); }} />
              </label>
            {/each}
            <label class="num small">
              <span class="tl-label">{t('tools.des.rotation')}</span>
              <input class="control" type="number" min="0" max="360" value={single.rotation} data-testid="des-rotation"
                oninput={(event) => { const value = num(event); if (Number.isFinite(value)) { edit((shape) => ({ ...shape, rotation: ((value % 360) + 360) % 360 }), 'rotation'); } }} />
            </label>
          </div>
          {#if single.kind === 'rect'}
            <label class="num">
              <span class="tl-label">{t('tools.des.radius')}</span>
              <input class="control" type="number" min="0" value={single.radius} data-testid="des-radius"
                oninput={(event) => { const value = num(event); if (Number.isFinite(value)) { edit((shape) => (shape.kind === 'rect' ? { ...shape, radius: Math.max(0, value) } : shape), 'radius'); } }} />
            </label>
          {:else if single.kind === 'text'}
            <label>
              <span class="tl-label">{t('tools.des.text')}</span>
              <input class="control" type="text" value={single.text} data-testid="des-text"
                oninput={(event) => { const value = event.currentTarget.value; edit((shape) => (shape.kind === 'text' ? { ...shape, text: value } : shape), 'text'); }} />
            </label>
            <label class="num">
              <span class="tl-label">{t('tools.des.fontSize')}</span>
              <input class="control" type="number" min="4" value={Math.round(single.fontSize * 10) / 10} data-testid="des-font"
                oninput={(event) => { const value = num(event); if (Number.isFinite(value)) { edit((shape) => (shape.kind === 'text' ? { ...shape, fontSize: Math.max(4, value) } : shape), 'font'); } }} />
            </label>
          {/if}
        </Card>
      {/if}

      <Card title={t('tools.des.canvasCard')} icon="screen-normal" tone="purple">
        <div class="tl-row">
          <label class="num">
            <span class="tl-label">{t('tools.img.width')}</span>
            <input class="control" type="number" min="1" max="8192" value={design.width} data-testid="des-w"
              oninput={(event) => { const value = num(event); if (Number.isFinite(value)) { put(resizeCanvas(design, value, design.height), 'canvas'); } }} />
          </label>
          <label class="num">
            <span class="tl-label">{t('tools.img.height')}</span>
            <input class="control" type="number" min="1" max="8192" value={design.height} data-testid="des-h"
              oninput={(event) => { const value = num(event); if (Number.isFinite(value)) { put(resizeCanvas(design, design.width, value), 'canvas'); } }} />
          </label>
        </div>
        <div class="tl-row">
          <label class="tl-check">
            <input class="color" type="color" value={hexOf(design.background)} disabled={design.background === 'none'} aria-label={t('tools.svg.background')} data-testid="des-bg"
              oninput={(event) => { put({ ...design, background: event.currentTarget.value }, 'bg'); }} />{t('tools.svg.background')}
          </label>
          <label class="tl-check">
            <input type="checkbox" checked={design.background === 'none'} data-testid="des-nobg"
              onchange={(event) => { put({ ...design, background: event.currentTarget.checked ? 'none' : '#ffffff' }); }} />{t('tools.des.none')}
          </label>
        </div>
      </Card>

      <Card title={t('tools.des.layers')} icon="layers" tone="green">
        {#if shown.shapes.length === 0}
          <p class="muted small">{t('tools.des.noLayers')}</p>
        {:else}
          <ul class="layers" data-testid="des-layers">
            {#each [...shown.shapes].reverse() as shape, i (shape.id)}
              <li>
                <button type="button" class="layer" aria-pressed={selected.includes(shape.id)} data-testid={`des-layer-${shape.id}`}
                  onclick={(event) => { selected = event.shiftKey ? (selected.includes(shape.id) ? selected.filter((id) => id !== shape.id) : [...selected, shape.id]) : [shape.id]; tool = 'select'; }}>
                  <span class="swatch" style="background: {shape.fill === 'none' ? shape.stroke : shape.fill};"></span>
                  {label(shape, shown.shapes.length - 1 - i)}
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </Card>
    </div>
  </div>

  <div class="tl-row files">
    <button type="button" class="button secondary" data-testid="des-import" onclick={() => { fileInput?.click(); }}>
      <Icon name="cloud-upload" />{t('tools.des.import')}
    </button>
    <input bind:this={fileInput} class="sr-only" type="file" accept=".svg,image/svg+xml" tabindex="-1" aria-label={t('tools.des.import')} data-testid="des-file"
      onchange={(event) => { void importFile(event.currentTarget.files?.[0]); event.currentTarget.value = ''; }} />
    <button type="button" class="button secondary" data-testid="des-from-editor" onclick={() => { importText(editorSvg); }}>
      <Icon name="arrow-down" />{t('tools.des.fromEditor')}
    </button>
    <button type="button" class="button secondary" data-testid="des-to-editor" onclick={() => { sendToEditor(toSvg(design)); }}>
      <Icon name="code" />{t('tools.des.toEditor')}
    </button>
    <IconButton icon="copy" tone="blue" label={t('tools.copyNamed', 'SVG')} data-testid="des-copy" onclick={() => { copy(toSvg(design)); }} />
    <button type="button" class="button" data-testid="des-save-svg" onclick={() => { void saveSvg(); }}>
      <Icon name="export" />{t('tools.des.saveSvg')}
    </button>
    <button type="button" class="button" data-testid="des-save-png" onclick={() => { void savePng(); }}>
      <Icon name="export" />{t('tools.svg.exportPng')}
    </button>
  </div>

  {#if problem !== undefined}
    <p class="tl-problem" role="alert" data-testid="des-problem"><Icon name="error" size={14} />{problem}</p>
  {/if}
  {#if note !== undefined}
    <p class="notice success" role="status" data-testid="des-note"><Icon name="pass" />{note}</p>
  {/if}
</div>

<style>
  .designer {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .top {
    align-items: center;
    padding: 6px 10px;
    border: 1px solid var(--dn-border);
    border-radius: 14px;
  }

  .sep {
    width: 1px;
    height: 20px;
    background: var(--dn-divider);
  }

  .zoom {
    min-width: 42px;
    text-align: center;
  }

  .step {
    width: 64px;
  }

  .work {
    display: grid;
    grid-template-columns: 44px minmax(0, 1fr) 290px;
    gap: 12px;
    align-items: start;
  }

  @media (max-width: 900px) {
    .work {
      grid-template-columns: 44px minmax(0, 1fr);
    }

    .side {
      grid-column: 1 / -1;
    }
  }

  .tools {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 4px;
    border: 1px solid var(--dn-border);
    border-radius: 12px;
  }

  .scroller {
    max-height: 640px;
    padding: 10px;
    overflow: auto;
    background: color-mix(in srgb, var(--vscode-foreground) 4%, transparent);
    border: 1px solid var(--dn-border);
    border-radius: 14px;
  }

  .side {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .num {
    width: 120px;
  }

  .num.small {
    width: 64px;
  }

  .num .control {
    width: 100%;
  }

  .color {
    width: 34px;
    height: 26px;
    padding: 0;
    background: transparent;
    border: 1px solid var(--dn-border);
    border-radius: 8px;
    cursor: pointer;
  }

  .layers {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 200px;
    padding: 0;
    margin: 0;
    overflow: auto;
    list-style: none;
  }

  .layer {
    display: flex;
    gap: 8px;
    align-items: center;
    width: 100%;
    padding: 4px 8px;
    color: var(--vscode-foreground);
    text-align: left;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 8px;
    font-family: inherit;
    font-size: inherit;
    cursor: pointer;
  }

  .layer:hover {
    background: var(--dn-hover);
  }

  .layer[aria-pressed='true'] {
    background: color-mix(in srgb, var(--dn-accent) 18%, transparent);
    border-color: color-mix(in srgb, var(--dn-accent) 55%, transparent);
  }

  .swatch {
    flex: none;
    width: 14px;
    height: 14px;
    border: 1px solid var(--dn-border);
    border-radius: 4px;
  }

  .files {
    align-items: center;
  }
</style>

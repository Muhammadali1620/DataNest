<script lang="ts">
  import { formatSize } from '../../../../src/shared/byte-size';
  import {
    type Bounds,
    clampRect,
    fitRatio,
    type Handle,
    HANDLES,
    moveRect,
    presetRatio,
    RATIO_PRESETS,
    type RatioPreset,
    type Rect,
    resizeRect,
    setSize,
  } from '../../../../src/shared/tools/crop';
  import {
    extensionOfFormat,
    OUTPUT_FORMATS,
    type OutputFormat,
    parseDataUrl,
  } from '../../../../src/shared/tools/image-data';
  import Icon from '../../components/Icon.svelte';
  import type { Translate } from '../../lib/i18n';
  import Card from './Card.svelte';
  import type { CanvasApi } from './canvas-api';
  import type { ImageApi, LoadedImage } from './image-api';
  import ImagePicker from './ImagePicker.svelte';

  interface Props {
    t: Translate;
    images: ImageApi;
    canvas: CanvasApi;
    loaded: LoadedImage | undefined;
    onLoad: (image: LoadedImage) => void;
    /** Asks the host where to save, then writes the picture. */
    save: (dataUrl: string | undefined, name: string, extension: string) => Promise<void>;
  }

  const { t, images, canvas, loaded, onLoad, save }: Props = $props();

  const bounds = $derived<Bounds>({ width: loaded?.width ?? 1, height: loaded?.height ?? 1 });

  let box = $state<Rect>({ x: 0, y: 0, w: 1, h: 1 });
  let preset = $state<RatioPreset>('free');
  let custom = $state('2:1');
  let format = $state<OutputFormat>('png');
  let quality = $state(90);
  let output = $state<string | undefined>(undefined);
  let problem = $state<string | undefined>(undefined);
  let busy = $state(false);
  let stage = $state<HTMLDivElement | undefined>(undefined);
  let announcement = $state('');

  const ratio = $derived(presetRatio(preset, custom));
  const customInvalid = $derived(preset === 'custom' && ratio === undefined);
  const outputBytes = $derived.by(() => {
    const parts = output === undefined ? undefined : parseDataUrl(output);
    const padding = /=*$/u.exec(parts?.base64 ?? '')?.[0].length ?? 0;
    return parts === undefined ? 0 : Math.floor((parts.base64.length * 3) / 4) - padding;
  });

  // A new picture starts with the whole picture selected.
  let lastSource: LoadedImage | undefined;
  $effect(() => {
    if (loaded !== undefined && loaded !== lastSource) {
      lastSource = loaded;
      box = { x: 0, y: 0, w: loaded.width, h: loaded.height };
      output = undefined;
      problem = undefined;
      format = loaded.mime === 'image/jpeg' ? 'jpeg' : loaded.mime === 'image/webp' ? 'webp' : 'png';
    }
  });

  function change(next: Rect): void {
    box = next;
    output = undefined;
    announcement = t('tools.crop.announce', next.x, next.y, next.w, next.h);
  }

  function pickRatio(next: RatioPreset): void {
    preset = next;
    const wanted = presetRatio(next, custom);
    if (wanted !== undefined) {
      change(fitRatio(box, wanted, bounds));
    }
  }

  // ---- Dragging

  interface Drag {
    readonly handle: Handle | 'move';
    readonly startX: number;
    readonly startY: number;
    readonly from: Rect;
  }
  let drag: Drag | undefined;

  /** Image pixels a screen pixel is worth. */
  function unit(): number {
    const width = stage?.getBoundingClientRect().width ?? 0;
    return width > 0 ? bounds.width / width : 1;
  }

  function begin(event: PointerEvent, handle: Handle | 'move'): void {
    event.preventDefault();
    try {
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    } catch {
      // A pointer that is gone (or a browser without capture) still drags on the box itself.
    }
    drag = { handle, startX: event.clientX, startY: event.clientY, from: box };
  }

  function onMove(event: PointerEvent): void {
    if (drag === undefined) {
      return;
    }
    const dx = Math.round((event.clientX - drag.startX) * unit());
    const dy = Math.round((event.clientY - drag.startY) * unit());
    change(
      drag.handle === 'move'
        ? moveRect(drag.from, dx, dy, bounds)
        : resizeRect(drag.from, drag.handle, dx, dy, bounds, ratio),
    );
  }

  function end(): void {
    drag = undefined;
  }

  /** Arrows move the box, + and − grow and shrink it, Esc selects everything again. */
  function onKey(event: KeyboardEvent): void {
    const step = event.shiftKey ? 10 : 1;
    const arrows: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const move = arrows[event.key];
    if (move !== undefined) {
      event.preventDefault();
      change(
        event.altKey
          ? resizeRect(box, move[0] === 0 ? (move[1] < 0 ? 'n' : 's') : move[0] < 0 ? 'w' : 'e', move[0], move[1], bounds, ratio)
          : moveRect(box, move[0], move[1], bounds),
      );
    } else if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      change(resizeRect(box, 'se', step * 2, step * 2, bounds, ratio));
    } else if (event.key === '-' || event.key === '_') {
      event.preventDefault();
      change(resizeRect(box, 'se', -step * 2, -step * 2, bounds, ratio));
    } else if (event.key === 'Escape') {
      event.preventDefault();
      change({ x: 0, y: 0, w: bounds.width, h: bounds.height });
    }
  }

  function field(side: 'x' | 'y' | 'w' | 'h', value: number): void {
    if (!Number.isFinite(value)) {
      return;
    }
    change(side === 'w' || side === 'h' ? setSize(box, side, value, bounds, ratio) : clampRect({ ...box, [side]: value }, bounds));
  }

  // ---- Result

  async function render(): Promise<void> {
    if (loaded === undefined || busy) {
      return;
    }
    busy = true;
    try {
      const result = await canvas.crop(loaded.dataUrl, box, {
        format,
        quality: quality / 100,
        background: format === 'jpeg' ? '#ffffff' : undefined,
      });
      output = result;
      problem = result === undefined ? t('tools.img.unsupported', format.toUpperCase()) : undefined;
    } finally {
      busy = false;
    }
  }

  async function copyResult(): Promise<void> {
    if (output !== undefined) {
      problem = (await canvas.copyImage(output)) ? undefined : t('tools.qr.copyFailed');
    }
  }

  const percent = (value: number, total: number): string => `${(value / total) * 100}%`;
  const FIELDS = ['x', 'y', 'w', 'h'] as const;
</script>

<div class="tl-grid wide">
  <Card title={t('tools.img.source')} icon="file-media" tone="blue">
    <ImagePicker {images} current={loaded} {onLoad} {t} />
  </Card>

  <Card title={t('tools.img.crop')} icon="screen-normal" tone="pink">
    {#if loaded === undefined}
      <p class="muted">{t('tools.img.pickFirst')}</p>
    {:else}
      <p id="tools-crop-help" class="sr-only">{t('tools.crop.help')}</p>
      <div
        class="stage"
        bind:this={stage}
        style="aspect-ratio: {bounds.width} / {bounds.height};"
        data-testid="crop-stage"
      >
        <img src={loaded.dataUrl} alt={t('tools.crop.picture')} draggable="false" />
        <button
          type="button"
          class="box"
          style="left: {percent(box.x, bounds.width)}; top: {percent(box.y, bounds.height)}; width: {percent(box.w, bounds.width)}; height: {percent(box.h, bounds.height)};"
          aria-label={t('tools.crop.box')}
          aria-describedby="tools-crop-help"
          data-testid="crop-box"
          onpointerdown={(event) => { begin(event, 'move'); }}
          onpointermove={onMove}
          onpointerup={end}
          onpointercancel={end}
          onkeydown={onKey}
        ></button>
        {#each HANDLES as handle (handle)}
          <button
            type="button"
            class="handle h-{handle}"
            style="left: {handle.includes('w') ? percent(box.x, bounds.width) : handle.includes('e') ? percent(box.x + box.w, bounds.width) : percent(box.x + box.w / 2, bounds.width)}; top: {handle.includes('n') ? percent(box.y, bounds.height) : handle.includes('s') ? percent(box.y + box.h, bounds.height) : percent(box.y + box.h / 2, bounds.height)};"
            aria-label={t(`tools.crop.handle.${handle}`)}
            data-testid={`crop-handle-${handle}`}
            onpointerdown={(event) => { begin(event, handle); }}
            onpointermove={onMove}
            onpointerup={end}
            onpointercancel={end}
            onkeydown={(event) => {
              const step = event.shiftKey ? 10 : 1;
              const delta: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
              const d = delta[event.key];
              if (d !== undefined) {
                event.preventDefault();
                change(resizeRect(box, handle, d[0], d[1], bounds, ratio));
              }
            }}
          ></button>
        {/each}
      </div>
      <span class="sr-only" role="status" data-testid="crop-announce">{announcement}</span>

      <div class="tl-row">
        {#each FIELDS as side (side)}
          <label class="num">
            <span class="tl-label">{t(`tools.crop.${side}`)}</span>
            <input
              class="control"
              type="number"
              min={side === 'w' || side === 'h' ? 1 : 0}
              value={box[side]}
              data-testid={`crop-${side}`}
              oninput={(event) => { field(side, event.currentTarget.valueAsNumber); }}
              onchange={(event) => {
                // A number the box could not take (or none) gives way to what the box is.
                event.currentTarget.value = String(box[side]);
              }}
            />
          </label>
        {/each}
      </div>

      <div class="tl-row">
        <div>
          <span class="tl-label" id="tools-crop-ratio">{t('tools.crop.ratio')}</span>
          <div class="seg" role="group" aria-labelledby="tools-crop-ratio">
            {#each RATIO_PRESETS as item (item)}
              <button type="button" aria-pressed={preset === item} data-testid={`crop-ratio-${item}`} onclick={() => { pickRatio(item); }}>
                {item === 'free' ? t('tools.crop.free') : item === 'custom' ? t('tools.crop.custom') : item}
              </button>
            {/each}
          </div>
        </div>
        {#if preset === 'custom'}
          <label class="num">
            <span class="tl-label">{t('tools.crop.customRatio')}</span>
            <input
              class="control"
              type="text"
              bind:value={custom}
              aria-invalid={customInvalid}
              data-testid="crop-custom"
              onchange={() => { const wanted = presetRatio('custom', custom); if (wanted !== undefined) { change(fitRatio(box, wanted, bounds)); } }}
            />
          </label>
        {/if}
      </div>
      {#if customInvalid}
        <p class="tl-problem" role="alert" data-testid="crop-ratio-problem"><Icon name="warning" size={14} />{t('tools.crop.badRatio')}</p>
      {/if}

      <div class="tl-row">
        <div class="seg" role="group" aria-label={t('tools.img.format')}>
          {#each OUTPUT_FORMATS as item (item)}
            <button type="button" aria-pressed={format === item} data-testid={`crop-format-${item}`} onclick={() => { format = item; output = undefined; }}>
              {item.toUpperCase()}
            </button>
          {/each}
        </div>
        {#if format !== 'png'}
          <label class="quality">
            <span class="tl-label">{t('tools.img.quality', quality)}</span>
            <input type="range" min="10" max="100" bind:value={quality} data-testid="crop-quality" aria-label={t('tools.img.quality', quality)} />
          </label>
        {/if}
      </div>

      <div class="tl-row">
        <button type="button" class="button" disabled={busy} data-testid="crop-render" onclick={() => { void render(); }}>
          <Icon name={busy ? 'loading' : 'screen-normal'} spin={busy} />{t('tools.crop.do')}
        </button>
        {#if output !== undefined}
          {@const made = output}
          <img class="thumb" src={made} alt={t('tools.crop.result')} data-testid="crop-result" />
          <span class="muted" data-testid="crop-size">{box.w}×{box.h} · {formatSize(outputBytes)}</span>
          <button type="button" class="button secondary" data-testid="crop-save" onclick={() => { void save(made, loaded.name, extensionOfFormat(format)); }}>
            <Icon name="export" />{t('tools.img.save')}
          </button>
          <button type="button" class="button secondary" data-testid="crop-copy" onclick={() => { void copyResult(); }}>
            <Icon name="copy" />{t('tools.qr.copyImage')}
          </button>
        {/if}
      </div>
      {#if problem !== undefined}
        <p class="tl-problem" role="alert" data-testid="crop-problem"><Icon name="error" size={14} />{problem}</p>
      {/if}
    {/if}
  </Card>
</div>

<style>
  .stage {
    position: relative;
    max-width: 100%;
    max-height: 520px;
    margin: 0 auto;
    overflow: hidden;
    background: repeating-conic-gradient(color-mix(in srgb, var(--vscode-foreground) 8%, transparent) 0% 25%, transparent 0% 50%) 50% / 16px 16px;
    border: 1px solid var(--dn-border);
    border-radius: 12px;
    touch-action: none;
  }

  .stage img {
    display: block;
    width: 100%;
    height: 100%;
    user-select: none;
    object-fit: fill;
  }

  .box {
    position: absolute;
    padding: 0;
    cursor: move;
    background: transparent;
    border: 2px solid var(--dn-accent);
    border-radius: 2px;
    /* Everything outside the box is dimmed; the stage clips the shadow. */
    box-shadow: 0 0 0 9999px color-mix(in srgb, var(--vscode-editor-background) 62%, transparent);
  }

  .box:focus-visible {
    outline: 2px solid var(--vscode-focusBorder);
    outline-offset: 2px;
  }

  .handle {
    position: absolute;
    width: 14px;
    height: 14px;
    padding: 0;
    background: var(--vscode-editor-background);
    border: 2px solid var(--dn-accent);
    border-radius: 50%;
    transform: translate(-50%, -50%);
  }

  .handle:focus-visible {
    outline: 2px solid var(--vscode-focusBorder);
    outline-offset: 2px;
  }

  .h-nw,
  .h-se {
    cursor: nwse-resize;
  }

  .h-ne,
  .h-sw {
    cursor: nesw-resize;
  }

  .h-n,
  .h-s {
    cursor: ns-resize;
  }

  .h-e,
  .h-w {
    cursor: ew-resize;
  }

  .num {
    width: 100px;
  }

  .num .control {
    width: 100%;
  }

  .quality {
    display: flex;
    flex-direction: column;
    min-width: 160px;
  }

  .thumb {
    max-width: 160px;
    max-height: 120px;
    background: repeating-conic-gradient(color-mix(in srgb, var(--vscode-foreground) 8%, transparent) 0% 25%, transparent 0% 50%) 50% / 14px 14px;
    border: 1px solid var(--dn-border);
    border-radius: 10px;
  }
</style>

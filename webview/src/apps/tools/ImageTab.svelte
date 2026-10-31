<script lang="ts">
  import CodeArea from '../../components/CodeArea.svelte';
  import type { ToolsProtocol } from '../../../../src/shared/protocols/tools';
  import type { RpcPeer } from '../../../../src/shared/rpc';
  import { formatSize } from '../../../../src/shared/byte-size';
  import {
    cssUrl,
    extensionOfFormat,
    formatSvg,
    htmlImg,
    isSvg,
    OUTPUT_FORMATS,
    type OutputFormat,
    parseDataUrl,
    resizeTo,
    setRootFill,
    svgToDataUrl,
    withinPixelLimit,
  } from '../../../../src/shared/tools/image-data';
  import Icon from '../../components/Icon.svelte';
  import IconButton from '../../components/IconButton.svelte';
  import type { CodiconName } from '../../lib/codicons';
  import type { Translate } from '../../lib/i18n';
  import Card from './Card.svelte';
  import type { CanvasApi } from './canvas-api';
  import CompressSection from './CompressSection.svelte';
  import CropSection from './CropSection.svelte';
  import DesignerSection from './DesignerSection.svelte';
  import type { ImageApi, LoadedImage } from './image-api';
  import ImagePicker from './ImagePicker.svelte';
  import { useToolsState } from './state';

  interface Props {
    rpc: RpcPeer<ToolsProtocol['webview'], ToolsProtocol['host']>;
    t: Translate;
    copy: (text: string) => void;
    images: ImageApi;
    canvas: CanvasApi;
  }

  const { rpc, t, copy, images, canvas }: Props = $props();

  type Mode = 'crop' | 'resize' | 'compress' | 'base64' | 'svg' | 'designer';
  const MODES: readonly { id: Mode; icon: CodiconName }[] = [
    { id: 'crop', icon: 'screen-normal' },
    { id: 'resize', icon: 'symbol-ruler' },
    { id: 'compress', icon: 'fold-down' },
    { id: 'base64', icon: 'code' },
    { id: 'svg', icon: 'file-code' },
    { id: 'designer', icon: 'edit' },
  ];
  const memory = useToolsState();
  const savedMode = memory.get('imageMode', 'crop');
  let mode = $state<Mode>(MODES.find((item) => item.id === savedMode)?.id ?? 'crop');
  $effect(() => {
    memory.set('imageMode', mode);
  });

  // The image picked for the first two modes is shared, so switching keeps it.
  let loaded = $state<LoadedImage | undefined>(undefined);
  let note = $state<string | undefined>(undefined);

  // ---- Resize
  let width = $state(0);
  let height = $state(0);
  let keepRatio = $state(true);
  let format = $state<OutputFormat>('png');
  let quality = $state(90);
  let output = $state<string | undefined>(undefined);
  let outputProblem = $state<string | undefined>(undefined);
  let busy = $state(false);

  const outputBytes = $derived.by(() => {
    const parts = output === undefined ? undefined : parseDataUrl(output);
    const padding = /=*$/u.exec(parts?.base64 ?? '')?.[0].length ?? 0;
    return parts === undefined ? 0 : Math.floor((parts.base64.length * 3) / 4) - padding;
  });

  function onLoaded(image: LoadedImage): void {
    loaded = image;
    width = image.width;
    height = image.height;
    output = undefined;
    outputProblem = undefined;
    note = undefined;
  }

  function setSide(side: 'width' | 'height', value: number): void {
    if (loaded === undefined) {
      return;
    }
    // Proportions come from the original; without them the other side stays as it is now.
    const next = resizeTo(keepRatio ? loaded : { width, height }, side, value, keepRatio);
    width = next.width;
    height = next.height;
    output = undefined;
  }

  async function renderResized(): Promise<void> {
    if (loaded === undefined || busy) {
      return;
    }
    if (!withinPixelLimit({ width, height })) {
      outputProblem = t('tools.img.tooBig');
      return;
    }
    busy = true;
    try {
      const result = await images.render(loaded.dataUrl, {
        width,
        height,
        format,
        quality: quality / 100,
        // JPEG has no transparency; a white page under it beats black.
        background: format === 'jpeg' ? '#ffffff' : undefined,
      });
      output = result;
      outputProblem = result === undefined ? t('tools.img.unsupported', format.toUpperCase()) : undefined;
    } finally {
      busy = false;
    }
  }

  async function save(dataUrl: string | undefined, name: string, extension: string): Promise<void> {
    const parts = dataUrl === undefined ? undefined : parseDataUrl(dataUrl);
    if (parts === undefined) {
      return;
    }
    const answer = await rpc.request('saveFile', {
      suggestedName: name,
      extension,
      base64: parts.base64,
    });
    note = answer.ok ? t('tools.img.saved') : answer.error === 'cancelled' ? undefined : t('tools.img.saveFailed');
  }

  // ---- Base64 outputs
  const outputs = $derived(
    loaded === undefined
      ? undefined
      : {
          base64: loaded.dataUrl,
          css: cssUrl(loaded.dataUrl),
          html: htmlImg(loaded.dataUrl, loaded.width, loaded.height),
        },
  );

  // ---- SVG editor

  /** The designer's drawing goes into the editor's text, and the editor is shown. */
  function sendToEditor(next: string): void {
    svg = next;
    mode = 'svg';
  }
  let svg = $state(
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">\n  <rect width="200" height="200" fill="#ffffff"/>\n  <rect x="40" y="40" width="120" height="120" rx="24" fill="#409eff"/>\n</svg>',
  );
  let background = $state('#ffffff');
  let fill = $state('#409eff');
  let svgProblem = $state<string | undefined>(undefined);
  const svgValid = $derived(isSvg(svg));
  const svgUrl = $derived(svgValid ? svgToDataUrl(svg) : undefined);

  function formatText(): void {
    const pretty = formatSvg(svg);
    svgProblem = pretty === undefined ? t('tools.svg.notSvg') : undefined;
    if (pretty !== undefined) {
      svg = pretty;
    }
  }

  function applyFill(): void {
    const next = setRootFill(svg, fill);
    svgProblem = next === undefined ? t('tools.svg.notSvg') : undefined;
    if (next !== undefined) {
      svg = next;
    }
  }

  /** The size the SVG declares, else a square of 512. */
  function svgSize(): { width: number; height: number } {
    const attr = (name: string): number | undefined => {
      const match = new RegExp(`<svg\\b[^>]*\\s${name}\\s*=\\s*["']([\\d.]+)(?:px)?["']`, 'iu').exec(svg);
      const value = match?.[1] === undefined ? Number.NaN : Number(match[1]);
      return Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
    };
    return { width: attr('width') ?? 512, height: attr('height') ?? 512 };
  }

  async function exportPng(): Promise<void> {
    if (svgUrl === undefined) {
      return;
    }
    const size = svgSize();
    const png = await images.render(svgUrl, { ...size, format: 'png', quality: 1, background });
    if (png === undefined) {
      svgProblem = t('tools.img.unsupported', 'PNG');
      return;
    }
    svgProblem = undefined;
    await save(png, 'image', 'png');
  }
</script>

<div class="image-layout">
  <nav class="side-nav" aria-label={t('tools.img.mode')}>
    {#each MODES as item (item.id)}
      <button
        type="button"
        class="nav-item"
        aria-pressed={mode === item.id}
        data-testid={`mode-${item.id}`}
        onclick={() => {
          mode = item.id;
          note = undefined;
        }}
      >
        <Icon name={item.icon} size={15} />{t(`tools.img.${item.id}`)}
      </button>
    {/each}
  </nav>

<div class="tl-stack content-area">
  {#if mode === 'crop'}
    <CropSection {t} {images} {canvas} {loaded} onLoad={onLoaded} {save} />
  {:else if mode === 'compress'}
    <CompressSection {rpc} {t} {images} {canvas} {loaded} onLoad={onLoaded} {save} />
  {:else if mode === 'resize'}
    <div class="tl-grid wide">
      <Card title={t('tools.img.source')} icon="file-media" tone="blue">
        <ImagePicker {images} current={loaded} onLoad={onLoaded} {t} />
      </Card>
      <Card title={t('tools.img.resize')} icon="symbol-ruler" tone="green">
        {#if loaded === undefined}
          <p class="muted">{t('tools.img.pickFirst')}</p>
        {:else}
          <div class="tl-row">
            <label class="num">
              <span class="tl-label">{t('tools.img.width')}</span>
              <input class="control" type="number" min="1" value={width} data-testid="width"
                oninput={(event) => { setSide('width', event.currentTarget.valueAsNumber); }} />
            </label>
            <label class="num">
              <span class="tl-label">{t('tools.img.height')}</span>
              <input class="control" type="number" min="1" value={height} data-testid="height"
                oninput={(event) => { setSide('height', event.currentTarget.valueAsNumber); }} />
            </label>
            <label class="tl-check">
              <input type="checkbox" bind:checked={keepRatio} data-testid="ratio" />{t('tools.img.keepRatio')}
            </label>
          </div>
          <div class="tl-row">
            <div class="seg" role="group" aria-label={t('tools.img.format')}>
              {#each OUTPUT_FORMATS as item (item)}
                <button type="button" aria-pressed={format === item} data-testid={`format-${item}`}
                  onclick={() => { format = item; output = undefined; }}>
                  {item.toUpperCase()}
                </button>
              {/each}
            </div>
            {#if format !== 'png'}
              <label class="quality">
                <span class="tl-label">{t('tools.img.quality', quality)}</span>
                <input type="range" min="10" max="100" bind:value={quality} data-testid="quality" aria-label={t('tools.img.quality', quality)} />
              </label>
            {/if}
          </div>
          <div class="tl-row">
            <button type="button" class="button" disabled={busy} data-testid="render" onclick={() => { void renderResized(); }}>
              <Icon name={busy ? 'loading' : 'play'} spin={busy} />{t('tools.img.render')}
            </button>
            {#if output !== undefined}
              <img class="thumb" src={output} alt={t('tools.img.result')} data-testid="result-img" />
              <span class="muted" data-testid="result-size">{width}×{height} · {formatSize(outputBytes)}</span>
              <button type="button" class="button secondary" data-testid="save" onclick={() => { void save(output, loaded?.name ?? 'image', extensionOfFormat(format)); }}>
                <Icon name="export" />{t('tools.img.save')}
              </button>
            {/if}
          </div>
          {#if outputProblem !== undefined}
            <p class="tl-problem" role="alert" data-testid="out-problem"><Icon name="error" size={14} />{outputProblem}</p>
          {/if}
        {/if}
      </Card>
    </div>
  {:else if mode === 'base64'}
    <div class="tl-grid wide">
      <Card title={t('tools.img.source')} icon="file-media" tone="blue">
        <ImagePicker {images} current={loaded} onLoad={onLoaded} {t} />
        {#if loaded !== undefined}
          <p class="muted small">{formatSize(loaded.bytes)} · {loaded.mime}</p>
        {/if}
      </Card>
      <Card title={t('tools.img.outputs')} icon="code" tone="purple">
        {#if outputs === undefined}
          <p class="muted">{t('tools.img.pickFirst')}</p>
        {:else}
          {#each [['Data URL', 'base64'], ['CSS url()', 'css'], ['HTML <img>', 'html']] as const as [label, id] (id)}
            <div>
              <div class="tl-line head-line">
                <label class="tl-label" for={`tools-out-${id}`}>{label}</label>
                <span class="grow"></span>
                <IconButton icon="copy" tone="blue" label={t('tools.copyNamed', label)} onclick={() => { copy(outputs[id]); }} />
              </div>
              <textarea id={`tools-out-${id}`} class="control tl-area tl-mono" rows="3" readonly value={outputs[id]} data-testid={`out-${id}`}></textarea>
            </div>
          {/each}
        {/if}
      </Card>
    </div>
  {:else if mode === 'svg'}
    <div class="tl-grid wide">
      <Card title="SVG" icon="code" tone="orange">
        {#snippet actions()}
          <button type="button" class="button secondary" data-testid="svg-format" onclick={formatText}>
            <Icon name="json" />{t('tools.svg.format')}
          </button>
          <IconButton icon="copy" tone="blue" label={t('tools.copyNamed', 'SVG')} onclick={() => { copy(svg); }} />
        {/snippet}
        <CodeArea bind:value={svg} mode="xml" label="SVG" testid="svg-text" rows={12} />
        {#if !svgValid}
          <p class="tl-problem" role="alert" data-testid="svg-invalid"><Icon name="warning" size={14} />{t('tools.svg.notSvg')}</p>
        {/if}
      </Card>
      <Card title={t('tools.preview')} icon="eye" tone="teal">
        <div class="tl-row">
          <label class="tl-check">
            <input class="color" type="color" bind:value={background} data-testid="svg-bg" aria-label={t('tools.svg.background')} />{t('tools.svg.background')}
          </label>
          <label class="tl-check">
            <input class="color" type="color" bind:value={fill} data-testid="svg-fill" aria-label={t('tools.svg.fill')} />{t('tools.svg.fill')}
          </label>
          <button type="button" class="button secondary" data-testid="svg-apply-fill" onclick={applyFill}>
            <Icon name="paintcan" />{t('tools.svg.applyFill')}
          </button>
        </div>
        <div class="stage" style="background: {background};">
          {#if svgUrl !== undefined}
            <img src={svgUrl} alt={t('tools.preview')} data-testid="svg-preview" />
          {/if}
        </div>
        <div class="tl-row">
          <button type="button" class="button" disabled={svgUrl === undefined} data-testid="svg-png" onclick={() => { void exportPng(); }}>
            <Icon name="export" />{t('tools.svg.exportPng')}
          </button>
        </div>
        {#if svgProblem !== undefined}
          <p class="tl-problem" role="alert" data-testid="svg-problem"><Icon name="error" size={14} />{svgProblem}</p>
        {/if}
      </Card>
    </div>
  {:else}
    <DesignerSection
      {rpc}
      {t}
      {copy}
      {images}
      editorSvg={svg}
      {sendToEditor}
      {save}
    />
  {/if}

  {#if note !== undefined}
    <p class="notice success" role="status" data-testid="img-note"><Icon name="pass" />{note}</p>
  {/if}
</div>
</div>

<style>
  .image-layout {
    display: grid;
    grid-template-columns: 190px minmax(0, 1fr);
    gap: 16px;
    align-items: start;
  }

  @media (max-width: 760px) {
    .image-layout {
      grid-template-columns: minmax(0, 1fr);
    }
  }

  .side-nav {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 8px;
    border: 1px solid var(--dn-border);
    border-radius: 14px;
  }

  .nav-item {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 7px 10px;
    color: var(--dn-muted);
    text-align: left;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 10px;
    font-family: inherit;
    font-size: inherit;
    cursor: pointer;
    transition:
      color var(--dn-duration) var(--dn-ease),
      background-color var(--dn-duration) var(--dn-ease);
  }

  .nav-item:hover {
    color: var(--vscode-foreground);
    background: var(--dn-hover);
  }

  .nav-item[aria-pressed='true'] {
    color: var(--vscode-foreground);
    background: color-mix(in srgb, var(--dn-accent) 18%, transparent);
    border-color: color-mix(in srgb, var(--dn-accent) 55%, transparent);
  }

  .nav-item:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: 1px;
  }

  .content-area {
    min-width: 0;
  }

  .num {
    width: 110px;
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
    background: repeating-conic-gradient(#8884 0% 25%, transparent 0% 50%) 50% / 14px 14px;
    border: 1px solid var(--dn-border);
    border-radius: 10px;
  }

  .head-line {
    align-items: flex-end;
  }

  .grow {
    flex: 1;
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

  .stage {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 220px;
    padding: 12px;
    border: 1px solid var(--dn-border);
    border-radius: 12px;
  }

  .stage img {
    max-width: 100%;
    max-height: 260px;
  }
</style>

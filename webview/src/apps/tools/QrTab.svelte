<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { ToolsProtocol } from '../../../../src/shared/protocols/tools';
  import type { RpcPeer } from '../../../../src/shared/rpc';
  import { bytesToBase64 } from '../../../../src/shared/tools/bytes';
  import { parseDataUrl, svgToDataUrl } from '../../../../src/shared/tools/image-data';
  import { decodeQrImage } from '../../../../src/shared/tools/qr/decode';
  import { encodeQr, QrTooLongError } from '../../../../src/shared/tools/qr/encode';
  import {
    contrastRatio,
    DEFAULT_DARK,
    DEFAULT_LIGHT,
    isHexColor,
    qrSide,
    qrToPixels,
    qrToSvg,
  } from '../../../../src/shared/tools/qr/render';
  import { QR_ECC_LEVELS, type QrEcc } from '../../../../src/shared/tools/qr/tables';
  import Icon from '../../components/Icon.svelte';
  import IconButton from '../../components/IconButton.svelte';
  import type { Translate } from '../../lib/i18n';
  import Card from './Card.svelte';
  import type { CanvasApi } from './canvas-api';
  import type { ImageApi, LoadedImage } from './image-api';
  import ImagePicker from './ImagePicker.svelte';

  interface Props {
    rpc: RpcPeer<ToolsProtocol['webview'], ToolsProtocol['host']>;
    t: Translate;
    copy: (text: string) => void;
    images: ImageApi;
    canvas: CanvasApi;
  }

  const { rpc, t, copy, images, canvas }: Props = $props();

  // ---- Read a code from a picture

  /** The longest side a picture is read at: bigger ones are scaled down first. */
  const READ_SIDE = 1600;
  const HISTORY_SIZE = 8;

  let loaded = $state<LoadedImage | undefined>(undefined);
  let decoded = $state<string | undefined>(undefined);
  let version = $state<number | undefined>(undefined);
  let notFound = $state(false);
  let reading = $state(false);
  let history = $state<string[]>([]);
  let note = $state<string | undefined>(undefined);

  function picked(image: LoadedImage): void {
    void read(image);
  }

  async function read(image: LoadedImage): Promise<void> {
    loaded = image;
    decoded = undefined;
    version = undefined;
    notFound = false;
    reading = true;
    try {
      const pixels = await canvas.pixels(image.dataUrl, READ_SIDE);
      const found = pixels === undefined ? undefined : decodeQrImage(pixels);
      if (found === undefined) {
        notFound = true;
        return;
      }
      decoded = found.text;
      version = found.version;
      history = [found.text, ...history.filter((entry) => entry !== found.text)].slice(0, HISTORY_SIZE);
    } finally {
      reading = false;
    }
  }

  const link = $derived(
    decoded !== undefined && /^(?:https?:\/\/|mailto:)\S+$/iu.test(decoded.trim()) ? decoded.trim() : undefined,
  );

  async function openLink(): Promise<void> {
    if (link === undefined) {
      return;
    }
    const answer = await rpc.request('openLink', { url: link });
    note = answer.opened ? undefined : t('tools.qr.notOpened');
  }

  function useAsText(text: string): void {
    source = text;
  }

  // ---- Make a code

  let source = $state('https://example.com');
  let ecc = $state<QrEcc>('M');
  let margin = $state(4);
  let size = $state(320);
  let dark = $state(DEFAULT_DARK);
  let light = $state(DEFAULT_LIGHT);

  const made = $derived.by(() => {
    try {
      return { code: encodeQr(source, { ecc }), problem: undefined };
    } catch (error) {
      return { code: undefined, problem: error instanceof QrTooLongError ? t('tools.qr.tooLong') : t('tools.qr.failed') };
    }
  });
  const code = $derived(made.code);
  const style = $derived({ margin, dark: isHexColor(dark) ? dark : DEFAULT_DARK, light: isHexColor(light) ? light : DEFAULT_LIGHT });
  const svg = $derived(code === undefined ? undefined : qrToSvg(code, style));
  const svgUrl = $derived(svg === undefined ? undefined : svgToDataUrl(svg));
  const contrast = $derived(contrastRatio(style.dark, style.light));
  const warning = $derived(
    contrast < 3 ? t('tools.qr.lowContrast') : contrastRatio(style.dark, '#000000') > contrastRatio(style.light, '#000000') ? t('tools.qr.inverted') : undefined,
  );

  async function png(): Promise<string | undefined> {
    if (code === undefined) {
      return undefined;
    }
    const scale = Math.max(1, Math.round(size / qrSide(code, style)));
    const pixels = qrToPixels(code, scale, style);
    return await canvas.fromPixels(pixels, { format: 'png', quality: 1 });
  }

  async function save(dataUrl: string | undefined, extension: string): Promise<void> {
    const parts = dataUrl === undefined ? undefined : parseDataUrl(dataUrl);
    if (parts === undefined) {
      return;
    }
    const answer = await rpc.request('saveFile', { suggestedName: 'qrcode', extension, base64: parts.base64 });
    note = answer.ok ? t('tools.img.saved') : answer.error === 'cancelled' ? undefined : t('tools.img.saveFailed');
  }

  async function saveSvg(): Promise<void> {
    if (svg === undefined) {
      return;
    }
    const answer = await rpc.request('saveFile', {
      suggestedName: 'qrcode',
      extension: 'svg',
      base64: bytesToBase64(new TextEncoder().encode(svg)),
    });
    note = answer.ok ? t('tools.img.saved') : answer.error === 'cancelled' ? undefined : t('tools.img.saveFailed');
  }

  async function copyPng(): Promise<void> {
    const url = await png();
    note = url !== undefined && (await canvas.copyImage(url)) ? t('tools.copied') : t('tools.qr.copyFailed');
  }

  let noteTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    if (note !== undefined) {
      clearTimeout(noteTimer);
      noteTimer = setTimeout(() => {
        note = undefined;
      }, 4000);
    }
  });
  onDestroy(() => {
    clearTimeout(noteTimer);
  });
</script>

<div class="tl-stack">
  <div class="tl-grid wide">
    <Card title={t('tools.qr.decode')} icon="search" tone="teal">
      <ImagePicker {images} current={loaded} onLoad={picked} {t} />
      {#if reading}
        <p class="muted"><Icon name="loading" spin />{t('tools.qr.reading')}</p>
      {:else if notFound}
        <p class="tl-problem" role="alert" data-testid="qr-none"><Icon name="warning" size={14} />{t('tools.qr.none')}</p>
      {/if}
      {#if decoded !== undefined}
        <div>
          <div class="tl-line head-line">
            <label class="tl-label" for="tools-qr-content">{t('tools.qr.result')}</label>
            <span class="grow"></span>
            {#if version !== undefined}
              <span class="badge outline" data-testid="qr-version">{t('tools.qr.version', version)}</span>
            {/if}
            <IconButton icon="copy" tone="blue" label={t('tools.copyNamed', t('tools.qr.result'))} onclick={() => { copy(decoded ?? ''); }} />
          </div>
          <textarea id="tools-qr-content" class="control tl-area tl-mono" rows="4" readonly value={decoded} data-testid="qr-content"></textarea>
        </div>
        <div class="tl-row">
          {#if link !== undefined}
            <button type="button" class="button" data-testid="qr-open" onclick={() => { void openLink(); }}>
              <Icon name="link-external" />{t('tools.qr.openLink')}
            </button>
          {/if}
          <button type="button" class="button secondary" data-testid="qr-reuse" onclick={() => { useAsText(decoded ?? ''); }}>
            <Icon name="arrow-down" />{t('tools.qr.reuse')}
          </button>
        </div>
      {/if}
      {#if history.length > 0}
        <div>
          <div class="tl-line head-line">
            <span class="tl-label">{t('tools.qr.history')}</span>
            <span class="grow"></span>
            <IconButton icon="clear-all" label={t('tools.qr.clear')} onclick={() => { history = []; }} />
          </div>
          <ul class="history" data-testid="qr-history">
            {#each history as entry (entry)}
              <li>
                <button type="button" class="link-button" title={entry} onclick={() => { decoded = entry; notFound = false; }}>{entry}</button>
              </li>
            {/each}
          </ul>
        </div>
      {/if}
    </Card>

    <Card title={t('tools.qr.encode')} icon="symbol-structure" tone="purple">
      <div>
        <label class="tl-label" for="tools-qr-source">{t('tools.qr.text')}</label>
        <textarea id="tools-qr-source" class="control tl-area tl-mono" rows="3" bind:value={source} data-testid="qr-source"></textarea>
      </div>
      <div class="tl-row">
        <div>
          <span class="tl-label" id="tools-qr-ecc">{t('tools.qr.ecc')}</span>
          <div class="seg" role="group" aria-labelledby="tools-qr-ecc" title={t('tools.qr.eccHint')}>
            {#each QR_ECC_LEVELS as level (level)}
              <button type="button" aria-pressed={ecc === level} data-testid={`qr-ecc-${level}`} onclick={() => { ecc = level; }}>{level}</button>
            {/each}
          </div>
        </div>
        <label class="num">
          <span class="tl-label">{t('tools.qr.margin')}</span>
          <input class="control" type="number" min="0" max="20" bind:value={margin} data-testid="qr-margin" />
        </label>
        <label class="num">
          <span class="tl-label">{t('tools.qr.size')}</span>
          <input class="control" type="number" min="64" max="4096" step="32" bind:value={size} data-testid="qr-size" />
        </label>
        <label class="tl-check">
          <input class="color" type="color" bind:value={dark} data-testid="qr-dark" aria-label={t('tools.qr.dark')} />{t('tools.qr.dark')}
        </label>
        <label class="tl-check">
          <input class="color" type="color" bind:value={light} data-testid="qr-light" aria-label={t('tools.qr.light')} />{t('tools.qr.light')}
        </label>
      </div>
      {#if made.problem !== undefined}
        <p class="tl-problem" role="alert" data-testid="qr-problem"><Icon name="error" size={14} />{made.problem}</p>
      {:else if svgUrl !== undefined && code !== undefined}
        <div class="stage">
          <img src={svgUrl} alt={t('tools.qr.preview')} data-testid="qr-preview" />
        </div>
        <p class="muted small" data-testid="qr-info">{t('tools.qr.version', code.version)} · {code.size}×{code.size}</p>
        {#if warning !== undefined}
          <p class="notice warning" role="status" data-testid="qr-warning"><Icon name="warning" />{warning}</p>
        {/if}
        <div class="tl-row">
          <button type="button" class="button" data-testid="qr-save-png" onclick={() => { void png().then((url) => save(url, 'png')); }}>
            <Icon name="export" />{t('tools.qr.savePng')}
          </button>
          <button type="button" class="button secondary" data-testid="qr-save-svg" onclick={() => { void saveSvg(); }}>
            <Icon name="export" />{t('tools.qr.saveSvg')}
          </button>
          <IconButton icon="copy" tone="blue" label={t('tools.copyNamed', 'SVG')} onclick={() => { copy(svg ?? ''); }} />
          <IconButton icon="file-media" tone="green" label={t('tools.qr.copyImage')} onclick={() => { void copyPng(); }} />
        </div>
      {/if}
    </Card>
  </div>

  {#if note !== undefined}
    <p class="notice success" role="status" data-testid="qr-note"><Icon name="pass" />{note}</p>
  {/if}
</div>

<style>
  .num {
    width: 100px;
  }

  .num .control {
    width: 100%;
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
    padding: 14px;
    background: repeating-conic-gradient(color-mix(in srgb, var(--vscode-foreground) 8%, transparent) 0% 25%, transparent 0% 50%) 50% / 16px 16px;
    border: 1px solid var(--dn-border);
    border-radius: 12px;
  }

  .stage img {
    width: min(100%, 260px);
    height: auto;
    image-rendering: pixelated;
  }

  .history {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .history .link-button {
    max-width: 100%;
    overflow: hidden;
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>

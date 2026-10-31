<script lang="ts">
  import { onMount } from 'svelte';
  import type { ToolsProtocol } from '../../../../src/shared/protocols/tools';
  import type { RpcPeer } from '../../../../src/shared/rpc';
  import { formatSize } from '../../../../src/shared/byte-size';
  import { bytesToBase64 } from '../../../../src/shared/tools/bytes';
  import { MAX_IMAGE_PIXELS, parseDataUrl } from '../../../../src/shared/tools/image-data';
  import { encodeIndexedPng, quantize } from '../../../../src/shared/tools/png-compress';
  import { isTinyMime, MAX_TINY_BYTES } from '../../../../src/shared/tools/tinypng';
  import Icon from '../../components/Icon.svelte';
  import type { Translate } from '../../lib/i18n';
  import Card from './Card.svelte';
  import type { CanvasApi } from './canvas-api';
  import type { ImageApi, LoadedImage } from './image-api';
  import ImagePicker from './ImagePicker.svelte';

  interface Props {
    rpc: RpcPeer<ToolsProtocol['webview'], ToolsProtocol['host']>;
    t: Translate;
    images: ImageApi;
    canvas: CanvasApi;
    loaded: LoadedImage | undefined;
    onLoad: (image: LoadedImage) => void;
    save: (dataUrl: string | undefined, name: string, extension: string) => Promise<void>;
  }

  const { rpc, t, images, canvas, loaded, onLoad, save }: Props = $props();

  type Mode = 'local' | 'tiny';
  /** The most pixels the page reduces to a palette; more would freeze the editor for long. */
  const LOCAL_PIXELS = 8_000_000;
  const PALETTES = [256, 128, 64, 32, 16, 8] as const;

  let mode = $state<Mode>('local');
  let colours = $state<number>(256);
  let quality = $state(75);
  let output = $state<{ dataUrl: string; bytes: number; extension: string } | undefined>(undefined);
  let problem = $state<string | undefined>(undefined);
  let busy = $state(false);

  // TinyPNG
  let keySaved = $state(false);
  let keyInput = $state('');
  let count = $state<number | undefined>(undefined);

  onMount(() => {
    void rpc.request('tinyStatus', {}).then((status) => {
      keySaved = status.saved;
    });
  });

  const savedPercent = $derived(
    output === undefined || loaded === undefined || loaded.bytes === 0
      ? 0
      : Math.round((1 - output.bytes / loaded.bytes) * 100),
  );

  // A new picture clears what was made from the old one.
  let lastLoaded: LoadedImage | undefined;
  $effect(() => {
    if (loaded !== lastLoaded) {
      lastLoaded = loaded;
      output = undefined;
      problem = undefined;
      count = undefined;
    }
  });

  const byteLength = (base64: string): number => {
    const padding = /=*$/u.exec(base64)?.[0].length ?? 0;
    return Math.floor((base64.length * 3) / 4) - padding;
  };

  async function compressLocal(): Promise<void> {
    if (loaded === undefined) {
      return;
    }
    if (loaded.width * loaded.height > MAX_IMAGE_PIXELS) {
      problem = t('tools.img.tooBig');
      return;
    }
    if (loaded.mime === 'image/jpeg' || loaded.mime === 'image/webp') {
      const format = loaded.mime === 'image/webp' ? 'webp' : 'jpeg';
      const result = await images.render(loaded.dataUrl, {
        width: loaded.width,
        height: loaded.height,
        format,
        quality: quality / 100,
        background: format === 'jpeg' ? '#ffffff' : undefined,
      });
      const parts = result === undefined ? undefined : parseDataUrl(result);
      if (result === undefined || parts === undefined) {
        problem = t('tools.img.unsupported', format.toUpperCase());
        return;
      }
      output = { dataUrl: result, bytes: byteLength(parts.base64), extension: format === 'jpeg' ? 'jpg' : 'webp' };
      return;
    }
    if (loaded.width * loaded.height > LOCAL_PIXELS) {
      problem = t('tools.comp.tooManyPixels');
      return;
    }
    const pixels = await canvas.pixels(loaded.dataUrl, Math.max(loaded.width, loaded.height), true);
    if (pixels === undefined) {
      problem = t('tools.img.notImage');
      return;
    }
    // Let the spinner paint before the long loop.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const palette = quantize(pixels.data, colours);
    const png = await encodeIndexedPng(pixels.width, pixels.height, palette, canvas.deflate);
    output = {
      dataUrl: `data:image/png;base64,${bytesToBase64(png)}`,
      bytes: png.length,
      extension: 'png',
    };
  }

  async function compressTiny(): Promise<void> {
    if (loaded === undefined) {
      return;
    }
    const parts = parseDataUrl(loaded.dataUrl);
    if (parts === undefined || !isTinyMime(parts.mime)) {
      problem = t('tools.comp.err.unsupported');
      return;
    }
    if (byteLength(parts.base64) > MAX_TINY_BYTES) {
      problem = t('tools.comp.err.too-big');
      return;
    }
    const answer = await rpc.request('tinyCompress', { base64: parts.base64, mime: parts.mime });
    if (!answer.ok || answer.base64 === undefined) {
      problem = t(`tools.comp.err.${answer.error ?? 'failed'}`);
      return;
    }
    count = answer.count;
    output = {
      dataUrl: `data:${parts.mime};base64,${answer.base64}`,
      bytes: byteLength(answer.base64),
      extension: parts.mime === 'image/png' ? 'png' : parts.mime === 'image/webp' ? 'webp' : 'jpg',
    };
  }

  async function run(): Promise<void> {
    if (busy || loaded === undefined) {
      return;
    }
    busy = true;
    output = undefined;
    problem = undefined;
    try {
      await (mode === 'local' ? compressLocal() : compressTiny());
    } catch {
      problem = t('tools.comp.err.failed');
    } finally {
      busy = false;
    }
  }

  async function saveKey(): Promise<void> {
    const answer = await rpc.request('tinySaveKey', { key: keyInput });
    if (answer.ok) {
      keySaved = true;
      keyInput = '';
      problem = undefined;
    } else {
      problem = t('tools.comp.badKey');
    }
  }

  async function forgetKey(): Promise<void> {
    await rpc.request('tinyForgetKey', {});
    keySaved = false;
  }
</script>

<div class="tl-grid wide">
  <Card title={t('tools.img.source')} icon="file-media" tone="blue">
    <ImagePicker {images} current={loaded} {onLoad} {t} />
    {#if loaded !== undefined}
      <p class="muted small" data-testid="comp-original">{t('tools.comp.original')}: {formatSize(loaded.bytes)} · {loaded.mime}</p>
    {/if}
  </Card>

  <Card title={t('tools.img.compress')} icon="fold-down" tone="green">
    <div class="seg" role="group" aria-label={t('tools.comp.mode')}>
      <button type="button" aria-pressed={mode === 'local'} data-testid="comp-local" onclick={() => { mode = 'local'; output = undefined; problem = undefined; }}>
        {t('tools.comp.local')}
      </button>
      <button type="button" aria-pressed={mode === 'tiny'} data-testid="comp-tiny" onclick={() => { mode = 'tiny'; output = undefined; problem = undefined; }}>
        TinyPNG
      </button>
    </div>

    {#if mode === 'local'}
      <p class="muted small">{t('tools.comp.localHint')}</p>
      {#if loaded?.mime === 'image/jpeg' || loaded?.mime === 'image/webp'}
        <label class="quality">
          <span class="tl-label">{t('tools.img.quality', quality)}</span>
          <input type="range" min="10" max="100" bind:value={quality} data-testid="comp-quality" aria-label={t('tools.img.quality', quality)} />
        </label>
      {:else}
        <div>
          <span class="tl-label" id="tools-comp-colours">{t('tools.comp.colours')}</span>
          <div class="seg" role="group" aria-labelledby="tools-comp-colours">
            {#each PALETTES as value (value)}
              <button type="button" aria-pressed={colours === value} data-testid={`comp-colours-${value}`} onclick={() => { colours = value; }}>{value}</button>
            {/each}
          </div>
        </div>
      {/if}
    {:else}
      <p class="notice info" data-testid="comp-privacy"><Icon name="info" />{t('tools.comp.privacy')}</p>
      {#if keySaved}
        <div class="tl-row">
          <span class="badge success" data-testid="comp-key-saved"><Icon name="key" size={12} />{t('tools.comp.keySaved')}</span>
          <button type="button" class="button secondary" data-testid="comp-forget" onclick={() => { void forgetKey(); }}>
            <Icon name="trash" />{t('tools.comp.forget')}
          </button>
        </div>
      {:else}
        <div class="tl-line">
          <label class="grow">
            <span class="tl-label">{t('tools.comp.apiKey')}</span>
            <input class="control" type="password" autocomplete="off" spellcheck="false" bind:value={keyInput} placeholder={t('tools.comp.keyPlaceholder')} data-testid="comp-key" />
          </label>
          <button type="button" class="button" disabled={keyInput.trim() === ''} data-testid="comp-save-key" onclick={() => { void saveKey(); }}>
            <Icon name="save" />{t('tools.comp.saveKey')}
          </button>
        </div>
        <p class="muted small">{t('tools.comp.keyHint')}</p>
      {/if}
    {/if}

    <div class="tl-row">
      <button type="button" class="button" disabled={busy || loaded === undefined || (mode === 'tiny' && !keySaved)} data-testid="comp-run" onclick={() => { void run(); }}>
        <Icon name={busy ? 'loading' : 'fold-down'} spin={busy} />{t('tools.comp.run')}
      </button>
    </div>

    {#if loaded === undefined}
      <p class="muted">{t('tools.img.pickFirst')}</p>
    {/if}
    {#if problem !== undefined}
      <p class="tl-problem" role="alert" data-testid="comp-problem"><Icon name="error" size={14} />{problem}</p>
    {/if}

    {#if output !== undefined && loaded !== undefined}
      {@const made = output}
      {@const source = loaded}
      <div class="result" data-testid="comp-result">
        <img class="thumb" src={made.dataUrl} alt={t('tools.comp.result')} />
        <div class="numbers">
          <span data-testid="comp-before">{formatSize(source.bytes)}</span>
          <Icon name="arrow-right" size={14} />
          <strong data-testid="comp-after">{formatSize(made.bytes)}</strong>
          <span class="badge {savedPercent > 0 ? 'success' : 'warning'}" data-testid="comp-saved">
            {savedPercent > 0 ? `−${savedPercent}%` : t('tools.comp.notSmaller')}
          </span>
        </div>
        {#if count !== undefined}
          <p class="muted small" data-testid="comp-count">{t('tools.comp.count', count)}</p>
        {/if}
        <button type="button" class="button secondary" data-testid="comp-save" onclick={() => { void save(made.dataUrl, `${source.name.replace(/\.[^.]+$/u, '')}-min`, made.extension); }}>
          <Icon name="export" />{t('tools.img.save')}
        </button>
      </div>
    {/if}
  </Card>
</div>

<style>
  .grow {
    flex: 1;
  }

  .grow .control {
    width: 100%;
  }

  .quality {
    display: flex;
    flex-direction: column;
    min-width: 200px;
  }

  .result {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
    padding: 10px;
    border: 1px solid var(--dn-border);
    border-radius: 12px;
  }

  .numbers {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .thumb {
    max-width: 140px;
    max-height: 100px;
    background: repeating-conic-gradient(color-mix(in srgb, var(--vscode-foreground) 8%, transparent) 0% 25%, transparent 0% 50%) 50% / 14px 14px;
    border: 1px solid var(--dn-border);
    border-radius: 10px;
  }
</style>

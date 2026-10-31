<script lang="ts">
  import { untrack } from 'svelte';
  import { hasAllBytes } from '../../../../src/shared/cell-text';
  import type { CellValue } from '../../../../src/shared/cell-value';
  import Icon from '../../components/Icon.svelte';
  import IconButton from '../../components/IconButton.svelte';
  import type { Translate } from '../../lib/i18n';
  import { looksLikeMarkup, tokenizeXml } from '../../lib/xml-view';
  import {
    bytesFromBase64,
    bytesFromHex,
    formatSize,
    hexOf,
    hexRows,
    imageMimeOf,
  } from './bytes-view';
  import { formatJson, tokenizeJson } from './json-view';
  import { textStats, viewOf } from './value-view';

  interface Props {
    /** The focused cell's value; undefined when no cell is focused. */
    cell: CellValue | undefined;
    /** Identifies the cell, so bytes are fetched again when another one is focused. */
    cellKey: string;
    columnName: string | undefined;
    dataType: string | undefined;
    /** Fetches the whole bytes of the focused binary cell from the host. */
    loadBytes: () => Promise<{ size: number; data?: string | undefined }>;
    onCopy: (text: string) => void;
    onClose: () => void;
    /** Saves the value to a file (V10.2.4); absent when there is nothing to save. */
    onSaveFile?: (() => void) | undefined;
    /** Loads a file into the cell; absent when the cell cannot take one. */
    onLoadFile?: (() => void) | undefined;
    t: Translate;
  }

  const {
    cell,
    cellKey,
    columnName,
    dataType,
    loadBytes,
    onCopy,
    onClose,
    onSaveFile,
    onLoadFile,
    t,
  }: Props = $props();

  /** Hex dump shows this many bytes at a time; a whole megabyte of rows would stall the page. */
  const HEX_PAGE_BYTES = 4096;
  /** Beyond this much text, colouring every token would be slower than reading it. */
  const MAX_HIGHLIGHT_CHARS = 200_000;

  const view = $derived(cell === undefined ? undefined : viewOf(cell));

  // ---- text and JSON ----
  let raw = $state(false);
  let wrap = $state(true);

  const shownText = $derived.by(() => {
    if (view?.kind !== 'text') {
      return '';
    }
    if (view.json && view.valid && !raw) {
      return formatJson(view.text) ?? view.text;
    }
    return view.text;
  });
  const tokens = $derived(
    view?.kind === 'text' && view.json && shownText.length <= MAX_HIGHLIGHT_CHARS
      ? tokenizeJson(shownText)
      : undefined,
  );
  const markup = $derived(
    view?.kind === 'text' && !view.json && looksLikeMarkup(view.text),
  );
  const markupTokens = $derived(
    markup && shownText.length <= MAX_HIGHLIGHT_CHARS ? tokenizeXml(shownText) : undefined,
  );
  const stats = $derived(view?.kind === 'text' ? textStats(view.text) : undefined);
  /** What the value is, as a badge in the bar. */
  const kindLabel = $derived(
    view?.kind !== 'text' ? '' : view.json ? 'JSON' : markup ? 'XML' : t('value.kindText'),
  );

  // ---- width: the handle on the left edge drags, and the arrow keys nudge ----
  const MIN_WIDTH = 260;
  const MAX_WIDTH = 760;
  const DEFAULT_WIDTH = 380;
  const WIDE_WIDTH = 600;
  let width = $state(DEFAULT_WIDTH);
  let dragFrom: { x: number; width: number } | undefined;

  function clampWidth(next: number): number {
    return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(next)));
  }

  /** Brief "copied" feedback on the copy button. */
  let copied = $state(false);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;

  // ---- binary ----
  let fetched = $state<{ key: string; size: number; data: string | undefined } | undefined>(
    undefined,
  );
  let fetchFailed = $state(false);
  let hexPage = $state(0);
  let binaryMode = $state<'auto' | 'hex'>('auto');
  /** Not reactive on purpose: it only discards answers for a cell that is no longer focused. */
  let wanted = '';

  const preview = $derived(view?.kind === 'binary' ? view.preview : '');
  const previewBytes = $derived(bytesFromHex(preview));
  const complete = $derived(view?.kind === 'binary' && hasAllBytes(view.size, view.preview));

  // Reading only the key and the kind (never `fetched`) keeps this out of a write loop.
  $effect(() => {
    const key = cellKey;
    const needs = view?.kind === 'binary' && !complete;
    untrack(() => {
      wanted = key;
      fetchFailed = false;
      hexPage = 0;
      if (needs) {
        void fetchBytes(key);
      }
    });
  });

  async function fetchBytes(key: string): Promise<void> {
    try {
      const answer = await loadBytes();
      if (wanted === key) {
        fetched = { key, size: answer.size, data: answer.data };
      }
    } catch (_error) {
      if (wanted === key) {
        fetchFailed = true;
      }
    }
  }

  const base64 = $derived(
    fetched?.key === cellKey ? fetched.data : undefined,
  );
  const bytes = $derived.by(() => {
    if (view?.kind !== 'binary') {
      return undefined;
    }
    if (complete) {
      return previewBytes;
    }
    return base64 === undefined ? undefined : bytesFromBase64(base64);
  });
  /** What can be told from the first bytes alone, so it holds before the download ends. */
  const mime = $derived(view?.kind === 'binary' ? imageMimeOf(bytes ?? previewBytes) : undefined);
  const imageSource = $derived(
    mime !== undefined && bytes !== undefined
      ? `data:${mime};base64,${complete ? btoa(String.fromCharCode(...bytes)) : (base64 ?? '')}`
      : undefined,
  );
  const showImage = $derived(imageSource !== undefined && binaryMode === 'auto');
  const waiting = $derived(
    view?.kind === 'binary' && !complete && bytes === undefined && !fetchFailed &&
      !(fetched?.key === cellKey),
  );
  const tooLarge = $derived(
    view?.kind === 'binary' && !complete && fetched?.key === cellKey && fetched.data === undefined,
  );
  const shownBytes = $derived(bytes ?? previewBytes);
  const pages = $derived(Math.max(1, Math.ceil(shownBytes.length / HEX_PAGE_BYTES)));
  const dump = $derived(hexRows(shownBytes, hexPage * HEX_PAGE_BYTES, HEX_PAGE_BYTES));

  function copy(): void {
    if (view?.kind === 'text') {
      onCopy(shownText);
    } else if (view?.kind === 'binary') {
      onCopy(`0x${hexOf(shownBytes)}`);
    } else {
      return;
    }
    copied = true;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      copied = false;
    }, 1500);
  }
</script>

<aside class="panel" aria-label={t('value.title')} data-testid="value-panel" style="width: {width}px">
  <span
    class="resizer"
    role="separator"
    aria-orientation="vertical"
    aria-label={t('value.resize')}
    data-testid="value-resizer"
    onpointerdown={(event) => {
      dragFrom = { x: event.clientX, width };
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onpointermove={(event) => {
      if (dragFrom !== undefined) {
        // The panel is at the right edge: dragging left makes it wider.
        width = clampWidth(dragFrom.width + (dragFrom.x - event.clientX));
      }
    }}
    onpointerup={() => {
      dragFrom = undefined;
    }}
    onpointercancel={() => {
      dragFrom = undefined;
    }}
  ></span>
  <header class="head">
    <span class="head-icon"><Icon name="open-preview" size={16} /></span>
    <strong class="title" title={columnName ?? t('value.title')}>{columnName ?? t('value.title')}</strong>
    {#if dataType !== undefined && dataType !== ''}
      <span class="type badge outline">{dataType}</span>
    {/if}
    <span class="spacer"></span>
    {#if onSaveFile !== undefined && view !== undefined && view.kind !== 'null'}
      <IconButton
        icon="save"
        tone="green"
        label={t('value.saveFile')}
        data-testid="value-save-file"
        onclick={onSaveFile}
      />
    {/if}
    {#if onLoadFile !== undefined}
      <IconButton
        icon="cloud-upload"
        tone="teal"
        label={t('value.loadFile')}
        data-testid="value-load-file"
        onclick={onLoadFile}
      />
    {/if}
    <!-- The keyboard's way to the same thing the handle does: toggle a wide panel. -->
    <IconButton
      icon="screen-full"
      label={t('value.widen')}
      pressed={width >= WIDE_WIDTH}
      data-testid="value-widen"
      onclick={() => {
        width = width >= WIDE_WIDTH ? DEFAULT_WIDTH : WIDE_WIDTH;
      }}
    />
    <IconButton icon="close" label={t('value.close')} onclick={onClose} />
  </header>

  {#if view === undefined}
    <p class="hint" data-testid="value-empty">{t('value.none')}</p>
  {:else if view.kind === 'null'}
    <p class="null" data-testid="value-null">NULL</p>
  {:else if view.kind === 'text'}
    <div class="bar">
      <span class="meta" data-testid="value-meta">
        {#if kindLabel !== ''}<span class="badge">{kindLabel}</span>{/if}
        {t('value.textStats', stats?.chars ?? 0, stats?.lines ?? 1)}
        {#if view.json && !view.valid}
          <span class="warn" data-testid="value-invalid">{t('value.invalidJson')}</span>
        {/if}
      </span>
      <span class="spacer"></span>
      {#if view.json && view.valid}
        <IconButton
          icon="json"
          tone="purple"
          label={raw ? t('value.formatted') : t('value.raw')}
          hint={raw ? t('value.formattedHint') : t('value.rawHint')}
          pressed={!raw}
          data-testid="value-format"
          onclick={() => {
            raw = !raw;
          }}
        />
      {/if}
      <IconButton
        icon="word-wrap"
        tone="orange"
        label={t('value.wrap')}
        pressed={wrap}
        data-testid="value-wrap"
        onclick={() => {
          wrap = !wrap;
        }}
      />
      <IconButton
        icon={copied ? 'check' : 'copy'}
        tone={copied ? 'green' : 'blue'}
        label={copied ? t('value.copied') : t('value.copy')}
        data-testid="value-copy"
        onclick={copy}
      />
    </div>
    <pre class="text" class:nowrap={!wrap} data-testid="value-text" data-copy-menu>{#if tokens !== undefined}{#each tokens as token, index (index)}<span class={token.type}>{token.text}</span>{/each}{:else if markupTokens !== undefined}{#each markupTokens as token, index (index)}<span class={`x-${token.type}`}>{token.text}</span>{/each}{:else}{shownText}{/if}</pre>
  {:else}
    <div class="bar">
      <span class="meta" data-testid="value-meta">
        {t('value.binaryStats', formatSize(view.size), mime ?? '')}
      </span>
      <span class="spacer"></span>
      {#if mime !== undefined}
        <IconButton
          icon={showImage ? 'symbol-numeric' : 'file-media'}
          tone="purple"
          label={showImage ? t('value.showHex') : t('value.showImage')}
          pressed={showImage}
          data-testid="value-binary-mode"
          onclick={() => {
            binaryMode = binaryMode === 'auto' ? 'hex' : 'auto';
          }}
        />
      {/if}
      <IconButton
        icon={copied ? 'check' : 'copy'}
        tone={copied ? 'green' : 'blue'}
        label={copied ? t('value.copied') : t('value.copyHex')}
        data-testid="value-copy"
        onclick={copy}
      />
    </div>
    {#if waiting}
      <p class="hint" data-testid="value-loading">{t('value.loading')}</p>
    {:else if fetchFailed}
      <p class="warn pad" role="alert" data-testid="value-failed">{t('value.loadFailed')}</p>
    {/if}
    {#if tooLarge}
      <p class="warn pad" data-testid="value-too-large">{t('value.tooLarge', formatSize(view.size))}</p>
    {/if}
    {#if showImage && imageSource !== undefined}
      <div class="image" data-testid="value-image-box">
        <img src={imageSource} alt={t('value.imageAlt')} data-testid="value-image" />
      </div>
    {:else}
      <pre class="hex" data-testid="value-hex" data-copy-menu>{#each dump as row (row.offset)}<span class="offset">{row.offset}</span>  {row.hex}  <span class="ascii">{row.ascii}</span>
{/each}</pre>
      {#if pages > 1}
        <div class="bar">
          <button
            type="button"
            class="mode"
            disabled={hexPage === 0}
            aria-label={t('value.hexPrev')}
            data-testid="value-hex-prev"
            onclick={() => {
              hexPage -= 1;
            }}
          >
            ‹
          </button>
          <span class="meta">{t('value.hexPage', hexPage + 1, pages)}</span>
          <button
            type="button"
            class="mode"
            disabled={hexPage >= pages - 1}
            aria-label={t('value.hexNext')}
            data-testid="value-hex-next"
            onclick={() => {
              hexPage += 1;
            }}
          >
            ›
          </button>
        </div>
      {/if}
    {/if}
  {/if}
</aside>

<style>
  .panel {
    position: relative;
    display: flex;
    flex: none;
    flex-direction: column;
    min-width: 0;
    overflow: hidden;
    border-left: 1px solid var(--dn-divider);
  }

  /* A strip on the left edge to drag; it lights up on hover and keyboard focus. */
  .resizer {
    position: absolute;
    top: 0;
    bottom: 0;
    left: -3px;
    z-index: 2;
    width: 7px;
    cursor: col-resize;
    touch-action: none;
  }

  .resizer:hover,
  .resizer:focus-visible {
    background: color-mix(in srgb, var(--dn-accent) 55%, transparent);
    outline: none;
  }

  .head-icon {
    display: inline-flex;
    color: var(--vscode-charts-teal, var(--dn-info));
  }

  .head,
  .bar {
    display: flex;
    flex: none;
    gap: 6px;
    align-items: center;
    padding: 6px 10px;
  }

  .head {
    border-bottom: 1px solid var(--dn-divider);
  }

  .meta {
    display: inline-flex;
    gap: 6px;
    align-items: center;
    font-size: var(--dn-font-small);
  }

  .title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .type,
  .meta,
  .hint {
    color: var(--vscode-descriptionForeground);
  }

  .hint,
  .null,
  .pad {
    padding: 4px 8px;
  }

  .null {
    color: var(--vscode-descriptionForeground);
    font-style: italic;
  }

  .spacer {
    flex: 1;
  }

  .warn {
    color: var(--vscode-editorWarning-foreground);
  }

  .close,
  .mode {
    padding: 1px 8px;
    color: var(--vscode-button-secondaryForeground);
    background: var(--vscode-button-secondaryBackground);
    border: none;
    border-radius: 2px;
    cursor: pointer;
  }

  .mode:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .wrap {
    display: flex;
    gap: 4px;
    align-items: center;
  }

  .text,
  .hex {
    flex: 1;
    min-height: 0;
    margin: 0;
    padding: 4px 8px;
    overflow: auto;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-editor-font-size, 13px);
    user-select: text;
  }

  .text {
    white-space: pre-wrap;
    word-break: break-word;
  }

  .text.nowrap {
    white-space: pre;
  }

  .hex {
    white-space: pre;
  }

  .offset {
    color: var(--vscode-descriptionForeground);
  }

  .ascii {
    color: var(--vscode-debugTokenExpression-string, inherit);
  }

  .key {
    color: var(--vscode-debugTokenExpression-name, inherit);
  }

  .string {
    color: var(--vscode-debugTokenExpression-string, inherit);
  }

  .number {
    color: var(--vscode-debugTokenExpression-number, inherit);
  }

  .literal {
    color: var(--vscode-debugTokenExpression-boolean, inherit);
  }

  .invalid {
    color: var(--vscode-errorForeground);
    text-decoration: underline wavy;
  }

  .x-tag {
    color: var(--vscode-terminal-ansiBlue, var(--dn-info));
  }

  .x-attr {
    color: var(--vscode-debugTokenExpression-name, inherit);
  }

  .x-string {
    color: var(--vscode-debugTokenExpression-string, inherit);
  }

  .x-punct {
    color: var(--dn-muted);
  }

  .x-comment,
  .x-decl {
    color: var(--vscode-editorLineNumber-foreground, var(--dn-muted));
    font-style: italic;
  }

  .x-invalid {
    color: var(--vscode-errorForeground);
    text-decoration: underline wavy;
  }

  .image {
    display: flex;
    flex: 1;
    align-items: center;
    justify-content: center;
    min-height: 0;
    padding: 8px;
    overflow: auto;
    /* A checkerboard shows transparent pixels, which a flat colour would hide. */
    background:
      repeating-conic-gradient(rgb(128 128 128 / 15%) 0 25%, transparent 0 50%) 0 0 / 16px 16px;
  }

  .image img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }
</style>

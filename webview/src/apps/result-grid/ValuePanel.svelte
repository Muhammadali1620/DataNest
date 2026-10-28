<script lang="ts">
  import { untrack } from 'svelte';
  import { hasAllBytes } from '../../../../src/shared/cell-text';
  import type { CellValue } from '../../../../src/shared/cell-value';
  import type { Translate } from '../../lib/i18n';
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
    t: Translate;
  }

  const { cell, cellKey, columnName, dataType, loadBytes, onCopy, onClose, t }: Props = $props();

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
  const stats = $derived(view?.kind === 'text' ? textStats(view.text) : undefined);

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
    }
  }
</script>

<aside class="panel" aria-label={t('value.title')} data-testid="value-panel">
  <header class="head">
    <strong class="title">{columnName ?? t('value.title')}</strong>
    {#if dataType !== undefined && dataType !== ''}
      <span class="type">{dataType}</span>
    {/if}
    <span class="spacer"></span>
    <button
      type="button"
      class="close"
      aria-label={t('value.close')}
      title={t('value.close')}
      onclick={onClose}
    >
      ×
    </button>
  </header>

  {#if view === undefined}
    <p class="hint" data-testid="value-empty">{t('value.none')}</p>
  {:else if view.kind === 'null'}
    <p class="null" data-testid="value-null">NULL</p>
  {:else if view.kind === 'text'}
    <div class="bar">
      <span class="meta" data-testid="value-meta">
        {t('value.textStats', stats?.chars ?? 0, stats?.lines ?? 1)}
        {#if view.json && !view.valid}
          <span class="warn" data-testid="value-invalid">{t('value.invalidJson')}</span>
        {/if}
      </span>
      <span class="spacer"></span>
      {#if view.json && view.valid}
        <button
          type="button"
          class="mode"
          aria-pressed={!raw}
          data-testid="value-format"
          onclick={() => {
            raw = !raw;
          }}
        >
          {raw ? t('value.formatted') : t('value.raw')}
        </button>
      {/if}
      <label class="wrap">
        <input
          type="checkbox"
          checked={wrap}
          onchange={(event) => {
            wrap = event.currentTarget.checked;
          }}
        />
        {t('value.wrap')}
      </label>
      <button type="button" class="mode" data-testid="value-copy" onclick={copy}>
        {t('value.copy')}
      </button>
    </div>
    <pre class="text" class:nowrap={!wrap} data-testid="value-text">{#if tokens !== undefined}{#each tokens as token, index (index)}<span class={token.type}>{token.text}</span>{/each}{:else}{shownText}{/if}</pre>
  {:else}
    <div class="bar">
      <span class="meta" data-testid="value-meta">
        {t('value.binaryStats', formatSize(view.size), mime ?? '')}
      </span>
      <span class="spacer"></span>
      {#if mime !== undefined}
        <button
          type="button"
          class="mode"
          aria-pressed={showImage}
          data-testid="value-binary-mode"
          onclick={() => {
            binaryMode = binaryMode === 'auto' ? 'hex' : 'auto';
          }}
        >
          {showImage ? t('value.showHex') : t('value.showImage')}
        </button>
      {/if}
      <button type="button" class="mode" data-testid="value-copy" onclick={copy}>
        {t('value.copyHex')}
      </button>
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
      <pre class="hex" data-testid="value-hex">{#each dump as row (row.offset)}<span class="offset">{row.offset}</span>  {row.hex}  <span class="ascii">{row.ascii}</span>
{/each}</pre>
      {#if pages > 1}
        <div class="bar">
          <button
            type="button"
            class="mode"
            disabled={hexPage === 0}
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
    display: flex;
    flex: none;
    flex-direction: column;
    width: 360px;
    min-width: 0;
    overflow: hidden;
    border-left: 1px solid var(--vscode-panel-border);
  }

  .head,
  .bar {
    display: flex;
    flex: none;
    gap: 6px;
    align-items: center;
    padding: 4px 8px;
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

  .mode[aria-pressed='true'] {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
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

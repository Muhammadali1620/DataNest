<script lang="ts">
  import { tick } from 'svelte';
  import { applyKey, JSON_PAIRS, XML_PAIRS } from '../apps/result-grid/json-editing';
  import { tokenizeJson } from '../apps/result-grid/json-view';
  import { tokenizeXml } from '../lib/xml-view';
  import type { CodeMode } from './code-mode';

  interface Props {
    value: string;
    /** What the text is: JSON and markup are coloured and close their brackets and quotes. */
    mode: CodeMode;
    readonly?: boolean;
    invalid?: boolean;
    label: string;
    testid?: string | undefined;
    rows?: number;
    /** The box itself, so the caller can focus it. */
    element?: HTMLTextAreaElement | undefined;
    onkeydown?: ((event: KeyboardEvent) => void) | undefined;
  }

  /* eslint-disable prefer-const, @typescript-eslint/no-useless-default-assignment */
  let {
    value = $bindable(),
    mode,
    readonly = false,
    invalid = false,
    label,
    testid,
    rows,
    element = $bindable(),
    onkeydown,
  }: Props = $props();
  /* eslint-enable prefer-const, @typescript-eslint/no-useless-default-assignment */

  /** Beyond this much text, colouring every token costs more than it helps. */
  const MAX_HIGHLIGHT_CHARS = 200_000;

  let layer = $state<HTMLPreElement | undefined>(undefined);

  const tokens = $derived.by(() => {
    if (mode === 'text' || value.length > MAX_HIGHLIGHT_CHARS) {
      return undefined;
    }
    // The closing newline gives the layer the height of a last empty line, like the box.
    return [...(mode === 'json' ? tokenizeJson(value) : tokenizeXml(value)), { type: 'space', text: '\n' }];
  });

  function syncScroll(): void {
    if (layer !== undefined && element !== undefined) {
      layer.scrollTop = element.scrollTop;
      layer.scrollLeft = element.scrollLeft;
    }
  }

  /** Typing behaves like the editor: brackets and quotes pair, Enter indents, Tab indents. */
  function onKey(event: KeyboardEvent): void {
    onkeydown?.(event);
    const box = element;
    if (
      event.defaultPrevented ||
      readonly ||
      mode === 'text' ||
      box === undefined ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.isComposing
    ) {
      return;
    }
    const result = applyKey(
      { text: box.value, start: box.selectionStart, end: box.selectionEnd },
      event.key,
      event.shiftKey,
      mode === 'json' ? JSON_PAIRS : XML_PAIRS,
    );
    if (result === undefined) {
      return;
    }
    event.preventDefault();
    value = result.text;
    // The caret can only be placed once the new text is in the box.
    void tick().then(() => {
      box.setSelectionRange(result.start, result.end);
    });
  }
</script>

<div class="code" class:invalid class:coloured={tokens !== undefined}>
  {#if tokens !== undefined}
    <pre class="layer" aria-hidden="true" bind:this={layer}>{#each tokens as token, index (index)}<span class={`${mode}-${token.type}`}>{token.text}</span>{/each}</pre>
  {/if}
  <textarea
    bind:this={element}
    bind:value
    class="control input"
    {readonly}
    {rows}
    spellcheck="false"
    aria-label={label}
    data-testid={testid}
    onkeydown={onKey}
    onscroll={syncScroll}
  ></textarea>
</div>

<style>
  .code {
    position: relative;
    display: flex;
    flex: 1;
    min-height: 0;
    border-radius: 10px;
  }

  .layer,
  .input {
    box-sizing: border-box;
    margin: 0;
    padding: 10px 12px;
    font-family: var(--dn-mono, var(--vscode-editor-font-family, monospace));
    font-size: 13px;
    line-height: 1.5;
    tab-size: 2;
    white-space: pre;
    word-break: normal;
    overflow-wrap: normal;
  }

  .layer {
    position: absolute;
    inset: 0;
    overflow: hidden;
    /* Room for the box's scrollbars, so both scroll to the same extent. */
    padding-right: 28px;
    padding-bottom: 28px;
    pointer-events: none;
  }

  .input {
    position: relative;
    flex: 1;
    width: 100%;
    min-height: 100px;
    border-radius: 10px;
    resize: vertical;
    overflow: auto;
  }

  /* The text is drawn by the layer behind; the box only keeps the caret and the selection. */
  .coloured .input {
    color: transparent;
    background: transparent;
    caret-color: var(--vscode-editorCursor-foreground, var(--vscode-foreground));
  }

  .coloured:not(.invalid) .input {
    border-color: var(--vscode-input-border, var(--dn-border));
  }

  .code.invalid .input {
    border-color: var(--dn-warning);
  }

  /* The layer sits behind a transparent box, so the box's own background must show it. */
  .coloured .layer {
    background: var(--vscode-input-background);
    border: 1px solid transparent;
    border-radius: 10px;
  }

  .json-key,
  .xml-attr {
    color: var(--vscode-debugTokenExpression-name, var(--vscode-terminal-ansiCyan));
  }

  .json-string,
  .xml-string {
    color: var(--vscode-debugTokenExpression-string, var(--vscode-terminal-ansiGreen));
  }

  .json-number {
    color: var(--vscode-debugTokenExpression-number, var(--vscode-terminal-ansiYellow));
  }

  .json-literal {
    color: var(--vscode-debugTokenExpression-boolean, var(--vscode-terminal-ansiMagenta));
  }

  .json-punct,
  .xml-punct {
    color: var(--dn-muted);
  }

  .xml-tag {
    color: var(--vscode-terminal-ansiBlue, var(--dn-info));
  }

  .xml-comment,
  .xml-decl {
    color: var(--vscode-editorLineNumber-foreground, var(--dn-muted));
    font-style: italic;
  }

  .json-invalid,
  .xml-invalid {
    color: var(--vscode-errorForeground);
    text-decoration: underline wavy;
  }
</style>

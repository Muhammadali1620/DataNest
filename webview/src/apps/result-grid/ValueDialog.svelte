<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import type { CellValue } from '../../../../src/shared/cell-value';
  import Icon from '../../components/Icon.svelte';
  import CodeArea from '../../components/CodeArea.svelte';
  import type { CodeMode } from '../../components/code-mode';
  import IconButton from '../../components/IconButton.svelte';
  import { looksLikeMarkup } from '../../lib/xml-view';
  import type { Translate } from '../../lib/i18n';
  import { formatJson, minifyJson } from './json-view';
  import { viewOf } from './value-view';

  interface Props {
    columnName: string;
    dataType: string | undefined;
    cell: CellValue;
    /** The cell can be changed here; false shows the value to read and copy. */
    editable: boolean;
    /** Saves the text into the cell; resolves to the reason it was refused, if it was. */
    onSave: (text: string) => Promise<string | undefined>;
    onCopy: (text: string) => void;
    onClose: () => void;
    onSaveFile?: (() => void) | undefined;
    onLoadFile?: (() => void) | undefined;
    t: Translate;
  }

  const { columnName, dataType, cell, editable, onSave, onCopy, onClose, onSaveFile, onLoadFile, t }: Props =
    $props();

  // The dialog is created for one value and shown until closed; it never follows a later one.
  const view = untrack(() => viewOf(cell));
  // A JSON value opens indented to read; that alone is not a change to save.
  const original =
    view.kind !== 'text' ? '' : view.json ? (formatJson(view.text) ?? view.text) : view.text;
  let text = $state(original);
  let mode = $state<CodeMode>(
    view.kind === 'text' && view.json ? 'json' : looksLikeMarkup(original) ? 'xml' : 'text',
  );
  let problem = $state<string | undefined>(undefined);
  let saving = $state(false);
  let area = $state<HTMLTextAreaElement | undefined>(undefined);

  const changed = $derived(text !== original);
  const jsonProblem = $derived(mode === 'json' && text.trim() !== '' && formatJson(text) === undefined);

  onMount(() => {
    area?.focus();
  });

  function format(): void {
    const pretty = formatJson(text);
    if (pretty === undefined) {
      problem = t('dialog.notJson');
      return;
    }
    problem = undefined;
    text = pretty;
  }

  function minify(): void {
    const flat = minifyJson(text);
    if (flat === undefined) {
      problem = t('dialog.notJson');
      return;
    }
    problem = undefined;
    text = flat;
  }

  function chooseMode(next: CodeMode): void {
    mode = next;
    problem = undefined;
    if (next === 'json') {
      const pretty = formatJson(text);
      if (pretty !== undefined) {
        text = pretty;
      }
    }
  }

  async function save(): Promise<void> {
    if (!editable || saving || jsonProblem) {
      return;
    }
    saving = true;
    // JSON goes to the server compact, as the user would type it; text goes as it is.
    const reason = await onSave(mode === 'json' ? (minifyJson(text) ?? text) : text);
    saving = false;
    if (reason === undefined) {
      onClose();
    } else {
      problem = reason;
    }
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void save();
    }
  }
</script>

<div
  class="modal-backdrop fade-in"
  role="presentation"
  onpointerdown={(event) => {
    if (event.target === event.currentTarget) {
      onClose();
    }
  }}
  onkeydown={onKey}
>
  <div class="modal" role="dialog" aria-modal="true" aria-label={t('dialog.valueTitle')} data-testid="value-dialog">
    <div class="modal-head">
      <span class="head-icon"><Icon name="open-preview" size={18} /></span>
      <h2 class="modal-title">
        {columnName}{#if dataType !== undefined}<span class="type-note"> · {dataType}</span>{/if}
      </h2>
      <IconButton icon="close" label={t('dialog.close')} onclick={onClose} />
    </div>

    {#if view.kind === 'binary'}
      <p class="binary">{t('dialog.binary', view.size)}</p>
    {:else}
      <div class="tools">
        <div class="seg" role="group" aria-label={t('dialog.format')}>
          <button type="button" aria-pressed={mode === 'text'} onclick={() => { chooseMode('text'); }}>
            {t('dialog.text')}
          </button>
          <button type="button" aria-pressed={mode === 'json'} onclick={() => { chooseMode('json'); }}>
            JSON
          </button>
          <button type="button" aria-pressed={mode === 'xml'} onclick={() => { chooseMode('xml'); }}>
            XML
          </button>
        </div>
        <span class="grow"></span>
        <IconButton
          icon="copy"
          tone="blue"
          label={t('dialog.copy')}
          onclick={() => {
            onCopy(text);
          }}
        />
        {#if mode === 'json'}
          <IconButton icon="json" tone="purple" label={t('dialog.formatJson')} onclick={format} />
          <IconButton icon="fold" tone="orange" label={t('dialog.minifyJson')} onclick={minify} />
        {/if}
        {#if onLoadFile !== undefined}
          <IconButton icon="cloud-upload" tone="teal" label={t('dialog.loadFile')} onclick={onLoadFile} />
        {/if}
        {#if onSaveFile !== undefined}
          <IconButton icon="export" tone="green" label={t('dialog.saveFile')} onclick={onSaveFile} />
        {/if}
      </div>
      <CodeArea
        bind:value={text}
        bind:element={area}
        {mode}
        readonly={!editable}
        invalid={jsonProblem}
        label={t('dialog.valueTitle')}
        testid="value-dialog-text"
        rows={14}
      />
    {/if}

    {#if problem !== undefined}
      <p class="problem" role="alert" data-testid="dialog-problem"><Icon name="error" size={14} />{problem}</p>
    {:else if jsonProblem}
      <p class="problem soft"><Icon name="warning" size={14} />{t('dialog.notJson')}</p>
    {/if}

    <div class="modal-foot">
      <span class="grow note">
        {#if editable}{t('dialog.saveHint')}{:else}{t('dialog.readOnly')}{/if}
      </span>
      <button type="button" class="button secondary" onclick={onClose}>
        <Icon name="close" />{t('dialog.close')}
      </button>
      {#if editable && view.kind !== 'binary'}
        <button type="button" class="button" disabled={!changed || saving || jsonProblem} onclick={() => { void save(); }}>
          <Icon name={saving ? 'loading' : 'save'} spin={saving} />{t('dialog.save')}
        </button>
      {/if}
    </div>
  </div>
</div>

<style>
  .head-icon {
    display: inline-flex;
    color: var(--vscode-charts-teal, var(--vscode-terminal-ansiCyan, var(--dn-info)));
  }

  .type-note {
    color: var(--dn-muted);
    font-weight: normal;
  }

  .tools {
    display: flex;
    gap: 4px;
    align-items: center;
  }

  .grow {
    flex: 1;
  }

  .problem {
    display: flex;
    gap: 6px;
    align-items: center;
    margin: 0;
    color: var(--dn-danger);
    font-size: var(--dn-font-small);
  }

  .problem.soft {
    color: var(--dn-warning);
  }

  .binary {
    margin: 0;
    color: var(--dn-muted);
  }

  .note {
    color: var(--dn-muted);
    font-size: var(--dn-font-small);
  }
</style>

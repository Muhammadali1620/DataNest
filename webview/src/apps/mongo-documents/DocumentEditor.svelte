<script lang="ts">
  // The editor of one document (V7.6): its text in the shell's syntax, checked by the host
  // when saved; a problem says where it is.
  import type { TypedProblem } from '../../../../src/shared/protocols/mongo-documents';
  import type { Translate } from '../../lib/i18n';
  import { problemText } from './documents-view';

  interface Props {
    title: string;
    text: string;
    t: Translate;
    busy: boolean;
    problem: TypedProblem | undefined;
    onsave: (text: string) => void;
    oncancel: () => void;
  }

  const { title, text, t, busy, problem, onsave, oncancel }: Props = $props();

  // Starts from the text it was opened with; later changes are the user's.
  // svelte-ignore state_referenced_locally
  let draft = $state(text);

  function keydown(event: KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && event.key === 's') {
      event.preventDefault();
      onsave(draft);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      oncancel();
    }
  }
</script>

<section class="editor">
  <h2>{title}</h2>
  <textarea
    class="control code"
    bind:value={draft}
    rows={22}
    spellcheck="false"
    aria-label={title}
    aria-invalid={problem !== undefined}
    onkeydown={keydown}
  ></textarea>
  {#if problem !== undefined}
    <p class="error" role="alert" data-testid="editor-problem">{problemText(problem)}</p>
  {/if}
  <p class="hint">{t('mongo.editorHint')}</p>
  <div class="actions">
    <button type="button" class="button" disabled={busy} onclick={() => { onsave(draft); }}>
      {t('mongo.save')}
    </button>
    <button type="button" class="button secondary" disabled={busy} onclick={oncancel}>
      {t('mongo.cancel')}
    </button>
  </div>
</section>

<style>
  .editor {
    display: flex;
    flex-direction: column;
    gap: 6px;
    border: 1px solid var(--vscode-focusBorder);
    padding: 10px;
  }
  h2 {
    font-size: 1.05em;
    margin: 0;
  }
  .code {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-editor-font-size, 13px);
    resize: vertical;
    white-space: pre;
  }
  .actions {
    display: flex;
    gap: 8px;
  }
  .hint {
    color: var(--vscode-descriptionForeground);
    margin: 0;
  }
  .error {
    color: var(--vscode-errorForeground);
    margin: 0;
  }
</style>

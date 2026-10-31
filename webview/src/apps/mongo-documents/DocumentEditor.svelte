<script lang="ts">
  // The editor of one document (V7.6): its text in the shell's syntax, checked by the host
  // when saved; a problem says where it is.
  import type { TypedProblem } from '../../../../src/shared/protocols/mongo-documents';
  import Icon from '../../components/Icon.svelte';
  import type { Translate } from '../../lib/i18n';
  import { problemText } from './documents-view';

  interface Props {
    title: string;
    text: string;
    t: Translate;
    busy: boolean;
    /** A new document rather than one being changed: only the icon differs. */
    isNew?: boolean;
    problem: TypedProblem | undefined;
    onsave: (text: string) => void;
    oncancel: () => void;
  }

  const { title, text, t, busy, isNew = false, problem, onsave, oncancel }: Props = $props();

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
  <header class="head">
    <Icon name={isNew ? 'new-file' : 'edit'} />
    <h2>{title}</h2>
  </header>
  <div class="body">
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
      <p class="notice error" role="alert" data-testid="editor-problem"><Icon name="error" /><span>{problemText(problem)}</span></p>
    {/if}
    <p class="hint"><Icon name="info" size={14} /><span>{t('mongo.editorHint')}</span></p>
  </div>
  <footer class="actions">
    <button type="button" class="button secondary" disabled={busy} onclick={oncancel}>
      {t('mongo.cancel')}
    </button>
    <button type="button" class="button" disabled={busy} onclick={() => { onsave(draft); }}
      ><Icon name="save" />{t('mongo.save')}</button
    >
  </footer>
</section>

<style>
  .editor {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }

  .head {
    display: flex;
    flex: none;
    gap: var(--dn-gap);
    align-items: center;
    min-height: 34px;
    padding: 4px var(--dn-gap-m);
    border-bottom: 1px solid var(--dn-divider);
  }

  .head > :global(.codicon-glyph) {
    color: var(--dn-muted);
  }

  h2 {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .body {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--dn-gap);
    min-height: 0;
    padding: var(--dn-gap-m);
  }

  .code {
    flex: 1;
    min-height: 120px;
    font-family: var(--dn-mono);
    font-size: var(--vscode-editor-font-size, 13px);
    white-space: pre;
    background: var(--dn-surface);
    resize: none;
  }

  .notice {
    margin: 0;
  }

  .hint {
    display: flex;
    gap: 6px;
    align-items: flex-start;
    margin: 0;
    color: var(--dn-muted);
    font-size: var(--dn-font-small);
  }

  .hint :global(.codicon-glyph) {
    margin-top: 1px;
  }

  .actions {
    display: flex;
    flex: none;
    gap: var(--dn-gap);
    justify-content: flex-end;
    padding: var(--dn-gap) var(--dn-gap-m);
    border-top: 1px solid var(--dn-divider);
  }
</style>

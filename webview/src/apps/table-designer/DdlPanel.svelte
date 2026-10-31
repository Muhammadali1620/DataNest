<script lang="ts">
  import Icon from '../../components/Icon.svelte';
  import IconButton from '../../components/IconButton.svelte';
  import type { Translate } from '../../lib/i18n';

  interface Props {
    /** The CREATE script; undefined while it is being read. */
    text: string | undefined;
    error: string | undefined;
    t: Translate;
    oncopy: (text: string) => void;
    onopen: (text: string) => void;
    onrefresh: () => void;
  }

  const { text, error, t, oncopy, onopen, onrefresh }: Props = $props();
</script>

<div class="ddl">
  <div class="toolbar">
    <IconButton
      icon="copy"
      tone="blue"
      label={t('designer.ddl.copy')}
      disabled={text === undefined}
      onclick={() => {
        if (text !== undefined) {
          oncopy(text);
        }
      }}
    />
    <IconButton
      icon="go-to-file"
      tone="green"
      label={t('designer.ddl.open')}
      disabled={text === undefined}
      onclick={() => {
        if (text !== undefined) {
          onopen(text);
        }
      }}
    />
    <IconButton icon="refresh" label={t('designer.ddl.refresh')} onclick={onrefresh} />
  </div>
  {#if error !== undefined}
    <p class="notice error" role="alert"><Icon name="error" /><span>{error}</span></p>
  {:else if text === undefined}
    <p class="muted" role="status"><Icon name="loading" spin /> {t('designer.loading')}</p>
  {:else}
    <pre data-testid="ddl">{text}</pre>
  {/if}
</div>

<style>
  .ddl {
    display: flex;
    flex-direction: column;
    gap: var(--dn-gap);
  }

  pre {
    margin: 0;
    padding: var(--dn-gap-m);
    overflow: auto;
    background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background));
    border: 1px solid var(--dn-border);
    border-radius: var(--dn-radius);
    font-family: var(--dn-mono);
    font-size: var(--vscode-editor-font-size);
    line-height: 1.5;
    white-space: pre-wrap;
    user-select: text;
  }
</style>

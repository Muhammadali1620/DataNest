<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    label: string;
    /** Shown under the control; the control is marked invalid while it is set. */
    error?: string | undefined;
    hint?: string | undefined;
    children: Snippet;
  }

  const { label, error, hint, children }: Props = $props();
</script>

<label class="field">
  <span class="label">{label}</span>
  {@render children()}
  {#if error}
    <span class="error" role="alert">{error}</span>
  {:else if hint}
    <span class="hint">{hint}</span>
  {/if}
</label>

<style>
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .label {
    color: var(--vscode-foreground);
  }

  .error {
    color: var(--vscode-inputValidation-errorForeground, var(--vscode-errorForeground));
  }

  .hint {
    color: var(--vscode-descriptionForeground);
  }

  .error,
  .hint {
    font-size: 0.9em;
  }
</style>

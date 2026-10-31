<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    label: string;
    /** Shown under the control; the control is marked invalid while it is set. */
    error?: string | undefined;
    hint?: string | undefined;
    /** A value must be given: the label ends with a red star and the control is marked. */
    required?: boolean;
    children: Snippet;
  }

  const { label, error, hint, required = false, children }: Props = $props();

  let field = $state<HTMLLabelElement | undefined>(undefined);

  // The control is the caller's, so the mark is set on it from here: screen readers
  // announce "required" with the control, not only with the label.
  $effect(() => {
    const control = field?.querySelector('input, select, textarea');
    if (required) {
      control?.setAttribute('aria-required', 'true');
    } else {
      control?.removeAttribute('aria-required');
    }
  });
</script>

<label class="field" bind:this={field}>
  <span class="label" class:required>{label}</span>
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

  /* Drawn by CSS, so the star is not part of the label's text or its accessible name:
     `aria-required` on the control tells screen readers. */
  .label.required::after {
    margin-inline-start: 3px;
    color: var(--dn-danger, var(--vscode-errorForeground));
    content: '*';
    font-weight: 700;
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

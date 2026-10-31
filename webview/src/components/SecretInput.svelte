<script lang="ts">
  // A password field with a button that shows what was typed (V10.2.5). Only what the
  // user types here is ever shown: a stored password never comes back to the page.
  interface Props {
    value?: string;
    label: string;
    showLabel: string;
    hideLabel: string;
    maxlength?: number | undefined;
    disabled?: boolean | undefined;
    oninput?: (() => void) | undefined;
    testid?: string | undefined;
  }

  // `let`, not `const`: a bindable prop is written back to the parent, and Svelte wants
  // every prop of the one `$props()` in the same declaration.
  /* eslint-disable prefer-const */
  let {
    value = $bindable(''),
    label,
    showLabel,
    hideLabel,
    maxlength,
    disabled = false,
    oninput,
    testid,
  }: Props = $props();
  /* eslint-enable prefer-const */

  let shown = $state(false);
</script>

<span class="secret">
  <input
    class="control grow"
    type={shown ? 'text' : 'password'}
    bind:value
    {oninput}
    {maxlength}
    {disabled}
    aria-label={label}
    autocomplete="off"
    spellcheck="false"
    data-testid={testid}
  />
  <button
    type="button"
    class="button secondary reveal"
    aria-pressed={shown}
    aria-label={shown ? hideLabel : showLabel}
    title={shown ? hideLabel : showLabel}
    {disabled}
    data-testid={testid === undefined ? undefined : `${testid}-reveal`}
    onclick={() => {
      shown = !shown;
    }}
  >
    {shown ? hideLabel : showLabel}
  </button>
</span>

<style>
  .secret {
    display: flex;
    gap: 4px;
  }

  .grow {
    flex: 1;
    min-width: 0;
  }

  .reveal {
    flex: none;
  }
</style>

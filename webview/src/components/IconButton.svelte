<script lang="ts">
  import type { HTMLButtonAttributes } from 'svelte/elements';
  import type { CodiconName } from '../lib/codicons';
  import Icon from './Icon.svelte';
  import type { Tone } from './tone';

  interface Props extends Omit<HTMLButtonAttributes, 'children'> {
    icon: CodiconName;
    /** The button's name: read by screen readers and shown as its tooltip. */
    label: string;
    /** Shown next to the icon; without it the button is the icon alone. */
    text?: string | undefined;
    /** A toggle: its state is shown and announced. */
    pressed?: boolean | undefined;
    /** A longer tooltip than the name, e.g. with the key that does the same. */
    hint?: string | undefined;
    spin?: boolean;
    /** The button's colour: its icon and tint, so the action reads without words. */
    tone?: Tone | undefined;
    /** A small count drawn on the button, e.g. how many filters are on; 0 shows none. */
    count?: number | undefined;
    element?: HTMLButtonElement | undefined;
  }

  // `let`, not `const`: `element` is bindable, and Svelte wants every prop of the one
  // `$props()` in the same declaration.
  /* eslint-disable prefer-const */
  let {
    icon,
    label,
    text,
    pressed,
    hint,
    spin = false,
    tone,
    count,
    element = $bindable(),
    class: extra = '',
    ...rest
  }: Props = $props();
  /* eslint-enable prefer-const */
</script>

<button
  bind:this={element}
  type="button"
  class="icon-button {tone === undefined ? '' : `tone-${tone}`} {extra}"
  class:labelled={text !== undefined}
  aria-label={text === undefined ? label : undefined}
  aria-pressed={pressed}
  title={hint ?? label}
  {...rest}
>
  <Icon name={icon} {spin} />
  {#if text !== undefined}<span>{text}</span>{/if}
  {#if count !== undefined && count > 0}<span class="count" aria-hidden="true">{count}</span>{/if}
</button>

<style>
  .count {
    min-width: 14px;
    height: 14px;
    padding: 0 3px;
    color: var(--vscode-activityBarBadge-foreground, var(--vscode-badge-foreground));
    background: var(--vscode-activityBarBadge-background, var(--vscode-badge-background));
    border-radius: 7px;
    font-size: 9px;
    font-weight: 600;
    line-height: 14px;
    text-align: center;
  }
</style>

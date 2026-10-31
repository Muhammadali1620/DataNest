<script lang="ts" generics="Id extends string">
  import { tick } from 'svelte';
  import type { CodiconName } from '../lib/codicons';
  import Icon from './Icon.svelte';
  import type { MenuItem } from './menu';

  interface Props {
    items: readonly MenuItem<Id>[];
    onSelect: (id: Id) => void;
    /** The button's name for screen readers and its tooltip. */
    label: string;
    /** The button's icon; without text the button is the icon alone. */
    icon?: CodiconName;
    /** Text on the button; a chevron follows it. */
    text?: string | undefined;
    hint?: string | undefined;
    disabled?: boolean;
    /** Which edge of the button the menu lines up with. */
    align?: 'start' | 'end';
    testid?: string;
  }

  const {
    items,
    onSelect,
    label,
    icon,
    text,
    hint,
    disabled = false,
    align = 'end',
    testid,
  }: Props = $props();

  const menuId = $props.id();
  let open = $state(false);
  let button = $state<HTMLButtonElement | undefined>(undefined);
  let menu = $state<HTMLDivElement | undefined>(undefined);
  let position = $state({ top: 0, left: 0, right: 0 });

  const enabled = (): HTMLElement[] =>
    menu === undefined
      ? []
      : [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')];

  async function show(focus: 'first' | 'last' = 'first'): Promise<void> {
    if (button === undefined) {
      return;
    }
    // Fixed to the window, so a scrolling or clipped toolbar does not cut it off.
    const box = button.getBoundingClientRect();
    position = { top: box.bottom + 2, left: box.left, right: window.innerWidth - box.right };
    open = true;
    await tick();
    const list = enabled();
    (focus === 'first' ? list[0] : list.at(-1))?.focus();
  }

  function hide(returnFocus = true): void {
    open = false;
    if (returnFocus) {
      button?.focus();
    }
  }

  function choose(item: MenuItem<Id>): void {
    if (item.disabled === true) {
      return;
    }
    hide();
    onSelect(item.id);
  }

  function onButtonKey(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      void show(event.key === 'ArrowDown' ? 'first' : 'last');
    }
  }

  function onMenuKey(event: KeyboardEvent): void {
    const list = enabled();
    const index = list.indexOf(document.activeElement as HTMLElement);
    const move = (to: number): void => {
      event.preventDefault();
      list[(to + list.length) % list.length]?.focus();
    };
    switch (event.key) {
      case 'ArrowDown':
        move(index + 1);
        break;
      case 'ArrowUp':
        move(index - 1);
        break;
      case 'Home':
        move(0);
        break;
      case 'End':
        move(list.length - 1);
        break;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        hide();
        break;
      case 'Tab':
        hide(false);
        break;
      default:
        // A letter jumps to the next item starting with it.
        if (event.key.length === 1 && /\S/.test(event.key)) {
          const letter = event.key.toLowerCase();
          const next = list.findIndex(
            (item, at) => at > index && item.textContent.trim().toLowerCase().startsWith(letter),
          );
          const first = list.findIndex((item) =>
            item.textContent.trim().toLowerCase().startsWith(letter),
          );
          const to = next === -1 ? first : next;
          if (to !== -1) {
            move(to);
          }
        }
    }
  }

  function onWindowPointer(event: PointerEvent): void {
    const target = event.target as Node | null;
    if (open && target !== null && !menu?.contains(target) && !button?.contains(target)) {
      hide(false);
    }
  }
</script>

<svelte:window
  onpointerdown={onWindowPointer}
  onblur={() => {
    if (open) {
      hide(false);
    }
  }}
/>

<button
  bind:this={button}
  type="button"
  class="icon-button menu-button"
  class:labelled={text !== undefined}
  aria-label={text === undefined ? label : undefined}
  aria-haspopup="menu"
  aria-expanded={open}
  aria-controls={open ? menuId : undefined}
  title={hint ?? label}
  {disabled}
  data-testid={testid}
  onclick={() => {
    if (open) {
      hide();
    } else {
      void show();
    }
  }}
  onkeydown={onButtonKey}
>
  {#if icon !== undefined}<Icon name={icon} />{/if}
  {#if text !== undefined}<span>{text}</span><Icon name="chevron-down" size={14} />{/if}
</button>

{#if open}
  <div
    bind:this={menu}
    id={menuId}
    class="menu fade-in"
    role="menu"
    aria-label={label}
    tabindex="-1"
    style="top: {position.top}px; {align === 'start'
      ? `left: ${position.left}px`
      : `right: ${position.right}px`};"
    onkeydown={onMenuKey}
  >
    {#each items as item (item.id)}
      {#if item.separated === true}<div class="separator" role="separator"></div>{/if}
      <div
        class="item"
        role="menuitem"
        tabindex="-1"
        aria-disabled={item.disabled === true ? 'true' : undefined}
        data-id={item.id}
        onclick={() => {
          choose(item);
        }}
        onkeydown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            choose(item);
          }
        }}
      >
        <span class="item-icon">{#if item.icon !== undefined}<Icon name={item.icon} />{/if}</span>
        <span class="item-label">{item.label}</span>
      </div>
    {/each}
  </div>
{/if}

<style>
  .menu {
    position: fixed;
    z-index: 100;
    min-width: 180px;
    max-width: min(360px, calc(100vw - 16px));
    max-height: min(420px, calc(100vh - 16px));
    padding: 4px;
    overflow-y: auto;
    color: var(--vscode-menu-foreground, var(--vscode-foreground));
    background: var(--vscode-menu-background, var(--dn-surface));
    border: 1px solid var(--vscode-menu-border, var(--dn-border));
    border-radius: var(--dn-radius-l);
    box-shadow: var(--dn-shadow);
    outline: none;
  }

  .item {
    display: flex;
    gap: 6px;
    align-items: center;
    height: 24px;
    padding: 0 8px 0 4px;
    border-radius: var(--dn-radius);
    white-space: nowrap;
    cursor: pointer;
  }

  .item:focus,
  .item:hover {
    color: var(--vscode-menu-selectionForeground, var(--vscode-list-activeSelectionForeground));
    background: var(--vscode-menu-selectionBackground, var(--vscode-list-activeSelectionBackground));
    outline: none;
  }

  .item[aria-disabled='true'] {
    opacity: 0.45;
    cursor: default;
  }

  .item[aria-disabled='true']:hover {
    color: inherit;
    background: none;
  }

  .item-icon {
    display: inline-flex;
    width: 16px;
  }

  .item-label {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .separator {
    height: 1px;
    margin: 4px 6px;
    background: var(--vscode-menu-separatorBackground, var(--dn-divider));
  }
</style>

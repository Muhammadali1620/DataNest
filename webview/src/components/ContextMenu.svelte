<script lang="ts" generics="Id extends string">
  import { onMount, tick } from 'svelte';
  import Icon from './Icon.svelte';
  import type { ContextEntry } from './menu';

  interface Props {
    /** Where the pointer was, in window coordinates. */
    x: number;
    y: number;
    items: readonly ContextEntry<Id>[];
    label: string;
    onSelect: (id: Id) => void;
    onClose: () => void;
    /** Move the focus into the menu; off for a text box's menu, which must keep its caret. */
    focusFirst?: boolean;
  }

  const { x, y, items, label, onSelect, onClose, focusFirst = true }: Props = $props();

  let menu = $state<HTMLDivElement | undefined>(undefined);
  let left = $state(0);
  let top = $state(0);
  let opened = $state<string | undefined>(undefined);

  const menuId = $props.id();

  onMount(() => {
    left = x;
    top = y;
    void tick().then(() => {
      if (menu === undefined) {
        return;
      }
      // Kept inside the window: a menu opened near the edge flips to the other side.
      const box = menu.getBoundingClientRect();
      left = Math.max(4, Math.min(x, window.innerWidth - box.width - 4));
      top = Math.max(4, Math.min(y, window.innerHeight - box.height - 4));
      if (focusFirst) {
        enabled()[0]?.focus();
      }
    });
  });

  const enabled = (scope: ParentNode | undefined = menu): HTMLElement[] =>
    scope === undefined
      ? []
      : [
          ...scope.querySelectorAll<HTMLElement>(
            ':scope > [role="menuitem"]:not([aria-disabled="true"])',
          ),
        ];

  function choose(entry: ContextEntry<Id>): void {
    if (entry.disabled === true) {
      return;
    }
    if (entry.children !== undefined) {
      opened = opened === entry.id ? undefined : entry.id;
      return;
    }
    onSelect(entry.id);
    onClose();
  }

  function onKey(event: KeyboardEvent): void {
    const current = document.activeElement as HTMLElement | null;
    const scope = current?.parentElement ?? menu;
    const list = enabled(scope ?? undefined);
    const index = current === null ? -1 : list.indexOf(current);
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
      case 'ArrowRight': {
        const id = current?.dataset.id;
        if (id !== undefined && current?.getAttribute('aria-haspopup') === 'menu') {
          event.preventDefault();
          opened = id;
          void tick().then(() => {
            enabled(current.querySelector('.sub') ?? undefined)[0]?.focus();
          });
        }
        break;
      }
      case 'ArrowLeft':
        if (scope?.classList.contains('sub') === true) {
          event.preventDefault();
          const parent = scope.parentElement;
          opened = undefined;
          parent?.focus();
        }
        break;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        onClose();
        break;
      case 'Tab':
        onClose();
        break;
    }
  }

  function onWindowPointer(event: PointerEvent): void {
    if (menu !== undefined && !menu.contains(event.target as Node | null)) {
      onClose();
    }
  }
</script>

<svelte:window onpointerdown={onWindowPointer} onblur={onClose} onresize={onClose} />

{#snippet entries(list: readonly ContextEntry<Id>[])}
  {#each list as entry (entry.id)}
    {#if entry.separated === true}<div class="separator" role="separator"></div>{/if}
    <div
      class="item"
      class:parent={entry.children !== undefined}
      role="menuitem"
      tabindex="-1"
      aria-disabled={entry.disabled === true ? 'true' : undefined}
      aria-haspopup={entry.children === undefined ? undefined : 'menu'}
      aria-expanded={entry.children === undefined ? undefined : opened === entry.id}
      data-id={entry.id}
      onclick={(event) => {
        // A submenu sits inside its parent's item; the click must not reach the parent too.
        event.stopPropagation();
        choose(entry);
      }}
      onpointerenter={() => {
        if (entry.children !== undefined) {
          opened = entry.id;
        } else if (list.some((other) => other.id === opened)) {
          opened = undefined;
        }
      }}
      onkeydown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          event.stopPropagation();
          choose(entry);
        }
      }}
    >
      <span class="item-icon {entry.tone === undefined ? '' : `tone-${entry.tone}`}">
        {#if entry.icon !== undefined}<Icon name={entry.icon} />{/if}
      </span>
      <span class="item-label">{entry.label}</span>
      {#if entry.keys !== undefined}<span class="keys">{entry.keys}</span>{/if}
      {#if entry.children !== undefined}
        <span class="chevron"><Icon name="chevron-right" size={14} /></span>
        {#if opened === entry.id}
          <div class="menu sub" role="menu" aria-label={entry.label} tabindex="-1">
            {@render entries(entry.children)}
          </div>
        {/if}
      {/if}
    </div>
  {/each}
{/snippet}

<div
  bind:this={menu}
  id={menuId}
  class="menu fade-in"
  role="menu"
  aria-label={label}
  tabindex="-1"
  style="top: {top}px; left: {left}px;"
  data-testid="context-menu"
  onkeydown={onKey}
  onmousedown={(event) => {
    if (!focusFirst) {
      // The text box keeps its focus and selection while its menu is used.
      event.preventDefault();
    }
  }}
>
  {@render entries(items)}
</div>

<style>
  .menu {
    position: fixed;
    z-index: 200;
    min-width: 200px;
    max-width: min(360px, calc(100vw - 16px));
    padding: 4px;
    color: var(--vscode-menu-foreground, var(--vscode-foreground));
    background: var(--vscode-menu-background, var(--dn-surface));
    border: 1px solid var(--vscode-menu-border, var(--dn-border));
    border-radius: var(--dn-radius-l);
    box-shadow: var(--dn-shadow);
    outline: none;
  }

  .menu.sub {
    position: absolute;
    top: -5px;
    left: calc(100% + 2px);
  }

  .item {
    position: relative;
    display: flex;
    gap: 8px;
    align-items: center;
    height: 26px;
    padding: 0 8px 0 6px;
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
    color: var(--tone, inherit);
  }

  .item-label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .keys,
  .chevron {
    color: var(--dn-muted);
    font-size: var(--dn-font-small);
  }

  .separator {
    height: 1px;
    margin: 4px 6px;
    background: var(--vscode-menu-separatorBackground, var(--dn-divider));
  }
</style>

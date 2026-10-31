import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ContextMenu from '../../../../webview/src/components/ContextMenu.svelte';
import type { ContextEntry } from '../../../../webview/src/components/menu';
import {
  copyableOf,
  isEditable,
  isTextBox,
  runCopyAction,
  runTextAction,
  selectedIn,
  selectedText,
} from '../../../../webview/src/components/text-menu';

afterEach(() => {
  cleanup();
});

const ITEMS: ContextEntry<string>[] = [
  { id: 'one', label: 'One', icon: 'copy', tone: 'blue', keys: 'Ctrl+1' },
  { id: 'two', label: 'Two', disabled: true, separated: true },
  {
    id: 'more',
    label: 'More',
    children: [
      { id: 'a', label: 'Alpha' },
      { id: 'b', label: 'Beta', disabled: true },
    ],
  },
  { id: 'last', label: 'Last' },
];

function show(extra: { focusFirst?: boolean } = {}) {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  render(ContextMenu, {
    props: { x: 10, y: 20, items: ITEMS, label: 'Menu', onSelect, onClose, ...extra },
  });
  return { onSelect, onClose, menu: screen.getByRole('menu', { name: 'Menu' }) };
}

describe('ContextMenu', () => {
  it('opens where the pointer was', () => {
    const { menu } = show();
    expect(menu.style.left).toBe('10px');
    expect(menu.style.top).toBe('20px');
  });

  it('lists the entries with their keys and a separator', () => {
    const { menu } = show();
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((item) => item.textContent.trim().replace(/\s+/gu, ' '))).toEqual([
      'One Ctrl+1',
      'Two',
      'More',
      'Last',
    ]);
    expect(within(menu).getAllByRole('separator')).toHaveLength(1);
  });

  it('runs an entry, then closes', async () => {
    const { onSelect, onClose } = show();
    await fireEvent.click(screen.getByText('One'));
    expect(onSelect).toHaveBeenCalledWith('one');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not run a disabled entry', async () => {
    const { onSelect, onClose } = show();
    await fireEvent.click(screen.getByText('Two'));
    expect(onSelect).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('puts the focus on the first enabled entry', async () => {
    show();
    await waitFor(() => {
      expect(document.activeElement?.getAttribute('data-id')).toBe('one');
    });
  });

  it('keeps the focus where it was when asked to', async () => {
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    show({ focusFirst: false });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(document.activeElement).toBe(input);
    input.remove();
  });

  it('walks with the arrows over the enabled entries only, and wraps', async () => {
    const { menu } = show();
    await waitFor(() => {
      expect(document.activeElement?.getAttribute('data-id')).toBe('one');
    });
    await fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement?.getAttribute('data-id')).toBe('more');
    await fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement?.getAttribute('data-id')).toBe('last');
    await fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement?.getAttribute('data-id')).toBe('one');
    await fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement?.getAttribute('data-id')).toBe('last');
    await fireEvent.keyDown(menu, { key: 'Home' });
    expect(document.activeElement?.getAttribute('data-id')).toBe('one');
    await fireEvent.keyDown(menu, { key: 'End' });
    expect(document.activeElement?.getAttribute('data-id')).toBe('last');
  });

  it('runs the focused entry with Enter and Space', async () => {
    const { menu, onSelect } = show();
    await waitFor(() => {
      expect(document.activeElement?.getAttribute('data-id')).toBe('one');
    });
    await fireEvent.keyDown(document.activeElement ?? menu, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('one');
  });

  it('closes on Escape and on Tab', async () => {
    const first = show();
    await fireEvent.keyDown(first.menu, { key: 'Escape' });
    expect(first.onClose).toHaveBeenCalledTimes(1);
    cleanup();
    const second = show();
    await fireEvent.keyDown(second.menu, { key: 'Tab' });
    expect(second.onClose).toHaveBeenCalledTimes(1);
  });

  it('closes when the pointer goes down elsewhere, not inside', async () => {
    const { onClose, menu } = show();
    await fireEvent.pointerDown(within(menu).getByText('One'));
    expect(onClose).not.toHaveBeenCalled();
    await fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('opens a submenu on click, with ArrowRight, and runs its entries', async () => {
    const { onSelect, menu } = show();
    await fireEvent.click(screen.getByText('More'));
    expect(await screen.findByRole('menu', { name: 'More' })).toBeTruthy();
    await fireEvent.click(screen.getByText('Alpha'));
    expect(onSelect).toHaveBeenCalledWith('a');
    cleanup();
    const again = show();
    await waitFor(() => {
      expect(document.activeElement).not.toBeNull();
    });
    within(again.menu).getByText('More').closest<HTMLElement>('[role="menuitem"]')?.focus();
    await fireEvent.keyDown(document.activeElement ?? again.menu, { key: 'ArrowRight' });
    await waitFor(() => {
      expect(screen.getByRole('menu', { name: 'More' })).toBeTruthy();
    });
    expect(menu).toBeTruthy();
  });

  it('does not run a disabled entry of a submenu and ArrowLeft returns to the parent', async () => {
    const { onSelect } = show();
    await fireEvent.click(screen.getByText('More'));
    await fireEvent.click(await screen.findByText('Beta'));
    expect(onSelect).not.toHaveBeenCalled();
    const sub = screen.getByRole('menu', { name: 'More' });
    const alpha = within(sub).getByText('Alpha').closest<HTMLElement>('[role="menuitem"]');
    alpha?.focus();
    await fireEvent.keyDown(alpha ?? sub, { key: 'ArrowLeft' });
    await waitFor(() => {
      expect(screen.queryByRole('menu', { name: 'More' })).toBeNull();
    });
  });
});

describe('text-menu', () => {
  function box(
    value: string,
    kind: 'input' | 'textarea' = 'input',
  ): HTMLInputElement | HTMLTextAreaElement {
    const element = document.createElement(kind);
    element.value = value;
    document.body.append(element);
    return element;
  }

  it('knows which elements hold typed text', () => {
    expect(isTextBox(box('', 'textarea'))).toBe(true);
    expect(isTextBox(box(''))).toBe(true);
    const colour = document.createElement('input');
    colour.type = 'color';
    expect(isTextBox(colour)).toBe(false);
    const check = document.createElement('input');
    check.type = 'checkbox';
    expect(isTextBox(check)).toBe(false);
    expect(isTextBox(document.createElement('div'))).toBe(false);
    expect(isTextBox(null)).toBe(false);
  });

  it('reads the selection whichever way it was made', () => {
    const element = box('hello world');
    element.setSelectionRange(6, 11);
    expect(selectedText(element)).toBe('world');
    element.setSelectionRange(2, 2);
    expect(selectedText(element)).toBe('');
  });

  it('is not editable when read-only or disabled', () => {
    const element = box('x');
    expect(isEditable(element)).toBe(true);
    element.readOnly = true;
    expect(isEditable(element)).toBe(false);
    element.readOnly = false;
    element.disabled = true;
    expect(isEditable(element)).toBe(false);
  });

  it('copies the selection, cuts it, pastes over it and selects all', () => {
    const element = box('hello world');
    const copy = vi.fn();
    element.setSelectionRange(0, 5);
    runTextAction(element, 'copy', { copy });
    expect(copy).toHaveBeenLastCalledWith('hello');
    expect(element.value).toBe('hello world');
    runTextAction(element, 'cut', { copy });
    expect(copy).toHaveBeenLastCalledWith('hello');
    expect(element.value).toBe(' world');
    element.setSelectionRange(0, 0);
    runTextAction(element, 'paste', { copy, clipboard: 'big' });
    expect(element.value).toBe('big world');
    runTextAction(element, 'selectAll', { copy });
    expect(selectedText(element)).toBe('big world');
  });

  it('does not cut or paste into a read-only box and cuts nothing when nothing is selected', () => {
    const element = box('keep');
    const copy = vi.fn();
    element.readOnly = true;
    element.setSelectionRange(0, 4);
    runTextAction(element, 'cut', { copy });
    runTextAction(element, 'paste', { copy, clipboard: 'x' });
    expect(element.value).toBe('keep');
    expect(copy).not.toHaveBeenCalled();
    element.readOnly = false;
    element.setSelectionRange(1, 1);
    runTextAction(element, 'cut', { copy });
    expect(copy).not.toHaveBeenCalled();
  });

  it('pastes nothing when the clipboard is empty or unreadable', () => {
    const element = box('a');
    runTextAction(element, 'paste', { copy: vi.fn(), clipboard: '' });
    runTextAction(element, 'paste', { copy: vi.fn() });
    expect(element.value).toBe('a');
  });

  describe('read-only text blocks', () => {
    function block(text: string): HTMLElement {
      const element = document.createElement('pre');
      element.setAttribute('data-copy-menu', '');
      element.innerHTML = `<span>${text}</span>`;
      document.body.append(element);
      return element;
    }

    it('finds the block a right click landed in, from any child', () => {
      const element = block('abc');
      expect(copyableOf(element.firstElementChild)).toBe(element);
      expect(copyableOf(document.createElement('div'))).toBeUndefined();
      expect(copyableOf(null)).toBeUndefined();
    });

    it('copies the whole text when nothing is selected, the selection when there is one', () => {
      const element = block('hello world');
      const copy = vi.fn();
      document.getSelection()?.removeAllRanges();
      runCopyAction(element, 'copy', { copy });
      expect(copy).toHaveBeenLastCalledWith('hello world');
      const range = document.createRange();
      const text = element.firstElementChild?.firstChild;
      range.setStart(text as Text, 0);
      range.setEnd(text as Text, 5);
      document.getSelection()?.removeAllRanges();
      document.getSelection()?.addRange(range);
      expect(selectedIn(element)).toBe('hello');
      runCopyAction(element, 'copy', { copy });
      expect(copy).toHaveBeenLastCalledWith('hello');
    });

    it('ignores a selection made somewhere else, and selects all of the block', () => {
      const element = block('one two');
      const other = block('elsewhere');
      const range = document.createRange();
      range.selectNodeContents(other);
      document.getSelection()?.removeAllRanges();
      document.getSelection()?.addRange(range);
      expect(selectedIn(element)).toBe('');
      runCopyAction(element, 'selectAll', { copy: vi.fn() });
      expect(selectedIn(element)).toBe('one two');
    });
  });
});

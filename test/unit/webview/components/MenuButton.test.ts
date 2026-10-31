import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import MenuButton from '../../../../webview/src/components/MenuButton.svelte';

const ITEMS = [
  { id: 'csv', label: 'CSV', icon: 'table' as const },
  { id: 'json', label: 'JSON' },
  { id: 'sql', label: 'SQL', disabled: true },
  { id: 'md', label: 'Markdown', separated: true },
];

function setup(props: Record<string, unknown> = {}) {
  const onSelect = vi.fn();
  render(MenuButton, {
    props: { items: ITEMS, onSelect, label: 'Export', icon: 'export', testid: 'menu', ...props },
  });
  return { onSelect, button: screen.getByTestId('menu') };
}

const focusedLabel = (): string => document.activeElement?.textContent.trim() ?? '';

describe('MenuButton', () => {
  it('is a closed menu button named by its label', () => {
    const { button } = setup();
    expect(button.getAttribute('aria-label')).toBe('Export');
    expect(button.getAttribute('aria-haspopup')).toBe('menu');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens on click with the first item focused and the menu tied to the button', async () => {
    const { button } = setup();
    await fireEvent.click(button);
    const menu = screen.getByRole('menu', { name: 'Export' });
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.getAttribute('aria-controls')).toBe(menu.id);
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent.trim()),
    ).toEqual(['CSV', 'JSON', 'SQL', 'Markdown']);
    expect(focusedLabel()).toBe('CSV');
    expect(within(menu).getAllByRole('separator')).toHaveLength(1);
  });

  it('picks an item on click, closes and gives the focus back', async () => {
    const { button, onSelect } = setup();
    await fireEvent.click(button);
    await fireEvent.click(screen.getByRole('menuitem', { name: 'JSON' }));
    expect(onSelect).toHaveBeenCalledWith('json');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('ignores a disabled item', async () => {
    const { button, onSelect } = setup();
    await fireEvent.click(button);
    const sql = screen.getByRole('menuitem', { name: 'SQL' });
    expect(sql.getAttribute('aria-disabled')).toBe('true');
    await fireEvent.click(sql);
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole('menu')).toBeTruthy();
  });

  it('walks the enabled items with arrows, Home and End, wrapping around', async () => {
    const { button } = setup();
    await fireEvent.click(button);
    const menu = screen.getByRole('menu');
    await fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(focusedLabel()).toBe('JSON');
    // SQL is disabled and skipped.
    await fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(focusedLabel()).toBe('Markdown');
    await fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(focusedLabel()).toBe('CSV');
    await fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(focusedLabel()).toBe('Markdown');
    await fireEvent.keyDown(menu, { key: 'Home' });
    expect(focusedLabel()).toBe('CSV');
    await fireEvent.keyDown(menu, { key: 'End' });
    expect(focusedLabel()).toBe('Markdown');
  });

  it('jumps to an item by its first letter', async () => {
    const { button } = setup();
    await fireEvent.click(button);
    await fireEvent.keyDown(screen.getByRole('menu'), { key: 'm' });
    expect(focusedLabel()).toBe('Markdown');
    await fireEvent.keyDown(screen.getByRole('menu'), { key: 'j' });
    expect(focusedLabel()).toBe('JSON');
    // No item starts with q: the focus stays.
    await fireEvent.keyDown(screen.getByRole('menu'), { key: 'q' });
    expect(focusedLabel()).toBe('JSON');
  });

  it('picks the focused item with Enter or Space', async () => {
    const { button, onSelect } = setup();
    await fireEvent.click(button);
    await fireEvent.keyDown(screen.getByRole('menuitem', { name: 'CSV' }), { key: 'Enter' });
    expect(onSelect).toHaveBeenLastCalledWith('csv');
    await fireEvent.click(button);
    await fireEvent.keyDown(screen.getByRole('menuitem', { name: 'JSON' }), { key: ' ' });
    expect(onSelect).toHaveBeenLastCalledWith('json');
  });

  it('closes with Escape and returns the focus, without letting the key go further', async () => {
    const { button } = setup();
    const outer = vi.fn();
    window.addEventListener('keydown', outer);
    await fireEvent.click(button);
    await fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    window.removeEventListener('keydown', outer);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(outer).not.toHaveBeenCalled();
  });

  it('closes with Tab, leaving the focus to move on', async () => {
    const { button } = setup();
    await fireEvent.click(button);
    await fireEvent.keyDown(screen.getByRole('menu'), { key: 'Tab' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens from the keyboard: Down focuses the first item, Up the last', async () => {
    const { button } = setup();
    await fireEvent.keyDown(button, { key: 'ArrowDown' });
    expect(focusedLabel()).toBe('CSV');
    await fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    await fireEvent.keyDown(button, { key: 'ArrowUp' });
    expect(focusedLabel()).toBe('Markdown');
  });

  it('closes on a second click of its button and on a click elsewhere', async () => {
    const { button } = setup();
    await fireEvent.click(button);
    await fireEvent.click(button);
    expect(screen.queryByRole('menu')).toBeNull();
    await fireEvent.click(button);
    await fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('stays open when the pointer goes down inside it', async () => {
    const { button } = setup();
    await fireEvent.click(button);
    await fireEvent.pointerDown(screen.getByRole('menuitem', { name: 'CSV' }));
    expect(screen.getByRole('menu')).toBeTruthy();
  });

  it('closes when the page loses focus', async () => {
    const { button } = setup();
    await fireEvent.click(button);
    await fireEvent.blur(window);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('can carry text with a chevron instead of an icon', () => {
    setup({ icon: undefined, text: 'Copy as' });
    const button = screen.getByRole('button', { name: 'Copy as' });
    expect(button.hasAttribute('aria-label')).toBe(false);
    expect(button.querySelectorAll('.codicon-glyph')).toHaveLength(1);
  });

  it('lines the menu up with either edge of the button', async () => {
    setup({ align: 'start' });
    await fireEvent.click(screen.getByTestId('menu'));
    expect(screen.getByRole('menu').style.left).not.toBe('');
    expect(screen.getByRole('menu').style.right).toBe('');
  });

  it('can be disabled', () => {
    const { button } = setup({ disabled: true });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});

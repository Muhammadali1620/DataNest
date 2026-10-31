import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import DriverPicker from '../../../../../webview/src/apps/connection-form/DriverPicker.svelte';
import type { DriverChoice } from '../../../../../webview/src/apps/connection-form/driver-choices';

const CHOICES: DriverChoice[] = [
  { value: 'mysql', label: 'MySQL', mark: 'My', tone: 'orange', compatible: false },
  { value: 'postgres', label: 'PostgreSQL', mark: 'Pg', tone: 'blue', compatible: false },
  { value: 'sqlite', label: 'SQLite', mark: 'Lt', tone: 'green', compatible: false },
  {
    value: 'preset:tidb',
    label: 'TiDB',
    mark: 'Ti',
    tone: 'orange',
    compatible: true,
    hint: 'Uses MySQL',
  },
];

function setup(value = 'postgres', choices = CHOICES) {
  const onChange = vi.fn();
  const view = render(DriverPicker, {
    props: { choices, value, label: 'Database', compatibleLabel: 'Compatible servers', onChange },
  });
  return { onChange, view };
}

const radio = (name: string): HTMLElement => screen.getByRole('radio', { name });

describe('DriverPicker', () => {
  it('is a radio group of cards named by the database alone', () => {
    setup();
    expect(screen.getByRole('radiogroup', { name: 'Database' })).toBeTruthy();
    expect(screen.getAllByRole('radio').map((card) => card.textContent.trim())).toEqual([
      'MySQL',
      'PostgreSQL',
      'SQLite',
      'TiDB',
    ]);
  });

  it('draws each mark from an attribute, out of the name', () => {
    setup();
    const mark = radio('MySQL').querySelector('.mark');
    expect(mark?.getAttribute('data-mark')).toBe('My');
    expect(mark?.getAttribute('aria-hidden')).toBe('true');
    expect(mark?.classList.contains('orange')).toBe(true);
  });

  it('marks the chosen card and makes it the only Tab stop', () => {
    setup('postgres');
    expect(radio('PostgreSQL').getAttribute('aria-checked')).toBe('true');
    expect(radio('MySQL').getAttribute('aria-checked')).toBe('false');
    expect(screen.getAllByRole('radio').filter((card) => card.tabIndex === 0)).toEqual([
      radio('PostgreSQL'),
    ]);
  });

  it('makes the first card the Tab stop when nothing known is chosen', () => {
    setup('oracle');
    expect(radio('MySQL').tabIndex).toBe(0);
  });

  it('reports a click on another card, and not one on the chosen card', async () => {
    const { onChange } = setup('postgres');
    await fireEvent.click(radio('SQLite'));
    expect(onChange).toHaveBeenCalledWith('sqlite');
    await fireEvent.click(radio('PostgreSQL'));
    expect(onChange).toHaveBeenCalledOnce();
  });

  it('moves the choice with the arrows, wrapping around, and with Home and End', async () => {
    const { onChange } = setup('postgres');
    const group = screen.getByRole('radiogroup');
    await fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('sqlite');
    await fireEvent.keyDown(group, { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith('mysql');
    await fireEvent.keyDown(group, { key: 'ArrowDown' });
    expect(onChange).toHaveBeenLastCalledWith('sqlite');
    await fireEvent.keyDown(group, { key: 'ArrowUp' });
    expect(onChange).toHaveBeenLastCalledWith('mysql');
    await fireEvent.keyDown(group, { key: 'End' });
    expect(onChange).toHaveBeenLastCalledWith('preset:tidb');
    await fireEvent.keyDown(group, { key: 'Home' });
    expect(onChange).toHaveBeenLastCalledWith('mysql');
  });

  it('wraps from the last card to the first', async () => {
    const { onChange } = setup('preset:tidb');
    await fireEvent.keyDown(screen.getByRole('radiogroup'), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('mysql');
  });

  it('leaves other keys alone', async () => {
    const { onChange } = setup();
    await fireEvent.keyDown(screen.getByRole('radiogroup'), { key: 'a' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('puts the compatible servers under their own heading, with a tooltip', () => {
    setup();
    expect(screen.getByText('Compatible servers')).toBeTruthy();
    expect(radio('TiDB').getAttribute('title')).toBe('Uses MySQL');
    expect(radio('TiDB').classList.contains('compatible')).toBe(true);
  });

  it('has no compatible heading without compatible servers', () => {
    setup('mysql', CHOICES.slice(0, 3));
    expect(screen.queryByText('Compatible servers')).toBeNull();
  });
});

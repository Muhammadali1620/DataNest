import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import Icon from '../../../../webview/src/components/Icon.svelte';
import IconButton from '../../../../webview/src/components/IconButton.svelte';

describe('Icon', () => {
  it('draws the glyph from an attribute, so it adds no text to copy or read', () => {
    const { container } = render(Icon, { props: { name: 'add' } });
    const glyph = container.querySelector('.codicon-glyph');
    expect(glyph?.getAttribute('data-glyph')).toBe(String.fromCodePoint(0xea60));
    expect(glyph?.getAttribute('aria-hidden')).toBe('true');
    expect(container.textContent).toBe('');
  });

  it('takes a colour tone of the theme palette', () => {
    const { container } = render(Icon, { props: { name: 'add', tone: 'purple' } });
    expect(container.querySelector('.codicon-glyph')?.classList.contains('tone-purple')).toBe(true);
    const plain = render(Icon, { props: { name: 'add' } });
    expect(plain.container.querySelector('.codicon-glyph')?.className).not.toContain('tone-');
  });

  it('takes a size and can spin', () => {
    const { container } = render(Icon, { props: { name: 'loading', size: 28, spin: true } });
    const glyph = container.querySelector<HTMLElement>('.codicon-glyph');
    expect(glyph?.style.fontSize).toBe('28px');
    expect(glyph?.classList.contains('spin')).toBe(true);
  });
});

describe('IconButton', () => {
  it('is named by its label, which is also its tooltip', () => {
    render(IconButton, { props: { icon: 'refresh', label: 'Refresh' } });
    const button = screen.getByRole('button', { name: 'Refresh' });
    expect(button.getAttribute('title')).toBe('Refresh');
    expect(button.getAttribute('type')).toBe('button');
    expect(button.textContent.trim()).toBe('');
  });

  it('shows a longer hint as the tooltip, keeping the short name', () => {
    render(IconButton, {
      props: { icon: 'open-preview', label: 'Value', hint: 'Show the value (F4)' },
    });
    const button = screen.getByRole('button', { name: 'Value' });
    expect(button.getAttribute('title')).toBe('Show the value (F4)');
  });

  it('with text is named by the text it shows', () => {
    render(IconButton, { props: { icon: 'add', label: 'Add row', text: 'Add row' } });
    const button = screen.getByRole('button', { name: 'Add row' });
    expect(button.hasAttribute('aria-label')).toBe(false);
    expect(button.textContent.trim()).toBe('Add row');
  });

  it('says whether a toggle is on', () => {
    render(IconButton, { props: { icon: 'filter', label: 'Filter', pressed: true } });
    expect(screen.getByRole('button', { name: 'Filter' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('draws a count only when there is one', () => {
    render(IconButton, { props: { icon: 'filter', label: 'Filter (2)', count: 2 } });
    const button = screen.getByRole('button', { name: 'Filter (2)' });
    expect(button.querySelector('.count')?.textContent).toBe('2');
  });

  it('draws no count for zero', () => {
    render(IconButton, { props: { icon: 'filter', label: 'Filter', count: 0 } });
    expect(screen.getByRole('button', { name: 'Filter' }).querySelector('.count')).toBeNull();
  });

  it('passes clicks, disabled and test ids through', async () => {
    const onclick = vi.fn();
    render(IconButton, {
      props: { icon: 'trash', label: 'Delete', onclick, 'data-testid': 'del', disabled: false },
    });
    await fireEvent.click(screen.getByTestId('del'));
    expect(onclick).toHaveBeenCalledOnce();
  });

  it('can be disabled', () => {
    render(IconButton, { props: { icon: 'trash', label: 'Delete', disabled: true } });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Delete' }).disabled).toBe(true);
  });
});

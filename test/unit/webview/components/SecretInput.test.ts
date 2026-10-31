import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import SecretInput from '../../../../webview/src/components/SecretInput.svelte';

function field(): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>('Password');
}

describe('SecretInput', () => {
  const props = { value: 'hunter2', label: 'Password', showLabel: 'Show', hideLabel: 'Hide' };

  it('hides what was typed until asked, then shows it and hides it again', async () => {
    render(SecretInput, { props: { ...props, testid: 'pw' } });
    expect(field().type).toBe('password');
    const reveal = screen.getByTestId('pw-reveal');
    expect(reveal.getAttribute('aria-pressed')).toBe('false');
    expect(reveal.getAttribute('aria-label')).toBe('Show');
    await fireEvent.click(reveal);
    expect(field().type).toBe('text');
    expect(field().value).toBe('hunter2');
    expect(reveal.getAttribute('aria-pressed')).toBe('true');
    expect(reveal.getAttribute('aria-label')).toBe('Hide');
    await fireEvent.click(reveal);
    expect(field().type).toBe('password');
  });

  it('reports typing and keeps the field free of autofill and spellcheck', async () => {
    const oninput = vi.fn();
    render(SecretInput, { props: { ...props, value: '', oninput, maxlength: 5 } });
    await fireEvent.input(field(), { target: { value: 'abc' } });
    expect(oninput).toHaveBeenCalled();
    expect(field().getAttribute('autocomplete')).toBe('off');
    expect(field().getAttribute('spellcheck')).toBe('false');
    expect(field().maxLength).toBe(5);
  });

  it('turns off both the field and its button when disabled', () => {
    render(SecretInput, { props: { ...props, disabled: true } });
    expect(field().disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Show' }).disabled).toBe(true);
  });
});

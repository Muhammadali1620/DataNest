import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import CodeArea from '../../../../webview/src/components/CodeArea.svelte';
import type { CodeMode } from '../../../../webview/src/components/code-mode';

afterEach(() => {
  cleanup();
});

function area(value: string, mode: CodeMode, readonly = false) {
  render(CodeArea, { props: { value, mode, readonly, label: 'Code', testid: 'code' } });
  return screen.getByTestId<HTMLTextAreaElement>('code');
}

/** Types one key the way the browser would: the page may take the key over. */
async function press(box: HTMLTextAreaElement, key: string, at: number, end = at) {
  box.focus();
  box.setSelectionRange(at, end);
  const allowed = await fireEvent.keyDown(box, { key });
  return allowed;
}

describe('CodeArea colouring', () => {
  it('draws JSON tokens in a layer behind the box', () => {
    area('{"a": [1, true, null, "x"]}', 'json');
    const layer = document.querySelector('.layer');
    expect(layer?.getAttribute('aria-hidden')).toBe('true');
    expect(layer?.querySelector('.json-key')?.textContent).toBe('"a"');
    expect(layer?.querySelector('.json-number')?.textContent).toBe('1');
    expect(layer?.querySelector('.json-literal')?.textContent).toBe('true');
    expect(layer?.querySelector('.json-string')?.textContent).toBe('"x"');
  });

  it('draws markup tokens', () => {
    area('<svg width="1"/>', 'xml');
    const layer = document.querySelector('.layer');
    expect(layer?.querySelector('.xml-tag')?.textContent).toBe('svg');
    expect(layer?.querySelector('.xml-attr')?.textContent).toBe('width');
    expect(layer?.querySelector('.xml-string')?.textContent).toBe('"1"');
  });

  it('shows plain text without a layer', () => {
    area('{"a": 1}', 'text');
    expect(document.querySelector('.layer')).toBeNull();
  });

  it('follows what is typed', async () => {
    const box = area('<a/>', 'xml');
    await fireEvent.input(box, { target: { value: '<b c="d"/>' } });
    await waitFor(() => {
      expect(document.querySelector('.xml-tag')?.textContent).toBe('b');
    });
  });

  it('gives up colouring a huge text instead of freezing', () => {
    area(`"${'x'.repeat(200_001)}"`, 'json');
    expect(document.querySelector('.layer')).toBeNull();
  });

  it('keeps the layer scrolled with the box', async () => {
    const box = area('<a/>\n'.repeat(100), 'xml');
    box.scrollTop = 120;
    await fireEvent.scroll(box);
    expect(document.querySelector<HTMLElement>('.layer')?.scrollTop).toBe(120);
  });

  it('keeps the text readable to screen readers once, in the box', () => {
    const box = area('<a/>', 'xml');
    expect(box.getAttribute('aria-label')).toBe('Code');
    expect(document.querySelector('.layer')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('CodeArea typing', () => {
  it('closes a brace in JSON with the caret between', async () => {
    const box = area('', 'json');
    expect(await press(box, '{', 0)).toBe(false);
    expect(box.value).toBe('{}');
    await waitFor(() => {
      expect(box.selectionStart).toBe(1);
    });
  });

  it.each([
    ['[', '[]'],
    ['(', '()'],
    ['"', '""'],
  ])('closes %s in JSON', async (key, expected) => {
    const box = area('', 'json');
    await press(box, key, 0);
    expect(box.value).toBe(expected);
  });

  it('closes tag brackets, quotes and parentheses in markup', async () => {
    const box = area('', 'xml');
    await press(box, '<', 0);
    expect(box.value).toBe('<>');
    cleanup();
    const second = area('', 'xml');
    await press(second, "'", 0);
    expect(second.value).toBe("''");
  });

  it('steps over a closer that is already there', async () => {
    const box = area('{}', 'json');
    await press(box, '}', 1);
    expect(box.value).toBe('{}');
    await waitFor(() => {
      expect(box.selectionStart).toBe(2);
    });
  });

  it('indents the new line after a brace', async () => {
    const box = area('{}', 'json');
    await press(box, 'Enter', 1);
    expect(box.value).toBe('{\n  \n}');
  });

  it('leaves plain text alone', async () => {
    const box = area('', 'text');
    expect(await press(box, '{', 0)).toBe(true);
    expect(box.value).toBe('');
  });

  it('does not touch a read-only box', async () => {
    const box = area('', 'json', true);
    expect(await press(box, '{', 0)).toBe(true);
  });

  it('lets shortcuts through', async () => {
    const box = area('', 'json');
    box.focus();
    expect(await fireEvent.keyDown(box, { key: '{', ctrlKey: true })).toBe(true);
    expect(box.value).toBe('');
  });

  it('wraps a selection in the pair', async () => {
    const box = area('abc', 'json');
    await press(box, '"', 0, 3);
    expect(box.value).toBe('"abc"');
  });
});

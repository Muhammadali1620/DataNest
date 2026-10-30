import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { CellValue } from '../../../../../src/shared/cell-value';
import ValuePanel from '../../../../../webview/src/apps/result-grid/ValuePanel.svelte';
import { base64Of, hexOf } from '../../../../helpers/bytes';
import { createTranslator } from '../../../../../webview/src/lib/i18n';

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const hex = hexOf;
const base64 = base64Of;

function panel(
  cell: CellValue | undefined,
  extra: Partial<{
    cellKey: string;
    loadBytes: () => Promise<{ size: number; data?: string | undefined }>;
    onCopy: (text: string) => void;
    onClose: () => void;
  }> = {},
) {
  const props = {
    cell,
    cellKey: 'k1',
    columnName: 'payload',
    dataType: 'json',
    loadBytes: vi.fn(() => Promise.resolve({ size: 0 })),
    onCopy: vi.fn(),
    onClose: vi.fn(),
    t: createTranslator('en'),
    ...extra,
  };
  const view = render(ValuePanel, { props });
  return { ...props, ...view };
}

describe('ValuePanel', () => {
  it('asks to select a cell when none is focused', () => {
    panel(undefined);
    expect(screen.getByTestId('value-empty')).toBeTruthy();
  });

  it('names the column and its type', () => {
    panel('x');
    expect(screen.getByText('payload')).toBeTruthy();
    expect(screen.getByText('json')).toBeTruthy();
  });

  it('shows NULL distinctly from an empty string', () => {
    const { unmount } = panel(null);
    expect(screen.getByTestId('value-null').textContent).toBe('NULL');
    unmount();
    panel('');
    expect(screen.queryByTestId('value-null')).toBeNull();
    expect(screen.getByTestId('value-text').textContent).toBe('');
  });

  it('shows long text whole, with its size', () => {
    const text = `${'line\n'.repeat(999)}end`;
    panel(text);
    expect(screen.getByTestId('value-text').textContent).toBe(text);
    expect(screen.getByTestId('value-meta').textContent).toContain('1000 lines');
  });

  it('formats a JSON column and colours its parts', () => {
    panel({ kind: 'json', text: '{"a":[1,"x",null]}' });
    const text = screen.getByTestId('value-text');
    expect(text.textContent).toBe('{\n  "a": [\n    1,\n    "x",\n    null\n  ]\n}');
    expect(text.querySelector('.key')?.textContent).toBe('"a"');
    expect(text.querySelector('.number')?.textContent).toBe('1');
    expect(text.querySelector('.string')?.textContent).toBe('"x"');
    expect(text.querySelector('.literal')?.textContent).toBe('null');
  });

  it('switches between formatted and raw JSON', async () => {
    panel({ kind: 'json', text: '{"a":1}' });
    expect(screen.getByTestId('value-text').textContent).toContain('\n');
    await fireEvent.click(screen.getByTestId('value-format'));
    expect(screen.getByTestId('value-text').textContent).toBe('{"a":1}');
    await fireEvent.click(screen.getByTestId('value-format'));
    expect(screen.getByTestId('value-text').textContent).toContain('\n');
  });

  it('shows broken JSON as it is, with a warning and no format button', () => {
    panel({ kind: 'json', text: '{"a":' });
    expect(screen.getByTestId('value-text').textContent).toBe('{"a":');
    expect(screen.getByTestId('value-invalid')).toBeTruthy();
    expect(screen.queryByTestId('value-format')).toBeNull();
  });

  it('recognizes JSON in a plain text value', () => {
    panel('{"a":1}');
    expect(screen.getByTestId('value-format')).toBeTruthy();
    expect(screen.getByTestId('value-text').textContent).toContain('\n');
  });

  it('keeps a plain text value without any formatting controls', () => {
    panel('just words');
    expect(screen.queryByTestId('value-format')).toBeNull();
    expect(screen.getByTestId('value-text').textContent).toBe('just words');
  });

  it('copies what is shown', async () => {
    const { onCopy } = panel({ kind: 'json', text: '{"a":1}' });
    await fireEvent.click(screen.getByTestId('value-copy'));
    expect(onCopy).toHaveBeenCalledWith('{\n  "a": 1\n}');
    await fireEvent.click(screen.getByTestId('value-format'));
    await fireEvent.click(screen.getByTestId('value-copy'));
    expect(onCopy).toHaveBeenLastCalledWith('{"a":1}');
  });

  it('closes on request', async () => {
    const { onClose } = panel('x');
    await fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('shows a small binary value from its preview without asking the host', () => {
    const { loadBytes } = panel({ kind: 'binary', size: 3, preview: '414243' });
    expect(screen.getByTestId('value-hex').textContent).toContain('41 42 43');
    expect(screen.getByTestId('value-hex').textContent).toContain('ABC');
    expect(loadBytes).not.toHaveBeenCalled();
  });

  it('fetches the whole bytes of a larger value and dumps them', async () => {
    const all = Array.from({ length: 300 }, (_, i) => i % 256);
    const loadBytes = vi.fn(() => Promise.resolve({ size: 300, data: base64(all) }));
    panel({ kind: 'binary', size: 300, preview: hex(all.slice(0, 256)) }, { loadBytes });
    expect(screen.getByTestId('value-loading')).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByTestId('value-loading')).toBeNull();
    });
    expect(loadBytes).toHaveBeenCalledOnce();
    // 300 bytes → 19 rows; the last offset proves bytes past the preview arrived.
    expect(screen.getByTestId('value-hex').textContent).toContain('00000120');
  });

  it('draws an image from a PNG blob and can switch to hex', async () => {
    const data = [...PNG, 1, 2, 3];
    panel(
      { kind: 'binary', size: 5000, preview: hex(data) },
      {
        loadBytes: vi.fn(() => Promise.resolve({ size: 5000, data: base64(data) })),
      },
    );
    const image = await screen.findByTestId('value-image');
    expect(image.getAttribute('src')).toBe(`data:image/png;base64,${base64(data)}`);
    expect(screen.getByTestId('value-meta').textContent).toContain('image/png');
    await fireEvent.click(screen.getByTestId('value-binary-mode'));
    expect(screen.queryByTestId('value-image')).toBeNull();
    expect(screen.getByTestId('value-hex').textContent).toContain('89 50 4e 47');
  });

  it('draws a tiny image that fits entirely in the preview', async () => {
    panel({ kind: 'binary', size: PNG.length, preview: hex(PNG) });
    const image = await screen.findByTestId('value-image');
    expect(image.getAttribute('src')).toBe(`data:image/png;base64,${base64(PNG)}`);
  });

  it('does not offer an image for bytes that are not one', () => {
    panel({ kind: 'binary', size: 4, preview: '00010203' });
    expect(screen.queryByTestId('value-binary-mode')).toBeNull();
    expect(screen.queryByTestId('value-image')).toBeNull();
  });

  it('says so when the value is too large to be sent', async () => {
    panel(
      { kind: 'binary', size: 40_000_000, preview: '00'.repeat(256) },
      {
        loadBytes: vi.fn(() => Promise.resolve({ size: 40_000_000 })),
      },
    );
    expect(await screen.findByTestId('value-too-large')).toBeTruthy();
    // The preview is still there to look at.
    expect(screen.getByTestId('value-hex').textContent).toContain('00000000');
  });

  it('reports a failed download without breaking the panel', async () => {
    panel(
      { kind: 'binary', size: 5000, preview: '00'.repeat(256) },
      {
        loadBytes: vi.fn(() => Promise.reject(new Error('gone'))),
      },
    );
    expect(await screen.findByTestId('value-failed')).toBeTruthy();
    expect(screen.getByTestId('value-hex')).toBeTruthy();
  });

  it('pages a long hex dump', async () => {
    const all = Array.from({ length: 5000 }, (_, i) => i % 256);
    panel(
      { kind: 'binary', size: 5000, preview: hex(all.slice(0, 256)) },
      {
        loadBytes: vi.fn(() => Promise.resolve({ size: 5000, data: base64(all) })),
      },
    );
    const next = await screen.findByTestId('value-hex-next');
    expect(screen.getByTestId('value-hex-prev').hasAttribute('disabled')).toBe(true);
    // The arrows are named for screen readers, not read out as symbols.
    expect(screen.getByRole('button', { name: 'Next bytes' })).toBe(next);
    expect(screen.getByRole('button', { name: 'Previous bytes' })).toBeTruthy();
    await fireEvent.click(next);
    expect(screen.getByTestId('value-hex').textContent).toContain('00001000');
    expect(next.hasAttribute('disabled')).toBe(true);
  });

  it('copies the bytes it has as hex', async () => {
    const { onCopy } = panel({ kind: 'binary', size: 3, preview: '010203' });
    await fireEvent.click(screen.getByTestId('value-copy'));
    expect(onCopy).toHaveBeenCalledWith('0x010203');
  });

  it('forgets bytes of the previous cell when another one is focused', async () => {
    const first = [...PNG, 1];
    const loadBytes = vi
      .fn<() => Promise<{ size: number; data?: string }>>()
      .mockResolvedValueOnce({ size: 9000, data: base64(first) });
    const { rerender } = panel({ kind: 'binary', size: 9000, preview: hex(first) }, { loadBytes });
    await screen.findByTestId('value-image');
    loadBytes.mockResolvedValueOnce({ size: 9001, data: undefined });
    await rerender({
      cell: { kind: 'binary', size: 9001, preview: '00'.repeat(256) },
      cellKey: 'k2',
    });
    await waitFor(() => {
      expect(screen.queryByTestId('value-image')).toBeNull();
    });
    expect(loadBytes).toHaveBeenCalledTimes(2);
  });

  it('ignores a late answer for a cell that is no longer focused', async () => {
    let release: (value: { size: number; data: string }) => void = () => undefined;
    const slow = new Promise<{ size: number; data: string }>((resolve) => {
      release = resolve;
    });
    const loadBytes = vi
      .fn<() => Promise<{ size: number; data?: string }>>()
      .mockReturnValueOnce(slow)
      .mockResolvedValueOnce({ size: 9001 });
    const { rerender } = panel({ kind: 'binary', size: 9000, preview: hex(PNG) }, { loadBytes });
    await rerender({
      cell: { kind: 'binary', size: 9001, preview: '00'.repeat(256) },
      cellKey: 'k2',
    });
    release({ size: 9000, data: base64(PNG) });
    await Promise.resolve();
    await waitFor(() => {
      expect(screen.queryByTestId('value-image')).toBeNull();
    });
  });

  it('switches from binary to text when another cell is focused', async () => {
    const { rerender } = panel({ kind: 'binary', size: 2, preview: '0102' });
    expect(screen.getByTestId('value-hex')).toBeTruthy();
    await rerender({ cell: 'text now', cellKey: 'k2' });
    expect(screen.queryByTestId('value-hex')).toBeNull();
    expect(screen.getByTestId('value-text').textContent).toBe('text now');
  });
});

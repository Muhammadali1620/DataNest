import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { EditInput } from '../../../../../src/shared/cell-input';
import type { CellValue } from '../../../../../src/shared/cell-value';
import type { EditColumn } from '../../../../../webview/src/apps/result-grid/edit-model';
import RecordPanel from '../../../../../webview/src/apps/result-grid/RecordPanel.svelte';
import { createTranslator } from '../../../../../webview/src/lib/i18n';

const COLUMNS = [
  { name: 'id', dataType: 'int' },
  { name: 'name', dataType: 'varchar(20)' },
  { name: 'active', dataType: 'boolean' },
  { name: 'status', dataType: 'enum' },
  { name: 'total', dataType: 'int' },
];

const EDIT: (EditColumn | null)[] = [
  { dataType: 'int', kind: 'integer', nullable: false },
  { dataType: 'varchar(20)', kind: 'text', nullable: true },
  { dataType: 'boolean', kind: 'boolean', nullable: true },
  { dataType: 'enum', kind: 'enum', nullable: false, options: ['new', 'paid'] },
  null,
];

const CELLS: CellValue[] = [7, 'alice', true, 'new', 100];

type Reply = string | undefined;

function panel(
  extra: Partial<{
    row: number | undefined;
    rowCount: number;
    rowKey: string;
    cells: CellValue[] | undefined;
    editColumns: (EditColumn | null)[] | undefined;
    changeAt: (row: number, column: number) => 'value' | 'default' | undefined;
    stateAt: (row: number) => 'inserted' | 'deleted' | undefined;
    reply: Reply;
  }> = {},
) {
  const onEdit = vi.fn((_row: number, _column: number, _input: EditInput) =>
    Promise.resolve(extra.reply),
  );
  const onStep = vi.fn();
  const onClose = vi.fn();
  const props = {
    row: 1,
    rowCount: 3,
    rowKey: 'k1',
    columns: COLUMNS,
    cells: CELLS,
    editColumns: EDIT,
    changeAt: () => undefined,
    stateAt: () => undefined,
    ...extra,
    onEdit,
    onStep,
    onClose,
    t: createTranslator('en'),
  };
  const view = render(RecordPanel, { props });
  return { ...view, onEdit, onStep, onClose };
}

const field = (name: string): HTMLElement => {
  const found = screen
    .getAllByTestId('record-field')
    .find((item) => item.querySelector('.name')?.textContent.trim().startsWith(name));
  if (found === undefined) {
    throw new Error(`no field ${name}`);
  }
  return found;
};

function inside<T extends HTMLElement>(name: string, selector: string, kind: new () => T): T {
  const found = field(name).querySelector(selector);
  if (!(found instanceof kind)) {
    throw new Error(`no ${selector} in ${name}`);
  }
  return found;
}

describe('RecordPanel', () => {
  it('asks to select a cell when no row is focused', () => {
    panel({ row: undefined });
    expect(screen.getByTestId('record-empty')).toBeTruthy();
  });

  it('shows every column of the row with its type and value', () => {
    panel();
    expect(screen.getAllByTestId('record-field')).toHaveLength(5);
    expect(field('name').textContent).toContain('varchar(20)');
    expect(inside('name', 'textarea', HTMLTextAreaElement).value).toBe('alice');
    expect(inside('id', 'input', HTMLInputElement).value).toBe('7');
    expect(inside('active', 'select', HTMLSelectElement).value).toBe('true');
    expect(inside('status', 'select', HTMLSelectElement).value).toBe('new');
  });

  it('shows a column that cannot be edited as plain text, NULL distinctly', () => {
    panel();
    expect(field('total').querySelector('input, textarea, select')).toBeNull();
    expect(field('total').querySelector('.readonly')?.textContent.trim()).toBe('100');
    panel({ cells: [1, null, null, 'new', null] });
    const nulls = screen
      .getAllByTestId('record-value')
      .filter((item) => item.classList.contains('null'));
    expect(nulls).toHaveLength(1);
    expect(nulls[0]?.textContent.trim()).toBe('NULL');
  });

  it('says which row it shows and steps to its neighbours', async () => {
    const { onStep } = panel();
    expect(screen.getByTestId('record-position').textContent).toBe('row 2 of 3');
    await fireEvent.click(screen.getByTestId('record-previous'));
    await fireEvent.click(screen.getByTestId('record-next'));
    expect(onStep).toHaveBeenNthCalledWith(1, -1);
    expect(onStep).toHaveBeenNthCalledWith(2, 1);
  });

  it('cannot step past the first or last row', () => {
    panel({ row: 0 });
    expect(screen.getByTestId<HTMLButtonElement>('record-previous').disabled).toBe(true);
    panel({ row: 2 });
    expect(screen.getAllByTestId<HTMLButtonElement>('record-next')[1]?.disabled).toBe(true);
  });

  it('sends the typed text on Enter, and only once', async () => {
    const { onEdit } = panel();
    const input = inside('id', 'input', HTMLInputElement);
    await fireEvent.input(input, { target: { value: '8' } });
    await fireEvent.keyDown(input, { key: 'Enter' });
    await fireEvent.blur(input);
    await waitFor(() => {
      expect(onEdit).toHaveBeenCalledWith(1, 0, { kind: 'text', text: '8' });
    });
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it('sends the typed text when the field loses focus', async () => {
    const { onEdit } = panel();
    const area = inside('name', 'textarea', HTMLTextAreaElement);
    await fireEvent.input(area, { target: { value: 'bob' } });
    await fireEvent.blur(area);
    await waitFor(() => {
      expect(onEdit).toHaveBeenCalledWith(1, 1, { kind: 'text', text: 'bob' });
    });
  });

  it('sends nothing when the text did not change', async () => {
    const { onEdit } = panel();
    const area = inside('name', 'textarea', HTMLTextAreaElement);
    await fireEvent.focus(area);
    await fireEvent.blur(area);
    await fireEvent.input(area, { target: { value: 'alice' } });
    await fireEvent.keyDown(area, { key: 'Enter' });
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('keeps Shift+Enter for a new line in a text field', async () => {
    const { onEdit } = panel();
    const area = inside('name', 'textarea', HTMLTextAreaElement);
    await fireEvent.input(area, { target: { value: 'a\nb' } });
    await fireEvent.keyDown(area, { key: 'Enter', shiftKey: true });
    expect(onEdit).not.toHaveBeenCalled();
    await fireEvent.keyDown(area, { key: 'Enter' });
    await waitFor(() => {
      expect(onEdit).toHaveBeenCalledWith(1, 1, { kind: 'text', text: 'a\nb' });
    });
  });

  it('drops the typed text on Escape', async () => {
    const { onEdit } = panel();
    const area = inside('name', 'textarea', HTMLTextAreaElement);
    await fireEvent.input(area, { target: { value: 'zzz' } });
    await fireEvent.keyDown(area, { key: 'Escape' });
    await waitFor(() => {
      expect(area.value).toBe('alice');
    });
    await fireEvent.blur(area);
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('sends a chosen boolean or enum value at once', async () => {
    const { onEdit } = panel();
    await fireEvent.change(inside('active', 'select', HTMLSelectElement), {
      target: { value: 'false' },
    });
    await fireEvent.change(inside('status', 'select', HTMLSelectElement), {
      target: { value: 'paid' },
    });
    await waitFor(() => {
      expect(onEdit).toHaveBeenCalledTimes(2);
    });
    expect(onEdit).toHaveBeenCalledWith(1, 2, { kind: 'text', text: 'false' });
    expect(onEdit).toHaveBeenCalledWith(1, 3, { kind: 'text', text: 'paid' });
  });

  it('sets NULL or DEFAULT from the buttons, and offers NULL only where it is allowed', async () => {
    const { onEdit } = panel();
    expect(field('id').querySelector('[data-testid="record-null"]')).toBeNull();
    await fireEvent.click(inside('name', '[data-testid="record-null"]', HTMLElement));
    await fireEvent.click(inside('name', '[data-testid="record-default"]', HTMLElement));
    expect(onEdit).toHaveBeenNthCalledWith(1, 1, 1, { kind: 'null' });
    expect(onEdit).toHaveBeenNthCalledWith(2, 1, 1, { kind: 'default' });
  });

  it('has nothing to null in a field that already is NULL', () => {
    panel({ cells: [1, null, true, 'new', 1] });
    expect(inside('name', '[data-testid="record-null"]', HTMLButtonElement).disabled).toBe(true);
  });

  it('shows why an edit was refused and keeps the typed text', async () => {
    panel({ reply: 'Enter a whole number' });
    const input = inside('id', 'input', HTMLInputElement);
    await fireEvent.input(input, { target: { value: 'abc' } });
    await fireEvent.keyDown(input, { key: 'Enter' });
    expect((await screen.findByTestId('record-error')).textContent).toBe('Enter a whole number');
    expect(input.value).toBe('abc');
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('marks changed cells and DEFAULT ones', () => {
    panel({
      changeAt: (_row, column) => (column === 1 ? 'value' : column === 3 ? 'default' : undefined),
    });
    expect(field('name').classList.contains('changed')).toBe(true);
    expect(field('status').textContent).toContain('DEFAULT');
    expect(field('id').classList.contains('changed')).toBe(false);
  });

  it('shows a deleted row read-only, with a mark', () => {
    panel({ stateAt: () => 'deleted' });
    expect(screen.getByTestId('record-panel').querySelector('input, textarea, select')).toBeNull();
    expect(screen.getByTestId('record-panel').querySelector('.tag.gone')?.textContent).toBe(
      'deleted',
    );
  });

  it('marks a new row as new', () => {
    panel({ stateAt: () => 'inserted' });
    expect(screen.getByTestId('record-panel').querySelector('.tag.new')?.textContent).toBe('new');
  });

  it('is read-only as a whole when the result is', () => {
    panel({ editColumns: undefined });
    expect(screen.getByTestId('record-panel').querySelector('input, textarea, select')).toBeNull();
    expect(screen.getAllByTestId('record-value')).toHaveLength(5);
  });

  it('starts over when another row is shown', async () => {
    const { rerender } = panel();
    const area = inside('name', 'textarea', HTMLTextAreaElement);
    await fireEvent.input(area, { target: { value: 'half typed' } });
    await rerender({ row: 2, rowKey: 'k2', cells: [8, 'carol', false, 'paid', 5] });
    await waitFor(() => {
      expect(inside('name', 'textarea', HTMLTextAreaElement).value).toBe('carol');
    });
  });

  it('says it is loading while the row has not arrived', () => {
    panel({ cells: undefined });
    expect(screen.getByText('Loading…')).toBeTruthy();
  });

  it('closes on request', async () => {
    const { onClose } = panel();
    await fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

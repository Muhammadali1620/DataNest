import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { TableFilter } from '../../../../../src/shared/table-filter';
import FilterBar from '../../../../../webview/src/apps/result-grid/FilterBar.svelte';
import { createTranslator } from '../../../../../webview/src/lib/i18n';

function bar(extra: { applied?: TableFilter; columns?: string[]; busy?: boolean } = {}) {
  const onApply = vi.fn();
  render(FilterBar, {
    props: {
      columns: ['id', 'name'],
      applied: undefined,
      busy: false,
      onApply,
      t: createTranslator('en'),
      ...extra,
    },
  });
  return { onApply };
}

const apply = (): HTMLButtonElement => screen.getByTestId('filter-apply');

describe('FilterBar', () => {
  it('starts without conditions and with Apply disabled', () => {
    bar();
    expect(screen.queryAllByTestId('filter-row')).toHaveLength(0);
    expect(apply().disabled).toBe(true);
  });

  it('adds a row on the first column and holds back Apply until it has a value', async () => {
    bar();
    await fireEvent.click(screen.getByTestId('filter-add'));
    expect(screen.getAllByTestId('filter-row')).toHaveLength(1);
    expect(screen.getByLabelText<HTMLSelectElement>('Column').value).toBe('id');
    expect(apply().disabled).toBe(true);
    await fireEvent.input(screen.getByLabelText('Value'), { target: { value: '7' } });
    expect(apply().disabled).toBe(false);
  });

  it('sends the filter and a hand-written WHERE', async () => {
    const { onApply } = bar();
    await fireEvent.click(screen.getByTestId('filter-add'));
    await fireEvent.change(screen.getByLabelText('Column'), { target: { value: 'name' } });
    await fireEvent.change(screen.getByLabelText('Condition'), { target: { value: 'contains' } });
    await fireEvent.input(screen.getByLabelText('Value'), { target: { value: 'ann' } });
    await fireEvent.input(screen.getByTestId('filter-where'), { target: { value: 'id > 3' } });
    await fireEvent.click(apply());
    expect(onApply).toHaveBeenCalledWith({
      conditions: [{ column: 'name', operator: 'contains', value: 'ann' }],
      where: 'id > 3',
    });
  });

  it('applies on Enter in the value box', async () => {
    const { onApply } = bar();
    await fireEvent.click(screen.getByTestId('filter-add'));
    const value = screen.getByLabelText('Value');
    await fireEvent.input(value, { target: { value: '1' } });
    await fireEvent.keyDown(value, { key: 'Enter' });
    expect(onApply).toHaveBeenCalledOnce();
  });

  it('does not apply on Enter while a row is incomplete', async () => {
    const { onApply } = bar();
    await fireEvent.click(screen.getByTestId('filter-add'));
    await fireEvent.keyDown(screen.getByLabelText('Value'), { key: 'Enter' });
    expect(onApply).not.toHaveBeenCalled();
  });

  it('hides the value box for a NULL check, which then needs no value', async () => {
    const { onApply } = bar();
    await fireEvent.click(screen.getByTestId('filter-add'));
    await fireEvent.change(screen.getByLabelText('Condition'), { target: { value: 'isNull' } });
    expect(screen.queryByLabelText('Value')).toBeNull();
    await fireEvent.click(apply());
    expect(onApply).toHaveBeenCalledWith({ conditions: [{ column: 'id', operator: 'isNull' }] });
  });

  it('removes a row', async () => {
    bar();
    await fireEvent.click(screen.getByTestId('filter-add'));
    await fireEvent.click(screen.getByRole('button', { name: 'Remove condition' }));
    expect(screen.queryAllByTestId('filter-row')).toHaveLength(0);
  });

  it('shows the applied filter and offers Apply only once it changes', async () => {
    bar({ applied: { conditions: [{ column: 'id', operator: 'eq', value: '1' }] } });
    expect(screen.getByLabelText<HTMLInputElement>('Value').value).toBe('1');
    expect(apply().disabled).toBe(true);
    await fireEvent.input(screen.getByLabelText('Value'), { target: { value: '2' } });
    expect(apply().disabled).toBe(false);
  });

  it('clears the applied filter with null', async () => {
    const { onApply } = bar({
      applied: { conditions: [{ column: 'id', operator: 'eq', value: '1' }] },
    });
    await fireEvent.click(screen.getByTestId('filter-clear'));
    expect(onApply).toHaveBeenCalledWith(null);
    expect(screen.queryAllByTestId('filter-row')).toHaveLength(0);
  });

  it('applies a WHERE alone', async () => {
    const { onApply } = bar();
    await fireEvent.input(screen.getByTestId('filter-where'), { target: { value: 'id = 1' } });
    await fireEvent.click(apply());
    expect(onApply).toHaveBeenCalledWith({ conditions: [], where: 'id = 1' });
  });

  it('cannot clear what is not there, and does nothing while busy', () => {
    bar();
    expect(screen.getByTestId<HTMLButtonElement>('filter-clear').disabled).toBe(true);
  });

  it('does not apply while a request is in flight', async () => {
    const { onApply } = bar({ busy: true });
    await fireEvent.input(screen.getByTestId('filter-where'), { target: { value: 'id = 1' } });
    expect(apply().disabled).toBe(true);
    await fireEvent.keyDown(screen.getByTestId('filter-where'), { key: 'Enter' });
    expect(onApply).not.toHaveBeenCalled();
  });

  it('lets the column be typed when the columns are not known', async () => {
    const { onApply } = bar({ columns: [] });
    await fireEvent.click(screen.getByTestId('filter-add'));
    const column = screen.getByLabelText('Column');
    expect(column.tagName).toBe('INPUT');
    await fireEvent.input(column, { target: { value: 'sku' } });
    await fireEvent.input(screen.getByLabelText('Value'), { target: { value: '9' } });
    await fireEvent.click(apply());
    expect(onApply).toHaveBeenCalledWith({
      conditions: [{ column: 'sku', operator: 'eq', value: '9' }],
    });
  });

  it('keeps a column of the applied filter that the table no longer lists', () => {
    bar({ applied: { conditions: [{ column: 'gone', operator: 'isNull' }] } });
    expect(screen.getByLabelText<HTMLSelectElement>('Column').value).toBe('gone');
  });
});

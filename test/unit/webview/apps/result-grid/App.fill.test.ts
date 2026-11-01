import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { CellValue } from '../../../../../src/shared/cell-value';
import {
  resultGridProtocol,
  type ResultGridProtocol,
  type ResultTab,
} from '../../../../../src/shared/protocols/result-grid';
import { RpcPeer } from '../../../../../src/shared/rpc';
import App from '../../../../../webview/src/apps/result-grid/App.svelte';
import { createTranslator } from '../../../../../webview/src/lib/i18n';
import { createLinkedTransports, flush } from '../../../../helpers/rpc';

type HostPeer = RpcPeer<ResultGridProtocol['host'], ResultGridProtocol['webview']>;

interface FillAnswer {
  ok: boolean;
  changed: number;
  skipped: number;
  error?: 'not-null' | 'invalid-start' | 'too-many-cells' | 'invalid-integer';
}

const TAB: ResultTab = {
  id: 'result-1',
  title: 'SELECT * FROM users',
  statement: 'SELECT * FROM users',
  columns: [{ name: 'id' }, { name: 'name' }, { name: 'age' }],
  rowCount: 4,
  truncated: false,
  durationMs: 3,
  changedCells: 0,
  insertedRows: 0,
  deletedRows: 0,
  revision: 0,
  edit: {
    editable: true,
    columns: [
      { dataType: 'int', kind: 'integer', nullable: false },
      { dataType: 'varchar(20)', kind: 'text', nullable: true },
      { dataType: 'int', kind: 'integer', nullable: true },
    ],
  },
};

const ROWS: CellValue[][] = [
  [1, 'a', 10],
  [2, 'b', 20],
  [3, 'c', 30],
  [4, 'd', 40],
];

async function open(
  tab: ResultTab = TAB,
  answer: FillAnswer = { ok: true, changed: 2, skipped: 0 },
) {
  const transports = createLinkedTransports();
  const host: HostPeer = new RpcPeer({
    local: resultGridProtocol.host,
    remote: resultGridProtocol.webview,
    transport: transports.host,
  });
  const rpc = new RpcPeer({
    local: resultGridProtocol.webview,
    remote: resultGridProtocol.host,
    transport: transports.webview,
  });
  host.handle('rows', ({ resultId, offset, limit }) => ({
    resultId,
    offset,
    rows: ROWS.slice(offset, offset + limit),
    rowCount: ROWS.length,
    changes: [],
    states: [],
  }));
  const fills = vi.fn((_: unknown) => answer);
  const edits = vi.fn((_: unknown) => ({ ok: true }));
  host.handle('fillCells', fills);
  host.handle('editCell', edits);
  render(App, { props: { rpc, t: createTranslator('en') } });
  await flush();
  host.emit('state', { tabs: [tab], activeId: tab.id, running: false });
  await waitFor(() => {
    expect(cells().length).toBeGreaterThan(0);
  });
  return { host, fills, edits };
}

function cells(): HTMLElement[] {
  return screen
    .queryAllByRole('gridcell')
    .filter((item) => item.getAttribute('data-column') !== null);
}

function cell(row: number, column: number): HTMLElement {
  const found = cells().filter((item) => item.getAttribute('data-column') === String(column))[row];
  if (found === undefined) {
    throw new Error(`no cell at ${row},${column}`);
  }
  return found;
}

/** Selects the block between two cells, like a click and a shift-click. */
async function select(from: [number, number], to: [number, number]): Promise<void> {
  await fireEvent.pointerDown(cell(...from), { button: 0 });
  await fireEvent.pointerDown(cell(...to), { button: 0, shiftKey: true });
}

const grid = (): HTMLElement => screen.getByTestId('grid');

describe('filling selected cells (V12.6)', () => {
  it('sets NULL in the whole selection with Delete', async () => {
    const { fills, edits } = await open();
    await select([0, 1], [2, 2]);
    await fireEvent.keyDown(grid(), { key: 'Delete' });
    await waitFor(() => {
      expect(fills).toHaveBeenCalledWith({
        resultId: 'result-1',
        top: 0,
        bottom: 2,
        columns: [1, 2],
        fill: { kind: 'value', input: { kind: 'null' } },
      });
    });
    expect(edits).not.toHaveBeenCalled();
  });

  it('still edits one cell with Delete when only one is selected', async () => {
    const { fills, edits } = await open();
    await fireEvent.pointerDown(cell(1, 1), { button: 0 });
    await fireEvent.keyDown(grid(), { key: 'Delete' });
    await waitFor(() => {
      expect(edits).toHaveBeenCalledTimes(1);
    });
    expect(fills).not.toHaveBeenCalled();
  });

  it('copies the top cell down with Ctrl+D', async () => {
    const { fills } = await open();
    await select([1, 1], [3, 1]);
    await fireEvent.keyDown(grid(), { key: 'd', ctrlKey: true });
    await waitFor(() => {
      expect(fills).toHaveBeenCalledWith({
        resultId: 'result-1',
        top: 1,
        bottom: 3,
        columns: [1],
        fill: { kind: 'down' },
      });
    });
  });

  it('does nothing on Ctrl+D with one row selected', async () => {
    const { fills } = await open();
    await select([1, 0], [1, 2]);
    await fireEvent.keyDown(grid(), { key: 'd', ctrlKey: true });
    await flush();
    expect(fills).not.toHaveBeenCalled();
  });

  it('offers Fill and Fill down in the cell menu', async () => {
    const { fills } = await open();
    await select([0, 1], [1, 1]);
    await fireEvent.contextMenu(cell(1, 1));
    const menu = await screen.findByTestId('context-menu');
    expect(within(menu).getByRole('menuitem', { name: /Fill selection…/u })).toBeTruthy();
    await fireEvent.click(within(menu).getByRole('menuitem', { name: /Fill down/u }));
    await waitFor(() => {
      expect(fills).toHaveBeenCalledWith(expect.objectContaining({ fill: { kind: 'down' } }));
    });
  });

  it('disables Fill down for a selection of one row', async () => {
    await open();
    await fireEvent.pointerDown(cell(0, 1), { button: 0 });
    await fireEvent.contextMenu(cell(0, 1));
    const menu = await screen.findByTestId('context-menu');
    const item = within(menu).getByRole('menuitem', { name: /Fill down/u });
    expect(item.getAttribute('aria-disabled') === 'true' || item.hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('sets NULL on the whole selection from the cell menu', async () => {
    const { fills } = await open();
    await select([0, 1], [1, 2]);
    await fireEvent.contextMenu(cell(1, 2));
    const menu = await screen.findByTestId('context-menu');
    await fireEvent.click(within(menu).getByRole('menuitem', { name: /Set NULL/u }));
    await waitFor(() => {
      expect(fills).toHaveBeenCalledWith(
        expect.objectContaining({
          fill: { kind: 'value', input: { kind: 'null' } },
          columns: [1, 2],
        }),
      );
    });
  });

  it('says why a fill failed under the grid', async () => {
    await open(TAB, { ok: false, changed: 0, skipped: 0, error: 'invalid-integer' });
    await select([0, 0], [1, 0]);
    await fireEvent.keyDown(grid(), { key: 'Delete' });
    const message = await screen.findByTestId('action-error');
    expect(message.textContent).toBe('Enter a whole number');
  });

  it('reports the cells that were skipped', async () => {
    await open(TAB, { ok: true, changed: 2, skipped: 2, error: 'not-null' });
    await select([0, 0], [1, 1]);
    await fireEvent.keyDown(grid(), { key: 'Delete' });
    const message = await screen.findByTestId('action-error');
    expect(message.textContent).toBe(
      '2 cells changed, 2 skipped: This column does not accept NULL',
    );
  });

  it('stays quiet when every cell took the fill', async () => {
    await open();
    await select([0, 1], [1, 1]);
    await fireEvent.keyDown(grid(), { key: 'Delete' });
    await flush();
    expect(screen.queryByTestId('action-error')).toBeNull();
  });

  describe('the dialog', () => {
    async function openDialog(
      from: [number, number],
      to: [number, number],
      tab?: ResultTab,
      answer?: FillAnswer,
    ) {
      const harness = await open(tab, answer);
      await select(from, to);
      await fireEvent.click(screen.getByTestId('fill-open'));
      const dialog = await screen.findByTestId('fill-dialog');
      return { ...harness, dialog };
    }

    it('opens from the edit bar and tells how big the fill is', async () => {
      const { dialog } = await openDialog([0, 1], [2, 2]);
      expect(dialog.textContent).toContain('3 rows × 2 columns');
    });

    it('starts with a series for several rows and with one value for one row', async () => {
      const first = await openDialog([0, 1], [2, 1]);
      expect(within(first.dialog).getByTestId<HTMLSelectElement>('fill-mode').value).toBe('series');
    });

    it('starts with one value for a single row', async () => {
      const { dialog } = await openDialog([1, 0], [1, 2]);
      expect(within(dialog).getByTestId<HTMLSelectElement>('fill-mode').value).toBe('value');
      const down = within(dialog).getByRole('option', { name: 'The top cell, copied down' });
      expect((down as HTMLOptionElement).disabled).toBe(true);
    });

    it('shows the first numbers of the series before it is applied', async () => {
      const { dialog } = await openDialog([0, 1], [3, 1]);
      expect(within(dialog).getByTestId('fill-preview').textContent).toContain('1, 2, 3, 4');
      await fireEvent.input(within(dialog).getByLabelText('Step'), { target: { value: '0.5' } });
      await waitFor(() => {
        expect(within(dialog).getByTestId('fill-preview').textContent).toContain(
          '1.0, 1.5, 2.0, 2.5',
        );
      });
      await fireEvent.input(within(dialog).getByLabelText(/Text around the number/u), {
        target: { value: 'row {n}' },
      });
      await waitFor(() => {
        expect(within(dialog).getByTestId('fill-preview').textContent).toContain(
          'row 1.0, row 1.5',
        );
      });
    });

    it('explains a start that is not a number instead of previewing', async () => {
      const { dialog } = await openDialog([0, 1], [3, 1]);
      await fireEvent.input(within(dialog).getByLabelText('Start'), { target: { value: 'abc' } });
      await waitFor(() => {
        expect(within(dialog).getByTestId('fill-preview').textContent).toContain(
          'The start is not a number',
        );
      });
    });

    it('sends the series and closes when the host takes it', async () => {
      const { dialog, fills } = await openDialog([0, 2], [3, 2]);
      await fireEvent.input(within(dialog).getByLabelText('Start'), { target: { value: '100' } });
      await fireEvent.input(within(dialog).getByLabelText('Step'), { target: { value: '5' } });
      await fireEvent.click(within(dialog).getByTestId('fill-run'));
      await waitFor(() => {
        expect(fills).toHaveBeenCalledWith({
          resultId: 'result-1',
          top: 0,
          bottom: 3,
          columns: [2],
          fill: { kind: 'series', start: '100', step: '5', template: '{n}', pad: 0 },
        });
      });
      await waitFor(() => {
        expect(screen.queryByTestId('fill-dialog')).toBeNull();
      });
    });

    it('sends a date series', async () => {
      const { dialog, fills } = await openDialog([0, 1], [2, 1]);
      await fireEvent.change(within(dialog).getByTestId('fill-mode'), {
        target: { value: 'dates' },
      });
      await fireEvent.input(within(dialog).getByLabelText('Start'), {
        target: { value: '2024-01-31' },
      });
      await fireEvent.change(within(dialog).getByLabelText('Unit'), { target: { value: 'month' } });
      await waitFor(() => {
        expect(within(dialog).getByTestId('fill-preview').textContent).toContain(
          '2024-01-31, 2024-02-29, 2024-03-31',
        );
      });
      await fireEvent.click(within(dialog).getByTestId('fill-run'));
      await waitFor(() => {
        expect(fills).toHaveBeenCalledWith(
          expect.objectContaining({
            fill: { kind: 'dates', start: '2024-01-31', step: 1, unit: 'month' },
          }),
        );
      });
    });

    it('sends one typed value, NULL, the default and the copy of the top cell', async () => {
      const { dialog, fills } = await openDialog([0, 1], [2, 1]);
      const mode = within(dialog).getByTestId('fill-mode');
      await fireEvent.change(mode, { target: { value: 'value' } });
      await fireEvent.input(within(dialog).getByLabelText('Value'), { target: { value: 'x' } });
      await fireEvent.click(within(dialog).getByTestId('fill-run'));
      await waitFor(() => {
        expect(fills).toHaveBeenLastCalledWith(
          expect.objectContaining({ fill: { kind: 'value', input: { kind: 'text', text: 'x' } } }),
        );
      });
    });

    it('sends NULL, the default and a copy down by their modes', async () => {
      for (const [value, fill] of [
        ['null', { kind: 'value', input: { kind: 'null' } }],
        ['default', { kind: 'value', input: { kind: 'default' } }],
        ['down', { kind: 'down' }],
      ] as const) {
        const { dialog, fills } = await openDialog([0, 1], [2, 1]);
        await fireEvent.change(within(dialog).getByTestId('fill-mode'), { target: { value } });
        await fireEvent.click(within(dialog).getByTestId('fill-run'));
        await waitFor(() => {
          expect(fills).toHaveBeenCalledWith(expect.objectContaining({ fill }));
        });
        await waitFor(() => {
          expect(screen.queryByTestId('fill-dialog')).toBeNull();
        });
        document.body.replaceChildren();
      }
    });

    it('stays open and says why when the host refuses', async () => {
      const { dialog } = await openDialog([0, 1], [2, 1], TAB, {
        ok: false,
        changed: 0,
        skipped: 0,
        error: 'too-many-cells',
      });
      await fireEvent.click(within(dialog).getByTestId('fill-run'));
      const problem = await screen.findByTestId('fill-problem');
      expect(problem.textContent).toContain('Too many cells');
      expect(screen.getByTestId('fill-dialog')).toBeTruthy();
    });

    it('closes on Escape without sending anything', async () => {
      const { dialog, fills } = await openDialog([0, 1], [2, 1]);
      await fireEvent.keyDown(dialog, { key: 'Escape' });
      await waitFor(() => {
        expect(screen.queryByTestId('fill-dialog')).toBeNull();
      });
      expect(fills).not.toHaveBeenCalled();
    });

    it('applies on Enter', async () => {
      const { dialog, fills } = await openDialog([0, 1], [2, 1]);
      await fireEvent.keyDown(within(dialog).getByLabelText('Start'), { key: 'Enter' });
      await waitFor(() => {
        expect(fills).toHaveBeenCalledTimes(1);
      });
    });
  });

  it('offers no fill for a result that cannot be edited', async () => {
    const { edit: _edit, ...readOnly } = TAB;
    await open(readOnly);
    await select([0, 1], [2, 1]);
    expect(screen.queryByTestId('fill-open')).toBeNull();
    await fireEvent.keyDown(grid(), { key: 'd', ctrlKey: true });
    await fireEvent.contextMenu(cell(1, 1));
    const menu = await screen.findByTestId('context-menu');
    expect(within(menu).queryByRole('menuitem', { name: /Fill/u })).toBeNull();
  });
});

import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
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
interface EditAnswer {
  ok: boolean;
  error?: 'not-null' | 'invalid-integer' | 'not-editable';
}

const EDITABLE_TAB: ResultTab = {
  id: 'result-1',
  title: 'SELECT * FROM users',
  statement: 'SELECT * FROM users',
  columns: [{ name: 'id' }, { name: 'name' }, { name: 'active' }, { name: 'status' }],
  rowCount: 2,
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
      { dataType: 'boolean', kind: 'boolean', nullable: true },
      { dataType: "enum('new','paid')", kind: 'enum', nullable: false, options: ['new', 'paid'] },
    ],
  },
};

const ROWS: CellValue[][] = [
  [1, 'alice', true, 'new'],
  [2, null, false, 'paid'],
];

interface Served {
  rows: CellValue[][];
  changes: { row: number; column: number; kind: 'value' | 'default' }[];
  states: { row: number; state: 'inserted' | 'deleted' }[];
}

async function open(tab: ResultTab = EDITABLE_TAB, answer: EditAnswer = { ok: true }) {
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
  const served: Served = { rows: ROWS, changes: [], states: [] };
  const rowsHandler = vi.fn(
    ({ resultId, offset, limit }: { resultId: string; offset: number; limit: number }) => ({
      resultId,
      offset,
      rows: served.rows.slice(offset, offset + limit),
      rowCount: served.rows.length,
      changes: served.changes,
      states: served.states,
    }),
  );
  const edits = vi.fn((_: unknown) => answer);
  const rowActions = vi.fn((_: unknown): { ok: boolean; error?: 'row-deleted'; row?: number } => ({
    ok: true,
  }));
  host.handle('rows', rowsHandler);
  host.handle('editCell', edits);
  host.handle('rowAction', rowActions);
  render(App, { props: { rpc, t: createTranslator('en') } });
  await flush();
  host.emit('state', { tabs: [tab], activeId: tab.id, running: false });
  await waitFor(() => {
    expect(cells().length).toBeGreaterThan(0);
  });
  return { host, served, edits, rowActions, rowsHandler, tab };
}

function cells(): HTMLElement[] {
  return screen
    .queryAllByRole('gridcell')
    .filter((item) => item.getAttribute('aria-colindex') !== null);
}

function cell(row: number, column: number): HTMLElement {
  const found = cells().filter((item) => item.getAttribute('aria-colindex') === String(column + 1))[
    row
  ];
  if (found === undefined) {
    throw new Error(`no cell at ${row},${column}`);
  }
  return found;
}

describe('result grid editing', () => {
  it('opens an editor on double-click, filled with the exact value', async () => {
    await open();
    await fireEvent.dblClick(cell(0, 1));
    const input = await screen.findByDisplayValue('alice');
    expect(input.tagName).toBe('INPUT');
  });

  it('sends the typed text on Enter and closes the editor', async () => {
    const { edits } = await open();
    await fireEvent.dblClick(cell(0, 1));
    const input = await screen.findByDisplayValue('alice');
    await fireEvent.input(input, { target: { value: 'bob' } });
    await fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(edits).toHaveBeenCalledWith({
        resultId: 'result-1',
        row: 0,
        column: 1,
        input: { kind: 'text', text: 'bob' },
      });
    });
    await waitFor(() => {
      expect(screen.queryByDisplayValue('bob')).toBeNull();
    });
  });

  it('opens with Enter on the selected cell and sends nothing on Escape', async () => {
    const { edits } = await open();
    await fireEvent.pointerDown(cell(1, 0), { button: 0 });
    await fireEvent.keyDown(screen.getByTestId('grid'), { key: 'Enter' });
    const input = await screen.findByDisplayValue('2');
    await fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByDisplayValue('2')).toBeNull();
    });
    expect(edits).not.toHaveBeenCalled();
  });

  it('keeps the editor open and says why when the host refuses', async () => {
    await open(EDITABLE_TAB, { ok: false, error: 'invalid-integer' });
    await fireEvent.dblClick(cell(0, 0));
    const input = await screen.findByDisplayValue('1');
    await fireEvent.input(input, { target: { value: 'abc' } });
    await fireEvent.keyDown(input, { key: 'Enter' });
    const tip = await screen.findByTestId('edit-error');
    expect(tip.textContent).toBe('Enter a whole number');
    expect(screen.getByDisplayValue('abc')).toBeTruthy();
  });

  it('gives a boolean and an enum a choice instead of free text', async () => {
    await open();
    await fireEvent.dblClick(cell(0, 2));
    const bool = await screen.findByRole('combobox');
    expect([...bool.querySelectorAll('option')].map((option) => option.textContent)).toEqual([
      'true',
      'false',
    ]);
    await fireEvent.keyDown(bool, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('combobox')).toBeNull();
    });
    await fireEvent.dblClick(cell(0, 3));
    const status = await screen.findByRole('combobox');
    expect([...status.querySelectorAll('option')].map((option) => option.textContent)).toEqual([
      'new',
      'paid',
    ]);
  });

  it('sends a chosen value at once', async () => {
    const { edits } = await open();
    await fireEvent.dblClick(cell(0, 3));
    const status = await screen.findByRole('combobox');
    await fireEvent.change(status, { target: { value: 'paid' } });
    await waitFor(() => {
      expect(edits).toHaveBeenCalledWith({
        resultId: 'result-1',
        row: 0,
        column: 3,
        input: { kind: 'text', text: 'paid' },
      });
    });
  });

  it('sets NULL and DEFAULT from the buttons for the focused cell', async () => {
    const { edits } = await open();
    await fireEvent.pointerDown(cell(0, 1), { button: 0 });
    await fireEvent.click(screen.getByRole('button', { name: 'Set NULL' }));
    await waitFor(() => {
      expect(edits).toHaveBeenCalledWith({
        resultId: 'result-1',
        row: 0,
        column: 1,
        input: { kind: 'null' },
      });
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Set DEFAULT' }));
    await waitFor(() => {
      expect(edits).toHaveBeenCalledWith({
        resultId: 'result-1',
        row: 0,
        column: 1,
        input: { kind: 'default' },
      });
    });
  });

  it('disables Set NULL on a column that is NOT NULL', async () => {
    await open();
    await fireEvent.pointerDown(cell(0, 0), { button: 0 });
    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Set NULL' }).disabled).toBe(
        true,
      );
    });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Set DEFAULT' }).disabled).toBe(
      false,
    );
  });

  it('sets NULL with the Delete key', async () => {
    const { edits } = await open();
    await fireEvent.pointerDown(cell(0, 1), { button: 0 });
    await fireEvent.keyDown(screen.getByTestId('grid'), { key: 'Delete' });
    await waitFor(() => {
      expect(edits).toHaveBeenCalledWith({
        resultId: 'result-1',
        row: 0,
        column: 1,
        input: { kind: 'null' },
      });
    });
  });

  it('shows why an action failed', async () => {
    await open(EDITABLE_TAB, { ok: false, error: 'not-null' });
    await fireEvent.pointerDown(cell(0, 1), { button: 0 });
    await fireEvent.click(screen.getByRole('button', { name: 'Set NULL' }));
    const problem = await screen.findByTestId('action-error');
    expect(problem.textContent).toBe('This column does not accept NULL');
  });

  it('highlights a changed cell and labels a DEFAULT', async () => {
    const { host, served, tab } = await open();
    served.rows = [
      [1, 'bob', true, 'new'],
      [2, null, false, 'paid'],
    ];
    served.changes = [
      { row: 0, column: 1, kind: 'value' },
      { row: 1, column: 1, kind: 'default' },
    ];
    host.emit('state', {
      tabs: [{ ...tab, revision: 2, changedCells: 2 }],
      activeId: tab.id,
      running: false,
    });
    await waitFor(() => {
      expect(cell(0, 1).textContent.trim()).toBe('bob');
    });
    expect(cell(0, 1).classList.contains('changed')).toBe(true);
    expect(cell(1, 1).textContent.trim()).toBe('DEFAULT');
    expect(cell(1, 1).classList.contains('defaulted')).toBe(true);
    expect(cell(0, 0).classList.contains('changed')).toBe(false);
    expect(screen.getByTestId('changed-count').textContent.trim()).toBe('2 unsaved changes');
  });

  it('reads the rows again when only the pending changes moved', async () => {
    const { host, rowsHandler, tab } = await open();
    const before = rowsHandler.mock.calls.length;
    host.emit('state', {
      tabs: [{ ...tab, revision: 1, changedCells: 1 }],
      activeId: tab.id,
      running: false,
    });
    await waitFor(() => {
      expect(rowsHandler.mock.calls.length).toBeGreaterThan(before);
    });
  });

  it('is read-only without an editor, buttons or hint for a read-only result', async () => {
    const { edit: _edit, ...rest } = EDITABLE_TAB;
    const { edits } = await open({ ...rest, edit: { editable: false, reason: 'no-key' } });
    await fireEvent.dblClick(cell(0, 1));
    await fireEvent.pointerDown(cell(0, 1), { button: 0 });
    await fireEvent.keyDown(screen.getByTestId('grid'), { key: 'Enter' });
    await fireEvent.keyDown(screen.getByTestId('grid'), { key: 'Delete' });
    await flush();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByTestId('editbar')).toBeNull();
    expect(edits).not.toHaveBeenCalled();
  });

  it('does not edit a computed column', async () => {
    const tab: ResultTab = {
      ...EDITABLE_TAB,
      edit: {
        editable: true,
        columns: [
          { dataType: 'int', kind: 'integer', nullable: false },
          null,
          { dataType: 'blob', kind: 'binary', nullable: true },
          { dataType: 'int', kind: 'integer', nullable: true },
        ],
      },
    };
    await open(tab);
    await fireEvent.dblClick(cell(0, 1));
    await fireEvent.dblClick(cell(0, 2));
    await flush();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  describe('rows', () => {
    it('adds a row with the button, scrolling to the one the host made', async () => {
      const { rowActions } = await open();
      rowActions.mockReturnValueOnce({ ok: true, row: 2 });
      await fireEvent.click(screen.getByRole('button', { name: 'Add row' }));
      await waitFor(() => {
        expect(rowActions).toHaveBeenCalledWith({ resultId: 'result-1', action: 'add', rows: [] });
      });
    });

    it('adds a row with the Insert key', async () => {
      const { rowActions } = await open();
      await fireEvent.keyDown(screen.getByTestId('grid'), { key: 'Insert' });
      await waitFor(() => {
        expect(rowActions).toHaveBeenCalledWith({ resultId: 'result-1', action: 'add', rows: [] });
      });
    });

    it('duplicates and deletes every row the selection touches', async () => {
      const { rowActions } = await open();
      await fireEvent.pointerDown(cell(0, 1), { button: 0 });
      await fireEvent.pointerEnter(cell(1, 2));
      await fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }));
      await waitFor(() => {
        expect(rowActions).toHaveBeenCalledWith({
          resultId: 'result-1',
          action: 'duplicate',
          rows: [0, 1],
        });
      });
      await fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
      await waitFor(() => {
        expect(rowActions).toHaveBeenCalledWith({
          resultId: 'result-1',
          action: 'delete',
          rows: [0, 1],
        });
      });
    });

    it('deletes with Ctrl+Delete, while plain Delete still sets NULL', async () => {
      const { rowActions, edits } = await open();
      await fireEvent.pointerDown(cell(1, 1), { button: 0 });
      await fireEvent.keyDown(screen.getByTestId('grid'), { key: 'Delete', ctrlKey: true });
      await waitFor(() => {
        expect(rowActions).toHaveBeenCalledWith({
          resultId: 'result-1',
          action: 'delete',
          rows: [1],
        });
      });
      expect(edits).not.toHaveBeenCalled();
    });

    it('shows deleted and new rows and offers Restore only for deleted ones', async () => {
      const { host, served, rowActions, tab } = await open();
      served.states = [{ row: 1, state: 'deleted' }];
      host.emit('state', {
        tabs: [{ ...tab, revision: 1, deletedRows: 1 }],
        activeId: tab.id,
        running: false,
      });
      await waitFor(() => {
        expect(screen.getAllByRole('row').some((row) => row.classList.contains('deleted'))).toBe(
          true,
        );
      });
      await fireEvent.pointerDown(cell(0, 0), { button: 0 });
      await waitFor(() => {
        expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Restore' }).disabled).toBe(
          true,
        );
      });
      await fireEvent.pointerDown(cell(1, 0), { button: 0 });
      await waitFor(() => {
        expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Restore' }).disabled).toBe(
          false,
        );
      });
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Delete' }).disabled).toBe(true);
      await fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
      await waitFor(() => {
        expect(rowActions).toHaveBeenCalledWith({
          resultId: 'result-1',
          action: 'restore',
          rows: [1],
        });
      });
    });

    it('grows the grid by the rows waiting to be inserted', async () => {
      const { host, served, tab } = await open();
      served.rows = [...ROWS, [null, null, null, null]];
      served.states = [{ row: 2, state: 'inserted' }];
      host.emit('state', {
        tabs: [{ ...tab, revision: 1, insertedRows: 1 }],
        activeId: tab.id,
        running: false,
      });
      await waitFor(() => {
        expect(
          screen.getAllByRole('row').filter((row) => row.classList.contains('inserted')),
        ).toHaveLength(1);
      });
      expect(screen.getByTestId('grid').getAttribute('aria-rowcount')).toBe('3');
      expect(screen.getByTestId('changed-count').textContent.trim()).toBe('1 unsaved changes');
    });

    it('says why a row action was refused', async () => {
      const { rowActions } = await open();
      rowActions.mockReturnValueOnce({ ok: false, error: 'row-deleted' });
      await fireEvent.click(screen.getByRole('button', { name: 'Add row' }));
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain('marked for deletion');
    });

    it('offers no row actions on a read-only result', async () => {
      const { edit: _edit, ...rest } = EDITABLE_TAB;
      const { rowActions } = await open({ ...rest, edit: { editable: false, reason: 'view' } });
      await fireEvent.keyDown(screen.getByTestId('grid'), { key: 'Insert' });
      await fireEvent.keyDown(screen.getByTestId('grid'), { key: 'Delete', ctrlKey: true });
      await flush();
      expect(screen.queryByRole('button', { name: 'Add row' })).toBeNull();
      expect(rowActions).not.toHaveBeenCalled();
    });
  });
});

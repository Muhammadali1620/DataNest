import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import {
  mongoDocumentsProtocol,
  type MongoDocumentsProtocol,
  type MongoDocumentsState,
} from '../../../../../src/shared/protocols/mongo-documents';
import { RpcPeer } from '../../../../../src/shared/rpc';
import App from '../../../../../webview/src/apps/mongo-documents/App.svelte';
import { createTranslator } from '../../../../../webview/src/lib/i18n';
import { createLinkedTransports, flush } from '../../../../helpers/rpc';

type HostPeer = RpcPeer<MongoDocumentsProtocol['host'], MongoDocumentsProtocol['webview']>;

function state(overrides: Partial<MongoDocumentsState> = {}): MongoDocumentsState {
  return {
    mode: 'collection',
    connectionName: 'Shop',
    database: 'shop',
    collection: 'orders',
    collectionType: 'collection',
    readOnly: false,
    editable: true,
    insertable: true,
    query: { filter: '{ status: "new" }', sort: '', projection: '', limit: 50 },
    skip: 0,
    columns: ['_id', 'status', 'total'],
    rows: [
      {
        index: 0,
        id: '1',
        cells: [
          { text: '1', type: 'int32' },
          { text: 'new', type: 'string' },
          { text: 'NumberDecimal("1.50")', type: 'decimal' },
        ],
        text: '{\n  _id: 1,\n  status: "new"\n}',
        truncated: false,
        size: 40,
      },
      {
        index: 1,
        id: '2',
        cells: [{ text: '2', type: 'int32' }, { text: 'new', type: 'string' }, null],
        text: '{\n  _id: 2,\n  status: "new"\n}',
        truncated: false,
        size: 30,
      },
    ],
    more: true,
    tookMs: 4,
    total: { count: '1234567', exact: true },
    ...overrides,
  };
}

async function open(initial: MongoDocumentsState) {
  const transports = createLinkedTransports();
  const host: HostPeer = new RpcPeer({
    local: mongoDocumentsProtocol.host,
    remote: mongoDocumentsProtocol.webview,
    transport: transports.host,
  });
  const rpc = new RpcPeer({
    local: mongoDocumentsProtocol.webview,
    remote: mongoDocumentsProtocol.host,
    transport: transports.webview,
  });
  const ready = vi.fn();
  host.on('ready', ready);
  render(App, { props: { rpc, t: createTranslator('en') } });
  await flush();
  expect(ready).toHaveBeenCalled();
  host.emit('state', initial);
  await waitFor(() => {
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeNull();
  });
  return host;
}

describe('MongoDB documents page (V7.6)', () => {
  it('shows the collection, the count, the query and a table of the page', async () => {
    await open(state());
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('shop.orders');
    expect(screen.getByTestId('total').textContent).toBe('1 234 567 documents');
    expect(screen.getByLabelText<HTMLInputElement>('Filter').value).toBe('{ status: "new" }');
    expect(screen.getByTestId('range').textContent).toBe('1–2');
    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent.trim())).toEqual([
      '',
      '_id',
      'status',
      'total',
    ]);
    const cells = screen.getAllByRole('cell');
    expect(cells.some((cell) => cell.classList.contains('missing'))).toBe(true);
    expect(cells.find((cell) => cell.textContent === 'NumberDecimal("1.50")')?.className).toContain(
      'number',
    );
  });

  it('runs the query on Enter and on the button', async () => {
    const host = await open(state());
    const run = vi.fn(() => ({}));
    host.handle('run', run);
    await fireEvent.input(screen.getByLabelText('Sort'), { target: { value: '{ _id: -1 }' } });
    await fireEvent.keyDown(screen.getByLabelText('Sort'), { key: 'Enter' });
    await waitFor(() => {
      expect(run).toHaveBeenCalledWith({
        filter: '{ status: "new" }',
        sort: '{ _id: -1 }',
        projection: '',
        limit: 50,
      });
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Find' }));
    await waitFor(() => {
      expect(run).toHaveBeenCalledTimes(2);
    });
  });

  it('sorts by a column header, the other way on the next click', async () => {
    const host = await open(state());
    const run = vi.fn(() => ({}));
    host.handle('run', run);
    await fireEvent.click(screen.getByRole('button', { name: /^status/ }));
    await waitFor(() => {
      expect(run).toHaveBeenLastCalledWith(expect.objectContaining({ sort: '{ status: 1 }' }));
    });
    await fireEvent.click(screen.getByRole('button', { name: /^status/ }));
    await waitFor(() => {
      expect(run).toHaveBeenLastCalledWith(expect.objectContaining({ sort: '{ status: -1 }' }));
    });
  });

  it('shows where a typed box is wrong', async () => {
    await open(
      state({ error: { message: 'Expected ":"', box: 'projection', line: 1, column: 4 } }),
    );
    expect(screen.getByTestId('query-problem').textContent.trim()).toBe(
      'Projection: 1:4 Expected ":"',
    );
    expect(screen.getByLabelText('Projection').getAttribute('aria-invalid')).toBe('true');
  });

  it('pages forward and back from what the host says', async () => {
    const host = await open(state({ skip: 50 }));
    const page = vi.fn(() => ({}));
    host.handle('page', page);
    await fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => {
      expect(page).toHaveBeenCalledTimes(1);
    });
    // One request at a time: the next waits for the page to be idle again.
    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Next page' }).disabled).toBe(
        false,
      );
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    await waitFor(() => {
      expect(page.mock.calls.map((call) => (call as unknown[])[0])).toEqual([
        { skip: 52 },
        { skip: 0 },
      ]);
    });
  });

  it('offers to count when the count is unknown', async () => {
    const host = await open(state({ total: undefined }));
    const count = vi.fn(() => ({}));
    host.handle('count', count);
    await fireEvent.click(screen.getByRole('button', { name: 'Count' }));
    await waitFor(() => {
      expect(count).toHaveBeenCalled();
    });
  });

  it('opens the editor on a double click and saves the text', async () => {
    const host = await open(state());
    host.handle('edit', () => ({ token: '7', text: '{ _id: 1, status: "new" }' }));
    const save = vi.fn(() => ({}));
    host.handle('save', save);
    const [, row] = screen.getAllByRole('row');
    if (row === undefined) {
      throw new Error('no row');
    }
    await fireEvent.dblClick(row);
    const box = await screen.findByLabelText<HTMLTextAreaElement>('Document 1');
    expect(box.value).toBe('{ _id: 1, status: "new" }');
    await fireEvent.input(box, { target: { value: '{ _id: 1, status: "done" }' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(save).toHaveBeenCalledWith({ token: '7', text: '{ _id: 1, status: "done" }' });
    });
    await waitFor(() => {
      expect(screen.queryByLabelText('Document 1')).toBeNull();
    });
  });

  it('keeps the editor open with the problem of a text that does not parse', async () => {
    const host = await open(state());
    host.handle('insert', () => ({
      problem: { message: 'Unexpected "x"', box: 'document', line: 2, column: 3 },
    }));
    await fireEvent.click(screen.getByRole('button', { name: 'Add document…' }));
    const box = await screen.findByLabelText<HTMLTextAreaElement>('New document');
    await fireEvent.input(box, { target: { value: '{\n  x' } });
    await fireEvent.keyDown(box, { key: 's', ctrlKey: true });
    await waitFor(() => {
      expect(screen.getByTestId('editor-problem').textContent).toBe('2:3 Unexpected "x"');
    });
    await fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.queryByLabelText('New document')).toBeNull();
  });

  it('deletes and copies the selected rows', async () => {
    const host = await open(state());
    const remove = vi.fn(() => ({ deleted: 2 }));
    const copy = vi.fn(() => ({}));
    host.handle('delete', remove);
    host.handle('copy', copy);
    await fireEvent.click(screen.getByLabelText('Select 1'));
    await fireEvent.click(screen.getByLabelText('Select 2'));
    await fireEvent.click(screen.getByRole('button', { name: 'Copy (2)' }));
    await waitFor(() => {
      expect(copy).toHaveBeenCalledWith({ rows: [0, 1] });
    });
    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Delete (2)' }).disabled).toBe(
        false,
      );
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Delete (2)' }));
    await waitFor(() => {
      expect(remove).toHaveBeenCalledWith({ rows: [0, 1] });
    });
    expect(copy).toHaveBeenCalledWith({ rows: [0, 1] });
  });

  it('shows the documents as text, each with its actions', async () => {
    const host = await open(state());
    const remove = vi.fn(() => ({ deleted: 1 }));
    host.handle('delete', remove);
    await fireEvent.click(screen.getByRole('tab', { name: 'Text' }));
    expect(screen.getAllByText(/status: "new"/)).toHaveLength(2);
    const second = screen.getAllByRole('button', { name: 'Delete' })[1];
    if (second === undefined) {
      throw new Error('no second document');
    }
    await fireEvent.click(second);
    await waitFor(() => {
      expect(remove).toHaveBeenCalledWith({ rows: [1] });
    });
  });

  it('offers no change on a read-only connection or a view', async () => {
    await open(state({ readOnly: true, editable: false, insertable: false }));
    expect(screen.getByTestId('meta').textContent).toContain('read-only');
    expect(screen.queryByRole('button', { name: 'Add document…' })).toBeNull();
    await fireEvent.click(screen.getByLabelText('Select 1'));
    expect(screen.queryByRole('button', { name: 'Delete (1)' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy (1)' })).toBeTruthy();
  });

  it('says when nothing matches, and shows what failed', async () => {
    const host = await open(state({ rows: [], columns: [], more: false, collectionType: 'view' }));
    expect(screen.getByTestId('empty')).toBeTruthy();
    expect(screen.getByTestId('meta').textContent).toContain('view');
    host.handle('refresh', () => {
      throw new Error('socket closed');
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => {
      expect(screen.getByTestId('error').textContent).toContain('socket closed');
    });
  });

  it('shows the result of a statement without the query bar (V7.7)', async () => {
    await open(
      state({
        mode: 'result',
        statement: 'db.orders.deleteMany({ a: 1 })',
        summary: 'Deleted: 3',
        collection: '',
        readOnly: true,
        editable: false,
        insertable: false,
      }),
    );
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('shop');
    expect(screen.getByTestId('statement').textContent).toBe('db.orders.deleteMany({ a: 1 })');
    expect(screen.getByTestId('summary').textContent).toBe('Deleted: 3');
    expect(screen.queryByLabelText('Filter')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add document…' })).toBeNull();
  });
});

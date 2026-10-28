import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import {
  tableDesignerProtocol,
  type TableDesignerProtocol,
  type TableDesignerState,
} from '../../../../../src/shared/protocols/table-designer';
import { RpcPeer } from '../../../../../src/shared/rpc';
import { newTableDesign, type TableDesign } from '../../../../../src/shared/table-design';
import App from '../../../../../webview/src/apps/table-designer/App.svelte';
import { createTranslator } from '../../../../../webview/src/lib/i18n';
import { createLinkedTransports, flush } from '../../../../helpers/rpc';

type HostPeer = RpcPeer<TableDesignerProtocol['host'], TableDesignerProtocol['webview']>;

function state(overrides: Partial<TableDesignerState> = {}): TableDesignerState {
  return {
    mode: 'create',
    driver: 'mysql',
    scope: 'shop',
    features: { columnComments: true, tableComment: true, types: ['int', 'varchar'] },
    design: newTableDesign('mysql'),
    ...overrides,
  };
}

async function setup(initial: TableDesignerState = state(), lang = 'en') {
  const transports = createLinkedTransports();
  const host: HostPeer = new RpcPeer({
    local: tableDesignerProtocol.host,
    remote: tableDesignerProtocol.webview,
    transport: transports.host,
  });
  const rpc = new RpcPeer({
    local: tableDesignerProtocol.webview,
    remote: tableDesignerProtocol.host,
    transport: transports.webview,
  });
  const previews: TableDesign[] = [];
  const saves: TableDesign[] = [];
  let saveOutcome: 'ran' | 'cancelled' | 'invalid' = 'cancelled';
  host.handle('preview', (design) => {
    previews.push(design);
    return { statements: [`CREATE TABLE ${design.name}`] };
  });
  const askedColumns: string[] = [];
  host.handle('tables', () => ({ tables: ['customers', 'products'] }));
  host.handle('columns', ({ table }) => {
    askedColumns.push(table);
    return { columns: table === 'customers' ? ['id', 'email'] : [] };
  });
  host.handle('save', (design) => {
    saves.push(design);
    return { outcome: saveOutcome };
  });
  const ready = vi.fn();
  const closed = vi.fn();
  host.on('ready', ready);
  host.on('close', closed);
  render(App, { props: { rpc, t: createTranslator(lang), previewDelay: 0 } });
  await flush();
  host.emit('state', initial);
  await waitFor(() => {
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeNull();
  });
  return {
    host,
    ready,
    closed,
    previews,
    saves,
    askedColumns,
    setOutcome: (outcome: typeof saveOutcome) => {
      saveOutcome = outcome;
    },
  };
}

function input(label: string): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>(label);
}

describe('table designer App', () => {
  it('asks for its state and shows the scope in the title', async () => {
    const { ready } = await setup();
    expect(ready).toHaveBeenCalledOnce();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('New table in shop');
  });

  it('shows a plain title for a file database and hides comments it cannot store', async () => {
    await setup(
      state({
        driver: 'sqlite',
        scope: '',
        features: { columnComments: false, tableComment: false, types: [] },
        design: newTableDesign('sqlite'),
      }),
    );
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('New table');
    expect(screen.queryByLabelText('Comment')).toBeNull();
    expect(screen.queryByLabelText('Comment of column id')).toBeNull();
  });

  it('starts with the id column of the state', async () => {
    await setup();
    expect(input('Name of column id').value).toBe('id');
    expect(input('Type of column id').value).toBe('int');
    expect(input('Key of column id').checked).toBe(true);
    expect(input('Auto of column id').checked).toBe(true);
    // A key column is always NOT NULL, so the box is checked and locked.
    expect(input('Not null of column id').checked).toBe(true);
    expect(input('Not null of column id').disabled).toBe(true);
  });

  it('adds, fills, moves and removes columns', async () => {
    await setup();
    await fireEvent.click(screen.getByRole('button', { name: 'Add column' }));
    const name = input('Name of column #2');
    await fireEvent.input(name, { target: { value: 'email' } });
    expect(input('Name of column email').value).toBe('email');
    await fireEvent.click(screen.getByRole('button', { name: 'Move column email up' }));
    const names = screen
      .getAllByLabelText(/^Name of column/)
      .map((element) => (element as HTMLInputElement).value);
    expect(names).toEqual(['email', 'id']);
    await fireEvent.click(screen.getByRole('button', { name: 'Remove column email' }));
    expect(screen.queryByLabelText('Name of column email')).toBeNull();
  });

  it('shows the SQL the host builds for the current design', async () => {
    const { previews } = await setup();
    await fireEvent.input(screen.getByLabelText('Table name'), { target: { value: 'orders' } });
    await fireEvent.click(screen.getByRole('tab', { name: 'SQL' }));
    await waitFor(() => {
      expect(screen.getByTestId('sql').textContent).toBe('CREATE TABLE orders;');
    });
    expect(previews.at(-1)?.name).toBe('orders');
  });

  it('shows problems after the first save attempt and does not save then', async () => {
    const { saves } = await setup();
    expect(screen.queryByText('Enter a table name')).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText('Enter a table name')).toBeTruthy();
    expect(screen.getByTestId('notice').textContent).toBe('Fix the problems first');
    expect(saves).toEqual([]);
  });

  it('shows a duplicate name at once, without waiting for a save', async () => {
    await setup();
    await fireEvent.click(screen.getByRole('button', { name: 'Add column' }));
    await fireEvent.input(input('Name of column #2'), { target: { value: 'ID' } });
    expect(screen.getByText('Another column has this name')).toBeTruthy();
  });

  it('sends the design to save with Ctrl+S', async () => {
    const { saves } = await setup();
    await fireEvent.input(screen.getByLabelText('Table name'), { target: { value: 'orders' } });
    await fireEvent.input(screen.getByLabelText('Comment'), { target: { value: 'all orders' } });
    await fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    await flush();
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({ name: 'orders', comment: 'all orders' });
  });

  it('reports a design the host refused', async () => {
    const harness = await setup();
    harness.setOutcome('invalid');
    await fireEvent.input(screen.getByLabelText('Table name'), { target: { value: 'orders' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(screen.getByTestId('notice').textContent).toBe('Fix the problems first');
    });
  });

  it('closes on Cancel', async () => {
    const { closed } = await setup();
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await flush();
    expect(closed).toHaveBeenCalledOnce();
  });

  it('speaks Russian', async () => {
    await setup(state(), 'ru');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Новая таблица в shop');
    expect(screen.getByRole('button', { name: 'Добавить колонку' })).toBeTruthy();
  });

  it('adds an index over chosen columns in order', async () => {
    const { saves } = await setup();
    await fireEvent.input(screen.getByLabelText('Table name'), { target: { value: 'orders' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Add column' }));
    await fireEvent.input(input('Name of column #2'), { target: { value: 'email' } });
    await fireEvent.click(screen.getByRole('tab', { name: 'Indexes' }));
    expect(screen.getByText('No indexes besides the primary key')).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Add index' }));
    const add = screen.getByLabelText<HTMLSelectElement>('Add to Columns of ix_orders_1');
    await fireEvent.change(add, { target: { value: 'new-2' } });
    await fireEvent.change(screen.getByLabelText('Add to Columns of ix_orders_1'), {
      target: { value: 'new-1' },
    });
    await fireEvent.click(input('Unique of ix_orders_1'));
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await flush();
    expect(saves[0]?.indexes).toEqual([
      { id: 'index-1', name: 'ix_orders_1', columns: ['new-2', 'new-1'], unique: true },
    ]);
  });

  it('removes a column from an index with its chip', async () => {
    await setup();
    await fireEvent.click(screen.getByRole('tab', { name: 'Indexes' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Add index' }));
    await fireEvent.change(screen.getByLabelText('Add to Columns of ix_table_1'), {
      target: { value: 'new-1' },
    });
    await fireEvent.click(
      screen.getByRole('button', { name: 'Remove id from Columns of ix_table_1' }),
    );
    expect(
      screen.queryByRole('button', { name: 'Remove id from Columns of ix_table_1' }),
    ).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Remove index ix_table_1' }));
    expect(screen.getByText('No indexes besides the primary key')).toBeTruthy();
  });

  it('builds a foreign key from the tables and columns the host knows', async () => {
    const { saves, askedColumns } = await setup();
    await fireEvent.input(screen.getByLabelText('Table name'), { target: { value: 'orders' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Add column' }));
    await fireEvent.input(input('Name of column #2'), { target: { value: 'customer_id' } });
    await fireEvent.click(screen.getByRole('tab', { name: 'Foreign keys' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Add foreign key' }));
    await fireEvent.change(screen.getByLabelText('Add to Columns of fk_orders_1'), {
      target: { value: 'new-2' },
    });
    await waitFor(() => {
      expect(
        screen.getByLabelText<HTMLSelectElement>('References table of fk_orders_1').options.length,
      ).toBe(4);
    });
    await fireEvent.change(screen.getByLabelText('References table of fk_orders_1'), {
      target: { value: 'customers' },
    });
    await waitFor(() => {
      expect(askedColumns).toEqual(['customers']);
    });
    await waitFor(() => {
      expect(screen.getByLabelText('Add to Referenced columns of fk_orders_1')).toBeTruthy();
    });
    await fireEvent.change(screen.getByLabelText('Add to Referenced columns of fk_orders_1'), {
      target: { value: 'id' },
    });
    await fireEvent.change(screen.getByLabelText('On delete of fk_orders_1'), {
      target: { value: 'CASCADE' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await flush();
    expect(saves[0]?.foreignKeys).toEqual([
      {
        id: 'key-1',
        name: 'fk_orders_1',
        columns: ['new-2'],
        targetTable: 'customers',
        targetColumns: ['id'],
        onDelete: 'CASCADE',
        onUpdate: 'NO ACTION',
      },
    ]);
  });

  it('lets a key point at the table being designed, with its own columns', async () => {
    const { askedColumns } = await setup();
    await fireEvent.input(screen.getByLabelText('Table name'), { target: { value: 'nodes' } });
    await fireEvent.click(screen.getByRole('tab', { name: 'Foreign keys' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Add foreign key' }));
    const select = screen.getByLabelText<HTMLSelectElement>('References table of fk_nodes_1');
    expect([...select.options].map((option) => option.textContent)).toContain('nodes (this table)');
    await fireEvent.change(select, { target: { value: 'nodes' } });
    const targets = screen.getByLabelText<HTMLSelectElement>(
      'Add to Referenced columns of fk_nodes_1',
    );
    expect([...targets.options].map((option) => option.value)).toEqual(['', 'id']);
    expect(askedColumns).toEqual([]);
  });

  it('shows key problems after a save attempt', async () => {
    await setup();
    await fireEvent.input(screen.getByLabelText('Table name'), { target: { value: 't' } });
    await fireEvent.click(screen.getByRole('tab', { name: 'Foreign keys' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Add foreign key' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText('Pick at least one column, each once')).toBeTruthy();
    expect(screen.getByText('Pick the referenced table')).toBeTruthy();
  });
});

import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import {
  type DesignPreview,
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
    features: {
      columnComments: true,
      tableComment: true,
      types: ['int', 'varchar'],
      reorder: true,
      autoIncrement: true,
      foreignKeys: true,
      uniqueIndexes: true,
    },
    design: newTableDesign('mysql'),
    kept: { indexes: [], columns: [] },
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
  let saveOutcome: 'ran' | 'cancelled' | 'invalid' | 'unchanged' = 'cancelled';
  let previewAnswer: (design: TableDesign) => DesignPreview = (design) => ({
    statements: [`CREATE TABLE ${design.name}`],
    notes: [],
  });
  host.handle('preview', (design) => {
    previews.push(design);
    return previewAnswer(design);
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
    setPreview: (answer: (design: TableDesign) => DesignPreview) => {
      previewAnswer = answer;
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
        features: {
          columnComments: false,
          tableComment: false,
          types: [],
          reorder: true,
          autoIncrement: true,
          foreignKeys: true,
          uniqueIndexes: true,
        },
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

  describe('editing an existing table', () => {
    const existing = (): TableDesignerState =>
      state({
        mode: 'edit',
        driver: 'postgres',
        scope: 'shop.public',
        features: {
          columnComments: true,
          tableComment: true,
          types: [],
          reorder: false,
          autoIncrement: true,
          foreignKeys: true,
          uniqueIndexes: true,
        },
        design: {
          ...newTableDesign('postgres', 'orders'),
          columns: [
            {
              id: 'col-1',
              original: 'id',
              name: 'id',
              type: 'integer',
              length: '',
              nullable: false,
              defaultValue: '',
              autoIncrement: true,
              primaryKey: true,
              comment: '',
            },
            {
              id: 'col-2',
              original: 'note',
              name: 'note',
              type: 'text',
              length: '',
              nullable: true,
              defaultValue: '',
              autoIncrement: false,
              primaryKey: false,
              comment: '',
            },
          ],
        },
        kept: {
          indexes: [{ name: 'ix_lower', description: '(lower(note))' }],
          columns: ['twice'],
        },
      });

    it('names the table in the title and tells what stays as is', async () => {
      await setup(existing());
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
        'Table shop.public.orders',
      );
      expect(screen.getByText('Computed columns, kept as they are: twice')).toBeTruthy();
      expect(
        screen.getByText(
          'Indexes the designer does not edit, kept as they are: ix_lower (lower(note))',
        ),
      ).toBeTruthy();
    });

    it('offers no moving of columns where the database cannot move them', async () => {
      await setup(existing());
      expect(screen.queryByRole('button', { name: /^Move column/ })).toBeNull();
    });

    it('says there are no changes yet, then shows the ALTER with its notes', async () => {
      const harness = await setup(existing());
      harness.setPreview((design) =>
        design.columns.some((column) => column.name === 'remark')
          ? {
              statements: ['ALTER TABLE orders RENAME COLUMN note TO remark'],
              notes: ['order-ignored'],
            }
          : { statements: [], notes: [] },
      );
      await fireEvent.click(screen.getByRole('tab', { name: 'SQL' }));
      await waitFor(() => {
        expect(screen.getByText('No changes yet')).toBeTruthy();
      });
      await fireEvent.click(screen.getByRole('tab', { name: 'Columns' }));
      await fireEvent.input(input('Name of column note'), { target: { value: 'remark' } });
      await fireEvent.click(screen.getByRole('tab', { name: 'SQL' }));
      await waitFor(() => {
        expect(screen.getByTestId('sql').textContent).toBe(
          'ALTER TABLE orders RENAME COLUMN note TO remark;',
        );
      });
      expect(screen.getByRole('note').textContent).toContain('PostgreSQL cannot move columns');
    });

    it('goes back to the stored design with Revert', async () => {
      await setup(existing());
      await fireEvent.input(input('Name of column note'), { target: { value: 'remark' } });
      await fireEvent.click(screen.getByRole('button', { name: 'Revert' }));
      expect(input('Name of column note').value).toBe('note');
    });

    it('says when there is nothing to save', async () => {
      const harness = await setup(existing());
      harness.setOutcome('unchanged');
      await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => {
        expect(screen.getByTestId('notice').textContent).toBe(
          'Nothing to save: the table already looks like this',
        );
      });
    });

    it('shows the rebuild note of SQLite', async () => {
      const harness = await setup(existing());
      harness.setPreview(() => ({ statements: ['BEGIN'], notes: ['rebuild'] }));
      await fireEvent.input(input('Name of column note'), { target: { value: 'x' } });
      await fireEvent.click(screen.getByRole('tab', { name: 'SQL' }));
      await waitFor(() => {
        expect(screen.getByRole('note').textContent).toContain('SQLite rebuilds the table');
      });
    });

    it('takes a fresh state from the host after a save', async () => {
      const harness = await setup(existing());
      await fireEvent.input(input('Name of column note'), { target: { value: 'remark' } });
      const next = existing();
      harness.host.emit('state', {
        ...next,
        design: {
          ...next.design,
          columns: next.design.columns.map((c) =>
            c.id === 'col-2' ? { ...c, name: 'remark', original: 'remark' } : c,
          ),
        },
      });
      await waitFor(() => {
        expect(input('Name of column remark').value).toBe('remark');
      });
      await fireEvent.click(screen.getByRole('button', { name: 'Revert' }));
      expect(input('Name of column remark').value).toBe('remark');
    });
  });
});

describe('table designer App: what the database cannot do (V6.3)', () => {
  const indexed: TableDesign = {
    name: 'hits',
    comment: '',
    columns: [
      {
        id: 'new-1',
        name: 'id',
        type: 'UInt64',
        length: '',
        nullable: false,
        defaultValue: '',
        autoIncrement: false,
        primaryKey: true,
        comment: '',
      },
    ],
    indexes: [{ id: 'i1', name: 'ix_id', columns: ['new-1'], unique: false }],
    foreignKeys: [],
  };

  it('hides foreign keys, auto numbering and unique indexes for ClickHouse', async () => {
    await setup(
      state({
        driver: 'clickhouse',
        scope: 'events',
        features: {
          columnComments: true,
          tableComment: true,
          types: ['UInt64', 'String'],
          reorder: true,
          autoIncrement: false,
          foreignKeys: false,
          uniqueIndexes: false,
        },
        design: indexed,
      }),
    );
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Columns',
      'Indexes',
      'SQL',
    ]);
    expect(screen.queryByLabelText('Auto of column id')).toBeNull();
    expect(screen.queryByText('Auto')).toBeNull();
    await fireEvent.click(screen.getByRole('tab', { name: 'Indexes' }));
    expect(screen.queryByLabelText('Unique of ix_id')).toBeNull();
    expect(screen.queryByText('Unique')).toBeNull();
  });

  it('keeps all three where the database has them', async () => {
    await setup(state({ design: { ...indexed, columns: indexed.columns } }));
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toContain('Foreign keys');
    expect(screen.queryByLabelText('Auto of column id')).not.toBeNull();
    await fireEvent.click(screen.getByRole('tab', { name: 'Indexes' }));
    expect(screen.queryByLabelText('Unique of ix_id')).not.toBeNull();
  });
});

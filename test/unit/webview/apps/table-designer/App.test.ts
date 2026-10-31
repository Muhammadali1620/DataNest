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
import { chooseFromMenu, menuLabels } from '../../../../helpers/webview/menu';
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
      triggers: false,
      checks: false,
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
  const parts = {
    definition: 'CREATE TABLE orders (id int);',
    triggers: ['trg_a', 'trg_b'],
    checks: [{ name: 'ck_pos', expression: 'id > 0' }],
    checkError: undefined as string | undefined,
    triggerCalls: [] as { action: string; name?: string | undefined }[],
    checkCalls: [] as { action: string; name: string; expression?: string | undefined }[],
    textCalls: [] as { action: string; text: string }[],
  };
  host.handle('definition', () => ({ text: parts.definition }));
  host.handle('triggers', () => ({ triggers: [...parts.triggers] }));
  host.handle('triggerAction', (call) => {
    parts.triggerCalls.push(call);
    if (call.action === 'drop') {
      parts.triggers = parts.triggers.filter((name) => name !== call.name);
      return { outcome: 'ran' as const };
    }
    return { outcome: 'opened' as const };
  });
  host.handle('checks', () => ({ checks: parts.checks.map((check) => ({ ...check })) }));
  host.handle('checkAction', (call) => {
    parts.checkCalls.push(call);
    if (parts.checkError !== undefined) {
      return { outcome: 'unsupported' as const, error: parts.checkError };
    }
    if (call.action === 'add') {
      parts.checks.push({ name: call.name, expression: call.expression ?? '' });
    } else {
      parts.checks = parts.checks.filter((check) => check.name !== call.name);
    }
    return { outcome: 'ran' as const };
  });
  host.handle('textAction', (call) => {
    parts.textCalls.push(call);
    return {};
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
    parts,
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
          triggers: false,
          checks: false,
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
    // The add menu is named after the picker and offers the columns not picked yet.
    expect(screen.getByRole('button', { name: 'Add to Columns of ix_orders_1' })).toBe(
      screen.getByTestId('index-columns-index-1'),
    );
    expect(await menuLabels('index-columns-index-1')).toEqual(['id', 'email']);
    await chooseFromMenu('index-columns-index-1', 'email');
    expect(await menuLabels('index-columns-index-1')).toEqual(['id']);
    await chooseFromMenu('index-columns-index-1', 'id');
    // Every column is picked: nothing is left to add.
    expect(screen.queryByTestId('index-columns-index-1')).toBeNull();
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
    await chooseFromMenu('index-columns-index-1', 'id');
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
    await chooseFromMenu('key-columns-key-1', 'customer_id');
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
      expect(
        screen.getByRole('button', { name: 'Add to Referenced columns of fk_orders_1' }),
      ).toBeTruthy();
    });
    expect(await menuLabels('key-targets-key-1')).toEqual(['id', 'email']);
    await chooseFromMenu('key-targets-key-1', 'id');
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
    expect(await menuLabels('key-targets-key-1')).toEqual(['id']);
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

  it('marks the tabs that hold problems once a save was tried (V11)', async () => {
    await setup();
    await fireEvent.input(screen.getByLabelText('Table name'), { target: { value: 't' } });
    await fireEvent.click(screen.getByRole('tab', { name: 'Foreign keys' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Add foreign key' }));
    expect(screen.queryByRole('tab', { name: 'Foreign keys, has problems' })).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('tab', { name: 'Foreign keys, has problems' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Columns' })).toBeTruthy();
    expect(screen.getByText('Problems to fix: 2')).toBeTruthy();
    expect(screen.getByTestId('notice').classList.contains('error')).toBe(true);
  });

  it('moves between tabs with the arrow keys, Home and End (V11)', async () => {
    await setup();
    const columns = screen.getByRole('tab', { name: 'Columns' });
    expect(columns.tabIndex).toBe(0);
    expect(screen.getByRole('tab', { name: 'Indexes' }).tabIndex).toBe(-1);
    await fireEvent.keyDown(columns, { key: 'ArrowRight' });
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Indexes' }));
    });
    expect(screen.getByRole('tab', { name: 'Indexes' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel', { name: 'Indexes' })).toBeTruthy();
    await fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'End' });
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'SQL' }));
    });
    await fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowRight' });
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Columns' }));
    });
    await fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowLeft' });
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'SQL' }));
    });
    await fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Home' });
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Columns' }));
    });
    // Other keys are left to the page.
    await fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'x' });
    expect(screen.getByRole('tab', { name: 'Columns' }).getAttribute('aria-selected')).toBe('true');
  });

  it('opens the keys tab from the keyboard and asks for the tables once (V11)', async () => {
    await setup();
    await fireEvent.keyDown(screen.getByRole('tab', { name: 'Columns' }), { key: 'ArrowLeft' });
    await fireEvent.keyDown(screen.getByRole('tab', { name: 'SQL' }), { key: 'ArrowLeft' });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Add foreign key' })).toBeTruthy();
    });
  });

  it('says when an index has no columns left to pick (V11)', async () => {
    await setup();
    await fireEvent.click(screen.getByRole('button', { name: 'Remove column id' }));
    await fireEvent.click(screen.getByRole('tab', { name: 'Indexes' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Add index' }));
    expect(screen.getByText('No columns to pick')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Add to Columns/ })).toBeNull();
  });

  it('shows how many columns, indexes and keys there are without renaming the tabs (V11)', async () => {
    await setup();
    const counts = screen
      .getAllByRole('tab')
      .map((tab) => tab.querySelector('[data-count]')?.getAttribute('data-count') ?? null);
    expect(counts).toEqual(['1', '0', '0', null]);
    await fireEvent.click(screen.getByRole('button', { name: 'Add column' }));
    expect(
      screen
        .getByRole('tab', { name: 'Columns' })
        .querySelector('[data-count]')
        ?.getAttribute('data-count'),
    ).toBe('2');
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
          triggers: false,
          checks: false,
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
      // Indexes the designer cannot edit are not a text blob any more: they are rows.
      expect(screen.queryByText(/does not edit, kept as they are/)).toBeNull();
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
          triggers: false,
          checks: false,
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

describe('table designer App: the properties tabs', () => {
  const stored = (overrides: Partial<TableDesignerState> = {}): TableDesignerState => {
    const base = state();
    return state({
      mode: 'edit',
      driver: 'postgres',
      scope: 'shop.public',
      features: { ...base.features, triggers: true, checks: true },
      design: { ...newTableDesign('postgres', 'orders') },
      ...overrides,
    });
  };

  it('has no DDL, trigger or check tabs for a new table', async () => {
    await setup();
    const names = screen.getAllByRole('tab').map((tab) => tab.textContent.trim());
    expect(names.some((name) => /DDL|Triggers|Checks/.test(name))).toBe(false);
  });

  it('shows DDL, columns, indexes, keys, triggers, checks and SQL of a stored table', async () => {
    await setup(stored());
    const names = screen.getAllByRole('tab').map((tab) => tab.textContent.trim());
    expect(names.map((name) => name.replace(/\d+$/, ''))).toEqual([
      'DDL',
      'Columns',
      'Indexes',
      'Foreign keys',
      'Triggers',
      'Checks',
      'SQL',
    ]);
  });

  it('puts the number of triggers and checks on their tabs', async () => {
    await setup(stored());
    await waitFor(() => {
      const counts = (name: RegExp): string | null | undefined =>
        screen.getByRole('tab', { name }).querySelector('[data-count]')?.getAttribute('data-count');
      expect(counts(/Triggers/)).toBe('2');
      expect(counts(/Checks/)).toBe('1');
    });
  });

  it('opens on the tab the state names and reads the DDL when shown', async () => {
    await setup(stored({ tab: 'ddl' }));
    await waitFor(() => {
      expect(screen.getByTestId('ddl').textContent).toBe('CREATE TABLE orders (id int);');
    });
  });

  it('copies the DDL and opens it in an editor through the host', async () => {
    const { parts } = await setup(stored({ tab: 'ddl' }));
    await waitFor(() => screen.getByTestId('ddl'));
    await fireEvent.click(screen.getByRole('button', { name: 'Copy DDL' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Open in SQL editor' }));
    await waitFor(() => {
      expect(parts.textCalls).toEqual([
        { action: 'copy', text: 'CREATE TABLE orders (id int);' },
        { action: 'open', text: 'CREATE TABLE orders (id int);' },
      ]);
    });
  });

  it('switches tab when the host asks (the results page opens the checks)', async () => {
    const { host } = await setup(stored());
    host.emit('tab', { tab: 'checks' });
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /Checks/ }).getAttribute('aria-selected')).toBe(
        'true',
      );
    });
    expect(screen.getByText('id > 0')).toBeTruthy();
  });

  it('ignores a request for a tab this table does not have', async () => {
    const { host } = await setup(state());
    host.emit('tab', { tab: 'triggers' });
    await flush();
    expect(screen.getByRole('tab', { name: /Columns/ }).getAttribute('aria-selected')).toBe('true');
  });

  it('lists the triggers and views, edits, starts and drops them', async () => {
    const { parts } = await setup(stored({ tab: 'triggers' }));
    await waitFor(() => screen.getByText('trg_a'));
    await fireEvent.click(screen.getByRole('button', { name: 'Show definition of trigger trg_a' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Edit trigger trg_b' }));
    await fireEvent.click(screen.getByRole('button', { name: 'New trigger' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Drop trigger trg_a' }));
    await waitFor(() => {
      expect(screen.queryByText('trg_a')).toBeNull();
    });
    expect(parts.triggerCalls).toEqual([
      { action: 'view', name: 'trg_a' },
      { action: 'edit', name: 'trg_b' },
      { action: 'new' },
      { action: 'drop', name: 'trg_a' },
    ]);
    expect(screen.getByText('trg_b')).toBeTruthy();
  });

  it('says there are no triggers', async () => {
    const { parts } = await setup(stored());
    parts.triggers = [];
    await fireEvent.click(screen.getByRole('tab', { name: /Triggers/ }));
    await fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => screen.getByText('No triggers'));
  });

  it('adds a check, clears the form and shows the new row', async () => {
    const { parts } = await setup(stored({ tab: 'checks' }));
    await waitFor(() => screen.getByText('id > 0'));
    const add = screen.getByRole('button', { name: 'Add check' });
    expect((add as HTMLButtonElement).disabled).toBe(true);
    await fireEvent.input(input('Name'), { target: { value: 'ck_two' } });
    await fireEvent.input(input('Condition'), { target: { value: 'id < 100' } });
    await fireEvent.click(add);
    await waitFor(() => screen.getByText('id < 100'));
    expect(parts.checkCalls).toEqual([{ action: 'add', name: 'ck_two', expression: 'id < 100' }]);
    expect(input('Name').value).toBe('');
  });

  it('keeps the form and shows the message when the host refuses a check', async () => {
    const { parts } = await setup(stored({ tab: 'checks' }));
    await waitFor(() => screen.getByText('id > 0'));
    parts.checkError = 'Enter the condition of the check';
    await fireEvent.input(input('Name'), { target: { value: 'x' } });
    await fireEvent.input(input('Condition'), { target: { value: 'y' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Add check' }));
    await waitFor(() => screen.getByRole('alert'));
    expect(screen.getByRole('alert').textContent).toContain('Enter the condition of the check');
    expect(input('Name').value).toBe('x');
  });

  it('drops a check', async () => {
    const { parts } = await setup(stored({ tab: 'checks' }));
    await waitFor(() => screen.getByText('id > 0'));
    await fireEvent.click(screen.getByRole('button', { name: 'Drop check ck_pos' }));
    await waitFor(() => {
      expect(screen.queryByText('id > 0')).toBeNull();
    });
    expect(parts.checkCalls).toEqual([{ action: 'drop', name: 'ck_pos' }]);
  });

  it('shows the indexes the designer cannot edit as locked rows, counted on the tab', async () => {
    await setup(
      stored({
        kept: { indexes: [{ name: 'ix_lower', description: '(lower(note))' }], columns: [] },
      }),
    );
    await fireEvent.click(screen.getByRole('tab', { name: /Indexes/ }));
    const block = screen.getByTestId('kept-indexes');
    expect(block.textContent).toContain('ix_lower');
    expect(block.textContent).toContain('(lower(note))');
    expect(
      screen
        .getByRole('tab', { name: /Indexes/ })
        .querySelector('[data-count]')
        ?.getAttribute('data-count'),
    ).toBe('1');
  });

  it('speaks Russian on the new tabs', async () => {
    await setup(stored(), 'ru');
    expect(screen.getByRole('tab', { name: /Триггеры/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Проверки/ })).toBeTruthy();
  });
});

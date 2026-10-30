import { describe, expect, it, vi } from 'vitest';
import { ErDiagramModel } from '../../../../src/vscode/panels/er-diagram-model';
import { cols, schemaMetadata } from '../../../helpers/schema-metadata';

function model(tables = ['a', 'b']) {
  const all = [
    { name: 'a', columns: cols('id') },
    {
      name: 'b',
      columns: cols('id', 'a_id int'),
      foreignKeys: [
        { name: 'b_a', columns: ['a_id'], target: { name: 'a' }, targetColumns: ['id'] },
      ],
    },
    { name: 'c', columns: cols('id') },
  ];
  let current = all.filter((table) => tables.includes(table.name));
  const reader = () => schemaMetadata(current);
  const metadata = vi.fn(() => Promise.resolve(reader()));
  const instance = new ErDiagramModel({
    metadata,
    scope: { database: 'shop' },
    scopeLabel: 'shop',
    connectionName: 'Local',
  });
  return {
    instance,
    metadata,
    setTables: (names: string[]) => {
      current = all.filter((table) => names.includes(table.name));
    },
  };
}

describe('ErDiagramModel', () => {
  it('is empty and not loaded before the first read', () => {
    const { instance } = model();
    expect(instance.loaded).toBe(false);
    expect(instance.state()).toEqual({
      scope: 'shop',
      connection: 'Local',
      tables: [],
      relations: [],
      positions: [],
      details: 'all',
    });
  });

  it('reads the tables and keys of the scope', async () => {
    const { instance } = model();
    const state = await instance.load();
    expect(instance.loaded).toBe(true);
    expect(state.tables.map((table) => table.id)).toEqual(['a', 'b']);
    expect(state.relations).toEqual([
      {
        name: 'b_a',
        from: 'b',
        columns: ['a_id'],
        to: 'a',
        targetColumns: ['id'],
        optional: false,
      },
    ]);
    expect(state.positions).toEqual([]);
  });

  it('remembers where the boxes are and the detail', async () => {
    const { instance } = model();
    await instance.load();
    instance.setPositions([
      { id: 'a', x: 10, y: 20 },
      { id: 'b', x: 300, y: 20 },
    ]);
    instance.setPositions([{ id: 'b', x: 310, y: 40 }]);
    instance.setDetails('keys');
    expect(instance.state().positions).toEqual([
      { id: 'a', x: 10, y: 20 },
      { id: 'b', x: 310, y: 40 },
    ]);
    expect(instance.state().details).toBe('keys');
  });

  it('keeps the places on a refresh that finds the same tables', async () => {
    const { instance, metadata } = model();
    await instance.load();
    instance.setPositions([
      { id: 'a', x: 1, y: 2 },
      { id: 'b', x: 3, y: 4 },
    ]);
    const state = await instance.load();
    expect(metadata).toHaveBeenCalledTimes(2);
    expect(state.positions).toHaveLength(2);
  });

  it('forgets the places when a new table turns up, so the page lays out again', async () => {
    const { instance, setTables } = model();
    await instance.load();
    instance.setPositions([
      { id: 'a', x: 1, y: 2 },
      { id: 'b', x: 3, y: 4 },
    ]);
    setTables(['a', 'b', 'c']);
    expect((await instance.load()).positions).toEqual([]);
  });

  it('drops the places of tables that are gone', async () => {
    const { instance, setTables } = model();
    await instance.load();
    instance.setPositions([
      { id: 'a', x: 1, y: 2 },
      { id: 'b', x: 3, y: 4 },
    ]);
    setTables(['a']);
    expect((await instance.load()).positions).toEqual([{ id: 'a', x: 1, y: 2 }]);
  });

  it('reads only the chosen tables and passes progress on', async () => {
    const metadata = schemaMetadata([
      { name: 'a', columns: cols('id') },
      { name: 'b', columns: cols('id') },
    ]);
    const instance = new ErDiagramModel({
      metadata: () => Promise.resolve(metadata),
      scope: {},
      tables: ['b'],
      scopeLabel: 'app.db',
      connectionName: 'app.db',
    });
    const progress = vi.fn();
    const state = await instance.load({ onProgress: progress });
    expect(state.tables.map((table) => table.id)).toEqual(['b']);
    expect(progress).toHaveBeenCalledWith(1, 1);
  });

  it('finds the table behind a box, but not one of another scope', async () => {
    const { instance } = model(['b']);
    await instance.load();
    expect(instance.tableOf('b')).toEqual({ database: 'shop', name: 'b' });
    const external = instance.state().tables.find((table) => table.external === true);
    expect(external?.label).toBe('a');
    expect(instance.tableOf(external?.id ?? '')).toBeUndefined();
    expect(instance.tableOf('nope')).toBeUndefined();
  });

  it('passes a failed read on and stays unloaded', async () => {
    const instance = new ErDiagramModel({
      metadata: () => Promise.reject(new Error('connection refused')),
      scope: {},
      scopeLabel: 'x',
      connectionName: 'x',
    });
    await expect(instance.load()).rejects.toThrow('connection refused');
    expect(instance.loaded).toBe(false);
  });
});

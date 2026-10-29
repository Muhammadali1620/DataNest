import { describe, expect, it } from 'vitest';
import {
  columnDesignSchema,
  foreignKeyDesignSchema,
  indexDesignSchema,
  tableDesignerProtocol,
  tableDesignSchema,
} from '../../../../src/shared/protocols/table-designer';
import { DESIGN_LIMITS, newTableDesign } from '../../../../src/shared/table-design';

const column = newTableDesign('mysql').columns[0];

describe('tableDesignSchema', () => {
  it('accepts a design as the page sends it', () => {
    const design = newTableDesign('postgres', 'orders');
    expect(tableDesignSchema.parse(design)).toEqual(design);
  });

  it('keeps the original name of an existing column', () => {
    const existing = { ...column, original: 'old_name' };
    expect(columnDesignSchema.parse(existing)).toEqual(existing);
  });

  it('rejects unknown fields, missing ones and wrong types', () => {
    expect(() => columnDesignSchema.parse({ ...column, sql: 'DROP TABLE x' })).toThrow();
    const { nullable: _dropped, ...withoutNullable } = column ?? {};
    expect(() => columnDesignSchema.parse(withoutNullable)).toThrow('nullable');
    expect(() => columnDesignSchema.parse({ ...column, primaryKey: 'yes' })).toThrow();
  });

  it('rejects an empty column id and names over the limit', () => {
    expect(() => columnDesignSchema.parse({ ...column, id: '' })).toThrow();
    expect(() =>
      columnDesignSchema.parse({ ...column, name: 'x'.repeat(DESIGN_LIMITS.name + 1) }),
    ).toThrow();
  });

  it('rejects too many columns', () => {
    const many = Array.from({ length: DESIGN_LIMITS.columns + 1 }, (_, index) => ({
      ...column,
      id: `c${index}`,
    }));
    expect(() => tableDesignSchema.parse({ name: 't', comment: '', columns: many })).toThrow();
  });
});

describe('tableDesignerProtocol', () => {
  it('describes the state the host sends', () => {
    const state = {
      mode: 'create',
      driver: 'sqlite',
      scope: '',
      features: {
        columnComments: false,
        tableComment: false,
        types: ['integer'],
        reorder: true,
        autoIncrement: true,
        foreignKeys: true,
        uniqueIndexes: true,
      },
      design: newTableDesign('sqlite'),
      kept: { indexes: [{ name: 'ix', description: '(lower(a))' }], columns: ['twice'] },
    };
    expect(tableDesignerProtocol.webview.events.state.parse(state)).toEqual(state);
    expect(() =>
      tableDesignerProtocol.webview.events.state.parse({ ...state, driver: 'db2' }),
    ).toThrow();
  });

  it('answers a save with one of the known outcomes only', () => {
    const result = tableDesignerProtocol.host.requests.save.result;
    for (const outcome of ['ran', 'opened', 'cancelled', 'unsupported', 'invalid', 'unchanged']) {
      expect(result.parse({ outcome })).toEqual({ outcome });
    }
    expect(() => result.parse({ outcome: 'maybe' })).toThrow();
  });

  it('answers a preview with statements and an optional error', () => {
    const result = tableDesignerProtocol.host.requests.preview.result;
    expect(result.parse({ statements: ['CREATE TABLE t (id int)'], notes: [] })).toEqual({
      statements: ['CREATE TABLE t (id int)'],
      notes: [],
    });
    expect(result.parse({ statements: [], notes: ['rebuild'], error: 'no' })).toEqual({
      statements: [],
      notes: ['rebuild'],
      error: 'no',
    });
    expect(() => result.parse({ statements: [], notes: ['explode'] })).toThrow();
  });
});

describe('index and key schemas', () => {
  const key = {
    id: 'k1',
    name: 'fk',
    columns: ['c1'],
    targetTable: 'parents',
    targetColumns: ['id'],
    onDelete: 'CASCADE',
    onUpdate: 'NO ACTION',
  };

  it('accepts an index and a key as the page sends them', () => {
    const index = { id: 'i1', name: 'ix', columns: ['c1', 'c2'], unique: true };
    expect(indexDesignSchema.parse(index)).toEqual(index);
    expect(foreignKeyDesignSchema.parse(key)).toEqual(key);
    expect(foreignKeyDesignSchema.parse({ ...key, targetSchema: 'crm' })).toMatchObject({
      targetSchema: 'crm',
    });
  });

  it('rejects an action that is not SQL', () => {
    expect(() => foreignKeyDesignSchema.parse({ ...key, onDelete: 'DROP TABLE x' })).toThrow();
  });

  it('rejects an empty column id inside an index', () => {
    expect(() =>
      indexDesignSchema.parse({ id: 'i', name: 'ix', columns: [''], unique: false }),
    ).toThrow();
  });

  it('describes the lookups of tables and columns', () => {
    const { tables, columns } = tableDesignerProtocol.host.requests;
    expect(tables.result.parse({ tables: ['a', 'b'] })).toEqual({ tables: ['a', 'b'] });
    expect(columns.params.parse({ table: 'a' })).toEqual({ table: 'a' });
    expect(() => columns.params.parse({ table: '' })).toThrow();
  });
});

describe('designer features (V6.3)', () => {
  it('requires the auto numbering, foreign key and unique index flags', () => {
    const state = {
      mode: 'create',
      driver: 'clickhouse',
      scope: 'events',
      features: {
        columnComments: true,
        tableComment: true,
        types: ['UInt64'],
        reorder: true,
        autoIncrement: false,
        foreignKeys: false,
        uniqueIndexes: false,
      },
      design: newTableDesign('clickhouse'),
      kept: { indexes: [], columns: [] },
    };
    expect(tableDesignerProtocol.webview.events.state.parse(state)).toEqual(state);
    for (const flag of ['autoIncrement', 'foreignKeys', 'uniqueIndexes'] as const) {
      const features = Object.fromEntries(
        Object.entries(state.features).filter(([key]) => key !== flag),
      );
      expect(
        () => tableDesignerProtocol.webview.events.state.parse({ ...state, features }),
        flag,
      ).toThrow();
    }
  });
});

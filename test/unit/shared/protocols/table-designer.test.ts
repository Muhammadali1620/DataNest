import { describe, expect, it } from 'vitest';
import {
  columnDesignSchema,
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
      features: { columnComments: false, tableComment: false, types: ['integer'] },
      design: newTableDesign('sqlite'),
    };
    expect(tableDesignerProtocol.webview.events.state.parse(state)).toEqual(state);
    expect(() =>
      tableDesignerProtocol.webview.events.state.parse({ ...state, driver: 'oracle' }),
    ).toThrow();
  });

  it('answers a save with one of the known outcomes only', () => {
    const result = tableDesignerProtocol.host.requests.save.result;
    for (const outcome of ['ran', 'opened', 'cancelled', 'unsupported', 'invalid']) {
      expect(result.parse({ outcome })).toEqual({ outcome });
    }
    expect(() => result.parse({ outcome: 'maybe' })).toThrow();
  });

  it('answers a preview with statements and an optional error', () => {
    const result = tableDesignerProtocol.host.requests.preview.result;
    expect(result.parse({ statements: ['CREATE TABLE t (id int)'] })).toEqual({
      statements: ['CREATE TABLE t (id int)'],
    });
    expect(result.parse({ statements: [], error: 'no' })).toEqual({ statements: [], error: 'no' });
  });
});

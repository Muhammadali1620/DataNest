import { describe, expect, it } from 'vitest';
import { erDiagramProtocol } from '../../../../src/shared/protocols/er-diagram';

const state = {
  scope: 'shop',
  connection: 'Local',
  tables: [
    {
      id: 'orders',
      label: 'orders',
      columns: [
        { name: 'id', dataType: 'int', nullable: false, primaryKey: true, foreignKey: false },
      ],
    },
    { id: '\u0001["x"]', label: 'x.coupons', columns: [], external: true },
  ],
  relations: [
    {
      name: 'k',
      from: 'orders',
      columns: ['id'],
      to: '\u0001["x"]',
      targetColumns: ['id'],
      optional: true,
    },
  ],
  positions: [{ id: 'orders', x: -12.5, y: 40 }],
  details: 'keys',
};

describe('erDiagramProtocol', () => {
  it('accepts the state the host sends', () => {
    expect(erDiagramProtocol.webview.events.state.parse(state)).toEqual(state);
  });

  it('rejects unknown details, fields and positions far off', () => {
    const events = erDiagramProtocol.webview.events;
    expect(() => events.state.parse({ ...state, details: 'everything' })).toThrow();
    expect(() => events.state.parse({ ...state, sql: 'DROP TABLE x' })).toThrow();
    expect(() =>
      events.state.parse({ ...state, positions: [{ id: 'a', x: 1e9, y: 0 }] }),
    ).toThrow();
    expect(() =>
      events.state.parse({ ...state, tables: [{ ...state.tables[1], external: false }] }),
    ).toThrow();
  });

  it('saves only SVG or PNG', () => {
    const save = erDiagramProtocol.host.requests.save.params;
    expect(save.parse({ format: 'png', data: 'iVBOR' })).toEqual({ format: 'png', data: 'iVBOR' });
    expect(() => save.parse({ format: 'pdf', data: '' })).toThrow();
  });

  it('takes the events of the page', () => {
    const events = erDiagramProtocol.host.events;
    expect(events.openTable.parse({ id: 'orders' })).toEqual({ id: 'orders' });
    expect(events.details.parse({ details: 'names' })).toEqual({ details: 'names' });
    expect(() => events.positions.parse({ positions: [{ id: 'a', x: 'left', y: 0 }] })).toThrow();
  });
});

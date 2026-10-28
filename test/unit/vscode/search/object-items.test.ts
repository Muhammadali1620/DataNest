import { describe, expect, it } from 'vitest';
import type { IndexedObject } from '../../../../src/services/object-index';
import {
  compareObjects,
  defaultAction,
  definitionRef,
  objectDescription,
  objectLabel,
} from '../../../../src/vscode/search/object-items';

const table: IndexedObject = {
  connectionId: 'c1',
  database: 'shop',
  kind: 'table',
  name: 'orders',
};

describe('labels', () => {
  it('shows an icon by kind and a routine with its arguments', () => {
    expect(objectLabel(table)).toBe('$(table) orders');
    expect(objectLabel({ ...table, kind: 'function', name: 'f', signature: 'a int' })).toBe(
      '$(symbol-function) f(a int)',
    );
    expect(objectLabel({ ...table, kind: 'event', name: 'e' })).toBe('$(calendar) e');
  });

  it('describes where the object lives', () => {
    expect(objectDescription(table, 'Local')).toBe('Local · shop');
    expect(
      objectDescription({ ...table, schema: 'sales', kind: 'trigger', table: 'orders' }, 'PG'),
    ).toBe('PG · shop.sales · → orders');
    expect(objectDescription({ connectionId: 'c', kind: 'view', name: 'v' }, 'File')).toBe('File');
  });
});

describe('compareObjects', () => {
  it('sorts by name, then connection, kind and place', () => {
    const names = (id: string) => (id === 'c1' ? 'B' : 'A');
    const list: IndexedObject[] = [
      { ...table, name: 'zeta' },
      { ...table, connectionId: 'c1' },
      { ...table, connectionId: 'c2' },
      { ...table, kind: 'view', connectionId: 'c2' },
    ];
    expect(
      [...list]
        .sort((a, b) => compareObjects(a, b, names))
        .map((o) => `${o.name}/${names(o.connectionId)}/${o.kind}`),
    ).toEqual(['orders/A/table', 'orders/A/view', 'orders/B/table', 'zeta/B/table']);
  });
});

describe('actions', () => {
  it('opens tables and views as data', () => {
    expect(defaultAction({ ...table, schema: 'public', kind: 'view', materialized: true })).toEqual(
      {
        kind: 'open-table',
        node: {
          kind: 'table',
          connectionId: 'c1',
          scope: { database: 'shop', schema: 'public' },
          name: 'orders',
          tableKind: 'view',
          materialized: true,
        },
      },
    );
  });

  it('shows the definition of everything else', () => {
    expect(
      defaultAction({
        connectionId: 'c1',
        schema: 's',
        kind: 'trigger',
        name: 't',
        table: 'orders',
      }),
    ).toEqual({
      kind: 'definition',
      object: { schema: 's', kind: 'trigger', name: 't', table: 'orders' },
    });
    expect(definitionRef({ ...table, kind: 'function', name: 'f', signature: '' })).toEqual({
      database: 'shop',
      kind: 'function',
      name: 'f',
      signature: '',
    });
  });
});

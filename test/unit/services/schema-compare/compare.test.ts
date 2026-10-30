import { describe, expect, it } from 'vitest';
import { postgresDialect } from '../../../../src/drivers/postgres/dialect';
import {
  alignDesign,
  compareSchemas,
  type CompareItem,
  scopeName,
} from '../../../../src/services/schema-compare/compare';
import { designFromStructure } from '../../../../src/services/table-structure';
import { snapshot, structure } from '../../../helpers/schema-snapshots';

const context = {
  driver: 'postgres' as const,
  quote: (name: string) => postgresDialect.quoteIdentifier(name),
};
const byName = (items: CompareItem[]) =>
  Object.fromEntries(items.map((item) => [`${item.kind}:${item.name}`, item]));

describe('alignDesign', () => {
  const before = designFromStructure(
    { name: 't' },
    structure(['id int*', 'name varchar(20)?', 'phone text?'], {
      indexes: [{ name: 'ix_name', columns: ['name'], unique: false, primary: false }],
    }),
  ).design;
  const source = designFromStructure(
    { name: 't' },
    structure(['email text?', 'id int*', 'name varchar(50)'], {
      indexes: [
        { name: 'ix_name', columns: ['name', 'email'], unique: false, primary: false },
        { name: 'ix_email', columns: ['email'], unique: true, primary: false },
      ],
    }),
  ).design;
  const after = alignDesign(before, source);

  it('keeps the ids and original names of columns with the same name', () => {
    const id = after.columns.find((column) => column.name === 'id');
    expect(id?.id).toBe(before.columns.find((column) => column.name === 'id')?.id);
    expect(id?.original).toBe('id');
    const email = after.columns.find((column) => column.name === 'email');
    expect(email?.original).toBeUndefined();
    expect(email?.id.startsWith('new-')).toBe(true);
  });

  it('keeps the target column order and puts new columns last', () => {
    expect(after.columns.map((column) => column.name)).toEqual(['id', 'name', 'email']);
  });

  it('matches indexes by name and points their columns at the new ids', () => {
    const named = after.indexes.find((index) => index.name === 'ix_name');
    expect(named?.id).toBe(before.indexes[0]?.id);
    const ids = new Map(after.columns.map((column) => [column.id, column.name]));
    expect(named?.columns.map((id) => ids.get(id))).toEqual(['name', 'email']);
    expect(after.indexes.find((index) => index.name === 'ix_email')?.original).toBeUndefined();
  });
});

describe('compareSchemas', () => {
  const source = snapshot(
    { schema: 'public' },
    {
      customers: structure(['id int*', 'name varchar(50)'], { comment: 'people' }),
      orders: structure(['id int*', 'customer_id int'], {
        foreignKeys: [
          {
            name: 'fk_c',
            columns: ['customer_id'],
            target: { schema: 'public', name: 'customers' },
            targetColumns: ['id'],
          },
        ],
      }),
      notes: structure(['id int*'], { generated: [] }),
      calc: structure(['id int*', 'a int', 'b int'], { generated: ['b'] }),
    },
    [
      {
        ref: { kind: 'view', name: 'v' },
        statements: ['CREATE VIEW public.v AS SELECT * FROM public.orders'],
      },
      {
        ref: { kind: 'function', name: 'f', signature: 'integer' },
        statements: ['CREATE FUNCTION public.f(integer) …'],
      },
      { ref: { kind: 'function', name: 'g' }, hidden: 'hidden from this user' },
    ],
  );
  const target = snapshot(
    { schema: 'staging' },
    {
      customers: structure(['id int*', 'name varchar(50)'], { comment: 'people' }),
      orders: structure(['id int*', 'customer_id int']),
      legacy: structure(['id int*']),
      calc: structure(['id int*', 'a int']),
    },
    [
      {
        ref: { kind: 'view', name: 'v' },
        statements: ['CREATE VIEW staging.v AS\n  SELECT * FROM staging.orders;'],
      },
      {
        ref: { kind: 'function', name: 'f', signature: 'integer' },
        statements: ['CREATE FUNCTION staging.f(integer) other'],
      },
      { ref: { kind: 'function', name: 'g' }, statements: ['CREATE FUNCTION staging.g()'] },
      { ref: { kind: 'trigger', name: 't', table: 'orders' }, statements: ['CREATE TRIGGER t …'] },
    ],
  );
  const items = byName(compareSchemas(source, target, context));

  it('tells new, removed, changed and equal tables apart', () => {
    expect(items['table:customers']?.status).toBe('same');
    expect(items['table:orders']?.status).toBe('changed');
    expect(items['table:notes']?.status).toBe('added');
    expect(items['table:legacy']?.status).toBe('removed');
  });

  it('counts a generated column the designer cannot write as a difference with a note', () => {
    const calc = items['table:calc'];
    expect(calc?.status).toBe('changed');
    expect(calc?.kind === 'table' ? calc.notes : []).toEqual([
      'generated column b is only in the source',
    ]);
  });

  it('compares other objects by definition with the target schema put in', () => {
    const view = items['view:v'];
    expect(view?.status).toBe('same');
    expect(view?.kind === 'view' ? view.source : []).toEqual([
      'CREATE VIEW staging.v AS SELECT * FROM staging.orders',
    ]);
    expect(items['function:f']?.status).toBe('changed');
    expect(items['trigger:t']?.status).toBe('removed');
  });

  it('cannot compare an object whose definition is hidden', () => {
    const hidden = items['function:g'];
    expect(hidden?.status).toBe('same');
    expect(hidden?.kind === 'function' ? hidden.hidden : undefined).toBe('hidden from this user');
  });

  it('points every object at the target schema, for DROP', () => {
    const view = items['view:v'];
    expect(view?.kind === 'view' ? view.ref : undefined).toMatchObject({
      schema: 'staging',
      name: 'v',
    });
  });

  it('names the qualifier of a scope', () => {
    expect(scopeName({ database: 'shop', schema: 'public' })).toBe('public');
    expect(scopeName({ database: 'shop' })).toBe('shop');
    expect(scopeName({})).toBeUndefined();
  });
});

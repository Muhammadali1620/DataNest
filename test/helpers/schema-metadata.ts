// A metadata reader over a little described schema: each table has its own columns
// and foreign keys, unlike FakeMetadata, which answers the same for every table.

import { DbError } from '../../src/core/errors';
import type {
  ColumnInfo,
  ForeignKey,
  ObjectScope,
  TableInfo,
  TableRef,
} from '../../src/core/model/objects';
import type { MetadataReader } from '../../src/drivers/driver';
import { FakeMetadata } from './fake-driver';

export interface FakeTable {
  readonly name: string;
  readonly kind?: TableInfo['kind'];
  readonly columns: readonly ColumnInfo[];
  readonly foreignKeys?: readonly ForeignKey[];
  /** Where the table lives; the reader's default scope when absent. */
  readonly scope?: ObjectScope;
}

/** `id int` primary key, then the other columns as `name type` and `?` for nullable. */
export function cols(...specs: string[]): ColumnInfo[] {
  return specs.map((spec, index) => {
    const [name = '', type = 'int'] = spec.replace(/\?$/u, '').split(' ');
    return {
      name,
      dataType: type,
      nullable: spec.endsWith('?'),
      primaryKey: index === 0 && name === 'id',
    };
  });
}

export function schemaMetadata(tables: readonly FakeTable[]): MetadataReader & {
  readonly calls: string[];
} {
  const base = new FakeMetadata();
  const calls: string[] = [];
  const key = (scope: ObjectScope): string => `${scope.database ?? ''}/${scope.schema ?? ''}`;
  const find = (table: TableRef): FakeTable => {
    const found = tables.find(
      (candidate) =>
        candidate.name === table.name &&
        (candidate.scope === undefined || key(candidate.scope) === key(table)),
    );
    if (found === undefined) {
      throw new DbError('not-found', `${table.name} does not exist`);
    }
    return found;
  };
  return Object.assign(base, {
    calls,
    listTables: async (scope: ObjectScope): Promise<TableInfo[]> => {
      calls.push(`listTables:${key(scope)}`);
      return await Promise.resolve(
        tables
          .filter((table) => table.scope === undefined || key(table.scope) === key(scope))
          .map((table) => ({ name: table.name, kind: table.kind ?? 'table' })),
      );
    },
    listColumns: async (table: TableRef): Promise<ColumnInfo[]> => {
      calls.push(`listColumns:${table.name}`);
      return await Promise.resolve([...find(table).columns]);
    },
    listForeignKeys: async (table: TableRef): Promise<ForeignKey[]> => {
      calls.push(`listForeignKeys:${table.name}`);
      return await Promise.resolve([...(find(table).foreignKeys ?? [])]);
    },
  });
}

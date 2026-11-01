import { DbError } from '../../core/errors';
import type {
  ColumnInfo,
  ForeignKey,
  IndexInfo,
  ListedObjectKind,
  ObjectInfo,
  ObjectRef,
  ObjectScope,
  TableInfo,
  TableRef,
  TableStructure,
} from '../../core/model/objects';
import { msg } from '../../core/user-message';
import type { CellValue } from '../../shared/cell-value';
import type { MetadataReader, TableDump, TypeDump } from '../driver';
import { fromHttpStatus } from './errors';
import { readText, send } from './http';
import type { InfluxSettings } from './session';

/** A string literal of Flux: `\` and `"` escaped, and `${` (an interpolation) too. */
export function fluxString(text: string): string {
  return `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('${', '\\${')}"`;
}

/** Where the schema functions look: the whole history, not just the last 30 days they default to. */
const FROM_THE_START = 'start: 1970-01-01T00:00:00Z';

const SCHEMA = 'import "influxdata/influxdb/schema"\n';

/** What the metadata reader needs of the session: a Flux query and the HTTP calls. */
export interface FluxQuery {
  queryRows(flux: string): Promise<CellValue[][]>;
}

interface BucketsPage {
  readonly buckets?: readonly { readonly name?: unknown; readonly type?: unknown }[];
}

/**
 * Structure for the tree: buckets are the databases, measurements the tables, and the
 * columns are `time`, the tag keys and the field keys. All of it comes from Flux's `schema`
 * package, which needs no database mapping and no write access.
 */
export class InfluxMetadata implements MetadataReader {
  constructor(
    private readonly session: FluxQuery,
    private readonly settings: InfluxSettings,
    private readonly agent: Parameters<typeof send>[1],
  ) {}

  async listDatabases(): Promise<string[]> {
    const names: string[] = [];
    const { target, org } = this.settings;
    for (let offset = 0; offset < 10_000; offset += 100) {
      const response = await send(target, this.agent, {
        method: 'GET',
        path: '/api/v2/buckets',
        query: {
          limit: '100',
          offset: String(offset),
          ...(org === '' ? {} : { org }),
        },
      });
      const body = await readText(response.body);
      if (response.status >= 400) {
        throw fromHttpStatus(response.status, body);
      }
      const page = (JSON.parse(body) as BucketsPage).buckets ?? [];
      for (const bucket of page) {
        if (typeof bucket.name === 'string') {
          names.push(bucket.name);
        }
      }
      if (page.length < 100) {
        break;
      }
    }
    return names.sort((a, b) => a.localeCompare(b));
  }

  listSchemas(): Promise<string[]> {
    return Promise.resolve([]);
  }

  async listTables(scope: ObjectScope): Promise<TableInfo[]> {
    const bucket = this.bucketOf(scope);
    const rows = await this.session.queryRows(
      `${SCHEMA}schema.measurements(bucket: ${fluxString(bucket)})`,
    );
    return texts(rows)
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({ name, kind: 'table' as const }));
  }

  async listColumns(table: TableRef): Promise<ColumnInfo[]> {
    const bucket = this.bucketOf(table);
    const [tags, fields] = await Promise.all([
      this.session.queryRows(
        `${SCHEMA}schema.measurementTagKeys(bucket: ${fluxString(bucket)}, measurement: ${fluxString(table.name)}, ${FROM_THE_START})`,
      ),
      this.session.queryRows(
        `${SCHEMA}schema.measurementFieldKeys(bucket: ${fluxString(bucket)}, measurement: ${fluxString(table.name)}, ${FROM_THE_START})`,
      ),
    ]);
    const column = (name: string, dataType: string, primaryKey = false): ColumnInfo => ({
      name,
      dataType,
      nullable: !primaryKey,
      primaryKey,
    });
    return [
      column('time', 'dateTime', true),
      // Tags the server keeps for itself (`_measurement`, `_field`, …) are not data.
      ...texts(tags)
        .filter((name) => !name.startsWith('_'))
        .sort((a, b) => a.localeCompare(b))
        .map((name) => column(name, 'tag')),
      ...texts(fields)
        .sort((a, b) => a.localeCompare(b))
        .map((name) => column(name, 'field')),
    ];
  }

  listUniqueKeys(): Promise<string[][]> {
    return Promise.resolve([]);
  }

  listForeignKeys(): Promise<ForeignKey[]> {
    return Promise.resolve([]);
  }

  listObjects(_scope: ObjectScope, _kind: ListedObjectKind): Promise<ObjectInfo[]> {
    return Promise.resolve([]);
  }

  listIndexes(): Promise<IndexInfo[]> {
    return Promise.resolve([]);
  }

  async describeTable(table: TableRef): Promise<TableStructure> {
    const columns = await this.listColumns(table);
    return {
      columns: columns.map((column) => ({
        name: column.name,
        dataType: column.dataType,
        nullable: column.nullable,
        autoIncrement: false,
        generated: false,
      })),
      // Points are never edited in place, so nothing here identifies a row for an UPDATE.
      primaryKey: [],
      indexes: [],
      foreignKeys: [],
    };
  }

  getDefinition(_object: ObjectRef): Promise<string[]> {
    return Promise.reject(
      new DbError(
        'unsupported',
        msg('A measurement has no definition to show: it exists as points'),
      ),
    );
  }

  getTableDump(_table: TableRef): Promise<TableDump> {
    return Promise.reject(new DbError('unsupported', msg('Measurements cannot be dumped as SQL')));
  }

  listTypeDumps(): Promise<TypeDump[]> {
    return Promise.resolve([]);
  }

  /** The bucket a scope names, else the one the connection opened. */
  private bucketOf(scope: ObjectScope): string {
    const bucket = scope.database ?? this.settings.database;
    if (bucket === undefined || bucket === '') {
      throw new DbError('not-found', msg('Pick a bucket first'));
    }
    return bucket;
  }
}

/** The text of the first cell of each row, without blanks. */
function texts(rows: readonly (readonly CellValue[])[]): string[] {
  const names: string[] = [];
  for (const row of rows) {
    const cell = row.at(-1);
    if (typeof cell === 'string' && cell !== '') {
      names.push(cell);
    }
  }
  return [...new Set(names)];
}

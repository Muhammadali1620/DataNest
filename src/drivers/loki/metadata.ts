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
import type { MetadataReader, TableDump, TypeDump } from '../driver';
import type { LokiApi } from './api';
import { nowNs, parseDuration, NS_PER_MS } from './time';

/** The most values of one label the tree lists: a label with more (ids, addresses) is cut. */
export const MAX_LABEL_VALUES = 500;

/** The tree looks at least this far back, so a quiet stream is not missing from it. */
const TREE_RANGE_MS = 24 * 3_600_000;

/**
 * Structure for the tree. Loki has labels and their values, nothing like tables: a label is
 * listed as a table (the streams that have it), and the values of the label are its columns.
 * A double click on a value opens the stream `{label="value"}` in an editor.
 */
export class LokiMetadata implements MetadataReader {
  constructor(
    private readonly api: LokiApi,
    private readonly range: () => string,
  ) {}

  listDatabases(): Promise<string[]> {
    return Promise.resolve([]);
  }

  listSchemas(): Promise<string[]> {
    return Promise.resolve([]);
  }

  async listTables(_scope: ObjectScope): Promise<TableInfo[]> {
    const labels = await this.api.list('/loki/api/v1/labels', this.window());
    return [...new Set(labels)]
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({ name, kind: 'table' as const }));
  }

  async listColumns(table: TableRef): Promise<ColumnInfo[]> {
    const values = await this.api.list(
      `/loki/api/v1/label/${encodeURIComponent(table.name)}/values`,
      this.window(),
    );
    return [...new Set(values)]
      .filter((value) => value !== '')
      .sort((a, b) => a.localeCompare(b))
      .slice(0, MAX_LABEL_VALUES)
      .map((name) => ({ name, dataType: 'value', nullable: false, primaryKey: false }));
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

  /** The columns of the log lines a label opens as a table: they are the same for every label. */
  describeTable(_table: TableRef): Promise<TableStructure> {
    const column = (name: string, dataType: string) => ({
      name,
      dataType,
      nullable: false,
      autoIncrement: false,
      generated: false,
    });
    return Promise.resolve({
      columns: [
        column('time', 'datetime'),
        column('ns', 'bigint'),
        column('labels', 'json'),
        column('line', 'text'),
      ],
      // A line has no key a row could be found by again.
      primaryKey: [],
      indexes: [],
      foreignKeys: [],
    });
  }

  getDefinition(_object: ObjectRef): Promise<string[]> {
    return Promise.reject(
      new DbError('unsupported', msg('A label has no definition to show: it exists as log lines')),
    );
  }

  getTableDump(_table: TableRef): Promise<TableDump> {
    return Promise.reject(new DbError('unsupported', msg('Labels cannot be dumped as SQL')));
  }

  listTypeDumps(): Promise<TypeDump[]> {
    return Promise.resolve([]);
  }

  /** The time window of the tree's calls: the session's range, but a day at least. */
  private window(): Record<string, string> {
    const end = nowNs(new Date());
    const asked = parseDuration(this.range()) ?? TREE_RANGE_MS;
    const back = BigInt(Math.max(asked, TREE_RANGE_MS)) * NS_PER_MS;
    return { start: String(end - back), end: String(end) };
  }
}

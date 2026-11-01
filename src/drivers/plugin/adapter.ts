// Turns a driver that another extension registered (src/api/types.ts, V12.7) into a driver
// of our own. The plugin writes a small contract; the rest of DataNest — dialect, metadata
// reader, capabilities — is filled in here, with plain SQL defaults. Everything a plugin
// returns is checked on the way in: it is code we did not write, and the grid must not
// meet a value or an event it does not know.

import type {
  PluginCell,
  PluginColumnInfo,
  PluginDriver,
  PluginEvent,
  PluginSession,
  PluginTable,
} from '../../api/types';
import { DbError, type DbErrorCode, errorMessage } from '../../core/errors';
import type {
  ColumnInfo,
  ObjectScope,
  TableInfo,
  TableRef,
  TableStructure,
} from '../../core/model/objects';
import { msg } from '../../core/user-message';
import type { CellValue } from '../../shared/cell-value';
import { isTaggedValue } from '../../shared/cell-value';
import { isPluginId, type ResolvedConnectionConfig } from '../../shared/connection';
import type { DesignerFeatures, TableBackground, TableDesign } from '../../shared/table-design';
import type {
  AlterPlan,
  Dialect,
  Driver,
  DumpDialect,
  ExecuteEvent,
  ExecuteOptions,
  MetadataReader,
  ReplacePlan,
  SchemaDdl,
  Session,
} from '../driver';
import { STANDARD_TRANSACTION } from '../common/transaction';
import { binaryValue, safeIntOrTag } from '../common/values';

/** Most columns a plugin may report for one result; the grid has a limit of its own. */
const MAX_COLUMNS = 10_000;

const ERROR_CODES: ReadonlySet<string> = new Set<DbErrorCode>([
  'connection-failed',
  'auth-failed',
  'timeout',
  'cancelled',
  'busy',
  'syntax',
  'constraint',
  'permission-denied',
  'not-found',
  'unsupported',
  'internal',
]);

/** A DbError for whatever a plugin threw; a `code` and a `position` it set are honoured. */
export function pluginError(error: unknown): DbError {
  if (error instanceof DbError) {
    return error;
  }
  const code = (error as { code?: unknown } | null)?.code;
  const position = (error as { position?: unknown } | null)?.position;
  return new DbError(
    typeof code === 'string' && ERROR_CODES.has(code) ? (code as DbErrorCode) : 'internal',
    errorMessage(error),
    {
      cause: error,
      ...(typeof position === 'number' && Number.isInteger(position) && position >= 0
        ? { position }
        : {}),
    },
  );
}

/** One cell of a plugin as a value of the grid. Never throws. */
export function normalizeCell(value: unknown): CellValue {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'bigint') {
    return safeIntOrTag(value.toString());
  }
  if (typeof value !== 'object') {
    // Functions and symbols have no value to show.
    return null;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : { kind: 'datetime', text: value.toISOString() };
  }
  if (value instanceof Uint8Array) {
    return binaryValue(value);
  }
  const tagged = value as { kind?: unknown; text?: unknown; size?: unknown; preview?: unknown };
  // A plugin may hand over the grid's own kinds directly, e.g. an exact decimal.
  if (
    typeof tagged.text === 'string' &&
    (tagged.kind === 'bigint' ||
      tagged.kind === 'decimal' ||
      tagged.kind === 'datetime' ||
      tagged.kind === 'json')
  ) {
    return { kind: tagged.kind, text: tagged.text };
  }
  if (
    tagged.kind === 'binary' &&
    typeof tagged.size === 'number' &&
    Number.isInteger(tagged.size) &&
    typeof tagged.preview === 'string'
  ) {
    return { kind: 'binary', size: tagged.size, preview: tagged.preview };
  }
  try {
    const text = JSON.stringify(value, (_key, inner: unknown) =>
      typeof inner === 'bigint' ? inner.toString() : inner,
    ) as string | undefined;
    return { kind: 'json', text: text ?? 'null' };
  } catch {
    return { kind: 'json', text: '[unserializable]' };
  }
}

/** A row of exactly `width` cells, whatever the plugin sent. */
function normalizeRow(row: unknown, width: number | undefined): CellValue[] {
  if (!Array.isArray(row)) {
    throw new DbError('internal', msg('The driver sent a row that is not a list'));
  }
  const cells = (row as PluginCell[]).map(normalizeCell);
  if (width === undefined || cells.length === width) {
    return cells;
  }
  return cells.length > width
    ? cells.slice(0, width)
    : [...cells, ...Array.from({ length: width - cells.length }, () => null)];
}

class PluginSessionAdapter implements Session {
  readonly metadata: MetadataReader;
  private closed = false;

  constructor(private readonly inner: PluginSession) {
    this.metadata = new PluginMetadataAdapter(inner);
  }

  async *execute(sql: string, options: ExecuteOptions = {}): AsyncIterable<ExecuteEvent> {
    const limit = options.rowLimit;
    let width: number | undefined;
    let sent = 0;
    try {
      const events = this.inner.execute(sql, limit === undefined ? undefined : { rowLimit: limit });
      for await (const event of events) {
        const checked = checkEvent(event);
        if (checked.kind === 'columns') {
          width = checked.columns.length;
          yield checked;
        } else if (checked.kind === 'rows') {
          const room = limit === undefined ? Infinity : limit - sent;
          if (room <= 0) {
            break;
          }
          const rows = checked.rows.slice(0, room).map((row) => normalizeRow(row, width));
          sent += rows.length;
          if (rows.length > 0) {
            yield { kind: 'rows', rows };
          }
          if (sent >= (limit ?? Infinity)) {
            break;
          }
        } else {
          yield checked;
          return;
        }
      }
    } catch (error) {
      throw pluginError(error);
    }
    // The plugin forgot `done`, or the limit cut it short.
    yield { kind: 'done' };
  }

  async cancel(): Promise<void> {
    if (this.inner.cancel === undefined || this.closed) {
      return;
    }
    try {
      await this.inner.cancel();
    } catch {
      // A cancel that fails leaves the statement running; the caller waits for it as before.
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      await this.inner.close();
    } catch {
      // The connection is gone either way.
    }
  }
}

/** Validates one event; rows are normalised by the caller, which knows the width. */
function checkEvent(
  event: PluginEvent,
): ExecuteEvent | { readonly kind: 'rows'; readonly rows: readonly unknown[] } {
  const kind = (event as { kind?: unknown } | null)?.kind;
  if (kind === 'columns') {
    const columns = (event as { columns?: unknown }).columns;
    if (!Array.isArray(columns) || columns.length > MAX_COLUMNS) {
      throw new DbError('internal', msg('The driver sent a bad list of columns'));
    }
    return {
      kind: 'columns',
      columns: columns.map((column: unknown, index) => {
        const { name, dataType } = (column ?? {}) as { name?: unknown; dataType?: unknown };
        return {
          name: typeof name === 'string' && name !== '' ? name : `column${index + 1}`,
          ...(typeof dataType === 'string' && dataType !== '' ? { dataType } : {}),
        };
      }),
    };
  }
  if (kind === 'rows') {
    const rows = (event as { rows?: unknown }).rows;
    if (!Array.isArray(rows)) {
      throw new DbError('internal', msg('The driver sent rows that are not a list'));
    }
    return { kind: 'rows', rows };
  }
  if (kind === 'done') {
    const { affectedRows, notice } = event as { affectedRows?: unknown; notice?: unknown };
    return {
      kind: 'done',
      ...(typeof affectedRows === 'number' && Number.isInteger(affectedRows) && affectedRows >= 0
        ? { affectedRows }
        : {}),
      ...(typeof notice === 'string' && notice !== '' ? { notice } : {}),
    };
  }
  throw new DbError('internal', msg('The driver sent an event that DataNest does not know'));
}

function names(list: unknown): string[] {
  return Array.isArray(list)
    ? list.filter((item): item is string => typeof item === 'string' && item !== '')
    : [];
}

function tableInfo(table: PluginTable | null): TableInfo | undefined {
  const { name, kind } = (table ?? {}) as { name?: unknown; kind?: unknown };
  return typeof name === 'string' && name !== ''
    ? { name, kind: kind === 'view' ? 'view' : 'table' }
    : undefined;
}

function columnInfo(column: PluginColumnInfo | null): ColumnInfo | undefined {
  const { name, dataType, nullable, primaryKey, defaultValue } = (column ?? {}) as {
    name?: unknown;
    dataType?: unknown;
    nullable?: unknown;
    primaryKey?: unknown;
    defaultValue?: unknown;
  };
  if (typeof name !== 'string' || name === '') {
    return undefined;
  }
  return {
    name,
    dataType: typeof dataType === 'string' ? dataType : '',
    nullable: nullable !== false,
    primaryKey: primaryKey === true,
    ...(typeof defaultValue === 'string' ? { defaultValue } : {}),
  };
}

function unsupported(what: string): DbError {
  return new DbError('unsupported', msg('This driver does not support {0}', what));
}

class PluginMetadataAdapter implements MetadataReader {
  constructor(private readonly inner: PluginSession) {}

  async listDatabases(): Promise<string[]> {
    try {
      return names(await this.inner.metadata.listDatabases?.());
    } catch (error) {
      throw pluginError(error);
    }
  }

  async listSchemas(database?: string): Promise<string[]> {
    try {
      return names(await this.inner.metadata.listSchemas?.(database));
    } catch (error) {
      throw pluginError(error);
    }
  }

  async listTables(scope: ObjectScope): Promise<TableInfo[]> {
    try {
      const tables = await this.inner.metadata.listTables(scope);
      return Array.isArray(tables) ? tables.flatMap((table) => tableInfo(table) ?? []) : [];
    } catch (error) {
      throw pluginError(error);
    }
  }

  async listColumns(table: TableRef): Promise<ColumnInfo[]> {
    try {
      const columns = await this.inner.metadata.listColumns(table);
      return Array.isArray(columns) ? columns.flatMap((column) => columnInfo(column) ?? []) : [];
    } catch (error) {
      throw pluginError(error);
    }
  }

  listUniqueKeys(): Promise<string[][]> {
    return Promise.resolve([]);
  }

  listForeignKeys(): Promise<[]> {
    return Promise.resolve([]);
  }

  listObjects(): Promise<[]> {
    return Promise.resolve([]);
  }

  listIndexes(): Promise<[]> {
    return Promise.resolve([]);
  }

  describeTable(): Promise<TableStructure> {
    return Promise.reject(unsupported(msg('the structure of a table')));
  }

  getDefinition(): Promise<string[]> {
    return Promise.reject(unsupported(msg('definitions')));
  }

  getTableDump(): Promise<never> {
    return Promise.reject(unsupported(msg('dumps')));
  }

  listTypeDumps(): Promise<[]> {
    return Promise.resolve([]);
  }
}

// --- the dialect: plain SQL, with the quote the plugin asked for ---------------------

function quoter(quote: '"' | '`' | '['): (name: string) => string {
  return (name) => {
    if (name === '') {
      throw new Error(msg('Identifier must not be empty'));
    }
    if (name.includes('\u0000')) {
      throw new Error(msg('Identifier must not contain NUL'));
    }
    switch (quote) {
      case '`':
        return `\`${name.replaceAll('`', '``')}\``;
      case '[':
        return `[${name.replaceAll(']', ']]')}]`;
      case '"':
        return `"${name.replaceAll('"', '""')}"`;
    }
  };
}

function quoteString(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

function literal(value: CellValue): string {
  if (value === null) {
    return 'NULL';
  }
  if (typeof value === 'boolean') {
    return value ? 'TRUE' : 'FALSE';
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : 'NULL';
  }
  if (typeof value === 'string') {
    return quoteString(value);
  }
  if (isTaggedValue(value)) {
    switch (value.kind) {
      case 'bigint':
      case 'decimal':
        return /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/u.test(value.text)
          ? value.text
          : quoteString(value.text);
      case 'datetime':
      case 'json':
        return quoteString(value.text);
      case 'binary':
        return `x'${value.preview}'`;
    }
  }
  return 'NULL';
}

const NO_DESIGNER: DesignerFeatures = {
  columnComments: false,
  tableComment: false,
  types: [],
  reorder: false,
  autoIncrement: false,
  foreignKeys: false,
  uniqueIndexes: false,
};

function refuse(what: string): never {
  throw unsupported(what);
}

const NO_DDL: SchemaDdl = {
  designer: NO_DESIGNER,
  createTable: (_table: TableRef, _design: TableDesign) => refuse(msg('changing the structure')),
  alterTable: (
    _table: TableRef,
    _before: TableDesign,
    _after: TableDesign,
    _background: TableBackground,
  ): AlterPlan => refuse(msg('changing the structure')),
  dropRelation: () => refuse(msg('changing the structure')),
  renameRelation: () => refuse(msg('changing the structure')),
  truncateTable: () => refuse(msg('changing the structure')),
  dropObject: () => refuse(msg('changing the structure')),
  replaceObject: (): ReplacePlan => refuse(msg('changing the structure')),
};

const NO_DUMP: DumpDialect = {
  prepare: [],
  beginSnapshot: [],
  endSnapshot: [],
  header: [],
  footer: [],
  routinesFirst: false,
  keysAfterData: false,
  insert: (quotedTable, quotedColumns, rows) =>
    `INSERT INTO ${quotedTable} (${quotedColumns.join(', ')}) VALUES\n${rows.join(',\n')}`,
  insertSelect: (quotedTable, quotedColumns, select) =>
    `INSERT INTO ${quotedTable} (${quotedColumns.join(', ')})\n${select}`,
  dropRelations: () => [],
  dropObject: () => refuse(msg('dumps')),
};

/** The dialect of a plugin driver: plain SQL with LIMIT/OFFSET and the quote it chose. */
export function pluginDialect(quote: '"' | '`' | '[' = '"'): Dialect {
  const quoteIdentifier = quoter(quote);
  return {
    keywords: [],
    quoteIdentifier,
    quoteTable: (table) =>
      [table.database, table.schema, table.name]
        .filter((part): part is string => part !== undefined)
        .map(quoteIdentifier)
        .join('.'),
    literal,
    paginate: (sql, limit, offset) => {
      if (!Number.isInteger(limit) || limit < 0 || !Number.isInteger(offset) || offset < 0) {
        throw new Error(`Invalid page: limit ${limit}, offset ${offset}`);
      }
      const base = sql.replace(/[\s;]+$/u, '');
      return offset === 0 ? `${base} LIMIT ${limit}` : `${base} LIMIT ${limit} OFFSET ${offset}`;
    },
    likeText: (quotedColumn, quotedPattern) =>
      `CAST(${quotedColumn} AS VARCHAR) LIKE ${quotedPattern} ESCAPE '!'`,
    defaultKeyword: false,
    insertDefaultRow: (quotedTable) => `INSERT INTO ${quotedTable} DEFAULT VALUES`,
    transaction: STANDARD_TRANSACTION,
    ddl: NO_DDL,
    dump: NO_DUMP,
  };
}

/** Why a descriptor cannot be registered; undefined when it is fine. */
export function pluginProblem(candidate: unknown): string | undefined {
  if (typeof candidate !== 'object' || candidate === null) {
    return msg('A driver must be an object');
  }
  const descriptor = candidate as Partial<PluginDriver>;
  if (!isPluginId(descriptor.id)) {
    return msg(
      'The driver id "{0}" is not valid: use lowercase letters, digits, ".", "-" and "_"',
      String(descriptor.id),
    );
  }
  if (typeof descriptor.label !== 'string' || descriptor.label.trim() === '') {
    return msg('The driver "{0}" needs a label', descriptor.id);
  }
  if (!Array.isArray(descriptor.fields)) {
    return msg('The driver "{0}" needs a list of fields', descriptor.id);
  }
  if (typeof descriptor.openSession !== 'function') {
    return msg('The driver "{0}" needs an openSession function', descriptor.id);
  }
  return undefined;
}

/** The driver DataNest runs for a registered plugin. */
export function createPluginDriver(descriptor: PluginDriver): Driver {
  const features = descriptor.features ?? {};
  return {
    id: 'plugin',
    dialect: pluginDialect(descriptor.identifierQuote),
    capabilities: {
      databases: features.databases === true,
      schemas: features.schemas === true,
      databaseScopedSessions: false,
      cancel: features.cancel === true,
      transactions: false,
      objectKinds: [],
    },
    openSession: async (config: ResolvedConnectionConfig): Promise<Session> => {
      let session: PluginSession;
      try {
        session = await descriptor.openSession({
          ...(config.host === undefined ? {} : { host: config.host }),
          ...(config.port === undefined ? {} : { port: config.port }),
          ...(config.user === undefined ? {} : { user: config.user }),
          ...(config.password === undefined ? {} : { password: config.password }),
          ...(config.database === undefined ? {} : { database: config.database }),
          ...(config.file === undefined ? {} : { file: config.file }),
          readOnly: config.readOnly === true,
        });
      } catch (error) {
        throw pluginError(error);
      }
      // A plugin is code we did not write: look at what it handed over.
      const opened: unknown = session;
      const parts = opened as Partial<PluginSession> | null;
      const metadata = parts?.metadata as Partial<PluginSession['metadata']> | undefined;
      if (
        typeof opened !== 'object' ||
        opened === null ||
        typeof parts?.execute !== 'function' ||
        typeof parts.close !== 'function' ||
        typeof metadata?.listTables !== 'function' ||
        typeof metadata.listColumns !== 'function'
      ) {
        throw new DbError(
          'internal',
          msg('The driver "{0}" returned a session that is not complete', descriptor.id),
        );
      }
      return new PluginSessionAdapter(session);
    },
  };
}

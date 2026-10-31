// What the Manager page (V11.13) shows, free of `vscode`: the sections a connection
// supports, the statement log, the dump of a scope and the pair of schemas of
// Structure Sync. The page's panel asks the user and draws; everything else is here.

import type { MetadataReader } from '../../drivers/driver';
import { DbError } from '../../core/errors';
import type { ObjectScope, TableInfo } from '../../core/model/objects';
import { msg } from '../../core/user-message';
import { browseSession } from '../../services/browse-session';
import type { ConnectionManager, SessionTarget } from '../../services/connection-manager';
import type { ConnectionStore } from '../../services/connection-store';
import type { TextSink } from '../../services/file-sink';
import type { HistoryEntry, QueryHistory } from '../../services/history';
import type { MetadataCache } from '../../services/metadata-cache';
import type { DumpProgress, DumpReport, DumpRequest } from '../../services/sql-dump';
import { type DriverId, describeTarget, isSqlDriver } from '../../shared/connection';
import type {
  ManagerDumpOptions,
  ManagerDumpReport,
  ManagerLogEntry,
  ManagerScope,
  ManagerSection,
  ManagerState,
  ManagerSyncConnection,
} from '../../shared/protocols/manager';
import { dumpFileName } from '../tree/dump-target';
import type { TablePageView } from './table-action';
import { compareSideOf } from './compare-side';
import { SchemaCompareModel } from './schema-compare-model';

/** The file a dump is written to: closed on success, discarded on failure. */
export type DumpSink = TextSink & {
  readonly bytes: number;
  close(): Promise<void>;
  discard(): Promise<void>;
};

/** What the page was opened from. */
export interface ManagerStart {
  readonly database?: string;
  readonly schema?: string;
  readonly table?: { readonly name: string; readonly kind: 'table' | 'view' };
  readonly section?: ManagerSection;
}

export interface ManagerModelDeps {
  readonly connectionId: string;
  readonly start: ManagerStart;
  readonly store: Pick<ConnectionStore, 'get' | 'list'>;
  readonly manager: Pick<ConnectionManager, 'driverOf' | 'connect' | 'acquire'>;
  readonly cache: Pick<MetadataCache, 'wrap'>;
  readonly history: Pick<QueryHistory, 'list' | 'clear'>;
  readonly dumper: { dump(request: DumpRequest): Promise<DumpReport> };
  /** Opens the file the dump is written to, which the panel then closes or discards. */
  readonly openSink: (path: string) => Promise<DumpSink>;
  readonly now?: () => Date;
}

/** The sections a connection of this kind supports, in the order of the list. */
export function sectionsFor(driver: DriverId): ManagerSection[] {
  if (!isSqlDriver(driver)) {
    return [];
  }
  return driver === 'sqlite'
    ? ['log', 'dashboard', 'dump', 'sync']
    : ['log', 'dashboard', 'processes', 'dump', 'sync'];
}

/** The statement log reads like a console: oldest first, the newest at the bottom. */
export function logEntryOf(entry: HistoryEntry): ManagerLogEntry {
  return {
    id: entry.id,
    at: entry.executedAt,
    sql: entry.sql,
    ok: entry.ok,
    durationMs: entry.durationMs,
    ...(entry.rows === undefined ? {} : { rows: entry.rows }),
    ...(entry.affected === undefined ? {} : { affected: entry.affected }),
    ...(entry.error === undefined ? {} : { error: entry.error }),
    ...(entry.database === undefined ? {} : { database: entry.database }),
    runs: entry.runs,
  };
}

export const DEFAULT_DUMP_OUTPUT = '{data_source}-{timestamp}.sql';

/**
 * The file a template names: `{data_source}` is the name of what is dumped, `{timestamp}`
 * the moment, as in `dumpFileName`. A template without a folder lands in `folder`.
 */
export function expandOutput(
  template: string,
  source: string,
  date: Date,
  folder: string | undefined,
): string {
  // `shop-2026-10-29-1405`: the stamp is always the last 15 characters.
  const named = dumpFileName(source, date).replace(/\.sql$/u, '');
  const stamp = named.slice(-15);
  const stem = named.slice(0, -16);
  let path = template.replaceAll('{data_source}', stem === '' ? 'dump' : stem);
  path = path.replaceAll('{timestamp}', stamp);
  const absolute = /^([/\\]|[A-Za-z]:[/\\])/u.test(path);
  if (!absolute && folder !== undefined) {
    path = `${folder.replace(/[/\\]+$/u, '')}/${path}`;
  }
  return path;
}

export class ManagerModel {
  private compare: SchemaCompareModel | undefined;
  private start: ManagerStart;

  constructor(private readonly deps: ManagerModelDeps) {
    this.start = deps.start;
  }

  /** The page was asked for again, perhaps from another table or on another section. */
  setStart(start: ManagerStart): void {
    this.start = start;
  }

  async openSink(path: string): Promise<DumpSink> {
    return await this.deps.openSink(path);
  }

  get compareModel(): SchemaCompareModel | undefined {
    return this.compare;
  }

  private get now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  /** The table the page was opened from, as the table bar's actions need it. */
  tableView(): TablePageView | undefined {
    const { start } = this;
    if (start.table === undefined) {
      return undefined;
    }
    return {
      target:
        start.database === undefined
          ? { connectionId: this.deps.connectionId }
          : { connectionId: this.deps.connectionId, database: start.database },
      table: {
        name: start.table.name,
        ...(start.database === undefined ? {} : { database: start.database }),
        ...(start.schema === undefined ? {} : { schema: start.schema }),
      },
      kind: start.table.kind,
    };
  }

  state(): ManagerState {
    const { connectionId } = this.deps;
    const { start } = this;
    const config = this.deps.store.get(connectionId);
    if (config === undefined) {
      throw new DbError('not-found', msg('The connection no longer exists'));
    }
    const sections = sectionsFor(config.driver);
    const wanted = start.section ?? 'log';
    return {
      connectionId,
      connectionName: config.name,
      driver: config.driver,
      sections,
      section: sections.includes(wanted) ? wanted : (sections[0] ?? 'log'),
      ...(start.database === undefined ? {} : { database: start.database }),
      ...(start.schema === undefined ? {} : { schema: start.schema }),
      ...(start.table === undefined ? {} : { table: start.table }),
      readOnly: config.readOnly === true,
      production: config.production === true,
    };
  }

  log(): ManagerLogEntry[] {
    return this.deps.history
      .list({ connectionId: this.deps.connectionId })
      .map(logEntryOf)
      .reverse();
  }

  clearLog(): number {
    return this.deps.history.clear(this.deps.connectionId);
  }

  /** The databases, schemas and tables the dump form offers for the scope. */
  async dumpOptions(
    picked: { database?: string; schema?: string },
    folder: string | undefined,
  ): Promise<ManagerDumpOptions> {
    const { connectionId } = this.deps;
    const { start } = this;
    const { capabilities } = await this.deps.manager.driverOf(connectionId);
    let databases: string[] = [];
    if (capabilities.databases) {
      databases = await (await this.deps.manager.connect(connectionId)).metadata.listDatabases();
    }
    const database =
      picked.database ?? start.database ?? (capabilities.databases ? databases[0] : undefined);
    let schemas: string[] = [];
    if (capabilities.schemas) {
      schemas = await (
        await browseSession(this.deps.manager, connectionId, database)
      ).metadata.listSchemas(database);
    }
    const schema = picked.schema ?? start.schema ?? (capabilities.schemas ? schemas[0] : undefined);
    const scope = scopeOf(database, schema);
    const relations: TableInfo[] = await (await this.metadata(scope)).listTables(scope);
    const asked = start.table?.name;
    const ticked =
      asked !== undefined && relations.some((relation) => relation.name === asked)
        ? [asked]
        : relations.map((relation) => relation.name);
    const name = asked ?? schema ?? database ?? this.deps.store.get(connectionId)?.name ?? 'dump';
    return {
      databases,
      ...(database === undefined ? {} : { database }),
      schemas,
      ...(schema === undefined ? {} : { schema }),
      relations: relations.map((relation) => ({ name: relation.name, kind: relation.kind })),
      ticked,
      output: expandOutput(DEFAULT_DUMP_OUTPUT, name, this.now, folder),
    };
  }

  /** Writes the dump; the caller closes the sink on success and discards it on failure. */
  async dump(
    request: {
      database?: string;
      schema?: string;
      relations: readonly string[];
      wholeScope: boolean;
      content: DumpRequest['content'];
      dropFirst: boolean;
      output: string;
    },
    sink: DumpSink,
    options: { signal?: AbortSignal; onProgress?: (progress: DumpProgress) => void },
  ): Promise<ManagerDumpReport> {
    const { connectionId } = this.deps;
    const scope = scopeOf(request.database, request.schema);
    const all = await (await this.metadata(scope)).listTables(scope);
    const chosen = new Set(request.relations);
    const relations = all.filter((relation) => chosen.has(relation.name));
    if (relations.length === 0 && !request.wholeScope) {
      throw new DbError('not-found', msg('There is nothing here to dump'));
    }
    const config = this.deps.store.get(connectionId);
    const source = [config?.name ?? connectionId, scope.database, scope.schema]
      .filter((part): part is string => part !== undefined)
      .join(' / ');
    const target: SessionTarget =
      scope.database === undefined ? { connectionId } : { connectionId, database: scope.database };
    const report = await this.deps.dumper.dump({
      target,
      scope,
      relations,
      wholeScope: request.wholeScope,
      content: request.content,
      dropFirst: request.content === 'data' ? false : request.dropFirst,
      sink,
      source,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
    });
    return {
      path: request.output,
      bytes: sink.bytes,
      tables: report.tables,
      views: report.views,
      objects: report.objects,
      rows: report.rows,
      durationMs: report.durationMs,
      skipped: report.skipped.map((skip) => skip.name),
    };
  }

  /** The connections Structure Sync can compare with: the same kind of database. */
  syncConnections(): ManagerSyncConnection[] {
    const own = this.deps.store.get(this.deps.connectionId);
    return this.deps.store
      .list()
      .filter((config) => config.driver === own?.driver)
      .map((config) => ({ id: config.id, name: config.name, detail: describeTarget(config) }));
  }

  async syncScopes(
    connectionId: string,
    database: string | undefined,
  ): Promise<{ databases: string[]; schemas: string[] }> {
    const { capabilities } = await this.deps.manager.driverOf(connectionId);
    const databases = capabilities.databases
      ? await (await this.deps.manager.connect(connectionId)).metadata.listDatabases()
      : [];
    const chosen = database ?? (capabilities.databases ? databases[0] : undefined);
    const schemas = capabilities.schemas
      ? await (
          await browseSession(this.deps.manager, connectionId, chosen)
        ).metadata.listSchemas(chosen)
      : [];
    return { databases, schemas };
  }

  /** Builds the comparison of two scopes; the same scope twice is refused. */
  async startSync(source: ManagerScope, target: ManagerScope): Promise<SchemaCompareModel> {
    const left = scopeOf(source.database, source.schema);
    const right = scopeOf(target.database, target.schema);
    if (
      source.connectionId === target.connectionId &&
      JSON.stringify(left) === JSON.stringify(right)
    ) {
      throw new DbError('unsupported', msg('Pick another database or schema to compare with'));
    }
    const driver = await this.deps.manager.driverOf(source.connectionId);
    this.compare = new SchemaCompareModel({
      source: await compareSideOf(this.deps, source.connectionId, left),
      target: await compareSideOf(this.deps, target.connectionId, right),
      dialect: driver.dialect,
      driver: driver.id,
    });
    return this.compare;
  }

  private async metadata(scope: ObjectScope): Promise<MetadataReader> {
    const { connectionId, manager, cache } = this.deps;
    return cache.wrap(
      connectionId,
      (await browseSession(manager, connectionId, scope.database)).metadata,
    );
  }
}

function scopeOf(database: string | undefined, schema: string | undefined): ObjectScope {
  return {
    ...(database === undefined ? {} : { database }),
    ...(schema === undefined ? {} : { schema }),
  };
}

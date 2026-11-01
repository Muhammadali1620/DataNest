// What the editor's language model may do with the user's databases (V13.15): list the
// connections, read a schema, run one statement that only reads. Everything the model
// sees here is cut down on purpose — no passwords, hosts or users; no more than 100
// rows, 20 000 characters and 30 seconds per answer; no statement the read-only
// classifier cannot vouch for. The `vscode` side only wraps these methods (D145).

import { isReadOnlyStatement } from '../core/sql/read-only';
import { splitStatements } from '../core/sql/split';
import { syntaxOf } from '../core/sql/tokenizer';
import type { DriverCapabilities, Session } from '../drivers/driver';
import { cellText } from '../shared/cell-text';
import { type ConnectionConfig, driverFamily, isSqlDriver } from '../shared/connection';

/** Rows of a query answer. */
export const AI_ROW_LIMIT = 100;
/** Characters of one answer; the rows that do not fit are dropped. */
export const AI_TEXT_LIMIT = 20_000;
/** Characters of one cell. */
export const AI_CELL_LIMIT = 200;
/** A statement that runs longer is cancelled. */
export const AI_TIMEOUT_MS = 30_000;
/** Tables listed at once. */
export const AI_TABLE_LIMIT = 500;
/** Tables and columns of a schema digest (the prompt of the chat participant). */
export const AI_DIGEST_TABLES = 40;
export const AI_DIGEST_COLUMNS = 30;

/** The tools, by the names the manifest and the model know them by. */
export const AI_TOOL_NAMES = {
  listConnections: 'datanest_listConnections',
  listTables: 'datanest_listTables',
  describeTable: 'datanest_describeTable',
  runReadOnlyQuery: 'datanest_runReadOnlyQuery',
} as const;

export type AiToolName = (typeof AI_TOOL_NAMES)[keyof typeof AI_TOOL_NAMES];

/** What a tool answers; `refused` marks an answer that is a "no", not data. */
export interface AiToolResult {
  readonly text: string;
  readonly refused?: boolean;
}

export interface AiScopeInput {
  readonly connection: string;
  readonly database?: string;
  readonly schema?: string;
}

export interface AiTableInput extends AiScopeInput {
  readonly table: string;
}

export interface AiQueryInput {
  readonly connection: string;
  readonly sql: string;
  readonly database?: string;
}

/** What the user is asked to approve before a tool runs; the host words the question. */
export interface AiConfirmation {
  readonly connection: string;
  readonly production: boolean;
  /** The statement, for a query. */
  readonly sql?: string;
}

export interface AiToolDeps {
  readonly store: { list(): ConnectionConfig[] };
  /** The session metadata is read through (the tree's, shared). */
  readonly browse: (connectionId: string, database?: string) => Promise<Session>;
  /** The session queries run in: its own, so a query never lands in an editor's transaction. */
  readonly query: (connectionId: string, database?: string) => Promise<Session>;
  readonly capabilitiesOf: (connectionId: string) => Promise<DriverCapabilities>;
  /** The setting that turns the tools off, asked at every call. */
  readonly enabled: () => boolean;
  readonly timeoutMs?: number;
}

type Resolved = { readonly config: ConnectionConfig } | { readonly refusal: AiToolResult };

const refuse = (text: string): AiToolResult => ({ text, refused: true });

/** Text for the model: JSON, compact, so it can be read back exactly. */
const json = (value: unknown): string => JSON.stringify(value);

export class AiTools {
  private readonly timeoutMs: number;

  constructor(private readonly deps: AiToolDeps) {
    this.timeoutMs = deps.timeoutMs ?? AI_TIMEOUT_MS;
  }

  /** Every connection the user has, in the words a model needs and no more. */
  listConnections(): AiToolResult {
    if (!this.deps.enabled()) {
      return TURNED_OFF;
    }
    return {
      text: json(
        this.deps.store.list().map((config) => ({
          id: config.id,
          name: config.name,
          driver: config.driver,
          kind: driverFamily(config.driver),
          ...(config.database === undefined ? {} : { database: config.database }),
          ...(config.production === true ? { production: true } : {}),
          ...(config.readOnly === true ? { readOnly: true } : {}),
          ...(config.disabled === true ? { disabled: true } : {}),
        })),
      ),
    };
  }

  /**
   * Databases, schemas or tables, whichever the scope still lacks: a first call without
   * a database lists the databases, one without a schema lists the schemas.
   */
  async listTables(input: AiScopeInput): Promise<AiToolResult> {
    const resolved = this.resolve(input.connection);
    if ('refusal' in resolved) {
      return resolved.refusal;
    }
    const { config } = resolved;
    const caps = await this.deps.capabilitiesOf(config.id);
    const database = caps.databases ? (input.database ?? config.database) : undefined;
    const session = await this.deps.browse(config.id, database);
    if (caps.databases && database === undefined) {
      return {
        text: json({
          hint: 'Pass one of these as "database".',
          databases: (await session.metadata.listDatabases()).slice(0, AI_TABLE_LIMIT),
        }),
      };
    }
    if (caps.schemas && input.schema === undefined) {
      return {
        text: json({
          hint: 'Pass one of these as "schema".',
          schemas: (await session.metadata.listSchemas(database)).slice(0, AI_TABLE_LIMIT),
        }),
      };
    }
    const tables = await session.metadata.listTables(scopeOf(database, input.schema));
    return {
      text: json({
        tables: tables.slice(0, AI_TABLE_LIMIT).map((table) => ({
          name: table.name,
          kind: table.kind,
        })),
        ...(tables.length > AI_TABLE_LIMIT ? { truncated: true, total: tables.length } : {}),
      }),
    };
  }

  /** Columns, foreign keys and indexes of one table. */
  async describeTable(input: AiTableInput): Promise<AiToolResult> {
    const resolved = this.resolve(input.connection);
    if ('refusal' in resolved) {
      return resolved.refusal;
    }
    const { config } = resolved;
    const caps = await this.deps.capabilitiesOf(config.id);
    const database = caps.databases ? (input.database ?? config.database) : undefined;
    const session = await this.deps.browse(config.id, database);
    const ref = { ...scopeOf(database, input.schema), name: input.table };
    const columns = await session.metadata.listColumns(ref);
    if (columns.length === 0) {
      return refuse(
        `No table "${input.table}" with columns was found. Call datanest_listTables to see the names.`,
      );
    }
    const [foreignKeys, indexes] = await Promise.all([
      session.metadata.listForeignKeys(ref),
      session.metadata.listIndexes(ref),
    ]);
    return {
      text: json({
        table: input.table,
        columns: columns.map((column) => ({
          name: column.name,
          type: column.dataType,
          nullable: column.nullable,
          ...(column.primaryKey ? { primaryKey: true } : {}),
          ...(column.defaultValue === undefined ? {} : { default: column.defaultValue }),
        })),
        foreignKeys: foreignKeys.map((key) => ({
          columns: key.columns,
          references: { table: key.target.name, columns: key.targetColumns },
        })),
        indexes: indexes.map((index) => ({
          name: index.name,
          columns: index.columns,
          ...(index.primary ? { primary: true } : index.unique ? { unique: true } : {}),
        })),
      }),
    };
  }

  /** One statement that only reads, with at most 100 rows back. */
  async runReadOnlyQuery(input: AiQueryInput): Promise<AiToolResult> {
    const resolved = this.resolve(input.connection);
    if ('refusal' in resolved) {
      return resolved.refusal;
    }
    const { config } = resolved;
    const statements = splitStatements(input.sql, config.driver);
    const only = statements[0];
    if (only === undefined || statements.length !== 1) {
      return refuse('Send exactly one SQL statement.');
    }
    if (!isReadOnlyStatement(only.text, syntaxOf(config.driver))) {
      return refuse(
        'Refused: only statements that merely read (SELECT, SHOW, EXPLAIN, …) are run. This one may change data or settings.',
      );
    }
    const caps = await this.deps.capabilitiesOf(config.id);
    const database = caps.databases ? (input.database ?? config.database) : undefined;
    const session = await this.deps.query(config.id, database);
    return await this.run(session, only.text);
  }

  /**
   * What the user must approve first, or nothing when the call may go ahead unasked.
   * A query always asks, because it is the one tool that runs something; the others
   * ask only on a production connection.
   */
  confirmationFor(
    tool: AiToolName,
    input: { connection?: string; sql?: string },
  ): AiConfirmation | undefined {
    if (tool === AI_TOOL_NAMES.listConnections || input.connection === undefined) {
      return undefined;
    }
    const resolved = this.resolve(input.connection);
    if ('refusal' in resolved) {
      return undefined;
    }
    const production = resolved.config.production === true;
    if (tool === AI_TOOL_NAMES.runReadOnlyQuery) {
      return {
        connection: resolved.config.name,
        production,
        ...(input.sql === undefined ? {} : { sql: input.sql }),
      };
    }
    return production ? { connection: resolved.config.name, production } : undefined;
  }

  /**
   * A short text of a schema — `orders(id int pk, user_id int, …)` per table — for the
   * prompt of the chat participant. Reads the first tables only.
   */
  async schemaDigest(input: AiScopeInput): Promise<string> {
    const resolved = this.resolve(input.connection);
    if ('refusal' in resolved) {
      return '';
    }
    const { config } = resolved;
    const caps = await this.deps.capabilitiesOf(config.id);
    const database = caps.databases ? (input.database ?? config.database) : undefined;
    const schema = input.schema;
    if ((caps.databases && database === undefined) || (caps.schemas && schema === undefined)) {
      return '';
    }
    const session = await this.deps.browse(config.id, database);
    const tables = (await session.metadata.listTables(scopeOf(database, schema))).slice(
      0,
      AI_DIGEST_TABLES,
    );
    const lines: string[] = [];
    for (const table of tables) {
      const columns = await session.metadata.listColumns({
        ...scopeOf(database, schema),
        name: table.name,
      });
      const shown = columns
        .slice(0, AI_DIGEST_COLUMNS)
        .map((column) => `${column.name} ${column.dataType}${column.primaryKey ? ' pk' : ''}`);
      const more = columns.length > AI_DIGEST_COLUMNS ? ', …' : '';
      lines.push(
        `${table.name}${table.kind === 'view' ? ' (view)' : ''}(${shown.join(', ')}${more})`,
      );
    }
    return lines.join('\n');
  }

  /** The connection a model named — by id, else by name — if it may be used at all. */
  resolve(reference: string): Resolved {
    if (!this.deps.enabled()) {
      return { refusal: TURNED_OFF };
    }
    const all = this.deps.store.list();
    const wanted = reference.trim();
    const byId = all.find((config) => config.id === wanted);
    const byName = all.filter((config) => config.name.toLowerCase() === wanted.toLowerCase());
    const found = byId ?? (byName.length === 1 ? byName[0] : undefined);
    if (found === undefined) {
      return {
        refusal: refuse(
          byName.length > 1
            ? `Several connections are named "${wanted}": use the id from datanest_listConnections.`
            : `There is no connection "${wanted}". Call datanest_listConnections first.`,
        ),
      };
    }
    if (found.disabled === true) {
      return { refusal: refuse(`The connection "${found.name}" is switched off by the user.`) };
    }
    if (!isSqlDriver(found.driver)) {
      return {
        refusal: refuse(
          `The connection "${found.name}" is not a SQL database (${found.driver}): these tools read SQL databases only.`,
        ),
      };
    }
    return { config: found };
  }

  private async run(session: Session, sql: string): Promise<AiToolResult> {
    let columns: string[] = [];
    const rows: unknown[][] = [];
    const state = { more: false };
    const collect = async (): Promise<void> => {
      for await (const event of session.execute(sql, { rowLimit: AI_ROW_LIMIT + 1 })) {
        if (event.kind === 'columns') {
          columns = event.columns.map((column) => column.name);
        } else if (event.kind === 'rows') {
          for (const row of event.rows) {
            if (rows.length >= AI_ROW_LIMIT) {
              state.more = true;
              return;
            }
            rows.push(row.map(cellForModel));
          }
        }
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        resolve('timeout');
      }, this.timeoutMs);
    });
    const running = collect();
    try {
      const outcome = await Promise.race([running.then(() => 'done' as const), timedOut]);
      if (outcome === 'timeout') {
        // The statement is still running on the server; stop it, and let go of its outcome.
        running.catch(() => undefined);
        await session.cancel().catch(() => undefined);
        return refuse(
          `The statement ran longer than ${String(this.timeoutMs / 1000)} seconds and was cancelled. Make it cheaper (a WHERE, a LIMIT).`,
        );
      }
    } catch (error) {
      return refuse(
        `The statement failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }
    if (state.more) {
      // Leaving the stream early may leave the server producing rows nobody reads.
      await session.cancel().catch(() => undefined);
    }
    return { text: fit(columns, rows, state.more) };
  }
}

const TURNED_OFF = refuse('DataNest tools for the language model are turned off in the settings.');

function scopeOf(
  database: string | undefined,
  schema: string | undefined,
): { database?: string; schema?: string } {
  return {
    ...(database === undefined ? {} : { database }),
    ...(schema === undefined ? {} : { schema }),
  };
}

/** A cell as the model gets it: null stays null, numbers stay numbers, the rest is text. */
function cellForModel(value: Parameters<typeof cellText>[0]): unknown {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  const text = cellText(value);
  return text.length > AI_CELL_LIMIT ? `${text.slice(0, AI_CELL_LIMIT)}…` : text;
}

/** The answer as JSON no longer than the limit: rows are dropped from the end until it fits. */
function fit(columns: readonly string[], rows: readonly unknown[][], more: boolean): string {
  let kept = rows.length;
  for (;;) {
    const cut = kept < rows.length;
    const text = json({
      columns,
      rows: rows.slice(0, kept),
      rowCount: kept,
      ...(more || cut
        ? {
            truncated: true,
            note: cut
              ? `Only the first ${String(kept)} rows fit into the answer.`
              : `Only the first ${String(AI_ROW_LIMIT)} rows are shown.`,
          }
        : {}),
    });
    if (text.length <= AI_TEXT_LIMIT || kept === 0) {
      return text;
    }
    kept = Math.floor(kept / 2);
  }
}

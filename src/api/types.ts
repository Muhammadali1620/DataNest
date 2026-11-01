// The public API of DataNest (V12.7): what another extension gets from
// `vscode.extensions.getExtension('datanest.datanest').exports` after activating it, and
// what it hands back to add a database. Nothing here imports the rest of DataNest, so the
// file can be copied into a plugin as it is. The contract is versioned by `apiVersion`:
// a version only ever gains optional members; a change that breaks plugins is version 2.
//
// A plugin implements a small `PluginDriver`; DataNest does the rest — the connection form
// fields, the tree, the SQL editor, the result grid, export, history. The rows a plugin
// yields are checked and normalised before DataNest uses them, so a plugin cannot crash
// the grid with an odd value.

/** Which of the standard fields of a connection the plugin's driver uses, in form order. */
export type PluginField = 'host' | 'port' | 'user' | 'password' | 'database' | 'file';

/** What the user entered for a connection; fields the driver does not use are absent. */
export interface PluginConnection {
  readonly host?: string;
  readonly port?: number;
  readonly user?: string;
  /** The password from the editor's secret storage; never written to a file. */
  readonly password?: string;
  readonly database?: string;
  /** A path on this machine, for drivers that read a database file. */
  readonly file?: string;
  /** The connection is marked read-only: the driver should not allow changes either. */
  readonly readOnly: boolean;
}

export interface PluginColumn {
  readonly name: string;
  /** The type as the database names it, e.g. `varchar(20)`. */
  readonly dataType?: string;
}

/**
 * A value of a cell. `bigint`, `Date`, `Uint8Array` and plain objects are turned into the
 * grid's own value kinds; `undefined`, `NaN` and infinities become NULL.
 */
export type PluginCell =
  null | undefined | string | number | boolean | bigint | Date | Uint8Array | object;

/** What `execute` yields: the columns once, rows in batches of any size, then `done`. */
export type PluginEvent =
  | { readonly kind: 'columns'; readonly columns: readonly PluginColumn[] }
  | { readonly kind: 'rows'; readonly rows: readonly (readonly PluginCell[])[] }
  | { readonly kind: 'done'; readonly affectedRows?: number; readonly notice?: string };

export interface PluginScope {
  readonly database?: string;
  readonly schema?: string;
}

export interface PluginTableRef extends PluginScope {
  readonly name: string;
}

export interface PluginTable {
  readonly name: string;
  /** `table` when absent. */
  readonly kind?: 'table' | 'view';
}

export interface PluginColumnInfo {
  readonly name: string;
  readonly dataType: string;
  /** `true` when absent. */
  readonly nullable?: boolean;
  /** `false` when absent. */
  readonly primaryKey?: boolean;
  readonly defaultValue?: string;
}

/** What the tree and the completion read. Only tables and columns are required. */
export interface PluginMetadata {
  /** Present when one session sees several databases; the tree then lists them. */
  listDatabases?(): Promise<string[]>;
  /** Present when objects live in schemas. */
  listSchemas?(database?: string): Promise<string[]>;
  listTables(scope: PluginScope): Promise<PluginTable[]>;
  listColumns(table: PluginTableRef): Promise<PluginColumnInfo[]>;
}

/** One live connection. DataNest runs one statement at a time on it. */
export interface PluginSession {
  /**
   * Runs one statement. `rowLimit` is a request to stop reading after that many rows; the
   * driver may stop early, and DataNest cuts the rest off whatever the driver does.
   */
  execute(sql: string, options?: { readonly rowLimit?: number }): AsyncIterable<PluginEvent>;
  /** Stops the running statement. When absent, the Cancel button does nothing. */
  cancel?(): Promise<void>;
  readonly metadata: PluginMetadata;
  /** Closes the connection; DataNest calls it once. */
  close(): Promise<void>;
}

export interface PluginFeatures {
  /** One session sees several databases (`metadata.listDatabases` is implemented). */
  readonly databases?: boolean;
  /** Objects live in schemas inside a database (`metadata.listSchemas` is implemented). */
  readonly schemas?: boolean;
  /** `session.cancel` stops a running statement. */
  readonly cancel?: boolean;
}

export interface PluginDriver {
  /**
   * Stable id, saved in every connection that uses the driver: lowercase letters, digits,
   * dots, dashes and underscores, up to 64. Start it with the extension's own id, e.g.
   * `acme.duckdb`, so two plugins never clash.
   */
  readonly id: string;
  /** The name in the list of databases. */
  readonly label: string;
  /** The fields the connection form asks for. */
  readonly fields: readonly PluginField[];
  readonly defaultPort?: number;
  /** What the driver can do beyond running statements; each is `false` when absent. */
  readonly features?: PluginFeatures;
  /** How identifiers are quoted in generated SQL; `"` when absent. */
  readonly identifierQuote?: '"' | '`' | '[';
  openSession(connection: PluginConnection): Promise<PluginSession>;
}

/** Anything with a `dispose`, like the editor's own Disposable. */
export interface PluginRegistration {
  dispose(): unknown;
}

export interface DataNestApi {
  /** 1. A plugin should check it before it uses anything else. */
  readonly apiVersion: 1;
  /**
   * Makes a driver available. Throws when the id is malformed or already taken. Dispose the
   * result (or deactivate the extension) to take it back; connections that use it then show
   * an error until the plugin registers it again.
   */
  registerDriver(driver: PluginDriver): PluginRegistration;
  /** The ids of the drivers that are registered now. */
  registeredDrivers(): readonly string[];
}

export const API_VERSION = 1;

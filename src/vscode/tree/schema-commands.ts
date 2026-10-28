// Tree commands that change the structure: new and dropped databases, schemas and
// tables, renames, TRUNCATE, dropped routines. Every one shows its SQL first, and
// the editor bits arrive through `SchemaUi`, so the flow is covered by unit tests.

import { isDbError } from '../../core/errors';
import { identifierLimit, identifierProblem } from '../../core/sql/identifiers';
import type { ConnectionManager } from '../../services/connection-manager';
import type { SchemaAction, SchemaActions } from '../../services/schema-actions';
import { actionDatabase } from '../../services/schema-actions';
import type { DriverId } from '../../shared/connection';
import type { DocumentBinding } from '../editor/document-bindings';
import { isTreeNode, relationKindOf, scopeOf, tableRefOf, type TreeNode } from './nodes';
import type { CommandTarget, RefreshableTree } from './tree-commands';

/** What the user is asked; `vscode.window` provides it in the extension. */
export interface SchemaUi {
  /** A name, or undefined when cancelled. `validate` returns a problem to show. */
  askName(options: {
    readonly title: string;
    readonly value?: string;
    readonly validate: (name: string) => string | undefined;
  }): Promise<string | undefined>;
  /** Shows the SQL; the answer is to run it, open it in an editor, or nothing. */
  confirm(options: {
    readonly title: string;
    readonly sql: string;
    readonly runLabel: string;
  }): Promise<'run' | 'edit' | undefined>;
  pick<T>(
    title: string,
    options: readonly { readonly label: string; readonly value: T }[],
  ): Promise<T | undefined>;
  info(message: string): void;
}

/** Every text the commands show, already translated. */
export interface SchemaTexts {
  /** Said where the database has no databases (a SQLite file) or no schemas. */
  readonly noDatabases: string;
  readonly noSchemas: string;
  readonly newDatabaseName: string;
  readonly newSchemaName: string;
  readonly newTableName: string;
  renameTo(name: string): string;
  typeToConfirm(name: string): string;
  readonly typeExactly: string;
  readonly emptyName: string;
  readonly nulInName: string;
  tooLong(limit: number): string;
  readonly sameName: string;
  createDatabase(name: string): string;
  dropDatabase(name: string): string;
  createSchema(name: string): string;
  dropSchema(name: string): string;
  readonly schemaOnlyIfEmpty: string;
  readonly schemaCascade: string;
  createTable(name: string): string;
  dropRelation(name: string): string;
  rename(from: string, to: string): string;
  truncate(name: string): string;
  dropObject(name: string): string;
  readonly create: string;
  readonly drop: string;
  readonly renameLabel: string;
  readonly truncateLabel: string;
  done(summary: string): string;
}

export interface SchemaCommandDeps {
  readonly actions: Pick<SchemaActions, 'sqlOf' | 'run'>;
  readonly manager: Pick<ConnectionManager, 'driverOf'>;
  readonly ui: SchemaUi;
  readonly texts: SchemaTexts;
  readonly tree: RefreshableTree;
  /** Opens SQL in a new editor bound to the connection, instead of running it. */
  readonly openEditor: (binding: DocumentBinding, sql: string) => Promise<unknown>;
}

export type SchemaCommandName =
  | 'createDatabase'
  | 'dropDatabase'
  | 'createSchema'
  | 'dropSchema'
  | 'createTable'
  | 'dropTable'
  | 'renameTable'
  | 'truncateTable'
  | 'dropObject';

export function schemaCommandHandlers(
  deps: SchemaCommandDeps,
): Record<SchemaCommandName, (target?: CommandTarget) => Promise<void>> {
  const { texts, ui } = deps;

  const nameValidator =
    (driver: DriverId, current?: string) =>
    (raw: string): string | undefined => {
      const name = raw.trim();
      switch (identifierProblem(name, driver)) {
        case 'empty':
          return texts.emptyName;
        case 'nul':
          return texts.nulInName;
        case 'too-long':
          return texts.tooLong(identifierLimit(driver) ?? 0);
        case undefined:
          return name === current ? texts.sameName : undefined;
      }
    };

  const askName = async (
    connectionId: string,
    title: string,
    current?: string,
  ): Promise<string | undefined> => {
    const driver = (await deps.manager.driverOf(connectionId)).id;
    const name = await ui.askName({
      title,
      ...(current === undefined ? {} : { value: current }),
      validate: nameValidator(driver, current),
    });
    return name?.trim();
  };

  /** Dropping a whole database or schema needs its name typed back. */
  const typedBack = async (name: string): Promise<boolean> => {
    const typed = await ui.askName({
      title: texts.typeToConfirm(name),
      validate: (value) => (value === name ? undefined : texts.typeExactly),
    });
    return typed === name;
  };

  /** Shows the SQL, then runs it or opens it; a database without the feature just says so. */
  const perform = async (
    connectionId: string,
    action: SchemaAction,
    title: string,
    runLabel: string,
  ): Promise<void> => {
    let sql: string;
    try {
      sql = await deps.actions.sqlOf(connectionId, action);
    } catch (error) {
      if (isDbError(error) && error.code === 'unsupported') {
        ui.info(error.message);
        return;
      }
      throw error;
    }
    const choice = await ui.confirm({ title, sql, runLabel });
    if (choice === 'edit') {
      const database = actionDatabase(action);
      await deps.openEditor(
        database === undefined ? { connectionId } : { connectionId, database },
        sql,
      );
      return;
    }
    if (choice !== 'run') {
      return;
    }
    await deps.actions.run(connectionId, action, sql);
    deps.tree.refresh();
    ui.info(texts.done(sql.split('\n')[0] ?? sql));
    return;
  };

  const nodeOf = <K extends TreeNode['kind']>(
    target: CommandTarget,
    kinds: readonly K[],
  ): Extract<TreeNode, { kind: K }> | undefined =>
    isTreeNode(target) && (kinds as readonly string[]).includes(target.kind)
      ? (target as Extract<TreeNode, { kind: K }>)
      : undefined;

  return {
    createDatabase: async (target) => {
      const connectionId = nodeOf(target, ['connection', 'database'])?.connectionId;
      if (connectionId === undefined) {
        return;
      }
      if ((await deps.manager.driverOf(connectionId)).dialect.ddl.createDatabase === undefined) {
        ui.info(texts.noDatabases);
        return;
      }
      const name = await askName(connectionId, texts.newDatabaseName);
      if (name === undefined) {
        return;
      }
      await perform(
        connectionId,
        { kind: 'createDatabase', name },
        texts.createDatabase(name),
        texts.create,
      );
    },

    dropDatabase: async (target) => {
      const node = nodeOf(target, ['database']);
      if (node === undefined || !(await typedBack(node.database))) {
        return;
      }
      await perform(
        node.connectionId,
        { kind: 'dropDatabase', name: node.database },
        texts.dropDatabase(node.database),
        texts.drop,
      );
    },

    createSchema: async (target) => {
      const node = nodeOf(target, ['database']);
      if (node === undefined) {
        return;
      }
      const { connectionId, database } = node;
      if ((await deps.manager.driverOf(connectionId)).dialect.ddl.createSchema === undefined) {
        ui.info(texts.noSchemas);
        return;
      }
      const name = await askName(connectionId, texts.newSchemaName);
      if (name === undefined) {
        return;
      }
      await perform(
        connectionId,
        { kind: 'createSchema', database, name },
        texts.createSchema(name),
        texts.create,
      );
    },

    dropSchema: async (target) => {
      const node = nodeOf(target, ['schema']);
      if (node === undefined) {
        return;
      }
      const cascade = await ui.pick(texts.dropSchema(node.schema), [
        { label: texts.schemaOnlyIfEmpty, value: false },
        { label: texts.schemaCascade, value: true },
      ]);
      if (cascade === undefined || !(await typedBack(node.schema))) {
        return;
      }
      await perform(
        node.connectionId,
        {
          kind: 'dropSchema',
          ...(node.database === undefined ? {} : { database: node.database }),
          name: node.schema,
          cascade,
        },
        texts.dropSchema(node.schema),
        texts.drop,
      );
    },

    createTable: async (target) => {
      const node = nodeOf(target, ['database', 'schema', 'group']);
      if (node === undefined || (node.kind === 'group' && node.group !== 'tables')) {
        return;
      }
      const { connectionId } = node;
      const driver = await deps.manager.driverOf(connectionId);
      const scope = scopeOf(node);
      // A database node of a server with schemas means its default schema.
      const withSchema =
        driver.capabilities.schemas && scope.schema === undefined
          ? { ...scope, schema: 'public' }
          : scope;
      const name = await askName(connectionId, texts.newTableName);
      if (name === undefined) {
        return;
      }
      await perform(
        connectionId,
        { kind: 'createTable', table: { ...withSchema, name } },
        texts.createTable(name),
        texts.create,
      );
    },

    dropTable: async (target) => {
      const node = nodeOf(target, ['table']);
      if (node === undefined) {
        return;
      }
      await perform(
        node.connectionId,
        { kind: 'dropTable', table: tableRefOf(node), relation: relationKindOf(node) },
        texts.dropRelation(node.name),
        texts.drop,
      );
    },

    renameTable: async (target) => {
      const node = nodeOf(target, ['table']);
      if (node === undefined) {
        return;
      }
      const newName = await askName(node.connectionId, texts.renameTo(node.name), node.name);
      if (newName === undefined) {
        return;
      }
      await perform(
        node.connectionId,
        {
          kind: 'renameTable',
          table: tableRefOf(node),
          relation: relationKindOf(node),
          newName,
        },
        texts.rename(node.name, newName),
        texts.renameLabel,
      );
    },

    truncateTable: async (target) => {
      const node = nodeOf(target, ['table']);
      if (node?.tableKind !== 'table') {
        return;
      }
      await perform(
        node.connectionId,
        { kind: 'truncateTable', table: tableRefOf(node) },
        texts.truncate(node.name),
        texts.truncateLabel,
      );
    },

    dropObject: async (target) => {
      const node = nodeOf(target, ['object']);
      if (node === undefined) {
        return;
      }
      await perform(
        node.connectionId,
        { kind: 'dropObject', object: node.object },
        texts.dropObject(node.object.name),
        texts.drop,
      );
    },
  };
}

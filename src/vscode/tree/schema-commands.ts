// Tree commands that change the structure: new and dropped databases, schemas and
// tables, renames, TRUNCATE, dropped routines. Every one shows its SQL first, and
// the editor bits arrive through `SchemaUi`, so the flow is covered by unit tests.

import { isDbError } from '../../core/errors';
import { identifierLimit, identifierProblem } from '../../core/sql/identifiers';
import type { ConnectionManager } from '../../services/connection-manager';
import type { SchemaAction, SchemaActions } from '../../services/schema-actions';
import { actionDatabase, actionScript } from '../../services/schema-actions';
import type { ObjectScope } from '../../core/model/objects';
import type { DriverId } from '../../shared/connection';
import { changeVerdict, NO_POLICY, type WritePolicy } from '../../services/write-policy';
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
  alterTable(name: string): string;
  readonly apply: string;
  dropRelation(name: string): string;
  rename(from: string, to: string): string;
  truncate(name: string): string;
  dropObject(name: string): string;
  readonly create: string;
  readonly drop: string;
  readonly renameLabel: string;
  readonly truncateLabel: string;
  done(summary: string): string;
  /** Said instead of running anything on a read-only connection. */
  readOnlyRefused(connection: string): string;
  /** The title of the SQL dialog when it changes a production database. */
  onProduction(connection: string, title: string): string;
}

export interface SchemaCommandDeps {
  readonly actions: Pick<SchemaActions, 'sqlOf' | 'run'>;
  readonly manager: Pick<ConnectionManager, 'driverOf'>;
  readonly ui: SchemaUi;
  readonly texts: SchemaTexts;
  readonly tree: RefreshableTree;
  /** Opens SQL in a new editor bound to the connection, instead of running it. */
  readonly openEditor: (binding: DocumentBinding, sql: string) => Promise<unknown>;
  /** Production and read-only flags of a connection; without it nothing is guarded. */
  readonly policy?: (connectionId: string) => WritePolicy;
  /** Opens the table designer: for a new table in this scope, or for an existing one. */
  readonly openDesigner: (
    connectionId: string,
    scope: ObjectScope,
    table?: string,
  ) => Promise<unknown>;
}

export type SchemaCommandName =
  | 'createDatabase'
  | 'dropDatabase'
  | 'createSchema'
  | 'dropSchema'
  | 'createTable'
  | 'designTable'
  | 'dropTable'
  | 'renameTable'
  | 'truncateTable'
  | 'dropObject';

/** What became of an action the user was shown. */
export type PerformOutcome = 'ran' | 'opened' | 'cancelled' | 'unsupported' | 'refused';

/**
 * Shows the SQL of an action, then runs it or opens it in an editor; a database
 * without the feature just says so. The table designer saves through it as well.
 */
export function schemaPerformer(
  deps: Pick<SchemaCommandDeps, 'actions' | 'ui' | 'texts' | 'tree' | 'openEditor' | 'policy'>,
): (
  connectionId: string,
  action: SchemaAction,
  title: string,
  runLabel: string,
) => Promise<PerformOutcome> {
  const { ui, texts } = deps;
  return async (connectionId, action, title, runLabel) => {
    const policy = deps.policy?.(connectionId) ?? NO_POLICY;
    const verdict = changeVerdict(policy);
    if (verdict === 'refuse') {
      ui.info(texts.readOnlyRefused(policy.name));
      return 'refused';
    }
    let statements: string[];
    try {
      statements = await deps.actions.sqlOf(connectionId, action);
    } catch (error) {
      if (isDbError(error) && error.code === 'unsupported') {
        ui.info(error.message);
        return 'unsupported';
      }
      throw error;
    }
    const sql = actionScript(statements);
    const choice = await ui.confirm({
      title: verdict === 'confirm' ? texts.onProduction(policy.name, title) : title,
      sql,
      runLabel,
    });
    if (choice === 'edit') {
      const database = actionDatabase(action);
      await deps.openEditor(
        database === undefined ? { connectionId } : { connectionId, database },
        sql,
      );
      return 'opened';
    }
    if (choice !== 'run') {
      return 'cancelled';
    }
    await deps.actions.run(connectionId, action, statements);
    deps.tree.refresh();
    const first = statements[0] ?? '';
    ui.info(texts.done(first.split('\n')[0] ?? first));
    return 'ran';
  };
}

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

  const perform = schemaPerformer(deps);

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
      await deps.openDesigner(connectionId, withSchema);
    },

    designTable: async (target) => {
      const node = nodeOf(target, ['table']);
      if (node?.tableKind !== 'table') {
        return;
      }
      await deps.openDesigner(node.connectionId, node.scope, node.name);
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

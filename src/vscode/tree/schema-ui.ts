// The editor side of the structure commands: input boxes, the modal that shows the
// SQL, and every text in the user's language.

import * as vscode from 'vscode';
import type { SchemaTexts, SchemaUi } from './schema-commands';

export function schemaUi(): SchemaUi {
  return {
    askName: async ({ title, value, validate }) =>
      await vscode.window.showInputBox({
        title,
        ...(value === undefined ? {} : { value }),
        validateInput: validate,
        ignoreFocusOut: true,
      }),
    confirm: async ({ title, sql, runLabel }) => {
      const edit = vscode.l10n.t('Open in Editor');
      const choice = await vscode.window.showWarningMessage(
        title,
        { modal: true, detail: sql },
        runLabel,
        edit,
      );
      return choice === runLabel ? 'run' : choice === edit ? 'edit' : undefined;
    },
    pick: async (title, options) =>
      (await vscode.window.showQuickPick(options, { title, placeHolder: title }))?.value,
    info: (message) => {
      void vscode.window.showInformationMessage(message);
    },
  };
}

export function schemaTexts(): SchemaTexts {
  return {
    noDatabases: vscode.l10n.t(
      'This connection is a single database file: there are no databases to create',
    ),
    noSchemas: vscode.l10n.t('This database has no schemas'),
    newDatabaseName: vscode.l10n.t('Name of the new database'),
    newSchemaName: vscode.l10n.t('Name of the new schema'),
    renameTo: (name) => vscode.l10n.t('New name for "{0}"', name),
    typeToConfirm: (name) => vscode.l10n.t('Type "{0}" to confirm', name),
    typeExactly: vscode.l10n.t('Type the name exactly as shown'),
    emptyName: vscode.l10n.t('Enter a name'),
    nulInName: vscode.l10n.t('A name cannot contain a NUL character'),
    tooLong: (limit) => vscode.l10n.t('A name can be at most {0} characters long', limit),
    sameName: vscode.l10n.t('This is the current name'),
    createDatabase: (name) => vscode.l10n.t('Create database "{0}"?', name),
    dropDatabase: (name) => vscode.l10n.t('Drop database "{0}" with everything in it?', name),
    createSchema: (name) => vscode.l10n.t('Create schema "{0}"?', name),
    dropSchema: (name) => vscode.l10n.t('Drop schema "{0}"?', name),
    schemaOnlyIfEmpty: vscode.l10n.t('Only if it is empty'),
    schemaCascade: vscode.l10n.t('With every object inside it (CASCADE)'),
    createTable: (name) => vscode.l10n.t('Create table "{0}"?', name),
    alterTable: (name) => vscode.l10n.t('Apply the changes to table "{0}"?', name),
    apply: vscode.l10n.t('Apply'),
    dropRelation: (name) => vscode.l10n.t('Drop "{0}"?', name),
    rename: (from, to) => vscode.l10n.t('Rename "{0}" to "{1}"?', from, to),
    truncate: (name) => vscode.l10n.t('Delete every row of "{0}"?', name),
    readOnlyRefused: (connection) =>
      vscode.l10n.t('"{0}" is read-only: structure changes are not allowed.', connection),
    onProduction: (connection, title) => vscode.l10n.t('PRODUCTION "{0}": {1}', connection, title),
    dropObject: (name) => vscode.l10n.t('Drop "{0}"?', name),
    create: vscode.l10n.t('Create'),
    drop: vscode.l10n.t('Drop'),
    renameLabel: vscode.l10n.t('Rename'),
    truncateLabel: vscode.l10n.t('Empty Table'),
    done: (summary) => vscode.l10n.t('Done: {0}', summary),
  };
}

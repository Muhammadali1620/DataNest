import * as vscode from 'vscode';
import { errorMessage } from '../../core/errors';
import type { Logger } from '../../core/logging/logger';
import {
  completionContextAt,
  type CompletionContext,
  type TableMention,
} from '../../core/sql/completion-context';
import { keywordsOf } from '../../core/sql/keywords';
import type { ObjectScope } from '../../core/model/objects';
import { ConnectionManager } from '../../services/connection-manager';
import type { ConnectionStore } from '../../services/connection-store';
import type { MetadataCache } from '../../services/metadata-cache';
import type { MetadataReader } from '../../drivers/driver';
import { SQL_LANGUAGE_ID } from './query-editor';
import type { QueryEditors } from './query-editor';

export interface CompletionDeps {
  readonly editors: QueryEditors;
  readonly store: ConnectionStore;
  readonly manager: ConnectionManager;
  readonly cache: MetadataCache;
  readonly logger: Logger;
}

/** Characters that trigger completion on their own. */
export const TRIGGER_CHARACTERS = ['.'];

/**
 * Suggests what fits where the cursor is. Everything comes from the metadata
 * cache, so typing never waits on the server more than once per object list.
 */
export class SqlCompletionProvider implements vscode.CompletionItemProvider {
  private readonly deps: CompletionDeps;
  private readonly logger: Logger;

  constructor(deps: CompletionDeps) {
    this.deps = deps;
    this.logger = deps.logger.child('completion');
  }

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.CompletionItem[]> {
    if (document.languageId !== SQL_LANGUAGE_ID) {
      return [];
    }
    const documentUri = document.uri.toString();
    const binding = this.deps.editors.bindings.get(documentUri);
    const config = binding === undefined ? undefined : this.deps.store.get(binding.connectionId);
    const context = completionContextAt(
      document.getText(),
      document.offsetAt(position),
      config?.driver,
    );
    if (context.inText) {
      return [];
    }
    const items: vscode.CompletionItem[] = [];
    if (context.kind === 'any' || context.kind === 'column') {
      items.push(...this.keywords(keywordsOf(config?.driver)));
    }
    if (binding === undefined || config === undefined) {
      // Without a connection only keywords are known; the status bar invites one.
      return items;
    }
    try {
      items.push(...(await this.fromDatabase(documentUri, context, binding.database)));
    } catch (error) {
      // Completion must never interrupt typing: a failure just offers less.
      this.logger.debug(`No suggestions from the server: ${errorMessage(error)}`);
    }
    return items;
  }

  private keywords(words: readonly string[]): vscode.CompletionItem[] {
    return words.map((word) => {
      const item = new vscode.CompletionItem(word, vscode.CompletionItemKind.Keyword);
      // Keywords come last: object names are what the user is usually after.
      item.sortText = `9_${word}`;
      return item;
    });
  }

  private async fromDatabase(
    documentUri: string,
    context: CompletionContext,
    database: string | undefined,
  ): Promise<vscode.CompletionItem[]> {
    const binding = this.deps.editors.bindings.get(documentUri);
    if (binding === undefined) {
      return [];
    }
    const session = await this.deps.manager.acquire(
      ConnectionManager.editorOwner(documentUri),
      binding,
    );
    const metadata = this.deps.cache.wrap(binding.connectionId, session.metadata);
    const scope: ObjectScope = database === undefined ? {} : { database };
    switch (context.kind) {
      case 'qualified':
        return await this.qualified(metadata, context, scope);
      case 'table':
        return await this.tables(metadata, scope);
      case 'column':
        return [
          ...(await this.columnsOf(metadata, context.tables, scope)),
          ...(await this.tables(metadata, scope)),
        ];
      case 'any':
        return await this.tables(metadata, scope);
    }
  }

  /** After `x.`: the columns of table `x`, or the tables of schema/database `x`. */
  private async qualified(
    metadata: MetadataReader,
    context: CompletionContext,
    scope: ObjectScope,
  ): Promise<vscode.CompletionItem[]> {
    const qualifier = context.qualifier;
    if (qualifier === undefined) {
      return [];
    }
    const mention = context.tables.find(
      (table) => table.alias === qualifier || table.name === qualifier,
    );
    if (mention !== undefined) {
      return await this.columnsOf(metadata, [mention], scope);
    }
    // Not a table of this statement: treat it as a schema or a database name.
    const tables = await metadata.listTables({ ...scope, schema: qualifier });
    if (tables.length > 0) {
      return tables.map((table) => tableItem(table.name, table.kind));
    }
    return (await metadata.listTables({ database: qualifier })).map((table) =>
      tableItem(table.name, table.kind),
    );
  }

  private async tables(
    metadata: MetadataReader,
    scope: ObjectScope,
  ): Promise<vscode.CompletionItem[]> {
    return (await metadata.listTables(scope)).map((table) => tableItem(table.name, table.kind));
  }

  private async columnsOf(
    metadata: MetadataReader,
    mentions: readonly TableMention[],
    scope: ObjectScope,
  ): Promise<vscode.CompletionItem[]> {
    const items: vscode.CompletionItem[] = [];
    for (const mention of mentions) {
      const columns = await metadata.listColumns({
        ...scope,
        ...(mention.database === undefined ? {} : { database: mention.database }),
        ...(mention.schema === undefined ? {} : { schema: mention.schema }),
        name: mention.name,
      });
      for (const column of columns) {
        const item = new vscode.CompletionItem(column.name, vscode.CompletionItemKind.Field);
        item.detail = column.dataType;
        item.documentation = mention.alias ?? mention.name;
        // Columns first, and primary keys before the rest.
        item.sortText = `${column.primaryKey ? '0' : '1'}_${column.name}`;
        items.push(item);
      }
    }
    return items;
  }
}

function tableItem(name: string, kind: 'table' | 'view'): vscode.CompletionItem {
  const item = new vscode.CompletionItem(
    name,
    kind === 'view' ? vscode.CompletionItemKind.Interface : vscode.CompletionItemKind.Struct,
  );
  item.sortText = `2_${name}`;
  return item;
}

import * as vscode from 'vscode';
import { errorMessage } from '../../core/errors';
import type { Logger } from '../../core/logging/logger';
import { ConnectionManager } from '../../services/connection-manager';
import type { ConnectionStore } from '../../services/connection-store';
import type { MetadataCache } from '../../services/metadata-cache';
import type { MetadataReader } from '../../drivers/driver';
import { type CompletionEntry, completionEntries, type EntryKind } from './completion-items';
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

const KINDS: Readonly<Record<EntryKind, vscode.CompletionItemKind>> = {
  keyword: vscode.CompletionItemKind.Keyword,
  table: vscode.CompletionItemKind.Struct,
  view: vscode.CompletionItemKind.Interface,
  column: vscode.CompletionItemKind.Field,
  function: vscode.CompletionItemKind.Function,
  snippet: vscode.CompletionItemKind.Snippet,
  alias: vscode.CompletionItemKind.Variable,
  cte: vscode.CompletionItemKind.Module,
};

/**
 * Suggests what fits where the cursor is (`completion-items.ts` decides). Everything
 * comes from the metadata cache, so typing never waits on the server more than
 * once per object list.
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
    let metadata: MetadataReader | undefined;
    if (binding !== undefined && config !== undefined) {
      try {
        const session = await this.deps.manager.acquire(
          ConnectionManager.editorOwner(documentUri),
          binding,
        );
        metadata = this.deps.cache.wrap(binding.connectionId, session.metadata);
      } catch (error) {
        // Completion must never interrupt typing: without a session it offers less.
        this.logger.debug(`No session for completion: ${errorMessage(error)}`);
      }
    }
    const entries = await completionEntries({
      sql: document.getText(),
      offset: document.offsetAt(position),
      ...(config === undefined ? {} : { driver: config.driver }),
      ...(metadata === undefined ? {} : { metadata }),
      scope: binding?.database === undefined ? {} : { database: binding.database },
      onError: (message) => {
        this.logger.debug(`No suggestions from the server: ${message}`);
      },
    });
    return entries.map(toItem);
  }
}

function toItem(entry: CompletionEntry): vscode.CompletionItem {
  const item = new vscode.CompletionItem(
    entry.description === undefined
      ? entry.label
      : { label: entry.label, description: entry.description },
    KINDS[entry.kind],
  );
  item.sortText = entry.sortText;
  if (entry.detail !== undefined) {
    item.detail = entry.detail;
  }
  if (entry.insertText !== undefined) {
    item.insertText =
      entry.snippet === true ? new vscode.SnippetString(entry.insertText) : entry.insertText;
  }
  return item;
}

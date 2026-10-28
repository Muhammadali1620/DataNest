// Hover over a table or column, and Go to Definition into its DDL. The DDL opens as
// a read-only document of our own scheme, so jumping around never leaves untitled
// editors behind.

import * as vscode from 'vscode';
import { errorMessage, isDbError } from '../../core/errors';
import type { Logger } from '../../core/logging/logger';
import type { ObjectRef } from '../../core/model/objects';
import { browseSession } from '../../services/browse-session';
import { ConnectionManager } from '../../services/connection-manager';
import type { ConnectionStore } from '../../services/connection-store';
import type { MetadataCache } from '../../services/metadata-cache';
import { definitionDocument } from '../../services/object-definitions';
import type { DocumentBindings } from './document-bindings';
import { type HoverTexts, hoverMarkdown } from './sql-hover';
import { definitionTargets, symbolAt } from './sql-symbols';
import { SQL_LANGUAGE_ID } from './query-editor';

/** The scheme of read-only DDL documents opened by Go to Definition. */
export const DDL_SCHEME = 'datanest-ddl';

interface DdlTarget {
  readonly connectionId: string;
  readonly object: ObjectRef;
}

export function ddlUri(target: DdlTarget): vscode.Uri {
  return vscode.Uri.from({
    scheme: DDL_SCHEME,
    path: `/${target.object.name}.sql`,
    query: JSON.stringify(target),
  });
}

function targetOf(uri: vscode.Uri): DdlTarget | undefined {
  try {
    const parsed = JSON.parse(uri.query) as Partial<DdlTarget>;
    return typeof parsed.connectionId === 'string' && typeof parsed.object?.name === 'string'
      ? (parsed as DdlTarget)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Where `name` first appears as a word, so the cursor lands on it. */
function focusOffset(text: string, name: string): number {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`, 'i').exec(text);
  return match?.index ?? 0;
}

function hoverTexts(): HoverTexts {
  return {
    table: vscode.l10n.t('table'),
    view: vscode.l10n.t('view'),
    cte: vscode.l10n.t('defined in this statement'),
    primaryKey: vscode.l10n.t('primary key'),
    nullable: vscode.l10n.t('NULL allowed'),
    notNull: 'NOT NULL',
    defaultIs: (value) => vscode.l10n.t('default {0}', value),
    autoIncrement: vscode.l10n.t('auto-numbered'),
    more: (count) => vscode.l10n.t('…and {0} more columns', count),
  };
}

export interface NavigationDeps {
  readonly bindings: DocumentBindings;
  readonly store: ConnectionStore;
  readonly manager: ConnectionManager;
  readonly cache: MetadataCache;
  readonly logger: Logger;
}

export class SqlNavigation
  implements vscode.HoverProvider, vscode.DefinitionProvider, vscode.TextDocumentContentProvider
{
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  /** Text of the DDL documents opened so far, by URI. */
  private readonly texts = new Map<string, string>();
  private readonly logger: Logger;

  constructor(private readonly deps: NavigationDeps) {
    this.logger = deps.logger.child('navigation');
  }

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.Hover | undefined> {
    const located = this.locate(document, position);
    if (located === undefined) {
      return undefined;
    }
    const { found, binding } = located;
    try {
      const metadata =
        binding === undefined
          ? undefined
          : this.deps.cache.wrap(
              binding.connectionId,
              (
                await this.deps.manager.acquire(
                  ConnectionManager.editorOwner(document.uri.toString()),
                  binding,
                )
              ).metadata,
            );
      const markdown = await hoverMarkdown(found.symbol, metadata, hoverTexts());
      return markdown === undefined
        ? undefined
        : new vscode.Hover(
            new vscode.MarkdownString(markdown),
            new vscode.Range(document.positionAt(found.start), document.positionAt(found.end)),
          );
    } catch (error) {
      // A hover is a nicety: failing to make one must not show an error.
      this.logger.debug(`No hover: ${errorMessage(error)}`);
      return undefined;
    }
  }

  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.Location | undefined> {
    const located = this.locate(document, position);
    const binding = located?.binding;
    const targets = located === undefined ? undefined : definitionTargets(located.found.symbol);
    if (binding === undefined || targets === undefined) {
      return undefined;
    }
    for (const object of targets.objects) {
      const target = { connectionId: binding.connectionId, object };
      const text = await this.read(target).catch((error: unknown) => {
        if (!isDbError(error) || (error.code !== 'not-found' && error.code !== 'unsupported')) {
          this.logger.debug(`No definition: ${errorMessage(error)}`);
        }
        return undefined;
      });
      if (text !== undefined) {
        const uri = ddlUri(target);
        this.texts.set(uri.toString(), text);
        this.changed.fire(uri);
        const offset = focusOffset(text, targets.focus);
        const before = text.slice(0, offset).split('\n');
        return new vscode.Location(
          uri,
          new vscode.Position(before.length - 1, before.at(-1)?.length ?? 0),
        );
      }
    }
    return undefined;
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const known = this.texts.get(uri.toString());
    if (known !== undefined) {
      return known;
    }
    // After a reload the editor may ask for a document we have not read yet.
    const target = targetOf(uri);
    if (target === undefined) {
      return '';
    }
    const text = await this.read(target).catch((error: unknown) => `-- ${errorMessage(error)}\n`);
    this.texts.set(uri.toString(), text);
    return text;
  }

  dispose(): void {
    this.changed.dispose();
    this.texts.clear();
  }

  private locate(document: vscode.TextDocument, position: vscode.Position) {
    if (document.languageId !== SQL_LANGUAGE_ID) {
      return undefined;
    }
    const binding = this.deps.bindings.get(document.uri.toString());
    const driver =
      binding === undefined ? undefined : this.deps.store.get(binding.connectionId)?.driver;
    const found = symbolAt(
      document.getText(),
      document.offsetAt(position),
      driver,
      binding?.database === undefined ? {} : { database: binding.database },
    );
    return found === undefined ? undefined : { found, binding };
  }

  private async read(target: DdlTarget): Promise<string> {
    const driver = await this.deps.manager.driverOf(target.connectionId);
    const session = await browseSession(
      this.deps.manager,
      target.connectionId,
      target.object.database,
    );
    return definitionDocument(await session.metadata.getDefinition(target.object), driver.id);
  }
}

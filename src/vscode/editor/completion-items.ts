// What completion offers at the cursor, decided without `vscode`: keywords, tables,
// columns of every table the statement mentions (CTEs and FROM subqueries included),
// aliases, dialect functions and statement snippets. The provider only turns these
// entries into editor items, so the choices are covered by unit tests.

import { errorMessage } from '../../core/errors';
import type { ObjectScope } from '../../core/model/objects';
import {
  afterTerminator,
  completionContextAt,
  type TableMention,
} from '../../core/sql/completion-context';
import { type DerivedTable, derivedTables } from '../../core/sql/derived-tables';
import { callSnippet, functionsOf } from '../../core/sql/functions';
import { keywordsOf } from '../../core/sql/keywords';
import { snippetsOf } from '../../core/sql/snippets';
import { statementAt } from '../../core/sql/split';
import { isTrivia, syntaxOf, tokenize } from '../../core/sql/tokenizer';
import type { MetadataReader } from '../../drivers/driver';
import type { DriverId } from '../../shared/connection';

export type EntryKind =
  'keyword' | 'table' | 'view' | 'column' | 'function' | 'snippet' | 'alias' | 'cte';

export interface CompletionEntry {
  readonly label: string;
  readonly kind: EntryKind;
  /** Shown next to the label: the table a column or alias belongs to. */
  readonly description?: string;
  /** Shown in the details: the column type, the snippet title. */
  readonly detail?: string;
  /** Text to insert when it differs from the label; a snippet when `snippet` is set. */
  readonly insertText?: string;
  readonly snippet?: boolean;
  /** Orders entries: object names first, keywords last. */
  readonly sortText: string;
}

export interface CompletionInput {
  readonly sql: string;
  readonly offset: number;
  readonly driver?: DriverId;
  /** The connection's structure, cached; absent for a document without one. */
  readonly metadata?: Pick<MetadataReader, 'listTables' | 'listColumns'>;
  /** The database the document is bound to. */
  readonly scope: ObjectScope;
  /** Failures of the server never stop completion; they are only reported here. */
  readonly onError?: (message: string) => void;
}

interface ColumnLike {
  readonly name: string;
  readonly dataType?: string;
  readonly primaryKey?: boolean;
}

export async function completionEntries(input: CompletionInput): Promise<CompletionEntry[]> {
  const { sql, offset, driver } = input;
  const context = completionContextAt(sql, offset, driver);
  if (context.inText) {
    return [];
  }
  const tokens = tokenize(sql, syntaxOf(driver));
  const statement = statementAt(sql, offset, driver);
  // After the terminator of a statement the cursor starts a new one, with no tokens yet.
  const statementTokens =
    statement === undefined || afterTerminator(tokens, statement.end, offset)
      ? []
      : tokens.filter((token) => token.start >= statement.start && token.end <= statement.end);
  const derived = derivedTables(sql, statementTokens);
  const resolver = new ColumnResolver(input, derived);
  const entries: CompletionEntry[] = [];
  const functions = functionsOf(driver);

  if (context.kind === 'any' || context.kind === 'column') {
    // A function comes as a call with its arguments, so the bare keyword is not repeated.
    const names = new Set(functions.map((fn) => fn.name));
    entries.push(
      ...keywordsOf(driver)
        .filter((word) => !names.has(word))
        .map((word) => ({ label: word, kind: 'keyword' as const, sortText: `9_${word}` })),
      ...functions.map((fn) => ({
        label: fn.name,
        kind: 'function' as const,
        detail: `${fn.name}(${fn.args.join(', ')})`,
        insertText: callSnippet(fn),
        snippet: true,
        sortText: `6_${fn.name}`,
      })),
    );
  }
  const first = statementTokens.find((token) => !isTrivia(token));
  if (context.kind === 'any' && (first === undefined || first.start >= context.start)) {
    // Only where a statement begins: a template in the middle of one helps nobody.
    entries.push(
      ...snippetsOf(driver).map((snippet) => ({
        label: snippet.prefix,
        kind: 'snippet' as const,
        detail: snippet.title,
        insertText: snippet.body,
        snippet: true,
        sortText: `8_${snippet.prefix}`,
      })),
    );
  }

  switch (context.kind) {
    case 'qualified': {
      const qualifier = context.qualifier;
      if (qualifier !== undefined) {
        entries.push(...(await resolver.qualified(qualifier, context.tables)));
      }
      break;
    }
    case 'table':
      entries.push(
        ...derived.map((table) => ({
          label: table.name,
          kind: 'cte' as const,
          detail: table.columns.join(', '),
          sortText: `1_${table.name}`,
        })),
        ...(await resolver.tables()),
      );
      break;
    case 'column':
      entries.push(
        ...(await resolver.columns(context.tables)),
        ...context.tables.flatMap((mention) =>
          mention.alias === undefined
            ? []
            : [
                {
                  label: mention.alias,
                  kind: 'alias' as const,
                  description: mention.name,
                  sortText: `3_${mention.alias}`,
                },
              ],
        ),
        ...(await resolver.tables()),
      );
      break;
    case 'any':
      entries.push(...(await resolver.tables()));
      break;
  }
  return entries;
}

/** Looks up tables and columns, answering derived tables from the statement itself. */
class ColumnResolver {
  private readonly byName: ReadonlyMap<string, DerivedTable>;

  constructor(
    private readonly input: CompletionInput,
    derived: readonly DerivedTable[],
  ) {
    this.byName = new Map(derived.map((table) => [table.name.toLowerCase(), table]));
  }

  async tables(): Promise<CompletionEntry[]> {
    const metadata = this.input.metadata;
    if (metadata === undefined) {
      return [];
    }
    const found = await this.safely(async () => await metadata.listTables(this.input.scope), []);
    return found.map((table) => ({
      label: table.name,
      kind: table.kind === 'view' ? ('view' as const) : ('table' as const),
      sortText: `2_${table.name}`,
    }));
  }

  async columns(mentions: readonly TableMention[]): Promise<CompletionEntry[]> {
    const entries: CompletionEntry[] = [];
    for (const mention of mentions) {
      const where = mention.alias ?? mention.name;
      for (const column of await this.columnsOf(mention, 0)) {
        entries.push({
          label: column.name,
          kind: 'column',
          description: where,
          ...(column.dataType === undefined ? {} : { detail: column.dataType }),
          // Columns first, and primary keys before the rest.
          sortText: `${column.primaryKey === true ? '0' : '1'}_${column.name}`,
        });
      }
    }
    return entries;
  }

  /** After `x.`: the columns of table, alias or CTE `x`, or the tables of schema `x`. */
  async qualified(
    qualifier: string,
    mentions: readonly TableMention[],
  ): Promise<CompletionEntry[]> {
    const lower = qualifier.toLowerCase();
    const mention =
      mentions.find((m) => m.alias?.toLowerCase() === lower) ??
      mentions.find((m) => m.name.toLowerCase() === lower) ??
      (this.byName.has(lower) ? { name: qualifier } : undefined);
    if (mention !== undefined) {
      const columns = await this.columns([{ ...mention, alias: qualifier }]);
      // `FROM archive.|` reads as a table named archive while the schema is typed.
      if (columns.length > 0 || mention.alias !== undefined) {
        return columns;
      }
    }
    const metadata = this.input.metadata;
    if (metadata === undefined) {
      return [];
    }
    // Not a table of this statement: a schema, or else a database.
    const inSchema = await this.safely(
      async () => await metadata.listTables({ ...this.input.scope, schema: qualifier }),
      [],
    );
    const tables =
      inSchema.length > 0
        ? inSchema
        : await this.safely(async () => await metadata.listTables({ database: qualifier }), []);
    return tables.map((table) => ({
      label: table.name,
      kind: table.kind === 'view' ? ('view' as const) : ('table' as const),
      sortText: `2_${table.name}`,
    }));
  }

  /** A derived table answers from its select list; `*` reaches its source tables. */
  private async columnsOf(mention: TableMention, depth: number): Promise<ColumnLike[]> {
    const derived =
      mention.schema === undefined && mention.database === undefined
        ? this.byName.get(mention.name.toLowerCase())
        : undefined;
    if (derived !== undefined) {
      if (depth > 2) {
        // A CTE that reads itself (WITH RECURSIVE) must not send us in circles.
        return derived.columns.map((name) => ({ name }));
      }
      const fromStar = await Promise.all(
        derived.starFrom.map(async (source) => await this.columnsOf(source, depth + 1)),
      );
      return [...derived.columns.map((name) => ({ name })), ...fromStar.flat()];
    }
    const metadata = this.input.metadata;
    if (metadata === undefined) {
      return [];
    }
    return await this.safely(
      async () =>
        await metadata.listColumns({
          ...this.input.scope,
          ...(mention.database === undefined ? {} : { database: mention.database }),
          ...(mention.schema === undefined ? {} : { schema: mention.schema }),
          name: mention.name,
        }),
      [],
    );
  }

  private async safely<T>(read: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await read();
    } catch (error) {
      this.input.onError?.(errorMessage(error));
      return fallback;
    }
  }
}

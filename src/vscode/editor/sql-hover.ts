// The text of a hover over a table, column or CTE: type, nullability, default,
// keys and comments, read through the metadata cache. Free of `vscode`.

import type { ColumnDetail, ForeignKey, TableRef } from '../../core/model/objects';
import type { MetadataReader } from '../../drivers/driver';
import type { SqlSymbol } from './sql-symbols';

export interface HoverTexts {
  readonly table: string;
  readonly view: string;
  readonly cte: string;
  readonly primaryKey: string;
  readonly nullable: string;
  readonly notNull: string;
  readonly defaultIs: (value: string) => string;
  readonly autoIncrement: string;
  readonly more: (count: number) => string;
}

type Reader = Pick<
  MetadataReader,
  'describeTable' | 'listColumns' | 'listForeignKeys' | 'listTables'
>;

/** Most columns a table hover lists before it says how many more there are. */
const MAX_COLUMNS = 25;

/** A name in a code span; a backtick inside needs a wider fence. */
function code(text: string): string {
  return text.includes('`') ? `\`\` ${text} \`\`` : `\`${text}\``;
}

/** Markdown would read `*`, `_` and friends in a comment as formatting. */
function plain(text: string): string {
  return text.replace(/([\\`*_{}[\]()#+\-.!|<>])/g, '\\$1');
}

interface Described {
  readonly columns: readonly ColumnDetail[];
  readonly primaryKey: readonly string[];
  readonly foreignKeys: readonly ForeignKey[];
  readonly comment?: string;
}

/** The full structure where the server gives it, else the basic column list (views). */
async function describe(reader: Reader, table: TableRef): Promise<Described | undefined> {
  try {
    const structure = await reader.describeTable(table);
    return structure;
  } catch {
    const columns = await reader.listColumns(table).catch(() => []);
    if (columns.length === 0) {
      return undefined;
    }
    return {
      columns: columns.map((c) => ({
        name: c.name,
        dataType: c.dataType,
        nullable: c.nullable,
        autoIncrement: false,
        generated: false,
        ...(c.defaultValue === undefined ? {} : { defaultExpression: c.defaultValue }),
      })),
      primaryKey: columns.filter((c) => c.primaryKey).map((c) => c.name),
      foreignKeys: [],
    };
  }
}

function keyOf(keys: readonly ForeignKey[], column: string): ForeignKey | undefined {
  return keys.find((key) => key.columns.includes(column));
}

function target(key: ForeignKey, column: string): string {
  const position = key.columns.indexOf(column);
  return `→ ${key.target.name}.${key.targetColumns[position] ?? ''}`;
}

function columnLine(table: Described, column: ColumnDetail, texts: HoverTexts): string {
  const parts = [column.nullable ? texts.nullable : texts.notNull];
  if (table.primaryKey.includes(column.name)) {
    parts.push(texts.primaryKey);
  }
  if (column.autoIncrement) {
    parts.push(texts.autoIncrement);
  }
  if (column.defaultExpression !== undefined) {
    parts.push(texts.defaultIs(code(column.defaultExpression)));
  }
  const key = keyOf(table.foreignKeys, column.name);
  if (key !== undefined) {
    parts.push(target(key, column.name));
  }
  return parts.join(' · ');
}

async function tableHover(
  reader: Reader,
  table: TableRef,
  texts: HoverTexts,
): Promise<string | undefined> {
  const described = await describe(reader, table);
  if (described === undefined) {
    return undefined;
  }
  const tables = await reader.listTables(table).catch(() => []);
  const isView = tables.some((t) => t.name === table.name && t.kind === 'view');
  const lines = [`**${plain(table.name)}** — ${isView ? texts.view : texts.table}`];
  if (described.comment !== undefined) {
    lines.push('', `_${plain(described.comment)}_`);
  }
  lines.push('', '| | | |', '|---|---|---|');
  for (const column of described.columns.slice(0, MAX_COLUMNS)) {
    lines.push(
      `| ${code(column.name)} | ${code(column.dataType)} | ${columnLine(described, column, texts)} |`,
    );
  }
  if (described.columns.length > MAX_COLUMNS) {
    lines.push('', texts.more(described.columns.length - MAX_COLUMNS));
  }
  return lines.join('\n');
}

async function columnHover(
  reader: Reader,
  table: TableRef,
  name: string,
  texts: HoverTexts,
): Promise<string | undefined> {
  const described = await describe(reader, table);
  const column = described?.columns.find((c) => c.name.toLowerCase() === name.toLowerCase());
  if (described === undefined || column === undefined) {
    return undefined;
  }
  const lines = [
    `**${plain(table.name)}.${plain(column.name)}** ${code(column.dataType)}`,
    '',
    columnLine(described, column, texts),
  ];
  if (column.comment !== undefined) {
    lines.push('', `_${plain(column.comment)}_`);
  }
  return lines.join('\n');
}

/** The hover of a symbol, or nothing when it names nothing the server knows. */
export async function hoverMarkdown(
  symbol: SqlSymbol,
  reader: Reader | undefined,
  texts: HoverTexts,
): Promise<string | undefined> {
  if (symbol.kind === 'cte') {
    const { derived } = symbol;
    const columns = derived.columns.map((c) => code(c)).join(', ');
    return `**${plain(derived.name)}** — ${texts.cte}${columns === '' ? '' : `\n\n${columns}`}`;
  }
  if (reader === undefined) {
    return undefined;
  }
  switch (symbol.kind) {
    case 'table':
      return await tableHover(reader, symbol.table, texts);
    case 'column':
      return await columnHover(reader, symbol.table, symbol.column, texts);
    case 'loose-column': {
      const found: string[] = [];
      for (const table of symbol.tables) {
        const text = await columnHover(reader, table, symbol.column, texts);
        if (text !== undefined) {
          found.push(text);
        }
      }
      return found.length === 0 ? undefined : found.join('\n\n---\n\n');
    }
    case 'routine':
      return undefined;
  }
}

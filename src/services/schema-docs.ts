// Documentation of a database or schema (V10.2.6) as one Markdown file: a table of
// contents, each table with its columns, keys, indexes and the tables that point at it,
// then the definitions of views, routines, triggers, sequences and events. The file is
// for people, in English like every file DataNest writes (ARCHITECTURE.md §10).

import type { ForeignKey, ObjectKind, ObjectScope } from '../core/model/objects';
import type { SchemaSnapshot, TableSnapshot } from './schema-compare/snapshot';

export interface SchemaDocumentOptions {
  /** What the document is about, e.g. `shop` or `shop.public`. */
  readonly title: string;
  /** The connection's name, shown under the title. */
  readonly connection: string;
  /** ISO date of the reading, `2026-10-31`. */
  readonly date: string;
}

/** Section titles of the kinds a snapshot holds besides tables. */
const KIND_TITLES: Readonly<Partial<Record<ObjectKind, string>>> = {
  view: 'Views',
  function: 'Functions',
  procedure: 'Procedures',
  trigger: 'Triggers',
  sequence: 'Sequences',
  event: 'Events',
};

function kindTitle(kind: ObjectKind): string {
  return KIND_TITLES[kind] ?? kind;
}

/** GitHub's anchor of a heading: lower case, punctuation dropped, spaces to dashes. */
export function anchorOf(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/gu, '-');
}

/** Text safe inside a Markdown table cell: pipes escaped, lines joined. */
export function cell(text: string | undefined): string {
  return (text ?? '').replace(/\\/gu, '\\\\').replace(/\|/gu, '\\|').replace(/\r?\n/gu, ' ');
}

/** A name as code: backticks inside are doubled-up fences, so any name stays code. */
export function code(name: string): string {
  const fence = name.includes('`') ? '``' : '`';
  const padded = name.startsWith('`') || name.endsWith('`') ? ` ${name} ` : name;
  return `${fence}${padded}${fence}`;
}

/** Headings of the tables, made unique the way GitHub numbers repeated anchors. */
function anchors(tables: readonly TableSnapshot[]): Map<string, string> {
  const used = new Map<string, number>();
  const result = new Map<string, string>();
  for (const table of tables) {
    const base = anchorOf(table.name) || 'table';
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    result.set(table.name, seen === 0 ? base : `${base}-${seen}`);
  }
  return result;
}

function keyMarks(table: TableSnapshot, column: string): string {
  const { structure } = table;
  const marks: string[] = [];
  if (structure.primaryKey.includes(column)) {
    marks.push('PK');
  }
  if (structure.foreignKeys.some((key) => key.columns.includes(column))) {
    marks.push('FK');
  }
  const unique = structure.indexes.some(
    (index) =>
      index.unique && !index.primary && index.columns.length === 1 && index.columns[0] === column,
  );
  if (unique) {
    marks.push('unique');
  }
  return marks.join(', ');
}

function link(name: string, anchorsByName: ReadonlyMap<string, string>): string {
  const anchor = anchorsByName.get(name);
  return anchor === undefined ? code(name) : `[${code(name)}](#${anchor})`;
}

function columnList(columns: readonly string[]): string {
  return columns.map(code).join(', ');
}

function foreignKeyLine(
  key: ForeignKey,
  anchorsByName: ReadonlyMap<string, string>,
  scope: ObjectScope,
): string {
  const actions = [
    key.onDelete === undefined || key.onDelete === 'NO ACTION' ? '' : `ON DELETE ${key.onDelete}`,
    key.onUpdate === undefined || key.onUpdate === 'NO ACTION' ? '' : `ON UPDATE ${key.onUpdate}`,
  ].filter((part) => part !== '');
  // A table of the same schema has a section to link to; another one is named in full.
  const here = key.target.schema === undefined || key.target.schema === scope.schema;
  const target = here
    ? link(key.target.name, anchorsByName)
    : code([key.target.schema, key.target.name].join('.'));
  return `- ${code(key.name)}: ${columnList(key.columns)} → ${target} (${columnList(key.targetColumns)})${actions.length === 0 ? '' : ` ${actions.join(', ')}`}`;
}

function tableSection(
  table: TableSnapshot,
  referencedBy: readonly { readonly from: string; readonly columns: readonly string[] }[],
  anchorsByName: ReadonlyMap<string, string>,
  scope: ObjectScope,
): string[] {
  const { structure } = table;
  const lines = [`### ${table.name}`, ''];
  if (structure.comment !== undefined && structure.comment.trim() !== '') {
    lines.push(structure.comment.trim(), '');
  }
  lines.push('| Column | Type | Null | Default | Key | Comment |', '|---|---|---|---|---|---|');
  for (const column of structure.columns) {
    const value = column.generated
      ? 'computed'
      : column.autoIncrement
        ? 'auto increment'
        : column.defaultExpression === undefined
          ? ''
          : code(column.defaultExpression);
    lines.push(
      `| ${code(column.name)} | ${code(column.dataType)} | ${column.nullable ? 'yes' : 'no'} | ${cell(value)} | ${keyMarks(table, column.name)} | ${cell(column.comment)} |`,
    );
  }
  const indexes = structure.indexes.filter((index) => !index.primary);
  if (indexes.length > 0) {
    lines.push('', '**Indexes**', '');
    for (const index of indexes) {
      const kind = [index.unique ? 'unique' : '', index.method ?? ''].filter((part) => part !== '');
      lines.push(
        `- ${code(index.name)}: ${columnList(index.columns)}${kind.length === 0 ? '' : ` (${kind.join(', ')})`}${index.where === undefined ? '' : ` where ${code(index.where)}`}`,
      );
    }
  }
  if (structure.foreignKeys.length > 0) {
    lines.push('', '**Foreign keys**', '');
    for (const key of structure.foreignKeys) {
      lines.push(foreignKeyLine(key, anchorsByName, scope));
    }
  }
  if (referencedBy.length > 0) {
    lines.push('', '**Referenced by**', '');
    for (const reference of referencedBy) {
      lines.push(`- ${link(reference.from, anchorsByName)} (${columnList(reference.columns)})`);
    }
  }
  lines.push('');
  return lines;
}

export function schemaDocument(snapshot: SchemaSnapshot, options: SchemaDocumentOptions): string {
  const tables = [...snapshot.tables].sort((a, b) => a.name.localeCompare(b.name));
  const anchorsByName = anchors(tables);
  const referencedBy = new Map<string, { from: string; columns: readonly string[] }[]>();
  for (const table of tables) {
    for (const key of table.structure.foreignKeys) {
      const list = referencedBy.get(key.target.name) ?? [];
      list.push({ from: table.name, columns: key.columns });
      referencedBy.set(key.target.name, list);
    }
  }
  const kinds = [...new Set(snapshot.objects.map((object) => object.ref.kind))];
  const lines = [
    `# ${options.title}`,
    '',
    `Documentation of ${code(options.title)} on the connection ${code(options.connection)}, read by DataNest on ${options.date}.`,
    '',
    '## Contents',
    '',
    `- [Tables](#tables) (${tables.length})`,
    ...kinds.map((kind) => {
      const title = kindTitle(kind);
      const count = snapshot.objects.filter((object) => object.ref.kind === kind).length;
      return `- [${title}](#${anchorOf(title)}) (${count})`;
    }),
    '',
    '## Tables',
    '',
  ];
  if (tables.length === 0) {
    lines.push('There are no tables.', '');
  }
  for (const table of tables) {
    lines.push(`- ${link(table.name, anchorsByName)}`);
  }
  if (tables.length > 0) {
    lines.push('');
  }
  for (const table of tables) {
    lines.push(
      ...tableSection(table, referencedBy.get(table.name) ?? [], anchorsByName, snapshot.scope),
    );
  }
  for (const kind of kinds) {
    lines.push(`## ${kindTitle(kind)}`, '');
    for (const object of snapshot.objects.filter((candidate) => candidate.ref.kind === kind)) {
      const signature = object.ref.signature === undefined ? '' : `(${object.ref.signature})`;
      const on =
        object.ref.table === undefined ? '' : ` on ${link(object.ref.table, anchorsByName)}`;
      lines.push(`### ${object.ref.name}${signature}`, '');
      if (on !== '') {
        lines.push(`A trigger${on}.`, '');
      }
      if (object.statements === undefined) {
        lines.push('_The server does not show its definition to this user._', '');
        continue;
      }
      // A fence longer than any run of backticks in the definition always closes it.
      const longest = Math.max(
        2,
        ...object.statements.flatMap((statement) =>
          [...statement.matchAll(/`+/gu)].map((match) => match[0].length),
        ),
      );
      const fence = '`'.repeat(longest + 1);
      lines.push(
        `${fence}sql`,
        ...object.statements.map((statement) => `${statement};`),
        fence,
        '',
      );
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

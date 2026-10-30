// The script that turns the target schema into the source (V8.3), for the chosen
// differences, in an order that works: views and triggers that change go first and
// come back last, new tables before the tables that point at them, functions before
// the views and triggers that call them. DataNest only writes it; the user reviews and
// runs it.

import { errorMessage } from '../../core/errors';
import type { ObjectScope, TableRef } from '../../core/model/objects';
import type { Dialect } from '../../drivers/driver';
import type { DriverId } from '../../shared/connection';
import type { TableDesign } from '../../shared/table-design';
import { commentLine, orderViews, scriptStatement } from '../dump-script';
import type { CompareItem, ObjectItem, TableItem } from './compare';

export interface MigrationInput {
  readonly items: readonly CompareItem[];
  readonly dialect: Dialect;
  readonly driver: DriverId;
  readonly target: ObjectScope;
  readonly sourceLabel: string;
  readonly targetLabel: string;
  readonly date: Date;
}

/** One piece of the script: comments and statements of one difference. */
interface Part {
  readonly comments: string[];
  readonly statements: string[];
}

const ROUTINES = new Set(['function', 'procedure', 'event']);

export function migrationScript(input: MigrationInput): string {
  const out: string[] = [
    commentLine('DataNest schema migration'),
    commentLine(`From (source): ${input.sourceLabel}`),
    commentLine(`To (target):   ${input.targetLabel}`),
    commentLine(`Written ${input.date.toISOString()}. Review it before running.`),
  ];
  const sections = migrationSections(input);
  for (const [title, parts] of sections) {
    if (parts.length === 0) {
      continue;
    }
    out.push('\n', commentLine(title));
    for (const part of parts) {
      out.push(...part.comments.map(commentLine));
      out.push(...part.statements.map((sql) => scriptStatement(sql, input.driver)));
    }
  }
  if (sections.every(([, parts]) => parts.length === 0)) {
    out.push('\n', commentLine('Nothing to change.'));
  }
  return out.join('');
}

/** The statements one difference adds to the script, for the page's preview. */
export function itemStatements(item: CompareItem, input: Omit<MigrationInput, 'items'>): Part {
  const sections = migrationSections({ ...input, items: [item] });
  return {
    comments: sections.flatMap(([, parts]) => parts.flatMap((part) => part.comments)),
    statements: sections.flatMap(([, parts]) => parts.flatMap((part) => part.statements)),
  };
}

function migrationSections(input: MigrationInput): [string, Part[]][] {
  const tables = input.items.filter((item): item is TableItem => item.kind === 'table');
  const objects = input.items.filter(
    (item): item is ObjectItem => item.kind !== 'table' && item.hidden === undefined,
  );
  const of = (kinds: (kind: string) => boolean, statuses: readonly string[]) =>
    objects.filter((item) => kinds(item.kind) && statuses.includes(item.status));
  const views = (statuses: readonly string[]) => of((kind) => kind === 'view', statuses);
  const ddl = input.dialect.ddl;
  const drop = (item: ObjectItem): Part =>
    guarded(() => [
      item.kind === 'view'
        ? ddl.dropRelation(item.ref, item.ref.materialized === true ? 'materialized-view' : 'view')
        : ddl.dropObject(item.ref),
    ]);
  const create = (item: ObjectItem): Part => ({
    comments: [],
    statements: [...(item.source ?? [])],
  });
  const viewOrder = (items: ObjectItem[]): ObjectItem[] =>
    orderViews(
      items.map((item) => ({
        item,
        name: item.name,
        sql: (item.source ?? item.target ?? []).join('\n'),
      })),
      input.driver,
    ).map((entry) => entry.item);
  const sequences = of((kind) => kind === 'sequence', ['added', 'changed', 'removed']);
  return [
    [
      'Views that change or go: dropped first, created again below',
      viewOrder(views(['changed', 'removed']))
        .reverse()
        .map(drop),
    ],
    [
      'Triggers that change or go',
      of((kind) => kind === 'trigger', ['changed', 'removed']).map(drop),
    ],
    [
      'Functions, procedures and events that change or go',
      of((kind) => ROUTINES.has(kind), ['changed', 'removed']).map(drop),
    ],
    ['New sequences', sequences.filter((item) => item.status === 'added').map(create)],
    [
      'Sequences that differ: not recreated, so their current values stay',
      sequences
        .filter((item) => item.status === 'changed')
        .map((item) => ({
          comments: [
            `${item.name} differs. In the source:`,
            ...(item.source ?? []).flatMap((sql) => sql.split('\n')),
          ],
          statements: [],
        })),
    ],
    [
      'New tables',
      createOrder(tables.filter((item) => item.status === 'added')).map((item) =>
        createTable(item, input),
      ),
    ],
    [
      'Tables that differ',
      tables.filter((item) => item.status === 'changed').map((item) => alterTable(item, input)),
    ],
    [
      'Tables only in the target',
      dropOrder(tables.filter((item) => item.status === 'removed')).map((item) =>
        guarded(() => [ddl.dropRelation(refOf(item.name, input.target), 'table')]),
      ),
    ],
    [
      'Sequences only in the target',
      sequences.filter((item) => item.status === 'removed').map(drop),
    ],
    [
      'Functions, procedures and events',
      of((kind) => ROUTINES.has(kind), ['added', 'changed']).map(create),
    ],
    ['Views', viewOrder(views(['added', 'changed'])).map(create)],
    ['Triggers', of((kind) => kind === 'trigger', ['added', 'changed']).map(create)],
  ];
}

function createTable(item: TableItem, input: MigrationInput): Part {
  const source = item.source;
  if (source === undefined) {
    return { comments: [], statements: [] };
  }
  const part = guarded(() =>
    input.dialect.ddl.createTable(
      refOf(item.name, input.target),
      withoutOriginals(source.loaded.design),
    ),
  );
  return {
    comments: [...item.notes.map((note) => `${item.name}: ${note}`), ...part.comments],
    statements: part.statements,
  };
}

function alterTable(item: TableItem, input: MigrationInput): Part {
  const { target, after } = item;
  const notes = item.notes.map((note) => `${item.name}: ${note}`);
  if (target === undefined || after === undefined) {
    return { comments: notes, statements: [] };
  }
  try {
    const plan = input.dialect.ddl.alterTable(
      refOf(item.name, input.target),
      target.loaded.design,
      after,
      target.loaded.background,
    );
    return {
      comments: [
        ...notes,
        ...plan.notes.map((note) =>
          note === 'rebuild'
            ? `${item.name} is copied into a new table: slow on big tables`
            : `${item.name}: the column order is not changed`,
        ),
      ],
      statements: [...plan.statements],
    };
  } catch (error) {
    return {
      comments: [...notes, `${item.name} cannot be changed this way: ${errorMessage(error)}`],
      statements: [],
    };
  }
}

/** A statement the dialect refuses becomes a comment that says why. */
function guarded(make: () => readonly string[]): Part {
  try {
    return { comments: [], statements: [...make()] };
  } catch (error) {
    return { comments: [`Skipped: ${errorMessage(error)}`], statements: [] };
  }
}

/** A new table comes after the new tables its keys point at; a cycle keeps its order. */
function createOrder(items: readonly TableItem[]): TableItem[] {
  const byName = new Map(items.map((item) => [item.name, item]));
  const needs = (item: TableItem): TableItem[] =>
    (item.source?.loaded.design.foreignKeys ?? [])
      .filter((key) => key.targetSchema === undefined && key.targetTable !== item.name)
      .flatMap((key) => byName.get(key.targetTable) ?? []);
  return topological(items, needs);
}

/** A table to drop goes before the dropped tables it points at. */
function dropOrder(items: readonly TableItem[]): TableItem[] {
  const byName = new Map(items.map((item) => [item.name, item]));
  const needs = (item: TableItem): TableItem[] =>
    (item.target?.loaded.design.foreignKeys ?? [])
      .filter((key) => key.targetSchema === undefined && key.targetTable !== item.name)
      .flatMap((key) => byName.get(key.targetTable) ?? []);
  return topological(items, needs).reverse();
}

function topological<T>(items: readonly T[], needs: (item: T) => T[]): T[] {
  const ordered: T[] = [];
  const placed = new Set<T>();
  const visiting = new Set<T>();
  const place = (item: T): void => {
    if (placed.has(item) || visiting.has(item)) {
      return;
    }
    visiting.add(item);
    for (const needed of needs(item)) {
      place(needed);
    }
    visiting.delete(item);
    placed.add(item);
    ordered.push(item);
  };
  for (const item of items) {
    place(item);
  }
  return ordered;
}

function withoutOriginals(design: TableDesign): TableDesign {
  return {
    ...design,
    columns: design.columns.map(({ original: _original, ...column }) => column),
    indexes: design.indexes.map(({ original: _original, ...index }) => index),
    foreignKeys: design.foreignKeys.map(({ original: _original, ...key }) => key),
  };
}

function refOf(name: string, scope: ObjectScope): TableRef {
  return { ...scope, name };
}

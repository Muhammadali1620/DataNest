// What the schema comparison page (V8.3) shows, free of `vscode`: both schemas read,
// the differences, one difference in detail, and the script of the chosen ones.

import { DbError } from '../../core/errors';
import type { ObjectScope } from '../../core/model/objects';
import type { Dialect } from '../../drivers/driver';
import {
  type CompareItem,
  compareSchemas,
  type TableItem,
} from '../../services/schema-compare/compare';
import { itemStatements, migrationScript } from '../../services/schema-compare/migration';
import type { SchemaSnapshot } from '../../services/schema-compare/snapshot';
import { scriptStatement } from '../../services/dump-script';
import type { DriverId } from '../../shared/connection';
import type {
  SchemaCompareChange,
  SchemaCompareDetail,
  SchemaCompareState,
} from '../../shared/protocols/schema-compare';
import type {
  ColumnDesign,
  ForeignKeyDesign,
  IndexDesign,
  TableDesign,
} from '../../shared/table-design';
import { composeType, columnNames } from '../../shared/table-design';
import { lineDiff } from '../../shared/text-diff';
import { msg } from '../../core/user-message';

export interface CompareSide {
  readonly connectionId: string;
  /** `Local · shop.public`. */
  readonly label: string;
  readonly scope: ObjectScope;
  /** Reads the schema; `onProgress` tells how far it got. */
  readonly read: (options: {
    signal?: AbortSignal;
    onProgress?: (done: number, total: number) => void;
  }) => Promise<SchemaSnapshot>;
}

export interface SchemaCompareModelDeps {
  readonly source: CompareSide;
  readonly target: CompareSide;
  readonly dialect: Dialect;
  readonly driver: DriverId;
}

export class SchemaCompareModel {
  private source: CompareSide;
  private target: CompareSide;
  private items: CompareItem[] | undefined;
  private loading: SchemaCompareState['loading'];
  private error: string | undefined;

  constructor(private readonly deps: SchemaCompareModelDeps) {
    this.source = deps.source;
    this.target = deps.target;
  }

  get loaded(): boolean {
    return this.items !== undefined;
  }

  /** The side scripts change, for the editor they open in. */
  get targetSide(): CompareSide {
    return this.target;
  }

  async load(
    options: { signal?: AbortSignal; onProgress?: (state: SchemaCompareState) => void } = {},
  ): Promise<void> {
    this.error = undefined;
    this.items = undefined;
    try {
      const read = async (
        side: 'source' | 'target',
        from: CompareSide,
      ): Promise<SchemaSnapshot> => {
        this.loading = { side, done: 0, total: 0 };
        options.onProgress?.(this.state());
        return await from.read({
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          onProgress: (done, total) => {
            this.loading = { side, done, total };
            options.onProgress?.(this.state());
          },
        });
      };
      const source = await read('source', this.source);
      const target = await read('target', this.target);
      this.items = compareSchemas(source, target, {
        driver: this.deps.driver,
        quote: (name) => this.deps.dialect.quoteIdentifier(name),
      });
    } catch (error) {
      if (error instanceof DbError && error.code === 'cancelled') {
        throw error;
      }
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.loading = undefined;
    }
  }

  /** Compares the other way round; the next load reads both again. */
  swap(): void {
    [this.source, this.target] = [this.target, this.source];
    this.items = undefined;
  }

  state(): SchemaCompareState {
    return {
      source: this.source.label,
      target: this.target.label,
      ...(this.loading === undefined ? {} : { loading: this.loading }),
      items: (this.items ?? []).map((item) => ({
        id: item.id,
        kind: item.kind,
        name: item.name,
        status: item.status,
        ...(item.kind !== 'table' && (item.ref.table ?? item.ref.signature) !== undefined
          ? { context: item.ref.table ?? item.ref.signature }
          : {}),
        ...(item.kind !== 'table' && item.hidden !== undefined ? { hidden: true as const } : {}),
      })),
      ...(this.error === undefined ? {} : { error: this.error }),
    };
  }

  detail(id: string, date = new Date()): SchemaCompareDetail {
    const item = this.find(id);
    const part = itemStatements(item, this.scriptInput(date));
    const script = [
      ...part.comments.map((comment) => `-- ${comment}\n`),
      ...part.statements.map((sql) => scriptStatement(sql, this.deps.driver)),
    ].join('');
    if (item.kind === 'table') {
      return { id, ...tableChanges(item), script };
    }
    return {
      id,
      columns: [],
      keys: [],
      notes: [],
      diff: lineDiff((item.target ?? []).join('\n\n'), (item.source ?? []).join('\n\n')),
      script,
      ...(item.hidden === undefined ? {} : { hidden: item.hidden }),
    };
  }

  /** The script of the chosen differences; unknown ids are ignored. */
  script(ids: readonly string[], date = new Date()): string {
    const wanted = new Set(ids);
    return migrationScript({
      ...this.scriptInput(date),
      items: (this.items ?? []).filter((item) => wanted.has(item.id) && item.status !== 'same'),
    });
  }

  private scriptInput(date: Date) {
    return {
      dialect: this.deps.dialect,
      driver: this.deps.driver,
      target: this.target.scope,
      sourceLabel: this.source.label,
      targetLabel: this.target.label,
      date,
    };
  }

  private find(id: string): CompareItem {
    const item = this.items?.find((candidate) => candidate.id === id);
    if (item === undefined) {
      throw new DbError('not-found', msg('This difference is no longer in the comparison'));
    }
    return item;
  }
}

function describeColumn(column: ColumnDesign): string {
  return [
    composeType(column.type, column.length),
    column.nullable ? '' : 'NOT NULL',
    column.defaultValue === '' ? '' : `DEFAULT ${column.defaultValue}`,
    column.autoIncrement ? 'AUTO_INCREMENT' : '',
    column.comment === '' ? '' : `COMMENT ${JSON.stringify(column.comment)}`,
  ]
    .filter((part) => part !== '')
    .join(' ');
}

function describeIndex(design: TableDesign, index: IndexDesign): string {
  return `${index.unique ? 'UNIQUE ' : ''}(${columnNames(design, index.columns).join(', ')})`;
}

function describeKey(design: TableDesign, key: ForeignKeyDesign): string {
  const target =
    key.targetSchema === undefined ? key.targetTable : `${key.targetSchema}.${key.targetTable}`;
  return `(${columnNames(design, key.columns).join(', ')}) → ${target} (${key.targetColumns.join(', ')}) ON DELETE ${key.onDelete} ON UPDATE ${key.onUpdate}`;
}

/** Column, key and comment differences of a table as lines for the page. */
function tableChanges(item: TableItem): Omit<SchemaCompareDetail, 'id' | 'script'> {
  const before = item.target?.loaded.design;
  const after = item.after ?? item.source?.loaded.design;
  const notes = [...item.notes];
  if (before === undefined || after === undefined) {
    const only = before ?? after;
    if (only === undefined) {
      return { columns: [], keys: [], notes, diff: [] };
    }
    const added = before === undefined;
    const side = (text: string): { before: string } | { after: string } =>
      added ? { after: text } : { before: text };
    const change = added ? ('added' as const) : ('removed' as const);
    return {
      columns: only.columns.map((column) => ({
        name: column.name,
        change,
        ...side(describeColumn(column)),
      })),
      keys: [
        ...only.indexes.map((index) => ({
          kind: 'index' as const,
          name: index.name,
          change,
          ...side(describeIndex(only, index)),
        })),
        ...only.foreignKeys.map((key) => ({
          kind: 'foreignKey' as const,
          name: key.name,
          change,
          ...side(describeKey(only, key)),
        })),
      ],
      notes,
      diff: [],
    };
  }
  const diff = item.diff;
  const columns: SchemaCompareChange[] = [
    ...(diff?.added ?? []).map((column) => ({
      name: column.name,
      change: 'added' as const,
      after: describeColumn(column),
    })),
    ...(diff?.dropped ?? []).map((column) => ({
      name: column.name,
      change: 'removed' as const,
      before: describeColumn(column),
    })),
    ...(diff?.changed ?? []).map((change) => ({
      name: change.after.name,
      change: 'changed' as const,
      before: describeColumn(change.before),
      after: describeColumn(change.after),
    })),
  ];
  const keys: SchemaCompareDetail['keys'] = [];
  if (diff?.primaryKey === true) {
    const keyOf = (design: TableDesign) =>
      design.columns
        .filter((column) => column.primaryKey)
        .map((column) => column.name)
        .join(', ');
    keys.push({
      kind: 'primaryKey',
      name: 'PRIMARY KEY',
      change: 'changed',
      before: `(${keyOf(before)})`,
      after: `(${keyOf(after)})`,
    });
  }
  const pair = <T extends { readonly name: string }>(
    kind: 'index' | 'foreignKey',
    dropped: readonly T[],
    added: readonly T[],
    describe: (design: TableDesign, part: T) => string,
  ): void => {
    for (const part of added) {
      const old = dropped.find((candidate) => candidate.name === part.name);
      keys.push({
        kind,
        name: part.name,
        change: old === undefined ? 'added' : 'changed',
        ...(old === undefined ? {} : { before: describe(before, old) }),
        after: describe(after, part),
      });
    }
    for (const part of dropped) {
      if (!added.some((candidate) => candidate.name === part.name)) {
        keys.push({ kind, name: part.name, change: 'removed', before: describe(before, part) });
      }
    }
  };
  pair('index', diff?.droppedIndexes ?? [], diff?.addedIndexes ?? [], describeIndex);
  pair('foreignKey', diff?.droppedKeys ?? [], diff?.addedKeys ?? [], describeKey);
  return {
    columns,
    keys,
    ...(diff?.comment === true
      ? { comment: { before: before.comment, after: after.comment } }
      : {}),
    notes,
    diff: [],
  };
}

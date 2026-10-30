// What the data comparison page (V8.4) shows, free of `vscode`: the column pairs and
// key, how far the comparison got, its counts, the kept rows a page at a time, and
// the sync script.

import { errorMessage, isDbError } from '../../core/errors';
import type { TableStructure } from '../../core/model/objects';
import type { ColumnPair } from '../../services/data-compare/column-pairs';
import {
  columnModes,
  targetTypes,
  writableColumns,
  writesIdentity,
} from '../../services/data-compare/column-pairs';
import { type ColumnMode, sameValue } from '../../services/data-compare/comparable';
import {
  type CompareTable,
  compareTableData,
  type DataCompareResult,
  type KeptRow,
} from '../../services/data-compare/data-compare';
import { syncScript } from '../../services/data-compare/sync-script';
import type { CellValue } from '../../shared/cell-value';
import { cellText } from '../../shared/cell-text';
import type { DriverId } from '../../shared/connection';
import type {
  DataCompareRow,
  DataCompareState,
  RowKind,
} from '../../shared/protocols/data-compare';

export interface DataCompareSide extends CompareTable {
  /** `Local · shop.orders`. */
  readonly label: string;
  readonly driver: DriverId;
  readonly structure: TableStructure;
}

export interface DataCompareModelDeps {
  readonly source: DataCompareSide;
  readonly target: DataCompareSide;
  readonly key: readonly ColumnPair[];
  readonly columns: readonly ColumnPair[];
  readonly sourceOnly: readonly string[];
  readonly targetOnly: readonly string[];
  /** The target database has transactions, so the script runs in one. */
  readonly transactions: boolean;
}

/** Longest text of one cell the page gets; the rest is cut with `…`. */
const CELL_TEXT = 2000;

export class DataCompareModel {
  private result: DataCompareResult | undefined;
  private progress: DataCompareState['progress'];
  private error: string | undefined;

  private readonly modes: ColumnMode[];

  constructor(private readonly deps: DataCompareModelDeps) {
    this.modes = columnModes([...deps.key, ...deps.columns], deps.source, deps.target);
  }

  get loaded(): boolean {
    return this.result !== undefined || this.error !== undefined;
  }

  async run(
    options: { signal?: AbortSignal; onProgress?: (state: DataCompareState) => void } = {},
  ): Promise<void> {
    this.result = undefined;
    this.error = undefined;
    this.progress = { phase: 'target', rows: 0 };
    try {
      this.result = await compareTableData({
        source: this.deps.source,
        target: this.deps.target,
        key: this.deps.key,
        columns: this.deps.columns,
        modes: this.modes,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        onProgress: (progress) => {
          this.progress = progress;
          options.onProgress?.(this.state());
        },
      });
    } catch (error) {
      if (isDbError(error) && error.code === 'cancelled') {
        throw error;
      }
      this.error = errorMessage(error);
    } finally {
      this.progress = undefined;
    }
  }

  state(): DataCompareState {
    const result = this.result;
    return {
      source: this.deps.source.label,
      target: this.deps.target.label,
      key: [...this.deps.key],
      columns: [...this.deps.columns],
      sourceOnly: [...this.deps.sourceOnly],
      targetOnly: [...this.deps.targetOnly],
      ...(this.progress === undefined ? {} : { progress: this.progress }),
      ...(result === undefined
        ? {}
        : {
            result: {
              same: result.same,
              different: result.different,
              onlySource: result.onlySource,
              onlyTarget: result.onlyTarget,
              kept: {
                different: result.differentRows.length,
                onlySource: result.onlySourceRows.length,
                onlyTarget: result.onlyTargetRows.length,
              },
              durationMs: result.durationMs,
            },
          }),
      ...(this.error === undefined ? {} : { error: this.error }),
    };
  }

  rows(kind: RowKind, offset: number, limit: number): DataCompareRow[] {
    const result = this.result;
    if (result === undefined) {
      return [];
    }
    const width = this.deps.key.length;
    const texts = (row: KeptRow): (string | null)[] => row.map(text);
    switch (kind) {
      case 'onlySource':
        return result.onlySourceRows
          .slice(offset, offset + limit)
          .map((row) => ({ cells: texts(row) }));
      case 'onlyTarget':
        return result.onlyTargetRows
          .slice(offset, offset + limit)
          .map((row) => ({ cells: texts(row) }));
      case 'different':
        return result.differentRows.slice(offset, offset + limit).map(({ source, target }) => ({
          cells: texts(source),
          target: texts(target),
          differs: source.map(
            (cell, index) =>
              index >= width && !sameValue(cell, target[index] ?? null, this.modes[index]),
          ),
        }));
    }
  }

  script(
    include: { insert: boolean; update: boolean; delete: boolean },
    date = new Date(),
  ): string {
    const result = this.result;
    const target = this.deps.target;
    const key = this.deps.key.map((pair) => pair.target);
    const columns = this.deps.columns.map((pair) => pair.target);
    return syncScript({
      dialect: target.dialect,
      driver: target.driver,
      table: target.table,
      key,
      columns,
      types: targetTypes([...this.deps.key, ...this.deps.columns], target.structure, target.driver),
      modes: this.modes,
      writable: writableColumns(target.structure),
      identity: writesIdentity(target.structure, [...key, ...columns]),
      transactions: this.deps.transactions,
      result: result ?? {
        same: 0,
        different: 0,
        onlySource: 0,
        onlyTarget: 0,
        differentRows: [],
        onlySourceRows: [],
        onlyTargetRows: [],
        durationMs: 0,
      },
      include,
      sourceLabel: this.deps.source.label,
      targetLabel: target.label,
      date,
    });
  }
}

function text(cell: CellValue): string | null {
  if (cell === null) {
    return null;
  }
  const value = cellText(cell);
  return value.length > CELL_TEXT ? `${value.slice(0, CELL_TEXT)}…` : value;
}

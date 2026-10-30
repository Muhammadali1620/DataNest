// Which columns of two tables are compared, and by which key (V8.4): columns pair up
// by name (exactly, or else ignoring case, so `ID` meets `id` across databases); the
// key is the source's primary key, or the target's, or a unique index, when all its
// columns are in both tables.

import type { TableStructure } from '../../core/model/objects';
import type { DriverId } from '../../shared/connection';
import { type NeutralType, neutralType } from '../transfer/type-map';
import type { ColumnMode } from './comparable';

export interface ColumnPair {
  readonly source: string;
  readonly target: string;
}

export interface ComparisonPlan {
  /** Every column both tables have. */
  readonly pairs: readonly ColumnPair[];
  /** The key found, or empty when the user has to choose one. */
  readonly key: readonly ColumnPair[];
  readonly sourceOnly: readonly string[];
  readonly targetOnly: readonly string[];
}

export function pairColumns(source: TableStructure, target: TableStructure): ComparisonPlan {
  const targetNames = target.columns.map((column) => column.name);
  const matchOf = new Map<string, string>();
  const taken = new Set<string>();
  for (const { name } of source.columns) {
    if (targetNames.includes(name)) {
      matchOf.set(name, name);
      taken.add(name);
    }
  }
  for (const { name } of source.columns) {
    const match = matchOf.has(name)
      ? undefined
      : targetNames.find(
          (other) => !taken.has(other) && other.toLowerCase() === name.toLowerCase(),
        );
    if (match !== undefined) {
      matchOf.set(name, match);
      taken.add(match);
    }
  }
  const pairs = source.columns.flatMap(({ name }) => {
    const match = matchOf.get(name);
    return match === undefined ? [] : [{ source: name, target: match }];
  });
  return {
    pairs,
    key: findKey(source, target, pairs),
    sourceOnly: source.columns.map((column) => column.name).filter((name) => !matchOf.has(name)),
    targetOnly: targetNames.filter((name) => !taken.has(name)),
  };
}

function findKey(
  source: TableStructure,
  target: TableStructure,
  pairs: readonly ColumnPair[],
): ColumnPair[] {
  const bySource = new Map(pairs.map((pair) => [pair.source, pair]));
  const byTarget = new Map(pairs.map((pair) => [pair.target, pair]));
  const all = (
    names: readonly string[],
    lookup: Map<string, ColumnPair>,
  ): ColumnPair[] | undefined => {
    const found = names.flatMap((name) => lookup.get(name) ?? []);
    return names.length > 0 && found.length === names.length ? found : undefined;
  };
  const unique = source.indexes
    .filter((index) => index.unique && !index.primary && index.where === undefined)
    .map((index) => all(index.columns, bySource))
    .find((key) => key !== undefined);
  return all(source.primaryKey, bySource) ?? all(target.primaryKey, byTarget) ?? unique ?? [];
}

/** Target columns a sync script may write: not computed. */
export function writableColumns(target: TableStructure): Set<string> {
  return new Set(target.columns.filter((column) => !column.generated).map((column) => column.name));
}

/** True when an INSERT of these columns writes an auto-numbered one. */
export function writesIdentity(target: TableStructure, columns: readonly string[]): boolean {
  const written = new Set(columns);
  return target.columns.some((column) => column.autoIncrement && written.has(column.name));
}

/** Each pair's type as the target sees it, for values written into it. */
export function targetTypes(
  pairs: readonly ColumnPair[],
  target: TableStructure,
  driver: DriverId,
): NeutralType[] {
  return pairs.map((pair) =>
    neutralType(
      target.columns.find((column) => column.name === pair.target)?.dataType ?? 'text',
      driver,
    ),
  );
}

/** JSON or date-time when either side's type says so, plain otherwise. */
export function columnModes(
  pairs: readonly ColumnPair[],
  source: { readonly structure: TableStructure; readonly driver: DriverId },
  target: { readonly structure: TableStructure; readonly driver: DriverId },
): ColumnMode[] {
  const kindOf = (side: typeof source, name: string): NeutralType['kind'] =>
    neutralType(
      side.structure.columns.find((column) => column.name === name)?.dataType ?? 'text',
      side.driver,
    ).kind;
  return pairs.map((pair) => {
    const kinds = [kindOf(source, pair.source), kindOf(target, pair.target)];
    if (kinds.includes('json')) {
      return 'json';
    }
    return kinds.some((kind) => kind === 'datetime' || kind === 'date' || kind === 'time')
      ? 'datetime'
      : 'plain';
  });
}

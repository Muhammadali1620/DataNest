// What the Dump section's form keeps: which relations are ticked, and how a finished
// dump is told.

import type { ManagerDumpOptions } from '../../../../src/shared/protocols/manager';

type Relation = ManagerDumpOptions['relations'][number];

/** Relations whose names contain the filter, case ignored. */
export function filterRelations(relations: readonly Relation[], text: string): Relation[] {
  const needle = text.trim().toLowerCase();
  return needle === ''
    ? [...relations]
    : relations.filter((relation) => relation.name.toLowerCase().includes(needle));
}

/** Ticks or unticks every name in `names`, keeping the ticks of names not in `names`. */
export function setTicked(
  ticked: readonly string[],
  names: readonly string[],
  on: boolean,
): string[] {
  const rest = ticked.filter((name) => !names.includes(name));
  return on ? [...rest, ...names] : rest;
}

/** The dump can run: something is ticked (or the routines are asked for) and there is a path. */
export function canRun(ticked: readonly string[], wholeScope: boolean, output: string): boolean {
  return (ticked.length > 0 || wholeScope) && output.trim() !== '';
}

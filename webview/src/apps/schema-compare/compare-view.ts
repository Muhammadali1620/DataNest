// What the schema comparison page (V8.3) works out itself: which differences are
// ticked at first, how they group by kind, and the counts in the summary.

import {
  COMPARE_KINDS,
  type SchemaCompareItem,
} from '../../../../src/shared/protocols/schema-compare';

/** New and changed objects go into the script at first; drops only when ticked. */
export function defaultSelection(items: readonly SchemaCompareItem[]): string[] {
  return items
    .filter(
      (item) => (item.status === 'added' || item.status === 'changed') && item.hidden !== true,
    )
    .map((item) => item.id);
}

/** True for items a script can include. */
export function selectable(item: SchemaCompareItem): boolean {
  return item.status !== 'same' && item.hidden !== true;
}

export interface KindGroup {
  readonly kind: SchemaCompareItem['kind'];
  readonly items: readonly SchemaCompareItem[];
}

const STATUS_ORDER: Readonly<Record<SchemaCompareItem['status'], number>> = {
  changed: 0,
  added: 1,
  removed: 2,
  same: 3,
};

/** Kinds in a fixed order; inside, differences first, then by name. */
export function groupByKind(items: readonly SchemaCompareItem[], showSame: boolean): KindGroup[] {
  return COMPARE_KINDS.flatMap((kind) => {
    const of = items
      .filter((item) => item.kind === kind && (showSame || item.status !== 'same'))
      .sort(
        (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.name.localeCompare(b.name),
      );
    return of.length === 0 ? [] : [{ kind, items: of }];
  });
}

export function counts(
  items: readonly SchemaCompareItem[],
): Record<SchemaCompareItem['status'], number> {
  const result = { added: 0, removed: 0, changed: 0, same: 0 };
  for (const item of items) {
    result[item.status] += 1;
  }
  return result;
}

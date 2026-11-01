// The tree of a RedisJSON document on the key page (V13.14), free of Svelte: which rows
// are shown for the nodes loaded so far, how a node reads, and how the keys move around.

import type { JsonNodeInfo } from '../../../../src/shared/protocols/redis-key';
import type { CodiconName } from '../../lib/codicons';
import type { Translate } from '../../lib/i18n';
import type { Tone } from '../../components/tone';

/** The children of one opened node, as loaded so far. */
export interface LoadedChildren {
  readonly nodes: readonly JsonNodeInfo[];
  /** Children in all. */
  readonly total: number;
  readonly more: boolean;
}

export type LoadedMap = Readonly<Record<string, LoadedChildren | undefined>>;
export type OpenMap = Readonly<Record<string, true | undefined>>;

export type JsonRow =
  | {
      readonly type: 'node';
      readonly node: JsonNodeInfo;
      readonly depth: number;
      /** Path of the parent; undefined for the root. */
      readonly parent: string | undefined;
      /** Kind of the parent: an item of an array is written `[3]`, a member by its name. */
      readonly parentKind: string | undefined;
      readonly open: boolean;
      /** It has members to open. */
      readonly expandable: boolean;
      /** Opened, but its children are still on the way. */
      readonly loading: boolean;
    }
  | {
      readonly type: 'more';
      readonly path: string;
      readonly depth: number;
      readonly shown: number;
      readonly total: number;
    };

export function isContainer(node: JsonNodeInfo): boolean {
  return (node.kind === 'object' || node.kind === 'array') && (node.size ?? 0) > 0;
}

/** The rows from the root down, opened nodes followed by their loaded children. */
export function rowsOf(root: JsonNodeInfo, open: OpenMap, loaded: LoadedMap): JsonRow[] {
  const rows: JsonRow[] = [];
  const add = (node: JsonNodeInfo, depth: number, parent: JsonNodeInfo | undefined): void => {
    const expandable = isContainer(node);
    const isOpen = expandable && open[node.path] === true;
    const children = loaded[node.path];
    rows.push({
      type: 'node',
      node,
      depth,
      parent: parent?.path,
      parentKind: parent?.kind,
      open: isOpen,
      expandable,
      loading: isOpen && children === undefined,
    });
    if (!isOpen || children === undefined) {
      return;
    }
    for (const child of children.nodes) {
      add(child, depth + 1, node);
    }
    if (children.more) {
      rows.push({
        type: 'more',
        path: node.path,
        depth: depth + 1,
        shown: children.nodes.length,
        total: children.total,
      });
    }
  };
  add(root, 0, undefined);
  return rows;
}

/** A colour class and an icon per kind, so a document reads at a glance. */
export type KindTone = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';

export function toneOf(kind: string): KindTone {
  switch (kind) {
    case 'object':
    case 'array':
    case 'string':
    case 'boolean':
      return kind;
    case 'integer':
    case 'number':
      return 'number';
    default:
      return 'null';
  }
}

export function iconOf(kind: string): CodiconName {
  switch (toneOf(kind)) {
    case 'object':
      return 'symbol-structure';
    case 'array':
      return 'symbol-array';
    case 'string':
      return 'symbol-string';
    case 'number':
      return 'symbol-numeric';
    case 'boolean':
      return 'symbol-boolean';
    case 'null':
      return 'circle-slash';
  }
}

/** The chart colour of an icon: containers cool, strings green, numbers warm; null stays grey. */
export function toneColor(kind: string): Tone | undefined {
  switch (toneOf(kind)) {
    case 'object':
      return 'blue';
    case 'array':
      return 'purple';
    case 'string':
      return 'green';
    case 'number':
      return 'orange';
    case 'boolean':
      return 'teal';
    case 'null':
      return undefined;
  }
}

/** The name of a kind in the user's language; a kind the module added later shows as it is. */
export function kindName(kind: string, t: Translate): string {
  switch (kind) {
    case 'object':
    case 'array':
    case 'string':
    case 'integer':
    case 'number':
    case 'boolean':
    case 'null':
      return t(`redis.json.kind.${kind}`);
    default:
      return kind;
  }
}

/** What stands next to the name of a node: its size for a container, else its value. */
export function summaryOf(node: JsonNodeInfo, t: Translate): string {
  switch (node.kind) {
    case 'object':
      return t('redis.json.members', node.size ?? 0);
    case 'array':
      return t('redis.json.itemsCount', node.size ?? 0);
    case 'string':
      return node.preview === undefined
        ? t('redis.json.chars', node.size ?? 0)
        : JSON.stringify(node.preview);
    default:
      return node.preview ?? '';
  }
}

/** A row's label: the member name, `[3]` for an item, the document itself for the root. */
export function labelOf(node: JsonNodeInfo, parentKind: string | undefined, t: Translate): string {
  if (node.path === '$') {
    return t('redis.json.document');
  }
  return parentKind === 'array' ? `[${node.label}]` : node.label;
}

export type TreeKey = 'next' | 'previous' | 'first' | 'last' | 'open' | 'close';

/** The arrow keys of a tree. */
export function treeKeyOf(key: string): TreeKey | undefined {
  switch (key) {
    case 'ArrowDown':
      return 'next';
    case 'ArrowUp':
      return 'previous';
    case 'Home':
      return 'first';
    case 'End':
      return 'last';
    case 'ArrowRight':
      return 'open';
    case 'ArrowLeft':
      return 'close';
    default:
      return undefined;
  }
}

/**
 * Where a key takes the selection from `from` (an index into `rows`): the next or
 * previous node (the "load more" rows are skipped), the first or last, or — for the left
 * arrow on a closed node — the parent. Undefined when it stays.
 */
export function moveTo(
  rows: readonly JsonRow[],
  from: number,
  key: 'next' | 'previous' | 'first' | 'last' | 'parent',
): number | undefined {
  const nodeAt = (index: number): boolean => rows[index]?.type === 'node';
  switch (key) {
    case 'next': {
      for (let index = from + 1; index < rows.length; index += 1) {
        if (nodeAt(index)) {
          return index;
        }
      }
      return undefined;
    }
    case 'previous': {
      for (let index = from - 1; index >= 0; index -= 1) {
        if (nodeAt(index)) {
          return index;
        }
      }
      return undefined;
    }
    case 'first':
      return nodeAt(0) && from !== 0 ? 0 : undefined;
    case 'last': {
      for (let index = rows.length - 1; index > from; index -= 1) {
        if (nodeAt(index)) {
          return index;
        }
      }
      return undefined;
    }
    case 'parent': {
      const row = rows[from];
      if (row?.type !== 'node' || row.parent === undefined) {
        return undefined;
      }
      const parent = row.parent;
      const index = rows.findIndex((entry) => entry.type === 'node' && entry.node.path === parent);
      return index === -1 ? undefined : index;
    }
  }
}

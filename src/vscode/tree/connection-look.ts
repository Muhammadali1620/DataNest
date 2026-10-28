// How a connection stands out in the tree: its color label and its production and
// read-only marks. Free of `vscode`, so the rules are unit-tested; the decoration
// provider only wraps the result.

import type { ConnectionColor, ConnectionConfig } from '../../shared/connection';

/** Theme colors every theme defines (they also color charts), so labels adapt to it. */
export const COLOR_THEME_IDS: Readonly<Record<ConnectionColor, string>> = {
  red: 'charts.red',
  orange: 'charts.orange',
  yellow: 'charts.yellow',
  green: 'charts.green',
  blue: 'charts.blue',
  purple: 'charts.purple',
};

export interface ConnectionLook {
  /** Theme color id for the label and the badge. */
  readonly color?: string;
  readonly badge?: string;
  readonly tooltip?: string;
}

export type ConnectionTag = 'production' | 'read-only';

/** The marks a connection wears, in a fixed order. */
export function tagsOf(config: ConnectionConfig | undefined): ConnectionTag[] {
  const tags: ConnectionTag[] = [];
  if (config?.production === true) {
    tags.push('production');
  }
  if (config?.readOnly === true) {
    tags.push('read-only');
  }
  return tags;
}

/**
 * Production is red unless the user picked another color, and wears a "P"; a
 * read-only connection wears "RO"; any other colored one a dot.
 */
export function lookOf(
  config: ConnectionConfig | undefined,
  tagText: (tag: ConnectionTag) => string = (tag) => tag,
): ConnectionLook | undefined {
  const tags = tagsOf(config);
  const color = config?.color ?? (tags.includes('production') ? 'red' : undefined);
  if (color === undefined && tags.length === 0) {
    return undefined;
  }
  const badge = tags.includes('production') ? 'P' : tags.includes('read-only') ? 'RO' : '●';
  return {
    ...(color === undefined ? {} : { color: COLOR_THEME_IDS[color] }),
    badge,
    ...(tags.length === 0 ? {} : { tooltip: tags.map(tagText).join(', ') }),
  };
}

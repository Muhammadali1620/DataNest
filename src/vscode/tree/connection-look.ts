// How a connection stands out in the tree: its color label. Free of `vscode`, so the
// rules are unit-tested; the decoration provider only wraps the result.

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
}

export function lookOf(config: ConnectionConfig | undefined): ConnectionLook | undefined {
  if (config?.color === undefined) {
    return undefined;
  }
  return { color: COLOR_THEME_IDS[config.color], badge: '●' };
}

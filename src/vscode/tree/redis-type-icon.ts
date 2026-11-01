// The icon of a Redis key in the tree, by its type. Free of `vscode`: the tree wraps the
// result in a ThemeIcon, and the rules are unit-tested.

export interface RedisTypeIcon {
  /** A codicon name. */
  readonly icon: string;
  /** A theme color id; absent for the plain icon. */
  readonly color?: string;
}

/**
 * Codicons per Redis type. RedisJSON (V13.14) has an icon and a color of its own, so a
 * document stands out among strings and hashes; another module's type gets a generic one.
 */
export function redisTypeIcon(type: string | undefined): RedisTypeIcon {
  switch (type) {
    case 'string':
      return { icon: 'symbol-string' };
    case 'hash':
      return { icon: 'symbol-structure' };
    case 'list':
      return { icon: 'list-ordered' };
    case 'set':
      return { icon: 'symbol-array' };
    case 'zset':
      return { icon: 'list-filter' };
    case 'stream':
      return { icon: 'pulse' };
    case 'ReJSON-RL':
      return { icon: 'json', color: 'charts.yellow' };
    case undefined:
      return { icon: 'key' };
    default:
      return { icon: 'extensions' };
  }
}

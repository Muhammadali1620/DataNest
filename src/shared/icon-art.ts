// The colours and tiles of the extension's own icons (D113). Pure strings, so the
// generator script and the tests share them. Colours are fixed here on purpose: these
// are image files that read on dark and light themes alike.

export type IconTone = 'blue' | 'green' | 'orange' | 'red' | 'purple' | 'teal' | 'pink' | 'amber';

export const TONES: Readonly<Record<IconTone, { from: string; to: string; mid: string }>> = {
  blue: { from: '#58a6ff', to: '#2563eb', mid: '#3b82f6' },
  green: { from: '#4ade80', to: '#15a34a', mid: '#22c55e' },
  orange: { from: '#fdba4d', to: '#ea580c', mid: '#f97316' },
  red: { from: '#fb7185', to: '#dc2626', mid: '#ef4444' },
  purple: { from: '#c084fc', to: '#7c3aed', mid: '#a855f7' },
  teal: { from: '#2dd4bf', to: '#0891b2', mid: '#14b8a6' },
  pink: { from: '#f472b6', to: '#db2777', mid: '#ec4899' },
  amber: { from: '#fcd34d', to: '#d97706', mid: '#f59e0b' },
};

export interface PanelTile {
  /** A codicon drawn white on the tile. */
  readonly glyph: string;
  readonly tone: IconTone;
  /** Own white shapes instead of a codicon, drawn in a box of `ownSize` pixels. */
  readonly own?: string;
  readonly ownSize?: number;
}

// The extension's logo (a database), and the grid of the results.
const LOGO =
  '<g fill="none" stroke="#fff" stroke-width="1.700" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="7" ry="2.800"/><path d="M5 5v14c0 1.500 3.100 2.800 7 2.800s7-1.300 7-2.800V5"/><path d="M5 12c0 1.500 3.100 2.800 7 2.800s7-1.300 7-2.800"/></g>';
const GRID =
  '<path fill="#fff" fill-rule="evenodd" d="M4 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm0 1.200A.8.8 0 0 0 3.200 4v1.300h9.600V4a.8.8 0 0 0-.8-.8H4zM3.200 6.500v2.300h2.900V6.500H3.200zm4.100 0v2.300h5.500V6.500H7.300zM3.200 10v2a.8.8 0 0 0 .8.8h2.100V10H3.200zm4.100 0v2.800H12a.8.8 0 0 0 .8-.8v-2H7.300z"/>';

/** Every page that has a tab icon, with its colour; the key is the app name. */
export const PANEL_TILES: Readonly<Record<string, PanelTile>> = {
  'connection-form': { glyph: 'plug', tone: 'green' },
  'data-compare': { glyph: 'git-compare', tone: 'orange' },
  'data-import': { glyph: 'insert', tone: 'teal' },
  'elastic-result': { glyph: 'search', tone: 'purple' },
  'er-diagram': { glyph: 'type-hierarchy', tone: 'pink' },
  manager: { glyph: 'dashboard', tone: 'teal' },
  'mongo-documents': { glyph: 'json', tone: 'green' },
  ping: { glyph: 'debug-disconnect', tone: 'teal' },
  'query-plan': { glyph: 'list-tree', tone: 'amber' },
  'redis-console': { glyph: 'terminal', tone: 'red' },
  'redis-info': { glyph: 'info', tone: 'red' },
  'redis-key': { glyph: 'key', tone: 'red' },
  'result-chart': { glyph: 'graph', tone: 'pink' },
  'result-grid': { glyph: 'table', tone: 'blue', own: GRID, ownSize: 16 },
  'schema-compare': { glyph: 'diff', tone: 'orange' },
  'server-monitor': { glyph: 'pulse', tone: 'green' },
  'table-designer': { glyph: 'symbol-structure', tone: 'purple' },
  'test-data': { glyph: 'beaker', tone: 'amber' },
  tools: { glyph: 'tools', tone: 'blue', own: LOGO, ownSize: 24 },
  'user-admin': { glyph: 'organization', tone: 'teal' },
};

/** A 16-pixel tab icon: a rounded tile in the tone's gradient with the shapes in white. */
export function panelSvg(app: string, shapes: string, tone: IconTone, ownSize?: number): string {
  const t = TONES[tone];
  const id = `dn-tile-${app}`;
  // A codicon is 16 wide; it is drawn 10 wide in the middle of the tile.
  const scale = 10 / (ownSize ?? 16);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">` +
    `<defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${t.from}"/><stop offset="1" stop-color="${t.to}"/></linearGradient></defs>` +
    `<rect width="16" height="16" rx="4.500" fill="url(#${id})"/>` +
    `<g transform="translate(3 3) scale(${Number(scale.toFixed(4))})" fill="#fff">${shapes}</g></svg>`
  );
}

/** The icons of the "actions" list of a tree item: a codicon and the tone it is drawn in. */
export const ACTION_ICONS: Readonly<Record<string, IconTone>> = {
  table: 'blue',
  edit: 'orange',
  'file-code': 'teal',
  wand: 'purple',
  'type-hierarchy': 'pink',
  'symbol-keyword': 'amber',
  copy: 'blue',
  clippy: 'teal',
  refresh: 'green',
  'clear-all': 'orange',
  trash: 'red',
  'arrow-up': 'green',
  'arrow-down': 'blue',
  'go-to-file': 'blue',
  organization: 'teal',
};

export function actionSvg(shapes: string, colour: string, size = 16): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 ${size} ${size}" fill="${colour}">${shapes}</svg>`;
}

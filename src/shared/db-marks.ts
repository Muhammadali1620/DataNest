// The marks of the databases (D113, revised): a recognisable brand glyph on a clean rounded
// tile. The glyph paths come from the CC0 `simple-icons` package (scripts/make-icons.mjs
// copies them into db-brand-paths.ts); a vendor missing there (SQL Server, Oracle) gets a
// simple drawing of ours on the same tile. The names and glyphs are trademarks of their
// owners and only identify the product (resources/licenses/brands.txt). One source for the
// connection form (inline in the page), the tree (files in resources/icons/db, written by
// the same script) and the tests that keep the two in step.

import type { DriverId } from './connection';
import { BRAND_PATHS } from './db-brand-paths';

interface Art {
  /** Tile colour; the gradient runs from a lighter shade of it. */
  readonly hex: string;
  /** Glyph colour on the tile. */
  readonly ink: string;
  /** Shapes in a 24 × 24 box. */
  readonly body: string;
}

const WHITE = '#ffffff';
const DARK = '#1f1f1f';

/** Our own simple drawings, white on the tile, for vendors the glyph package does not hold. */
const OWN: Readonly<Partial<Record<DriverId, Art>>> = {
  // A rack of three servers.
  mssql: {
    hex: '#cc2927',
    ink: WHITE,
    body: '<rect x="2" y="3" width="20" height="5" rx="1.500"/><rect x="2" y="9.500" width="20" height="5" rx="1.500"/><rect x="2" y="16" width="20" height="5" rx="1.500"/>',
  },
  // A plug: the mark of a database that another extension added (V12.7).
  plugin: {
    hex: '#6d28d9',
    ink: WHITE,
    body: '<rect x="4" y="8" width="16" height="9" rx="2.500"/><rect x="7.500" y="2.500" width="3" height="6"/><rect x="13.500" y="2.500" width="3" height="6"/><rect x="10.500" y="16" width="3" height="5.500"/>',
  },
  // A stack of discs: a server database reached over HTTP (V13.17); libSQL has no glyph in
  // the package, and the drawing is ours.
  libsql: {
    hex: '#0d9488',
    ink: WHITE,
    body: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 9.500c0 1.700 3.600 3 8 3s8-1.300 8-3v3.500c0 1.700-3.600 3-8 3s-8-1.300-8-3zM4 16.500c0 1.700 3.600 3 8 3s8-1.300 8-3V19c0 1.700-3.600 3-8 3s-8-1.300-8-3z"/>',
  },
  // A wave over a baseline: a time series (V13.20); the vendor's logo is not ours to use.
  influxdb: {
    hex: '#7c3aed',
    ink: WHITE,
    body: '<path d="M2 14h4l2.500-8 4 14 3-9 1.500 3H22" fill="none" stroke="currentColor" stroke-width="2.600" stroke-linecap="round" stroke-linejoin="round"/>',
  },
  // Three nodes joined by edges: a graph database (V13.21); the vendor's logo is not ours to use.
  neo4j: {
    hex: '#4f46e5',
    ink: WHITE,
    body: '<path d="M12 6 6 17.500M12 6l6 11.500M6 17.500h12" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="5.500" r="3.200"/><circle cx="5.500" cy="18" r="3.200"/><circle cx="18.500" cy="18" r="3.200"/>',
  },
  // Lines of a log, one short: what Loki stores (V13.25); the vendor's logo is not ours to use.
  loki: {
    hex: '#ea580c',
    ink: WHITE,
    body: '<rect x="3" y="4.500" width="18" height="3.200" rx="1.600"/><rect x="3" y="10.400" width="12" height="3.200" rx="1.600"/><rect x="3" y="16.300" width="15" height="3.200" rx="1.600"/>',
  },
  // A ring of four nodes: the ring Cassandra spreads its data over (V13.22); the vendor's logo is
  // not ours to use.
  cassandra: {
    hex: '#0891b2',
    ink: WHITE,
    body: '<circle cx="12" cy="12" r="6.500" fill="none" stroke="currentColor" stroke-width="1.800"/><circle cx="12" cy="5.500" r="2.600"/><circle cx="18.500" cy="12" r="2.600"/><circle cx="12" cy="18.500" r="2.600"/><circle cx="5.500" cy="12" r="2.600"/>',
  },
  // A key: the thing etcd stores values under (V13.19); the vendor's logo is not ours to use.
  etcd: {
    hex: '#2563eb',
    ink: WHITE,
    body: '<circle cx="7.500" cy="12" r="4.500" fill="none" stroke="currentColor" stroke-width="3"/><rect x="11" y="10.500" width="11" height="3"/><rect x="16" y="13" width="2.500" height="4.500"/><rect x="20" y="13" width="2" height="3.500"/>',
  },
  // One source feeding two readers: the shape of a topic with its consumers (V13.23); the
  // vendor's logo is not ours to use.
  kafka: {
    hex: '#ea580c',
    ink: WHITE,
    body: '<circle cx="6" cy="12" r="3"/><circle cx="18" cy="6" r="2.500"/><circle cx="18" cy="18" r="2.500"/><path d="M8.500 10.700l7.200-3.600M8.500 13.300l7.200 3.600" fill="none" stroke="currentColor" stroke-width="1.800" stroke-linecap="round"/>',
  },
  // A ring around a core.
  oracle: {
    hex: '#c74634',
    ink: WHITE,
    body: '<rect x="1.500" y="6" width="21" height="12" rx="6" fill="none" stroke="currentColor" stroke-width="3"/>',
  },
};

/** Brands whose tile is light enough to need a dark glyph. */
const DARK_INK: ReadonlySet<DriverId> = new Set<DriverId>(['clickhouse']);

function artOf(driver: DriverId): Art {
  const own = OWN[driver];
  if (own !== undefined) return own;
  const brand = BRAND_PATHS[driver as keyof typeof BRAND_PATHS];
  return {
    hex: `#${brand.hex}`,
    ink: DARK_INK.has(driver) ? DARK : WHITE,
    body: `<path d="${brand.path}"/>`,
  };
}

/** A shade `amount` (0–1) of the way from the colour to white. */
function lighten(hex: string, amount: number): string {
  const channel = (at: number): string => {
    const value = Number.parseInt(hex.slice(at, at + 2), 16);
    return Math.round(value + (255 - value) * amount)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${channel(1)}${channel(3)}${channel(5)}`;
}

/** How a saved connection stands in the tree: dimmed, or with a green or a red dot. */
export type DbMarkState = 'off' | 'on' | 'error';

const STATE_DOT: Readonly<Record<'on' | 'error', string>> = {
  on: '<circle cx="18.500" cy="18.500" r="4.200" fill="#22c55e" stroke="#0f5132" stroke-width="1.200"/>',
  error:
    '<circle cx="18.500" cy="18.500" r="4.200" fill="#ef4444" stroke="#7f1d1d" stroke-width="1.200"/>',
};

/** The mark as a stand-alone SVG, `size` pixels square; the gradient id is its own. */
export function dbMarkSvg(driver: DriverId, size = 16, state?: DbMarkState): string {
  const art = artOf(driver);
  const id = `dn-db-${driver}`;
  // The glyph fills 62% of the tile, centred.
  const glyph = `<g transform="translate(4.560 4.560) scale(.62)" fill="${art.ink}" color="${art.ink}">${art.body}</g>`;
  const tile = `<rect x="1" y="1" width="22" height="22" rx="6" fill="url(#${id})"/>${glyph}`;
  const shown = state === 'off' ? `<g opacity=".6">${tile}</g>` : tile;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24">` +
    `<defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${lighten(art.hex, 0.22)}"/><stop offset="1" stop-color="${art.hex}"/>` +
    `</linearGradient></defs>${shown}${state === 'on' || state === 'error' ? STATE_DOT[state] : ''}</svg>`
  );
}

/** File name (without folder) of a driver's mark in `resources/icons/db`. */
export function dbMarkFile(driver: DriverId, state?: DbMarkState): string {
  return state === undefined ? `${driver}.svg` : `${driver}-${state}.svg`;
}

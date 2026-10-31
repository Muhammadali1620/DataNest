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

// Our own drawings for each database (D113): a stylised animal or shape per driver, drawn
// from scratch (never a vendor's logo). One source for the connection form (inline in the
// page), the tree (files in resources/icons/db, written by scripts/make-icons.mjs) and
// the tests that keep the two in step.

import type { DriverId } from './connection';

interface Art {
  readonly from: string;
  readonly to: string;
  readonly body: string;
}

// `url(#g)` in a body is the mark's own gradient.
const ART: Readonly<Record<DriverId, Art>> = {
  // An elephant seen from the side: head, trunk, ear and an eye.
  postgres: {
    from: '#5aa9ff',
    to: '#2f5fd0',
    body:
      '<path fill="url(#g)" d="M5.5 10.5C5.5 6.4 8.8 3.5 13 3.5s7.5 2.9 7.5 7c0 2.9-1.100 4.900-1.100 7.100V20a1.600 1.600 0 0 1-3.200 0v-2.600c-1.700.5-3.500.5-5.200.1V20a1.600 1.600 0 0 1-3.200 0v-3.400C6.700 15.200 5.500 13.100 5.500 10.500z"/>' +
      '<path fill="#1e3f9e" d="M5.600 9.800C3.600 10.300 2.600 12.300 3 14.600c.3 1.600 1.300 2.500 2.300 2.200.9-.3.800-1.500.3-2.500-.4-.9-.6-1.800-.3-2.800z"/>' +
      '<ellipse cx="13.300" cy="9.600" rx="3.300" ry="3.700" fill="#fff" fill-opacity=".28"/>' +
      '<circle cx="9" cy="8.800" r="1.100" fill="#fff"/>',
  },
  // A dolphin: arched body, dorsal fin and a tail.
  mysql: {
    from: '#2fb4d8',
    to: '#1d6fb8',
    body:
      '<path fill="url(#g)" d="M2.500 14C4.800 8.800 9.800 6.200 15 7.100c2 .4 3.500 1.200 4.600 2.500L22 7.200c-.2 3.200-1.300 5-3.400 6.200C16.400 17.800 10.800 19.400 6.300 17.800c-1.700-.6-3-2-3.800-3.800z"/>' +
      '<path fill="#f29a1a" d="M10 7.100C10.500 4.700 12 3.300 14.200 2.800c-.4 1.500-.2 3 .9 4.300z"/>' +
      '<path fill="#f29a1a" d="M19 12.500c1.300.300 2.200 1.100 2.800 2.600.2.600-.2 1-.8.800-1-.4-1.900-.4-2.700.3z"/>' +
      '<circle cx="7.600" cy="12" r=".9" fill="#fff"/>',
  },
  // A feather.
  sqlite: {
    from: '#59d0b0',
    to: '#1b8f9e',
    body:
      '<path fill="url(#g)" d="M20.500 3C11.500 3 5.500 8 5.500 15c0 1.500.3 2.800.8 4L4.500 21l1.500.6 1.800-1.800c1 .3 2 .5 3.100.5 7 0 9.600-8 9.600-17.300z"/>' +
      '<path stroke="#fff" stroke-opacity=".7" stroke-linecap="round" stroke-width="1.200" fill="none" d="M7 19c3-5 6.500-8.500 11-11"/>',
  },
  // A rack of servers.
  mssql: {
    from: '#ff7b7b',
    to: '#c42b2b',
    body:
      '<rect x="3" y="3.500" width="18" height="4.800" rx="1.600" fill="url(#g)"/>' +
      '<rect x="3" y="9.600" width="18" height="4.800" rx="1.600" fill="url(#g)"/>' +
      '<rect x="3" y="15.700" width="18" height="4.800" rx="1.600" fill="url(#g)"/>' +
      '<circle cx="6.600" cy="5.900" r="1" fill="#fff"/><circle cx="6.600" cy="12" r="1" fill="#fff"/><circle cx="6.600" cy="18.100" r="1" fill="#fff"/>' +
      '<path stroke="#fff" stroke-opacity=".7" stroke-linecap="round" stroke-width="1.200" d="M10.500 5.900h7M10.500 12h7M10.500 18.100h7"/>',
  },
  // Columns of different height: a column store.
  clickhouse: {
    from: '#ffe15a',
    to: '#f59e0b',
    body:
      '<rect x="3" y="9" width="3.600" height="12" rx="1.200" fill="url(#g)"/>' +
      '<rect x="8.200" y="4" width="3.600" height="17" rx="1.200" fill="url(#g)"/>' +
      '<rect x="13.400" y="7" width="3.600" height="14" rx="1.200" fill="url(#g)"/>' +
      '<rect x="18.600" y="11.500" width="2.400" height="9.500" rx="1.200" fill="#f97316"/>',
  },
  // A ring around a core.
  oracle: {
    from: '#ff6a5c',
    to: '#d4251c',
    body:
      '<rect x="2.500" y="6.500" width="19" height="11" rx="5.500" fill="none" stroke="url(#g)" stroke-width="3.200"/>' +
      '<circle cx="12" cy="12" r="1.800" fill="url(#g)"/>',
  },
  // Three stacked layers.
  redis: {
    from: '#ff6b6b',
    to: '#c92a2a',
    body:
      '<path fill="url(#g)" d="M12 3.200l9 3.800-9 3.800L3 7z"/>' +
      '<path fill="url(#g)" fill-opacity=".85" d="M3 10.500l9 3.800 9-3.800v3.200l-9 3.800-9-3.800z"/>' +
      '<path fill="url(#g)" fill-opacity=".7" d="M3 15.400l9 3.800 9-3.800v2.800l-9 3.800-9-3.800z"/>',
  },
  // A leaf with its vein.
  mongodb: {
    from: '#6fdc7c',
    to: '#1f9d55',
    body:
      '<path fill="url(#g)" d="M12 2c3.600 3.600 5.600 7.200 5.600 10.700 0 3.300-2.100 5.900-5.100 7.600-3-1.700-5.100-4.300-5.100-7.600C7.400 9.200 9 5.600 12 2z"/>' +
      '<path stroke="#0f5c32" stroke-linecap="round" stroke-width="1.400" d="M12 8.500v13"/>',
  },
  // A magnifying glass with a spark.
  elasticsearch: {
    from: '#c58bff',
    to: '#6d3fd6',
    body:
      '<circle cx="10.500" cy="10.500" r="6.200" fill="none" stroke="url(#g)" stroke-width="2.800"/>' +
      '<path stroke="url(#g)" stroke-linecap="round" stroke-width="3" d="M15.300 15.300L20.500 20.500"/>' +
      '<path fill="#fff" d="M10.500 7l.9 2.600 2.600.9-2.600.9-.9 2.600-.9-2.600-2.600-.9 2.600-.9z"/>',
  },
};

/** How a saved connection stands in the tree: dimmed, or with a green or a red dot. */
export type DbMarkState = 'off' | 'on' | 'error';

const STATE_DOT: Readonly<Record<'on' | 'error', string>> = {
  on: '<circle cx="18.500" cy="18.500" r="4.200" fill="#22c55e" stroke="#0f5132" stroke-width="1.200"/>',
  error:
    '<circle cx="18.500" cy="18.500" r="4.200" fill="#ef4444" stroke="#7f1d1d" stroke-width="1.200"/>',
};

/** The mark as a stand-alone SVG, `size` pixels square; the gradient id is its own. */
export function dbMarkSvg(driver: DriverId, size = 16, state?: DbMarkState): string {
  const art = ART[driver];
  const id = `dn-db-${driver}`;
  const body = art.body.replaceAll('url(#g)', `url(#${id})`);
  const shown = state === 'off' ? `<g opacity=".6">${body}</g>` : body;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24">` +
    `<defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${art.from}"/><stop offset="1" stop-color="${art.to}"/>` +
    `</linearGradient></defs>${shown}${state === 'on' || state === 'error' ? STATE_DOT[state] : ''}</svg>`
  );
}

/** File name (without folder) of a driver's mark in `resources/icons/db`. */
export function dbMarkFile(driver: DriverId, state?: DbMarkState): string {
  return state === undefined ? `${driver}.svg` : `${driver}-${state}.svg`;
}

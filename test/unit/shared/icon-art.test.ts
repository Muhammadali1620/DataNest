import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DRIVER_IDS } from '../../../src/shared/connection';
import { dbMarkFile, dbMarkSvg } from '../../../src/shared/db-marks';
import {
  ACTION_ICONS,
  PANEL_TILES,
  TONES,
  actionSvg,
  panelSvg,
} from '../../../src/shared/icon-art';
import { PANEL_ICONS } from '../../../src/vscode/panels/webview-html';

const ROOT = join(__dirname, '../../..');
const CODICONS = join(ROOT, 'node_modules/@vscode/codicons/src/icons');

function glyphOf(name: string): { shapes: string; size: number } {
  const svg = readFileSync(join(CODICONS, `${name}.svg`), 'utf8');
  return {
    shapes: svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, ''),
    size: Number(/viewBox="0 0 (\d+)/.exec(svg)?.[1] ?? 16),
  };
}

describe('database marks', () => {
  it('has a mark for every driver, with its own gradient', () => {
    const ids = new Set<string>();
    for (const driver of DRIVER_IDS) {
      const svg = dbMarkSvg(driver);
      expect(svg, driver).toContain('<svg');
      expect(svg, driver).toContain('linearGradient');
      expect(svg, driver).not.toContain('url(#g)');
      const id = /linearGradient id="([^"]+)"/.exec(svg)?.[1];
      expect(id, driver).toBeDefined();
      ids.add(id ?? '');
    }
    expect(ids.size).toBe(DRIVER_IDS.length);
  });

  it('draws at the size asked for', () => {
    expect(dbMarkSvg('postgres', 40)).toContain('width="40" height="40"');
  });

  it('has the file the tree shows, equal to the drawing', () => {
    for (const driver of DRIVER_IDS) {
      const file = join(ROOT, 'resources/icons/db', `${driver}.svg`);
      expect(existsSync(file), driver).toBe(true);
      expect(readFileSync(file, 'utf8'), driver).toBe(dbMarkSvg(driver));
      for (const state of ['off', 'on', 'error'] as const) {
        const stateFile = join(ROOT, 'resources/icons/db', dbMarkFile(driver, state));
        expect(readFileSync(stateFile, 'utf8'), `${driver} ${state}`).toBe(
          dbMarkSvg(driver, 16, state),
        );
      }
    }
  });

  it('dims a disconnected mark and marks the other states with a dot', () => {
    expect(dbMarkSvg('mysql', 16, 'off')).toContain('opacity=".6"');
    expect(dbMarkSvg('mysql', 16, 'on')).toContain('#22c55e');
    expect(dbMarkSvg('mysql', 16, 'error')).toContain('#ef4444');
    expect(dbMarkSvg('mysql')).not.toContain('<circle cx="18.5');
    expect(dbMarkFile('redis')).toBe('redis.svg');
    expect(dbMarkFile('redis', 'on')).toBe('redis-on.svg');
  });
});

describe('icon files in the package', () => {
  it('lets the .vsix carry every folder of icons', () => {
    const ignore = readFileSync(join(ROOT, '.vscodeignore'), 'utf8');
    expect(ignore).toContain('!resources/**');
  });
});

describe('page tab icons', () => {
  it('has a tile for every page, in step with the editor icon of the page', () => {
    expect(Object.keys(PANEL_TILES).sort()).toEqual(Object.keys(PANEL_ICONS).sort());
  });

  it('has files equal to the drawing (run `npm run icons` after a change)', () => {
    for (const [app, tile] of Object.entries(PANEL_TILES)) {
      const glyph =
        tile.own === undefined
          ? glyphOf(tile.glyph)
          : { shapes: tile.own, size: tile.ownSize ?? 16 };
      const expected = panelSvg(app, glyph.shapes, tile.tone, glyph.size);
      for (const theme of ['light', 'dark']) {
        const file = join(ROOT, 'resources/icons/panels', `${app}-${theme}.svg`);
        expect(readFileSync(file, 'utf8'), `${app}-${theme}`).toBe(expected);
      }
    }
  });

  it('uses a gradient of its own for each tile, so inline copies never clash', () => {
    expect(panelSvg('a', '', 'blue')).toContain('id="dn-tile-a"');
    expect(panelSvg('a', '', 'blue')).toContain('url(#dn-tile-a)');
  });
});

describe('action icons', () => {
  it('has a coloured file for every icon of the actions list', () => {
    for (const [name, tone] of Object.entries(ACTION_ICONS)) {
      const glyph = glyphOf(name);
      const file = join(ROOT, 'resources/icons/actions', `${name}.svg`);
      expect(readFileSync(file, 'utf8'), name).toBe(
        actionSvg(glyph.shapes, TONES[tone].mid, glyph.size),
      );
    }
  });
});

describe('brand glyphs of the database marks', () => {
  const BRANDS = {
    postgres: 'siPostgresql',
    mysql: 'siMysql',
    sqlite: 'siSqlite',
    clickhouse: 'siClickhouse',
    redis: 'siRedis',
    mongodb: 'siMongodb',
    elasticsearch: 'siElasticsearch',
  } as const;

  it('copies the glyphs of the CC0 package unchanged', async () => {
    const icons = (await import('simple-icons')) as unknown as Record<
      string,
      { hex: string; path: string }
    >;
    const { BRAND_PATHS } = await import('../../../src/shared/db-brand-paths');
    for (const [driver, key] of Object.entries(BRANDS)) {
      const icon = icons[key];
      expect(icon, key).toBeDefined();
      expect(BRAND_PATHS[driver as keyof typeof BRANDS], driver).toEqual({
        hex: icon?.hex,
        path: icon?.path,
      });
    }
  });

  it('draws a brand glyph on a rounded tile, a dark glyph on the light ClickHouse tile', () => {
    expect(dbMarkSvg('postgres')).toContain('<rect x="1" y="1" width="22" height="22" rx="6"');
    expect(dbMarkSvg('postgres')).toContain('fill="#ffffff"');
    expect(dbMarkSvg('clickhouse')).toContain('fill="#1f1f1f"');
  });

  it('draws SQL Server and Oracle itself, white on a tile', () => {
    for (const driver of ['mssql', 'oracle'] as const) {
      expect(dbMarkSvg(driver), driver).toContain('fill="#ffffff"');
      expect(dbMarkSvg(driver), driver).not.toContain('<path d="M');
    }
  });

  it('keeps the trademark notice that ships in the package', () => {
    const notice = readFileSync(join(ROOT, 'resources/licenses/brands.txt'), 'utf8');
    expect(notice).toContain('trademarks');
    expect(notice).toContain('CC0');
  });
});

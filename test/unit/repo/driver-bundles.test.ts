// Every driver bundle, built the way a release builds it, loads in plain Node and has
// the shape the registry expects: a stub or a native module that throws on load would
// otherwise only show on the first connection in a user's editor.

import { createRequire } from 'node:module';
import { join } from 'node:path';
import { build } from 'esbuild';
import { afterAll, describe, expect, it } from 'vitest';
import { createHostBuildOptions, findDriverEntries } from '../../../scripts/build-config.mjs';
import type { DriverModule } from '../../../src/drivers/driver';
import { DRIVER_IDS } from '../../../src/shared/connection';
import { createTempDir, ROOT } from '../../helpers/repo';

const tmp = createTempDir();

afterAll(() => {
  tmp.dispose();
});

describe('driver bundles', () => {
  it('has one bundle per driver id', () => {
    const bundles = Object.keys(findDriverEntries(ROOT))
      .filter((entry) => !entry.endsWith('-worker'))
      .map((entry) => entry.replace(/^drivers\//u, ''));
    expect(bundles.sort()).toEqual([...DRIVER_IDS].sort());
  });

  it.each(DRIVER_IDS.filter((id) => id !== 'sqlite'))(
    'builds %s for production and loads it without a server',
    async (id) => {
      const options = createHostBuildOptions({ rootDir: ROOT, outDir: tmp.path, production: true });
      await build({
        ...options,
        entryPoints: { [`drivers/${id}`]: join(ROOT, 'src', 'drivers', id, 'index.ts') },
        logLevel: 'silent',
      });
      const module = createRequire(join(tmp.path, 'extension.js'))(
        `./drivers/${id}.js`,
      ) as DriverModule;
      expect(module.driver.id).toBe(id);
      expect(typeof module.driver.openSession).toBe('function');
      expect(module.driver.dialect.quoteIdentifier('a')).toMatch(/a/u);
    },
    60_000,
  );
});

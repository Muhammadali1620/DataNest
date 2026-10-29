// Every driver bundle, built the way a release builds it, loads in plain Node and has
// the shape the registry expects: a stub or a native module that throws on load would
// otherwise only show on the first connection in a user's editor.

import { createRequire } from 'node:module';
import { join } from 'node:path';
import { build } from 'esbuild';
import { afterAll, describe, expect, it } from 'vitest';
import { createHostBuildOptions, findDriverEntries } from '../../../scripts/build-config.mjs';
import type { DriverModule } from '../../../src/drivers/driver';
import type { RedisDriverModule } from '../../../src/drivers/redis-driver';
import { DbError } from '../../../src/core/errors';
import { DRIVER_IDS, SQL_DRIVER_IDS } from '../../../src/shared/connection';
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

  it.each(SQL_DRIVER_IDS.filter((id) => id !== 'sqlite'))(
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

  // Redis is no SQL driver (D81): it has no dialect, and its errors must still be the
  // host's DbError, though the bundle carries its own copy of the class (D82).
  it('builds redis for production, and a failed connect is a DbError the host knows', async () => {
    const options = createHostBuildOptions({ rootDir: ROOT, outDir: tmp.path, production: true });
    await build({
      ...options,
      entryPoints: { 'drivers/redis': join(ROOT, 'src', 'drivers', 'redis', 'index.ts') },
      logLevel: 'silent',
    });
    const module = createRequire(join(tmp.path, 'extension.js'))(
      './drivers/redis.js',
    ) as RedisDriverModule;
    expect(module.driver.id).toBe('redis');
    // Port 1 refuses at once on any machine.
    const opening = module.driver.openSession({
      id: 'x',
      name: 'x',
      driver: 'redis',
      host: '127.0.0.1',
      port: 1,
      options: { connectTimeout: 2 },
    });
    const error: unknown = await opening.then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(DbError);
    expect((error as DbError).code).toBe('connection-failed');
  }, 60_000);
});

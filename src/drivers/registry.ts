// Lazy driver loading (ARCHITECTURE.md §7): each driver is a separate bundle in
// dist/drivers/<id>.js and is require()d only on the first connection to that DBMS.

import { createRequire } from 'node:module';
import { DbError, toDbError } from '../core/errors';
import type { Logger } from '../core/logging/logger';
import { type DriverId, isDriverId, type SqlDriverId } from '../shared/connection';
import type { Driver, DriverModule } from './driver';
import type { RedisDriver, RedisDriverModule } from './redis-driver';

export type DriverLoader = (id: DriverId) => Promise<DriverModule | RedisDriverModule>;

/**
 * Resolves `./drivers/<id>.js` relative to the running bundle (dist/extension.js).
 * In tests a fake loader is injected instead.
 */
export function createBundleDriverLoader(bundlePath: string): DriverLoader {
  const requireFromBundle = createRequire(bundlePath);
  return (id) => Promise.resolve(requireFromBundle(`./drivers/${id}.js`) as DriverModule);
}

/** A SQL driver or the Redis one (D81), as the bundle exports it. */
type AnyDriver = Driver | RedisDriver;

export class DriverRegistry {
  private readonly loader: DriverLoader;
  private readonly logger: Logger;
  private readonly loading = new Map<DriverId, Promise<AnyDriver>>();

  constructor(deps: { loader: DriverLoader; logger: Logger }) {
    this.loader = deps.loader;
    this.logger = deps.logger.child('drivers');
  }

  /** Loads a SQL driver on first use; concurrent calls share one load. */
  async get(id: SqlDriverId): Promise<Driver> {
    if (!isDriverId(id) || id === ('redis' as DriverId)) {
      throw new DbError('unsupported', `Unknown SQL driver "${id}"`);
    }
    const driver = await this.loadOnce(id);
    if (!isSqlDriverShaped(driver)) {
      throw new DbError('internal', `Driver "${id}" is broken: unexpected module shape`);
    }
    return driver;
  }

  /** Loads the Redis driver on first use. */
  async getRedis(): Promise<RedisDriver> {
    const driver = await this.loadOnce('redis');
    if (isSqlDriverShaped(driver)) {
      throw new DbError('internal', 'Driver "redis" is broken: unexpected module shape');
    }
    return driver;
  }

  private async loadOnce(id: DriverId): Promise<AnyDriver> {
    let promise = this.loading.get(id);
    if (!promise) {
      promise = (async () => {
        try {
          return await this.load(id);
        } catch (error) {
          // A failed load is forgotten, so a later attempt can retry (e.g. after
          // a broken install is repaired); the error still reaches every caller.
          this.loading.delete(id);
          throw error;
        }
      })();
      this.loading.set(id, promise);
    }
    return await promise;
  }

  private async load(id: DriverId): Promise<AnyDriver> {
    this.logger.debug(`Loading driver "${id}"`);
    let module: DriverModule | RedisDriverModule;
    try {
      module = await this.loader(id);
    } catch (error) {
      this.logger.error(`Driver "${id}" failed to load`, error);
      throw toDbError(error, 'internal');
    }
    const driver: unknown = (module as Partial<DriverModule> | null | undefined)?.driver;
    const shaped = id === 'redis' ? isRedisDriverShaped(driver) : isSqlDriverShaped(driver);
    if (!shaped || (driver as AnyDriver).id !== id) {
      this.logger.error(`Driver bundle "${id}" has a wrong shape`);
      throw new DbError('internal', `Driver "${id}" is broken: unexpected module shape`);
    }
    this.logger.info(`Driver "${id}" loaded`);
    return driver as AnyDriver;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isSqlDriverShaped(value: unknown): value is Driver {
  return (
    isObject(value) &&
    typeof value.id === 'string' &&
    typeof value.openSession === 'function' &&
    isObject(value.dialect) &&
    isObject(value.capabilities)
  );
}

function isRedisDriverShaped(value: unknown): value is RedisDriver {
  return isObject(value) && value.id === 'redis' && typeof value.openSession === 'function';
}

// Lazy driver loading (ARCHITECTURE.md §7): each driver is a separate bundle in
// dist/drivers/<id>.js and is require()d only on the first connection to that DBMS.

import { createRequire } from 'node:module';
import { DbError, toDbError } from '../core/errors';
import type { Logger } from '../core/logging/logger';
import { type DriverId, isDriverId } from '../core/model/connection';
import type { Driver, DriverModule } from './driver';

export type DriverLoader = (id: DriverId) => Promise<DriverModule>;

/**
 * Resolves `./drivers/<id>.js` relative to the running bundle (dist/extension.js).
 * In tests a fake loader is injected instead.
 */
export function createBundleDriverLoader(bundlePath: string): DriverLoader {
  const requireFromBundle = createRequire(bundlePath);
  return (id) => Promise.resolve(requireFromBundle(`./drivers/${id}.js`) as DriverModule);
}

export class DriverRegistry {
  private readonly loader: DriverLoader;
  private readonly logger: Logger;
  private readonly loading = new Map<DriverId, Promise<Driver>>();

  constructor(deps: { loader: DriverLoader; logger: Logger }) {
    this.loader = deps.loader;
    this.logger = deps.logger.child('drivers');
  }

  /** Loads the driver on first use; concurrent calls share one load. */
  async get(id: DriverId): Promise<Driver> {
    if (!isDriverId(id)) {
      throw new DbError('unsupported', `Unknown driver "${String(id)}"`);
    }
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

  private async load(id: DriverId): Promise<Driver> {
    this.logger.debug(`Loading driver "${id}"`);
    let module: DriverModule;
    try {
      module = await this.loader(id);
    } catch (error) {
      this.logger.error(`Driver "${id}" failed to load`, error);
      throw toDbError(error, 'internal');
    }
    const driver: unknown = (module as Partial<DriverModule> | null | undefined)?.driver;
    if (!isDriverShaped(driver) || driver.id !== id) {
      this.logger.error(`Driver bundle "${id}" has a wrong shape`);
      throw new DbError('internal', `Driver "${id}" is broken: unexpected module shape`);
    }
    this.logger.info(`Driver "${id}" loaded`);
    return driver;
  }
}

function isDriverShaped(value: unknown): value is Driver {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const driver = value as Record<string, unknown>;
  return (
    typeof driver.id === 'string' &&
    typeof driver.openSession === 'function' &&
    typeof driver.dialect === 'object' &&
    driver.dialect !== null &&
    typeof driver.capabilities === 'object' &&
    driver.capabilities !== null
  );
}

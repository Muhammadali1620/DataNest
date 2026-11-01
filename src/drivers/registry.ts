// Lazy driver loading (ARCHITECTURE.md §7): each driver is a separate bundle in
// dist/drivers/<id>.js and is require()d only on the first connection to that DBMS.

import { createRequire } from 'node:module';
import { DbError, toDbError } from '../core/errors';
import type { Logger } from '../core/logging/logger';
import {
  type BuiltInSqlDriverId,
  type DriverId,
  isDriverId,
  isSqlDriver,
} from '../shared/connection';
import type { Driver, DriverModule } from './driver';
import type { ElasticDriver, ElasticDriverModule } from './elastic-driver';
import type { EtcdDriver, EtcdDriverModule } from './etcd-driver';
import type { KafkaDriver, KafkaDriverModule } from './kafka-driver';
import type { MongoDriver, MongoDriverModule } from './mongo-driver';
import type { PluginDrivers } from './plugin/plugin-drivers';
import type { RedisDriver, RedisDriverModule } from './redis-driver';
import { msg } from '../core/user-message';

export type DriverLoader = (
  id: DriverId,
) => Promise<
  | DriverModule
  | RedisDriverModule
  | MongoDriverModule
  | ElasticDriverModule
  | EtcdDriverModule
  | KafkaDriverModule
>;

/**
 * Resolves `./drivers/<id>.js` relative to the running bundle (dist/extension.js).
 * In tests a fake loader is injected instead.
 */
export function createBundleDriverLoader(bundlePath: string): DriverLoader {
  const requireFromBundle = createRequire(bundlePath);
  return (id) => Promise.resolve(requireFromBundle(`./drivers/${id}.js`) as DriverModule);
}

/** A SQL driver, the Redis one (D81) or the MongoDB one (D88), as the bundle exports it. */
type AnyDriver = Driver | RedisDriver | MongoDriver | ElasticDriver | EtcdDriver | KafkaDriver;

export class DriverRegistry {
  private readonly loader: DriverLoader;
  private readonly logger: Logger;
  private readonly loading = new Map<DriverId, Promise<AnyDriver>>();

  private readonly plugins: PluginDrivers | undefined;

  constructor(deps: { loader: DriverLoader; logger: Logger; plugins?: PluginDrivers }) {
    this.loader = deps.loader;
    this.logger = deps.logger.child('drivers');
    this.plugins = deps.plugins;
  }

  /** A driver another extension registered (V12.7); throws when it is not there. */
  getPlugin(id: string): Promise<Driver> {
    if (this.plugins === undefined) {
      return Promise.reject(
        new DbError('unsupported', msg('This build has no drivers from other extensions')),
      );
    }
    try {
      return Promise.resolve(this.plugins.get(id));
    } catch (error) {
      return Promise.reject(toDbError(error, 'unsupported'));
    }
  }

  /** Loads a SQL driver on first use; concurrent calls share one load. */
  async get(id: BuiltInSqlDriverId): Promise<Driver> {
    if (!isDriverId(id) || !isSqlDriver(id) || (id as string) === 'plugin') {
      throw new DbError('unsupported', msg('Unknown SQL driver "{0}"', id));
    }
    const driver = await this.loadOnce(id);
    if (!isSqlDriverShaped(driver)) {
      throw new DbError('internal', msg('Driver "{0}" is broken: unexpected module shape', id));
    }
    return driver;
  }

  /** Loads the Redis driver on first use. */
  async getRedis(): Promise<RedisDriver> {
    const driver = await this.loadOnce('redis');
    if (isSqlDriverShaped(driver) || driver.id !== 'redis') {
      throw new DbError('internal', msg('Driver "redis" is broken: unexpected module shape'));
    }
    return driver;
  }

  /** Loads the MongoDB driver on first use. */
  async getMongo(): Promise<MongoDriver> {
    const driver = await this.loadOnce('mongodb');
    if (isSqlDriverShaped(driver) || driver.id !== 'mongodb') {
      throw new DbError('internal', msg('Driver "mongodb" is broken: unexpected module shape'));
    }
    return driver;
  }

  /** Loads the Elasticsearch driver on first use (V7.8). */
  async getElastic(): Promise<ElasticDriver> {
    const driver = await this.loadOnce('elasticsearch');
    if (isSqlDriverShaped(driver) || driver.id !== 'elasticsearch') {
      throw new DbError(
        'internal',
        msg('Driver "elasticsearch" is broken: unexpected module shape'),
      );
    }
    return driver;
  }

  /** Loads the etcd driver on first use (V13.19). */
  async getEtcd(): Promise<EtcdDriver> {
    const driver = await this.loadOnce('etcd');
    if (isSqlDriverShaped(driver) || driver.id !== 'etcd') {
      throw new DbError('internal', msg('Driver "etcd" is broken: unexpected module shape'));
    }
    return driver;
  }

  /** Loads the Kafka driver on first use (V13.23). */
  async getKafka(): Promise<KafkaDriver> {
    const driver = await this.loadOnce('kafka');
    if (isSqlDriverShaped(driver) || driver.id !== 'kafka') {
      throw new DbError('internal', msg('Driver "kafka" is broken: unexpected module shape'));
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
    let module:
      | DriverModule
      | RedisDriverModule
      | MongoDriverModule
      | ElasticDriverModule
      | EtcdDriverModule
      | KafkaDriverModule;
    try {
      module = await this.loader(id);
    } catch (error) {
      this.logger.error(`Driver "${id}" failed to load`, error);
      throw toDbError(error, 'internal');
    }
    const driver: unknown = (module as Partial<DriverModule> | null | undefined)?.driver;
    const shaped = isSqlDriver(id) ? isSqlDriverShaped(driver) : isFamilyDriverShaped(driver, id);
    if (!shaped || (driver as AnyDriver).id !== id) {
      this.logger.error(`Driver bundle "${id}" has a wrong shape`);
      throw new DbError('internal', msg('Driver "{0}" is broken: unexpected module shape', id));
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

/** The Redis and MongoDB drivers: an id and `openSession`, no dialect. */
function isFamilyDriverShaped(
  value: unknown,
  id: DriverId,
): value is RedisDriver | MongoDriver | ElasticDriver | EtcdDriver | KafkaDriver {
  return isObject(value) && value.id === id && typeof value.openSession === 'function';
}

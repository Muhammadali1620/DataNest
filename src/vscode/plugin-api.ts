// The object `activate` hands to other extensions (V12.7). Frozen, so a plugin cannot
// replace `registerDriver` for the next one, and it logs every registration.

import { type DataNestApi, type PluginDriver } from '../api/types';
import type { Logger } from '../core/logging/logger';
import type { PluginDrivers } from '../drivers/plugin/plugin-drivers';

export function createDataNestApi(plugins: PluginDrivers, logger: Logger): DataNestApi {
  return Object.freeze({
    apiVersion: 1,
    registerDriver: (driver: PluginDriver) => {
      const registration = plugins.register(driver);
      logger.info(`Driver "${driver.id}" registered by another extension`);
      return {
        dispose: () => {
          registration.dispose();
          logger.info(`Driver "${driver.id}" taken back`);
        },
      };
    },
    registeredDrivers: () => plugins.list().map((info) => info.id),
  } as const satisfies DataNestApi);
}

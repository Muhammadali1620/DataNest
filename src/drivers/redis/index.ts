// Redis driver (V7.1), over ioredis. Bundled separately (dist/drivers/redis.js) and
// loaded on the first Redis connection. Not a SQL driver: see D81.

import type { RedisDriver } from '../redis-driver';
import { openRedisSession } from './session';

export const driver: RedisDriver = {
  id: 'redis',
  openSession: openRedisSession,
};

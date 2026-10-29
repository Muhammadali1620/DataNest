// MongoDB driver (V7.5), over the official `mongodb` driver. Bundled separately
// (dist/drivers/mongodb.js) and loaded on the first MongoDB connection. Not a SQL
// driver: see D81, D88.

import type { MongoDriver } from '../mongo-driver';
import { openMongoSession } from './session';

export const driver: MongoDriver = {
  id: 'mongodb',
  openSession: openMongoSession,
};

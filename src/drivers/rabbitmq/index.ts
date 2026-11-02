// RabbitMQ driver (V13.26), over Node's own HTTP client and the management plugin's API.
// Bundled separately (dist/drivers/rabbitmq.js) and loaded on the first RabbitMQ
// connection. Not a SQL driver: see D81.

import type { RabbitDriver } from '../rabbitmq-driver';
import { openRabbitSession } from './session';

export const driver: RabbitDriver = {
  id: 'rabbitmq',
  openSession: openRabbitSession,
};

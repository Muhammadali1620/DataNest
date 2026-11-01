// Kafka driver (V13.23), over the pure-JavaScript kafkajs client. Bundled separately
// (dist/drivers/kafka.js) and loaded on the first Kafka connection. Not a SQL driver: see D81.

import type { KafkaDriver } from '../kafka-driver';
import { openKafkaSession } from './session';

export const driver: KafkaDriver = {
  id: 'kafka',
  openSession: (config) => openKafkaSession(config),
};

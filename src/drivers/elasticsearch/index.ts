// Elasticsearch driver (V7.8), over Node's own HTTP client. Bundled separately
// (dist/drivers/elasticsearch.js) and loaded on the first Elasticsearch connection. Not a
// SQL driver: see D81, D91.

import type { ElasticDriver } from '../elastic-driver';
import { openElasticSession } from './session';

export const driver: ElasticDriver = {
  id: 'elasticsearch',
  openSession: openElasticSession,
};

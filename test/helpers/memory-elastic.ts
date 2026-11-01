// An Elasticsearch node in memory for the tests of index files (V13.11): one index that
// answers scroll searches, `_mapping`, `_settings`, `_bulk` and `_refresh` the way the
// real one does in shape, and records what it was asked.

import type { ElasticRequest, ElasticResponse } from '../../src/drivers/elastic-driver';
import { FakeElasticSession, json } from './fake-elastic';

export interface StoredDocument {
  readonly id?: string;
  readonly routing?: string;
  /** The source as JSON text, so that big numbers survive. */
  readonly source: string;
}

export interface MemoryElasticOptions {
  readonly index?: string;
  readonly documents?: readonly StoredDocument[];
  readonly mappings?: unknown;
  readonly settings?: unknown;
  /** Refuses a bulk item: the reason, or undefined to take it. */
  readonly refuse?: (
    action: string,
    id: string | undefined,
    source: string,
    position: number,
  ) => { status: number; type: string; reason: string } | undefined;
  /** Hits that come without `_source`. */
  readonly noSource?: boolean;
  /** A whole-request answer for `_bulk`, instead of the usual one. */
  readonly bulkAnswer?: (request: ElasticRequest) => ElasticResponse | undefined;
}

export class MemoryElastic {
  readonly stored: StoredDocument[];
  readonly bulks: string[] = [];
  readonly scrollSizes: number[] = [];
  deleted: string[] = [];
  refreshed = 0;
  private cursor = 0;
  private generated = 0;
  readonly session: FakeElasticSession;

  constructor(private readonly options: MemoryElasticOptions = {}) {
    this.stored = [...(options.documents ?? [])];
    this.session = new FakeElasticSession((request) => this.answer(request));
  }

  get index(): string {
    return this.options.index ?? 'shop';
  }

  private answer(request: ElasticRequest): ElasticResponse | undefined {
    const path = request.path;
    if (request.method === 'POST' && path.includes('/_search?scroll=')) {
      const size = (JSON.parse(request.body ?? '{}') as { size: number }).size;
      this.scrollSizes.push(size);
      this.cursor = 0;
      return this.page(size);
    }
    if (request.method === 'POST' && path === '/_search/scroll') {
      const size = this.scrollSizes[0] ?? 1000;
      return this.page(size);
    }
    if (request.method === 'DELETE' && path === '/_search/scroll') {
      this.deleted.push((JSON.parse(request.body ?? '{}') as { scroll_id: string }).scroll_id);
      return json({ succeeded: true });
    }
    if (request.method === 'GET' && path.endsWith('/_mapping')) {
      return json({ [this.index]: { mappings: this.options.mappings ?? { properties: {} } } });
    }
    if (request.method === 'GET' && path.endsWith('/_settings')) {
      return json({
        [this.index]: {
          settings: this.options.settings ?? {
            index: {
              number_of_shards: '1',
              number_of_replicas: '0',
              uuid: 'abc',
              creation_date: '1',
              version: { created: '8' },
              provided_name: this.index,
            },
          },
        },
      });
    }
    if (request.method === 'POST' && path.endsWith('/_refresh')) {
      this.refreshed += 1;
      return json({ _shards: {} });
    }
    if (request.method === 'POST' && path.endsWith('/_bulk')) {
      return this.bulk(request);
    }
    return undefined;
  }

  private page(size: number): ElasticResponse {
    const slice = this.stored.slice(this.cursor, this.cursor + size);
    this.cursor += slice.length;
    const hits = slice.map((document, offset) => {
      const id = document.id ?? `auto${this.cursor - slice.length + offset}`;
      const routing =
        document.routing === undefined ? '' : `,"_routing":${JSON.stringify(document.routing)}`;
      const source = this.options.noSource === true ? '' : `,"_source":${document.source}`;
      return `{"_index":"${this.index}","_id":${JSON.stringify(id)}${routing}${source}}`;
    });
    return json(
      `{"_scroll_id":"scroll-1","hits":{"total":{"value":${this.stored.length}},"hits":[${hits.join(',')}]}}`,
    );
  }

  private bulk(request: ElasticRequest): ElasticResponse {
    this.bulks.push(request.body ?? '');
    const custom = this.options.bulkAnswer?.(request);
    if (custom !== undefined) {
      return custom;
    }
    const lines = (request.body ?? '').split('\n').filter((line) => line !== '');
    const items: unknown[] = [];
    let errors = false;
    for (let index = 0; index < lines.length; index += 2) {
      const action = JSON.parse(lines[index] ?? '{}') as Record<
        string,
        { _id?: string; routing?: string }
      >;
      const [name, meta] = Object.entries(action)[0] ?? ['index', {}];
      const source = lines[index + 1] ?? '{}';
      const refusal = this.options.refuse?.(name, meta._id, source, index / 2);
      if (refusal !== undefined) {
        errors = true;
        items.push({
          [name]: {
            _id: meta._id ?? 'x',
            status: refusal.status,
            error: { type: refusal.type, reason: refusal.reason },
          },
        });
        continue;
      }
      const id = meta._id ?? `generated${this.generated++}`;
      const existing = this.stored.findIndex((document) => document.id === id);
      const document: StoredDocument = {
        id,
        ...(meta.routing === undefined ? {} : { routing: meta.routing }),
        source,
      };
      if (existing >= 0 && name === 'create') {
        errors = true;
        items.push({
          create: {
            _id: id,
            status: 409,
            error: {
              type: 'version_conflict_engine_exception',
              reason: `[${id}]: version conflict`,
            },
          },
        });
        continue;
      }
      if (existing >= 0) {
        this.stored[existing] = document;
      } else {
        this.stored.push(document);
      }
      items.push({ [name]: { _id: id, status: existing >= 0 ? 200 : 201 } });
    }
    return json({ took: 1, errors, items });
  }
}

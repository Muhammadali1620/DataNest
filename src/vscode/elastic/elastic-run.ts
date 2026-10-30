// Running one request of an Elasticsearch query editor (V7.8), free of `vscode`: parse
// it, see what it may change, let the connection's policy and safe mode stop or question
// it, then send it (D91). The editor bits arrive through the deps.

import { DbError } from '../../core/errors';
import {
  type ElasticRequestText,
  parseRequest,
  type ParsedRequest,
  RequestSyntaxError,
  requestEffect,
} from '../../core/elastic/requests';
import { lineAndColumn } from '../../core/mongo/shell-parse';
import type { ElasticResponse, ElasticSession } from '../../drivers/elastic-driver';
import type { SafeMode } from '../../services/safe-mode';
import type { WritePolicy } from '../../services/write-policy';
import { msg } from '../../core/user-message';

export interface ElasticRunQuestion {
  readonly kind: 'production' | 'dangerous';
  /** `DELETE /products`. */
  readonly request: string;
  readonly production: boolean;
}

export interface ElasticRunDeps {
  readonly session: () => Promise<ElasticSession>;
  readonly policy: WritePolicy;
  readonly safeMode: SafeMode;
  /** Milliseconds a request may take; 0: no limit. */
  readonly timeoutMs: number;
  readonly ask: (question: ElasticRunQuestion) => Promise<boolean>;
  readonly texts: { readonly readOnly: string; readonly blocked: string };
  readonly now?: () => number;
}

export type ElasticRunResult =
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'done'; readonly response: ElasticResponse; readonly tookMs: number };

/** Parses a request, saying where its body is wrong in the document. */
export function parseInDocument(request: ElasticRequestText, document: string): ParsedRequest {
  try {
    return parseRequest(request, document);
  } catch (error) {
    if (error instanceof RequestSyntaxError) {
      const { line, column } = lineAndColumn(document, error.offset);
      throw new DbError('syntax', msg('{0}:{1} {2}', line, column, error.message), {
        position: error.offset,
      });
    }
    throw error;
  }
}

export async function runElasticRequest(
  deps: ElasticRunDeps,
  request: ParsedRequest,
): Promise<ElasticRunResult> {
  const effect = requestEffect(request);
  const line = `${request.method} ${request.path}`;
  if (effect !== 'read') {
    if (deps.policy.readOnly) {
      throw new DbError('permission-denied', deps.texts.readOnly);
    }
    if (effect === 'dangerous' && deps.safeMode === 'block') {
      throw new DbError('permission-denied', deps.texts.blocked);
    }
    // One question at most, as for SQL and MongoDB (D52, D90).
    const dangerous = effect === 'dangerous' && deps.safeMode === 'confirm';
    if (deps.policy.production || dangerous) {
      if (
        !(await deps.ask({
          kind: dangerous ? 'dangerous' : 'production',
          request: line,
          production: deps.policy.production,
        }))
      ) {
        return { kind: 'cancelled' };
      }
    }
  }
  const now = deps.now ?? Date.now;
  const session = await deps.session();
  const started = now();
  const response = await session.request({
    method: request.method,
    path: request.path,
    ...(request.body === undefined ? {} : { body: request.body }),
    ...(request.ndjson ? { ndjson: true } : {}),
    ...(deps.timeoutMs === 0 ? {} : { timeoutMs: deps.timeoutMs }),
  });
  return { kind: 'done', response, tookMs: Math.max(0, now() - started) };
}

/** What a new query starts with: a search of the index it was opened from. */
export function requestTemplate(index: string | undefined): string {
  if (index === undefined) {
    return 'GET /_cat/indices?v\n\nGET /_cluster/health\n';
  }
  const path = `/${encodeURIComponent(index)}`;
  return `GET ${path}/_search\n{\n  "query": { "match_all": {} },\n  "size": 20\n}\n\nGET ${path}/_mapping\n`;
}

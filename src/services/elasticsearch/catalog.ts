// What the tree lists of an Elasticsearch cluster (V7.8): its indices with their health,
// size and count, and the fields of an index's mapping, nested as the mapping nests them.
// Free of `vscode`.

import { DbError } from '../../core/errors';
import {
  jsonNumberText,
  jsonString,
  type JsonValue,
  member,
  parseJson,
} from '../../core/json/json-tree';
import type { ElasticRequest, ElasticSession } from '../../drivers/elastic-driver';
import { elasticFailure } from '../../drivers/elasticsearch/errors';
import { msg } from '../../core/user-message';

/** Sends a request that must succeed and answers JSON; a failed status is a DbError. */
export async function callJson(
  session: Pick<ElasticSession, 'request'>,
  request: ElasticRequest,
): Promise<JsonValue> {
  const response = await session.request(request);
  if (response.status >= 400) {
    throw elasticFailure(response);
  }
  try {
    return parseJson(response.body);
  } catch {
    throw new DbError(
      'internal',
      msg("The server's answer to {0} {1} is not JSON", request.method, request.path),
    );
  }
}

export interface ElasticIndexInfo {
  readonly name: string;
  readonly health?: 'green' | 'yellow' | 'red';
  readonly status: 'open' | 'close';
  /** Documents as the index counts them, nested ones included; decimal text. */
  readonly docs?: string;
  /** Bytes of the primary and replica shards; decimal text. */
  readonly size?: string;
  readonly hidden: boolean;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** The indices, sorted; hidden and system ones (`.…`) only when asked for. */
export async function listIndices(
  session: Pick<ElasticSession, 'request'>,
  showHidden: boolean,
): Promise<ElasticIndexInfo[]> {
  const rows = await callJson(session, {
    method: 'GET',
    path: `/_cat/indices?format=json&bytes=b&h=index,health,status,docs.count,store.size&expand_wildcards=${showHidden ? 'all' : 'open,closed'}`,
  });
  const indices = (rows.type === 'array' ? rows.items : []).flatMap((row): ElasticIndexInfo[] => {
    const name = jsonString(member(row, 'index'));
    if (name === undefined) {
      return [];
    }
    const health = jsonString(member(row, 'health'));
    const docs = jsonNumberText(member(row, 'docs.count'));
    const size = jsonNumberText(member(row, 'store.size'));
    return [
      {
        name,
        ...(health === 'green' || health === 'yellow' || health === 'red' ? { health } : {}),
        status: jsonString(member(row, 'status')) === 'close' ? 'close' : 'open',
        ...(docs === undefined ? {} : { docs }),
        ...(size === undefined ? {} : { size }),
        hidden: name.startsWith('.'),
      },
    ];
  });
  return indices
    .filter((index) => showHidden || !index.hidden)
    .sort((a, b) => collator.compare(a.name, b.name));
}

/** A field of a mapping, with the fields inside it (objects, nested, multi-fields). */
export interface ElasticFieldInfo {
  readonly name: string;
  /** The full path: `maker.name`, `name.keyword`. */
  readonly path: string;
  /** `keyword`, `text`, `nested`, `object`, … */
  readonly type: string;
  readonly children: readonly ElasticFieldInfo[];
}

function fieldsOf(
  properties: JsonValue | undefined,
  prefix: string,
  depth: number,
): ElasticFieldInfo[] {
  if (properties?.type !== 'object' || depth > 100) {
    return [];
  }
  return properties.members.map(([name, definition]): ElasticFieldInfo => {
    const path = prefix === '' ? name : `${prefix}.${name}`;
    const nested = fieldsOf(member(definition, 'properties'), path, depth + 1);
    const multi = fieldsOf(member(definition, 'fields'), path, depth + 1);
    const type =
      jsonString(member(definition, 'type')) ?? (nested.length > 0 ? 'object' : 'unknown');
    return { name, path, type, children: [...nested, ...multi] };
  });
}

/** The fields of an index's mapping, in the order the mapping lists them. */
export async function listFields(
  session: Pick<ElasticSession, 'request'>,
  index: string,
): Promise<ElasticFieldInfo[]> {
  const reply = await callJson(session, {
    method: 'GET',
    path: `/${encodeURIComponent(index)}/_mapping`,
  });
  // The reply is keyed by the concrete index, which an alias would hide.
  const [first] = reply.type === 'object' ? reply.members : [];
  return fieldsOf(member(member(first?.[1], 'mappings'), 'properties'), '', 0);
}

/** Why an index name is refused, or undefined (Elasticsearch's own rules). */
export function indexNameProblem(name: string): string | undefined {
  if (name.trim() === '') {
    return msg('The name is empty');
  }
  if (name !== name.toLowerCase()) {
    return msg('An index name is in lowercase');
  }
  if (/[\\/*?"<>| ,#:]/.test(name)) {
    return msg('An index name cannot hold \\ / * ? " < > | , # : or spaces');
  }
  if (/^[-_+]/.test(name) || name === '.' || name === '..') {
    return msg('An index name cannot start with -, _ or +');
  }
  if (new TextEncoder().encode(name).length > 255) {
    return msg('An index name is at most 255 bytes');
  }
  return undefined;
}

/** Creates an index; `body` holds its settings and mappings as JSON text, or nothing. */
export async function createIndex(
  session: Pick<ElasticSession, 'request'>,
  name: string,
  body: string,
): Promise<void> {
  const problem = indexNameProblem(name);
  if (problem !== undefined) {
    throw new DbError('syntax', problem);
  }
  const trimmed = body.trim();
  if (trimmed !== '') {
    // Checked here, so a typo is a message and not a half-made index.
    try {
      parseJson(trimmed);
    } catch (error) {
      throw new DbError(
        'syntax',
        msg(
          'The settings are not JSON: {0}',
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }
  await callJson(session, {
    method: 'PUT',
    path: `/${encodeURIComponent(name)}`,
    ...(trimmed === '' ? {} : { body: trimmed }),
  });
}

export async function deleteIndex(
  session: Pick<ElasticSession, 'request'>,
  name: string,
): Promise<void> {
  if (name.includes('*') || name === '_all' || name.includes(',')) {
    throw new DbError('unsupported', msg('DataNest deletes one index at a time, by its name'));
  }
  await callJson(session, { method: 'DELETE', path: `/${encodeURIComponent(name)}` });
}

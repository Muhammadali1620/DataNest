// How the result page shows an Elasticsearch answer (V7.8): a search's hits as a table
// (their `_source` fields as columns), counts and errors as a line, everything as text.
// Numbers stay as the server wrote them (D91). Free of `vscode`.

import {
  formatJson,
  jsonNumberText,
  jsonString,
  type JsonValue,
  member,
  parseJson,
  previewJson,
} from '../../core/json/json-tree';
import type { ElasticResponse } from '../../drivers/elastic-driver';
import { failureText } from '../../drivers/elasticsearch/errors';
import {
  type ElasticResultState,
  MAX_ANSWER_TEXT,
  MAX_HIT_TEXT,
} from '../../shared/protocols/elastic-result';

const CELL_TEXT = 200;
const META = ['_index', '_id', '_score'] as const;

type Summary = NonNullable<ElasticResultState['summary']>;

function cut(text: string, max: number): { text: string; truncated: boolean } {
  return text.length <= max
    ? { text, truncated: false }
    : { text: `${text.slice(0, max)}\n…`, truncated: true };
}

function cell(value: JsonValue | undefined): { text: string; type: string } | null {
  return value === undefined ? null : { text: previewJson(value, CELL_TEXT), type: value.type };
}

/** The hits of a search answer, if it is one. */
function hitsOf(answer: JsonValue): readonly JsonValue[] | undefined {
  const hits = member(member(answer, 'hits'), 'hits');
  return hits?.type === 'array' ? hits.items : undefined;
}

function summaryOf(
  answer: JsonValue,
  status: number,
  response: ElasticResponse,
): Summary | undefined {
  if (status >= 400) {
    return { kind: 'error', error: failureText(response) };
  }
  const took = jsonNumberText(member(answer, 'took'));
  const tookMs = took === undefined ? {} : { took: Number(took) };
  const hits = hitsOf(answer);
  if (hits !== undefined) {
    const total = member(member(answer, 'hits'), 'total');
    // Elasticsearch 7+ says { value, relation }; older servers a number.
    const value = jsonNumberText(member(total, 'value')) ?? jsonNumberText(total);
    const relation = jsonString(member(total, 'relation'));
    return {
      kind: 'hits',
      ...(value === undefined ? {} : { total: value }),
      ...(relation === 'gte'
        ? { relation: 'gte' as const }
        : relation === 'eq'
          ? { relation: 'eq' as const }
          : {}),
      shown: hits.length,
      ...tookMs,
    };
  }
  const count = jsonNumberText(member(answer, 'count'));
  return count === undefined ? undefined : { kind: 'count', total: count };
}

export interface ResultInput {
  readonly connectionName: string;
  readonly request: string;
  readonly response: ElasticResponse;
  readonly tookMs: number;
}

export function resultState(input: ResultInput): ElasticResultState {
  const { response } = input;
  const base = {
    connectionName: input.connectionName,
    request: input.request,
    status: response.status,
    tookMs: input.tookMs,
  };
  let answer: JsonValue | undefined;
  try {
    answer = response.body.trim() === '' ? undefined : parseJson(response.body);
  } catch {
    answer = undefined;
  }
  if (answer === undefined) {
    // `_cat` text, a proxy's page, HEAD: shown as it came.
    const { text, truncated } = cut(response.body, MAX_ANSWER_TEXT);
    return {
      ...base,
      summary:
        response.status >= 400
          ? { kind: 'error', error: failureText(response) }
          : response.body === ''
            ? { kind: 'empty' }
            : undefined,
      columns: [],
      rows: [],
      text,
      truncated,
    };
  }
  const summary = summaryOf(answer, response.status, response);
  const hits = response.status >= 400 ? undefined : hitsOf(answer);
  const columns: string[] = [];
  const rows: ElasticResultState['rows'] = [];
  if (hits !== undefined && hits.length > 0) {
    const fields = new Set<string>();
    for (const hit of hits) {
      const source = member(hit, '_source');
      for (const [name] of source?.type === 'object' ? source.members : []) {
        fields.add(name);
      }
    }
    columns.push(
      ...META.filter((name) => hits.some((hit) => member(hit, name) !== undefined)),
      ...fields,
    );
    for (const hit of hits) {
      const source = member(hit, '_source');
      rows.push({
        cells: columns.map((column) =>
          (META as readonly string[]).includes(column)
            ? cell(member(hit, column))
            : cell(member(source, column)),
        ),
        text: cut(formatJson(hit), MAX_HIT_TEXT).text,
      });
    }
  }
  const { text, truncated } = cut(formatJson(answer), MAX_ANSWER_TEXT);
  return {
    ...base,
    ...(summary === undefined ? {} : { summary }),
    columns,
    rows,
    text,
    truncated,
  };
}

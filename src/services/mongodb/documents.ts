// Documents of a MongoDB collection (V7.6): a page of them, how many there are, and the
// changes the documents page makes — replace, insert, delete — each one command built
// from parsed values (§8). A replacement goes through only while the stored document is
// still the one the user read (D89). Free of `vscode`.

import { DbError } from '../../core/errors';
import { newObjectId } from '../../core/mongo/object-id';
import { formatValue } from '../../core/mongo/shell-format';
import {
  arrayField,
  bool,
  doc,
  documentField,
  field,
  int32,
  type MongoDocument,
  type MongoValue,
  numberField,
  str,
  stringField,
} from '../../core/mongo/value';
import type { MongoRawDocument, MongoSession } from '../../drivers/mongo-driver';
import { mongoErrorKind } from '../../drivers/mongodb/errors';
import { msg } from '../../core/user-message';

type Session = Pick<MongoSession, 'command' | 'openCursor'>;

/** What the page asks for: a find with its parts already parsed. */
export interface DocumentQuery {
  readonly filter: MongoDocument;
  readonly sort: MongoDocument;
  readonly projection: MongoDocument;
  readonly skip: number;
  readonly limit: number;
  /** Milliseconds the server may spend; 0 means no limit. */
  readonly maxTimeMS: number;
}

export interface DocumentPage {
  readonly documents: MongoRawDocument[];
  /** More documents follow the page. */
  readonly more: boolean;
  /** How long the read took, in milliseconds. */
  readonly tookMs: number;
}

/** Reads one page, and one document more to know whether another page follows. */
export async function readPage(
  session: Session,
  database: string,
  collection: string,
  query: DocumentQuery,
  now: () => number = Date.now,
): Promise<DocumentPage> {
  const started = now();
  const cursor = await session.openCursor(database, {
    kind: 'find',
    collection,
    ...(query.filter.fields.length === 0 ? {} : { filter: query.filter }),
    ...(query.sort.fields.length === 0 ? {} : { sort: query.sort }),
    ...(query.projection.fields.length === 0 ? {} : { projection: query.projection }),
    ...(query.skip === 0 ? {} : { skip: query.skip }),
    limit: query.limit + 1,
    ...(query.maxTimeMS === 0 ? {} : { maxTimeMS: query.maxTimeMS }),
  });
  try {
    const { documents } = await cursor.next(query.limit + 1);
    return {
      documents: documents.slice(0, query.limit),
      more: documents.length > query.limit,
      tookMs: Math.max(0, now() - started),
    };
  } finally {
    await cursor.close().catch(() => undefined);
  }
}

export interface DocumentCount {
  /** Decimal text: a count may pass 2^53. */
  readonly count: string;
  /** False for the server's estimate of a whole collection. */
  readonly exact: boolean;
}

/** Time a count may take before the page says "unknown" and offers to count anyway. */
export const COUNT_TIME_MS = 3000;

function countText(value: MongoValue | undefined): string {
  if (value === undefined) {
    return '0';
  }
  if (value.type === 'int32') {
    return String(value.value);
  }
  return value.type === 'int64' || value.type === 'double' ? value.value : '0';
}

/**
 * How many documents match. Without a filter the server answers from its metadata at
 * once (an estimate, exact for most collections); with one it counts, within `maxTimeMS`.
 */
export async function countDocuments(
  session: Session,
  database: string,
  collection: string,
  filter: MongoDocument,
  maxTimeMS: number = COUNT_TIME_MS,
): Promise<DocumentCount> {
  if (filter.fields.length === 0) {
    const reply = await session.command(database, doc([['count', str(collection)]]));
    return { count: countText(field(reply, 'n')), exact: false };
  }
  const cursor = await session.openCursor(database, {
    kind: 'aggregate',
    collection,
    pipeline: [doc([['$match', filter]]), doc([['$count', str('n')]])],
    ...(maxTimeMS === 0 ? {} : { maxTimeMS }),
  });
  try {
    const [first] = (await cursor.next(1)).documents;
    return {
      count: countText(first === undefined ? undefined : field(first.document, 'n')),
      exact: true,
    };
  } finally {
    await cursor.close().catch(() => undefined);
  }
}

/** The document with this `_id`, as stored now; undefined when there is none. */
export async function findById(
  session: Session,
  database: string,
  collection: string,
  id: MongoValue,
): Promise<MongoDocument | undefined> {
  const cursor = await session.openCursor(database, {
    kind: 'find',
    collection,
    filter: doc([['_id', id]]),
    limit: 1,
  });
  try {
    return (await cursor.next(1)).documents[0]?.document;
  } finally {
    await cursor.close().catch(() => undefined);
  }
}

/** Fails with the first write error of a reply that the server sent with `ok: 1`. */
export function checkWrite(reply: MongoDocument): void {
  const [first] = arrayField(reply, 'writeErrors') ?? [];
  const concern = documentField(reply, 'writeConcernError');
  const failure = first?.type === 'document' ? first : concern;
  if (failure === undefined) {
    return;
  }
  const code = numberField(failure, 'code');
  const message = stringField(failure, 'errmsg') ?? msg('The server refused the write');
  throw new DbError(
    (code === undefined ? undefined : mongoErrorKind(code)) ?? 'constraint',
    message,
    {
      ...(code === undefined ? {} : { driverCode: code }),
    },
  );
}

function count(reply: MongoDocument, name: string): number {
  return numberField(reply, name) ?? 0;
}

/** The `_id` of a document; undefined when it has none (some views, capped collections). */
export function idOf(document: MongoDocument): MongoValue | undefined {
  return field(document, '_id');
}

/** `{ _id: …, $expr: { $eq: ["$$ROOT", { $literal: original }] } }`: this document, unchanged. */
function unchanged(original: MongoDocument, id: MongoValue): MongoDocument {
  return doc([
    ['_id', id],
    [
      '$expr',
      doc([
        [
          '$eq',
          {
            type: 'array',
            items: [str('$$ROOT'), doc([['$literal', original]])],
          },
        ],
      ]),
    ],
  ]);
}

/**
 * Replaces a document with the user's version, but only while the stored one is still
 * `original`, compared whole, field order included: another client's change in between
 * is not silently overwritten.
 */
export async function replaceDocument(
  session: Session,
  database: string,
  collection: string,
  original: MongoDocument,
  next: MongoDocument,
): Promise<void> {
  const id = idOf(original);
  if (id === undefined) {
    throw new DbError(
      'unsupported',
      msg('A document without _id cannot be found again to replace it'),
    );
  }
  const nextId = idOf(next);
  if (nextId === undefined || formatValue(nextId) !== formatValue(id)) {
    throw new DbError('constraint', msg('The _id cannot change: keep _id: {0}', formatValue(id)));
  }
  const reply = await session.command(
    database,
    doc([
      ['update', str(collection)],
      [
        'updates',
        {
          type: 'array',
          items: [
            doc([
              ['q', unchanged(original, id)],
              ['u', next],
              ['upsert', bool(false)],
              ['multi', bool(false)],
            ]),
          ],
        },
      ],
    ]),
  );
  checkWrite(reply);
  if (count(reply, 'n') === 1) {
    return;
  }
  const now = await findById(session, database, collection, id);
  throw now === undefined
    ? new DbError('not-found', msg('The document was deleted meanwhile'))
    : new DbError('busy', msg('The document changed after it was read: refresh it and edit again'));
}

/** Inserts a document; one without `_id` gets a new ObjectId first, as drivers do. */
export async function insertDocument(
  session: Session,
  database: string,
  collection: string,
  document: MongoDocument,
): Promise<MongoValue> {
  const id = idOf(document);
  const withId: MongoDocument =
    id === undefined
      ? doc([['_id', { type: 'objectId', value: newObjectId() }], ...document.fields])
      : document;
  const reply = await session.command(
    database,
    doc([
      ['insert', str(collection)],
      ['documents', { type: 'array', items: [withId] }],
    ]),
  );
  checkWrite(reply);
  return idOf(withId) ?? { type: 'null' };
}

/** Deletes documents by `_id`; returns how many went (a document already gone counts 0). */
export async function deleteDocuments(
  session: Session,
  database: string,
  collection: string,
  ids: readonly MongoValue[],
): Promise<number> {
  if (ids.length === 0) {
    return 0;
  }
  const reply = await session.command(
    database,
    doc([
      ['delete', str(collection)],
      [
        'deletes',
        {
          type: 'array',
          items: ids.map((id) =>
            doc([
              ['q', doc([['_id', id]])],
              ['limit', int32(1)],
            ]),
          ),
        },
      ],
    ]),
  );
  checkWrite(reply);
  return count(reply, 'n');
}

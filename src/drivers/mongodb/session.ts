// A MongoDB session over the `mongodb` driver (V7.5): one client with a small pool.
// Documents are read raw and decoded in their own field order (D88); commands go to
// the primary; whatever fails becomes a DbError.

import {
  type AbstractCursor,
  type AggregateOptions,
  type Document,
  type FindOptions,
  MongoClient,
} from 'mongodb';
import { DbError } from '../../core/errors';
import { type MongoDocument, stringField } from '../../core/mongo/value';
import type { MongoMode, ResolvedConnectionConfig } from '../../shared/connection';
import { mongoModeOf } from '../../shared/connection';
import { tlsFailure, tlsMaterial } from '../common/tls';
import type {
  MongoCollectionInfo,
  MongoCursor,
  MongoCursorRequest,
  MongoDatabaseInfo,
  MongoRawDocument,
  MongoServerInfo,
  MongoSession,
} from '../mongo-driver';
import { readBson } from './bson-read';
import { fromDriverDocument, toDriverCommand, toDriverDocument, toDriverValue } from './bson-write';
import { toMongoDbError } from './errors';
import { mongoOptions, mongoUrl } from './options';

/** Replies of commands keep int32, double and int64 apart, and regexes as written. */
const COMMAND_OPTIONS = {
  promoteValues: false,
  promoteLongs: false,
  promoteBuffers: false,
  bsonRegExp: true,
} as const;

/** Documents per batch the server sends; the UI reads pages of a few hundred. */
const BATCH_SIZE = 200;

function asBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }
  throw new DbError(
    'internal',
    'The driver returned a decoded document where raw bytes were asked',
  );
}

function rawDocument(value: unknown): MongoRawDocument {
  const bytes = asBytes(value);
  return { document: readBson(bytes), size: bytes.length };
}

class DriverCursor implements MongoCursor {
  constructor(private readonly cursor: AbstractCursor) {}

  async next(count: number): Promise<{ documents: MongoRawDocument[]; done: boolean }> {
    const documents: MongoRawDocument[] = [];
    try {
      while (documents.length < count) {
        // What is buffered already costs no round trip.
        const buffered = this.cursor.readBufferedDocuments(count - documents.length);
        documents.push(...buffered.map(rawDocument));
        if (documents.length >= count || this.exhausted()) {
          break;
        }
        if (!(await this.cursor.hasNext())) {
          break;
        }
      }
    } catch (error) {
      throw toMongoDbError(error);
    }
    return { documents, done: this.exhausted() };
  }

  async close(): Promise<void> {
    try {
      await this.cursor.close();
    } catch (error) {
      throw toMongoDbError(error);
    }
  }

  /** Nothing buffered, and the server has no more: its cursor id is 0. */
  private exhausted(): boolean {
    if (this.cursor.bufferedCount() > 0) {
      return false;
    }
    const id = this.cursor.id;
    return this.cursor.closed || id?.isZero() === true;
  }
}

class DriverSession implements MongoSession {
  constructor(
    private readonly client: MongoClient,
    readonly mode: MongoMode,
    readonly server: MongoServerInfo,
  ) {}

  async listDatabases(): Promise<MongoDatabaseInfo[]> {
    const admin = this.client.db('admin');
    let reply: Document;
    try {
      reply = await admin.command({ listDatabases: 1, authorizedDatabases: true });
    } catch (error) {
      const mapped = toMongoDbError(error);
      if (mapped.code !== 'permission-denied') {
        throw mapped;
      }
      // Users without the privilege may still list the names they can read.
      try {
        reply = await admin.command({
          listDatabases: 1,
          nameOnly: true,
          authorizedDatabases: true,
        });
      } catch (retryError) {
        throw toMongoDbError(retryError);
      }
    }
    const databases = Array.isArray(reply.databases) ? (reply.databases as unknown[]) : [];
    return databases.flatMap((entry): MongoDatabaseInfo[] => {
      const { name, sizeOnDisk } = (entry ?? {}) as { name?: unknown; sizeOnDisk?: unknown };
      if (typeof name !== 'string') {
        return [];
      }
      const size = typeof sizeOnDisk === 'number' ? sizeOnDisk : Number(sizeOnDisk);
      return [{ name, ...(Number.isFinite(size) ? { sizeOnDisk: size } : {}) }];
    });
  }

  async listCollections(database: string): Promise<MongoCollectionInfo[]> {
    let found: Document[];
    try {
      found = await this.client
        .db(database)
        .listCollections({}, { nameOnly: false, authorizedCollections: true, ...COMMAND_OPTIONS })
        .toArray();
    } catch (error) {
      throw toMongoDbError(error);
    }
    return found.flatMap((entry): MongoCollectionInfo[] => {
      if (typeof entry.name !== 'string') {
        return [];
      }
      const kind: unknown = entry.type;
      const type = kind === 'view' || kind === 'timeseries' ? kind : 'collection';
      const found: unknown = entry.options;
      const options = typeof found === 'object' && found !== null ? (found as Document) : {};
      return [{ name: entry.name, type, options: fromDriverDocument(options) }];
    });
  }

  async listIndexes(database: string, collection: string): Promise<MongoDocument[]> {
    try {
      const raw = await this.client
        .db(database)
        .collection(collection)
        .listIndexes({ raw: true })
        .toArray();
      return raw.map((entry) => readBson(asBytes(entry)));
    } catch (error) {
      throw toMongoDbError(error);
    }
  }

  async command(database: string, command: MongoDocument): Promise<MongoDocument> {
    if (command.fields.length === 0) {
      throw new DbError('syntax', 'The command is empty');
    }
    try {
      const reply = await this.client
        .db(database)
        .command(toDriverCommand(command), COMMAND_OPTIONS);
      return fromDriverDocument(reply);
    } catch (error) {
      throw toMongoDbError(error);
    }
  }

  /** Opening sends nothing yet: the first `next` runs the query. */
  openCursor(database: string, request: MongoCursorRequest): Promise<MongoCursor> {
    const db = this.client.db(database);
    let cursor: AbstractCursor;
    try {
      if (request.kind === 'find') {
        const options: FindOptions = {
          raw: true,
          batchSize: BATCH_SIZE,
          ...(request.projection === undefined
            ? {}
            : { projection: toDriverDocument(request.projection) }),
          ...(request.sort === undefined
            ? {}
            : { sort: toDriverDocument(request.sort) as unknown as FindOptions['sort'] }),
          ...(request.skip === undefined || request.skip === 0 ? {} : { skip: request.skip }),
          ...(request.limit === undefined || request.limit === 0 ? {} : { limit: request.limit }),
          ...(request.hint === undefined ? {} : { hint: toDriverValue(request.hint) as Document }),
          ...(request.collation === undefined
            ? {}
            : {
                collation: Object.fromEntries(
                  toDriverDocument(request.collation),
                ) as unknown as FindOptions['collation'],
              }),
          ...(request.maxTimeMS === undefined || request.maxTimeMS === 0
            ? {}
            : { maxTimeMS: request.maxTimeMS }),
        };
        const filter =
          request.filter === undefined
            ? {}
            : (toDriverDocument(request.filter) as unknown as Document);
        cursor = db.collection(request.collection).find(filter, options);
      } else {
        const options: AggregateOptions = {
          raw: true,
          batchSize: BATCH_SIZE,
          ...(request.maxTimeMS === undefined || request.maxTimeMS === 0
            ? {}
            : { maxTimeMS: request.maxTimeMS }),
          ...(request.allowDiskUse === undefined ? {} : { allowDiskUse: request.allowDiskUse }),
          ...(request.hint === undefined ? {} : { hint: toDriverValue(request.hint) as Document }),
          ...(request.collation === undefined
            ? {}
            : {
                collation: Object.fromEntries(
                  toDriverDocument(request.collation),
                ) as unknown as AggregateOptions['collation'],
              }),
        };
        const pipeline = request.pipeline.map((stage) => toDriverValue(stage) as Document);
        cursor =
          request.collection === undefined
            ? db.aggregate(pipeline, options)
            : db.collection(request.collection).aggregate(pipeline, options);
      }
    } catch (error) {
      return Promise.reject(toMongoDbError(error));
    }
    return Promise.resolve(new DriverCursor(cursor));
  }

  async close(): Promise<void> {
    try {
      await this.client.close(true);
    } catch (error) {
      throw toMongoDbError(error);
    }
  }
}

/** Errors a failure wraps: causes, and what each server said during server selection. */
function* causes(error: unknown, depth = 0): Generator {
  if (error === null || error === undefined || depth > 6) {
    return;
  }
  yield error;
  const { cause, reason } = error as { cause?: unknown; reason?: { servers?: unknown } };
  yield* causes(cause, depth + 1);
  if (reason?.servers instanceof Map) {
    for (const server of reason.servers.values() as Iterable<{ error?: unknown }>) {
      yield* causes(server.error, depth + 1);
    }
  }
}

/** Why a connect failed: a refused certificate says so in words (as for other drivers). */
function connectFailure(error: unknown, serverName: string | undefined): DbError {
  if (serverName !== undefined) {
    for (const cause of causes(error)) {
      const tls = tlsFailure(cause, serverName);
      if (tls !== undefined) {
        return tls;
      }
    }
  }
  const mapped = toMongoDbError(error);
  // Anything that kept the session from opening is a failed connection, unless it is
  // about who the user is.
  return mapped.code === 'auth-failed' ||
    mapped.code === 'permission-denied' ||
    mapped.code === 'connection-failed'
    ? mapped
    : new DbError('connection-failed', mapped.message, { cause: error });
}

/** Who the server is: `hello` (`isMaster` before 4.4.2) and `buildInfo`. */
async function serverInfo(client: MongoClient): Promise<MongoServerInfo> {
  const admin = client.db('admin');
  let hello: Document;
  try {
    hello = await admin.command({ hello: 1 });
  } catch (error) {
    if (toMongoDbError(error).code !== 'syntax') {
      throw error;
    }
    hello = await admin.command({ isMaster: 1 });
  }
  const build = await admin.command({ buildInfo: 1 });
  const info = fromDriverDocument(hello);
  const setName = stringField(info, 'setName');
  const topology =
    stringField(info, 'msg') === 'isdbgrid'
      ? 'sharded'
      : setName === undefined
        ? 'standalone'
        : 'replicaSet';
  return {
    version: typeof build.version === 'string' ? build.version : 'unknown',
    topology,
    ...(setName === undefined ? {} : { setName }),
  };
}

export async function openMongoSession(config: ResolvedConnectionConfig): Promise<MongoSession> {
  const tls = await tlsMaterial(config);
  let client: MongoClient;
  try {
    client = new MongoClient(mongoUrl(config), mongoOptions(config, tls));
  } catch (error) {
    throw toMongoDbError(error);
  }
  try {
    await client.connect();
    const server = await serverInfo(client);
    return new DriverSession(client, mongoModeOf(config), server);
  } catch (error) {
    await client.close(true).catch(() => undefined);
    throw connectFailure(error, tls?.serverName);
  }
}

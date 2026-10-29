// A MongoDB session for unit tests: databases, collections and indexes are plain data,
// commands are answered by a function, and every call is recorded.

import { DbError } from '../../src/core/errors';
import { formatValue } from '../../src/core/mongo/shell-format';
import { doc, int32, type MongoDocument, type MongoValue } from '../../src/core/mongo/value';
import type {
  MongoCollectionInfo,
  MongoCursor,
  MongoCursorRequest,
  MongoDatabaseInfo,
  MongoDriver,
  MongoRawDocument,
  MongoServerInfo,
  MongoSession,
} from '../../src/drivers/mongo-driver';
import type { MongoMode, ResolvedConnectionConfig } from '../../src/shared/connection';

export type FakeMongoAnswer = (
  database: string,
  command: MongoDocument,
) => MongoDocument | Error | undefined;

/** `{ ok: 1 }`, the reply of most commands. */
export const OK = doc([['ok', { type: 'double', value: '1' }]]);

export class FakeMongoSession implements MongoSession {
  /** Every command as `database: { … }` in the shell's syntax. */
  readonly commands: string[] = [];
  readonly cursors: { database: string; request: MongoCursorRequest }[] = [];
  databases: MongoDatabaseInfo[] = [];
  collections = new Map<string, MongoCollectionInfo[]>();
  indexes = new Map<string, MongoDocument[]>();
  /** Documents a cursor returns, by `database.collection`. */
  documents = new Map<string, MongoDocument[]>();
  /** Thrown by the next listing or command when set. */
  failure: Error | undefined;
  /** What an aggregation returns; by default the documents of its collection. */
  aggregate: ((request: MongoCursorRequest) => MongoDocument[] | Error | undefined) | undefined;
  /** What a find returns instead of the documents of its collection, e.g. by its filter. */
  find: ((request: MongoCursorRequest) => MongoDocument[] | Error | undefined) | undefined;
  closed = false;

  constructor(
    private readonly answer: FakeMongoAnswer = () => OK,
    readonly mode: MongoMode = 'direct',
    readonly server: MongoServerInfo = { version: '8.2.12', topology: 'standalone' },
  ) {}

  private check(): void {
    if (this.closed) {
      throw new DbError('connection-failed', 'Topology is closed');
    }
    if (this.failure !== undefined) {
      throw this.failure;
    }
  }

  async listDatabases(): Promise<MongoDatabaseInfo[]> {
    this.check();
    return await Promise.resolve([...this.databases]);
  }

  async listCollections(database: string): Promise<MongoCollectionInfo[]> {
    this.check();
    return await Promise.resolve([...(this.collections.get(database) ?? [])]);
  }

  async listIndexes(database: string, collection: string): Promise<MongoDocument[]> {
    this.check();
    return await Promise.resolve([...(this.indexes.get(`${database}.${collection}`) ?? [])]);
  }

  async command(database: string, command: MongoDocument): Promise<MongoDocument> {
    this.commands.push(`${database}: ${formatValue(command)}`);
    this.check();
    const reply = this.answer(database, command);
    if (reply instanceof Error) {
      throw reply;
    }
    return await Promise.resolve(reply ?? OK);
  }

  async openCursor(database: string, request: MongoCursorRequest): Promise<MongoCursor> {
    this.check();
    this.cursors.push({ database, request });
    const name = request.kind === 'find' ? request.collection : (request.collection ?? '');
    const custom = request.kind === 'find' ? this.find?.(request) : this.aggregate?.(request);
    if (custom instanceof Error) {
      throw custom;
    }
    const all = custom ?? this.documents.get(`${database}.${name}`) ?? [];
    const skip = request.kind === 'find' ? (request.skip ?? 0) : 0;
    const limit =
      request.kind === 'find' && request.limit !== undefined && request.limit > 0
        ? request.limit
        : Infinity;
    const rest = all.slice(skip, skip + limit);
    let position = 0;
    let closed = false;
    return await Promise.resolve({
      next: async (count: number) => {
        this.check();
        const documents: MongoRawDocument[] = closed
          ? []
          : rest.slice(position, position + count).map((document) => ({
              document,
              size: formatValue(document).length,
            }));
        position += documents.length;
        return await Promise.resolve({ documents, done: closed || position >= rest.length });
      },
      close: async () => {
        closed = true;
        await Promise.resolve();
      },
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.resolve();
  }
}

export class FakeMongoDriver implements MongoDriver {
  readonly id = 'mongodb' as const;
  readonly configs: ResolvedConnectionConfig[] = [];
  readonly sessions: FakeMongoSession[] = [];
  /** Thrown by openSession when set. */
  failure: Error | undefined;

  constructor(private readonly make: () => FakeMongoSession = () => new FakeMongoSession()) {}

  async openSession(config: ResolvedConnectionConfig): Promise<MongoSession> {
    this.configs.push(config);
    if (this.failure !== undefined) {
      throw this.failure;
    }
    const session = this.make();
    this.sessions.push(session);
    return await Promise.resolve(session);
  }
}

/** An index spec as the server lists it. */
export function indexSpec(
  name: string,
  key: MongoDocument,
  extra: [string, MongoValue][] = [],
): MongoDocument {
  return doc([['v', int32(2)], ['key', key], ['name', { type: 'string', value: name }], ...extra]);
}

export function collection(
  name: string,
  type: MongoCollectionInfo['type'] = 'collection',
  options: MongoDocument = doc([]),
): MongoCollectionInfo {
  return { name, type, options };
}

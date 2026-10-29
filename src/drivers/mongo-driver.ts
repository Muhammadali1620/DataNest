// What a MongoDB driver offers (V7.5). MongoDB is not SQL: it keeps documents in
// collections and is asked with commands, so it does not implement `Driver` (D81, D88).
// The connection manager opens, keeps and drops its sessions like any other, and the
// MongoDB UI (tree, documents, queries) talks to it through these types only.

import type { MongoDocument, MongoValue } from '../core/mongo/value';
import type { MongoMode, ResolvedConnectionConfig } from '../shared/connection';

/** What the server said about itself when the session opened. */
export interface MongoServerInfo {
  /** `8.2.12`. */
  readonly version: string;
  /** One server, a member of a replica set, or a router of a sharded cluster. */
  readonly topology: 'standalone' | 'replicaSet' | 'sharded';
  /** The name of the replica set, for `replicaSet`. */
  readonly setName?: string;
}

export interface MongoDatabaseInfo {
  readonly name: string;
  /** Bytes on disk; absent when the user may only list names. */
  readonly sizeOnDisk?: number;
}

export interface MongoCollectionInfo {
  readonly name: string;
  readonly type: 'collection' | 'view' | 'timeseries';
  /** What it was created with: `capped`, `validator`, `viewOn` and `pipeline`, … */
  readonly options: MongoDocument;
}

/** A document as the server sent it, with its encoded size. */
export interface MongoRawDocument {
  readonly document: MongoDocument;
  /** Bytes of its BSON; the UI shows huge documents cut. */
  readonly size: number;
}

/** What a cursor reads: a `find` on a collection or an aggregation pipeline. */
export type MongoCursorRequest =
  | {
      readonly kind: 'find';
      readonly collection: string;
      readonly filter?: MongoDocument;
      readonly projection?: MongoDocument;
      readonly sort?: MongoDocument;
      readonly skip?: number;
      /** Documents in all; absent or 0 means every one. */
      readonly limit?: number;
      readonly hint?: MongoValue;
      readonly collation?: MongoDocument;
      readonly maxTimeMS?: number;
    }
  | {
      readonly kind: 'aggregate';
      /** Absent for a database-wide pipeline (`$currentOp`, `$documents`). */
      readonly collection?: string;
      readonly pipeline: readonly MongoValue[];
      readonly maxTimeMS?: number;
      readonly allowDiskUse?: boolean;
      readonly hint?: MongoValue;
      readonly collation?: MongoDocument;
    };

/** A server cursor, read batch by batch; the server keeps it until it is exhausted or closed. */
export interface MongoCursor {
  /** Up to `count` more documents; `done` once the cursor has nothing more. */
  next(count: number): Promise<{ readonly documents: MongoRawDocument[]; readonly done: boolean }>;
  /** Kills the cursor on the server, if it is still open. */
  close(): Promise<void>;
}

/** One live MongoDB connection: a client with its own small pool. */
export interface MongoSession {
  readonly mode: MongoMode;
  readonly server: MongoServerInfo;
  /** The databases the user may see (`authorizedDatabases`). */
  listDatabases(): Promise<MongoDatabaseInfo[]>;
  listCollections(database: string): Promise<MongoCollectionInfo[]>;
  /** Index specs of a collection, keys in their order. */
  listIndexes(database: string, collection: string): Promise<MongoDocument[]>;
  /**
   * Runs one command (`{ create: 'orders' }`, `{ insert: … }`) on the primary. A reply
   * with `ok: 0` rejects with a DbError; write errors inside an `ok: 1` reply are the
   * caller's to read. A lost link rejects with code `connection-failed` (D26).
   */
  command(database: string, command: MongoDocument): Promise<MongoDocument>;
  /** Opens a cursor; documents keep their field order (D88). */
  openCursor(database: string, request: MongoCursorRequest): Promise<MongoCursor>;
  /** Closes the client; the session is unusable afterwards. */
  close(): Promise<void>;
}

/** Opens MongoDB sessions; holds no connections itself. */
export interface MongoDriver {
  readonly id: 'mongodb';
  openSession(config: ResolvedConnectionConfig): Promise<MongoSession>;
}

/** The shape of the lazily loaded bundle dist/drivers/mongodb.js. */
export interface MongoDriverModule {
  readonly driver: MongoDriver;
}

// Changes to the structure of a MongoDB server (V7.5): databases, collections and
// indexes, each one command. The commands are built here from the user's names and
// parsed values, never from text glued together (§8). Free of `vscode`.

import { DbError } from '../../core/errors';
import {
  bool,
  doc,
  int32,
  int64,
  type MongoDocument,
  type MongoField,
  type MongoValue,
  str,
} from '../../core/mongo/value';
import type { MongoSession } from '../../drivers/mongo-driver';

type Commands = Pick<MongoSession, 'command'>;

/** The longest database name the server accepts (bytes). */
const MAX_DATABASE_BYTES = 63;

/** Why a database name is refused, or undefined when it is fine (MongoDB's rules). */
export function databaseNameProblem(name: string): string | undefined {
  if (name.trim() === '') {
    return 'The name is empty';
  }
  if (/[/\\. "$*<>:|?]/u.test(name) || name.includes('\u0000')) {
    return 'A database name cannot hold / \\ . " $ * < > : | ? or spaces';
  }
  if (new TextEncoder().encode(name).length > MAX_DATABASE_BYTES) {
    return `A database name is at most ${MAX_DATABASE_BYTES} bytes`;
  }
  return undefined;
}

/** Why a collection name is refused, or undefined when it is fine. */
export function collectionNameProblem(name: string): string | undefined {
  if (name.trim() === '') {
    return 'The name is empty';
  }
  if (name.includes('\u0000') || name.includes('$')) {
    return 'A collection name cannot hold $ or the NUL character';
  }
  if (name.startsWith('system.')) {
    return 'Names starting with "system." belong to the server';
  }
  if (name.startsWith('.') || name.endsWith('.')) {
    return 'A collection name cannot start or end with a dot';
  }
  return undefined;
}

/** What kind of collection to create. */
export type NewCollection =
  | { readonly kind: 'collection' }
  | { readonly kind: 'capped'; readonly sizeBytes: number; readonly maxDocuments?: number }
  | { readonly kind: 'timeseries'; readonly timeField: string; readonly metaField?: string };

export function createCollectionCommand(name: string, options: NewCollection): MongoDocument {
  const fields: MongoField[] = [['create', str(name)]];
  if (options.kind === 'capped') {
    fields.push(['capped', bool(true)], ['size', int64(options.sizeBytes)]);
    if (options.maxDocuments !== undefined) {
      fields.push(['max', int64(options.maxDocuments)]);
    }
  } else if (options.kind === 'timeseries') {
    fields.push([
      'timeseries',
      doc([
        ['timeField', str(options.timeField)],
        ...(options.metaField === undefined
          ? []
          : ([['metaField', str(options.metaField)]] as MongoField[])),
      ]),
    ]);
  }
  return doc(fields);
}

export async function createCollection(
  session: Commands,
  database: string,
  name: string,
  options: NewCollection = { kind: 'collection' },
): Promise<void> {
  const problem = databaseNameProblem(database) ?? collectionNameProblem(name);
  if (problem !== undefined) {
    throw new DbError('syntax', problem);
  }
  await session.command(database, createCollectionCommand(name, options));
}

/** A database comes to be with its first collection: MongoDB keeps no empty ones. */
export async function createDatabase(
  session: Commands,
  database: string,
  firstCollection: string,
): Promise<void> {
  await createCollection(session, database, firstCollection);
}

export async function dropDatabase(session: Commands, database: string): Promise<void> {
  await session.command(database, doc([['dropDatabase', int32(1)]]));
}

/** Drops a collection or a view. */
export async function dropCollection(
  session: Commands,
  database: string,
  name: string,
): Promise<void> {
  await session.command(database, doc([['drop', str(name)]]));
}

/** Renames within the database; an existing target is an error, never replaced. */
export async function renameCollection(
  session: Commands,
  database: string,
  from: string,
  to: string,
): Promise<void> {
  const problem = collectionNameProblem(to);
  if (problem !== undefined) {
    throw new DbError('syntax', problem);
  }
  await session.command(
    'admin',
    doc([
      ['renameCollection', str(`${database}.${from}`)],
      ['to', str(`${database}.${to}`)],
      ['dropTarget', bool(false)],
    ]),
  );
}

/** Values an index key may have: a direction, or the name of a special index. */
function keyPart(value: MongoValue): string | undefined {
  if (value.type === 'int32') {
    return String(value.value);
  }
  return value.type === 'int64' || value.type === 'double' || value.type === 'string'
    ? value.value
    : undefined;
}

/** The name the server gives an index the user did not name: `email_1_name_-1`. */
export function defaultIndexName(keys: MongoDocument): string {
  return keys.fields.map(([name, value]) => `${name}_${keyPart(value) ?? ''}`).join('_');
}

/** Why an index key is refused before it reaches the server. */
export function indexKeyProblem(keys: MongoDocument): string | undefined {
  if (keys.fields.length === 0) {
    return 'The index has no keys: name at least one field, e.g. { email: 1 }';
  }
  for (const [name, value] of keys.fields) {
    if (keyPart(value) === undefined) {
      return `The key "${name}" must be 1, -1 or a kind such as "text", "2dsphere", "hashed"`;
    }
  }
  return undefined;
}

/** `createIndexes` with one index; options such as `unique` come from the user as a document. */
export function createIndexCommand(
  collection: string,
  keys: MongoDocument,
  options: MongoDocument,
): MongoDocument {
  const problem = indexKeyProblem(keys);
  if (problem !== undefined) {
    throw new DbError('syntax', problem);
  }
  const own = options.fields.filter(([name]) => name !== 'key');
  const named = own.some(([name]) => name === 'name');
  return doc([
    ['createIndexes', str(collection)],
    [
      'indexes',
      {
        type: 'array',
        items: [
          doc([
            ['key', keys],
            ...(named ? [] : ([['name', str(defaultIndexName(keys))]] as MongoField[])),
            ...own,
          ]),
        ],
      },
    ],
  ]);
}

export async function createIndex(
  session: Commands,
  database: string,
  collection: string,
  keys: MongoDocument,
  options: MongoDocument,
): Promise<void> {
  await session.command(database, createIndexCommand(collection, keys, options));
}

export async function dropIndex(
  session: Commands,
  database: string,
  collection: string,
  name: string,
): Promise<void> {
  if (name === '_id_') {
    throw new DbError(
      'unsupported',
      'The _id index belongs to every collection and cannot be dropped',
    );
  }
  await session.command(
    database,
    doc([
      ['dropIndexes', str(collection)],
      ['index', str(name)],
    ]),
  );
}

// What the tree lists of a MongoDB server (V7.5): databases, their collections and views,
// and the indexes of a collection, ordered and described for people. Free of `vscode`.

import { formatValue } from '../../core/mongo/shell-format';
import {
  boolField,
  documentField,
  field,
  type MongoDocument,
  numberField,
  stringField,
} from '../../core/mongo/value';
import type {
  MongoCollectionInfo,
  MongoDatabaseInfo,
  MongoSession,
} from '../../drivers/mongo-driver';

/** Databases the server keeps for itself. */
export const MONGO_SYSTEM_DATABASES: readonly string[] = ['admin', 'config', 'local'];

/** `system.views`, `system.buckets.*` and the like belong to the server. */
export function isSystemCollection(name: string): boolean {
  return name.startsWith('system.');
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * The databases, sorted, with the one the connection names added when the user may not
 * list databases but may use that one.
 */
export async function listMongoDatabases(
  session: Pick<MongoSession, 'listDatabases'>,
  configured: string | undefined,
): Promise<MongoDatabaseInfo[]> {
  const found = await session.listDatabases();
  const name = configured?.trim();
  const all =
    name === undefined || name === '' || found.some((database) => database.name === name)
      ? found
      : [...found, { name }];
  return [...all].sort((a, b) => collator.compare(a.name, b.name));
}

export interface CollectionListing {
  readonly collections: MongoCollectionInfo[];
  readonly views: MongoCollectionInfo[];
}

/** Collections (time series among them), then views, each sorted by name. */
export async function listMongoCollections(
  session: Pick<MongoSession, 'listCollections'>,
  database: string,
  showSystem: boolean,
): Promise<CollectionListing> {
  const found = (await session.listCollections(database))
    .filter((collection) => showSystem || !isSystemCollection(collection.name))
    .sort((a, b) => collator.compare(a.name, b.name));
  return {
    collections: found.filter((collection) => collection.type !== 'view'),
    views: found.filter((collection) => collection.type === 'view'),
  };
}

/** What the tree shows about an index; the spec itself stays for commands. */
export interface MongoIndexInfo {
  readonly name: string;
  /** The keys as written: `{ customer: 1, createdAt: -1 }`. */
  readonly keys: string;
  /** `_id_`: every collection has it and it cannot be dropped. */
  readonly primary: boolean;
  readonly unique: boolean;
  readonly sparse: boolean;
  readonly hidden: boolean;
  /** Seconds after which documents expire (a TTL index). */
  readonly expireAfterSeconds?: number;
  /** The filter of a partial index. */
  readonly partial?: string;
  /** `text`, `2dsphere`, `hashed`, … when a key is not a plain direction. */
  readonly kind?: string;
}

/** The special kinds an index key can have instead of 1 or -1. */
function kindOf(keys: MongoDocument | undefined): string | undefined {
  for (const [, value] of keys?.fields ?? []) {
    if (value.type === 'string') {
      return value.value;
    }
  }
  return undefined;
}

export function mongoIndexInfo(spec: MongoDocument): MongoIndexInfo {
  const name = stringField(spec, 'name') ?? '';
  const key = documentField(spec, 'key');
  const ttl = numberField(spec, 'expireAfterSeconds');
  const partial = documentField(spec, 'partialFilterExpression');
  const kind = kindOf(key);
  return {
    name,
    keys: key === undefined ? '' : formatValue(key),
    primary: name === '_id_',
    unique: boolField(spec, 'unique') === true,
    sparse: boolField(spec, 'sparse') === true,
    hidden: boolField(spec, 'hidden') === true,
    ...(ttl === undefined ? {} : { expireAfterSeconds: ttl }),
    ...(partial === undefined ? {} : { partial: formatValue(partial) }),
    ...(kind === undefined ? {} : { kind }),
  };
}

/** The indexes of a collection, `_id_` first, then by name. */
export async function listMongoIndexes(
  session: Pick<MongoSession, 'listIndexes'>,
  database: string,
  collection: string,
): Promise<MongoIndexInfo[]> {
  const specs = await session.listIndexes(database, collection);
  return specs
    .map(mongoIndexInfo)
    .sort((a, b) =>
      a.primary === b.primary ? collator.compare(a.name, b.name) : a.primary ? -1 : 1,
    );
}

/** Marks of a collection the tree shows next to its name. */
export interface CollectionMarks {
  readonly capped: boolean;
  readonly timeseries: boolean;
  /** The collection a view reads. */
  readonly viewOn?: string;
  /** It has a validator: documents must match a schema. */
  readonly validated: boolean;
}

export function collectionMarks(info: MongoCollectionInfo): CollectionMarks {
  const viewOn = stringField(info.options, 'viewOn');
  return {
    capped: boolField(info.options, 'capped') === true,
    timeseries: info.type === 'timeseries',
    ...(viewOn === undefined ? {} : { viewOn }),
    validated: field(info.options, 'validator') !== undefined,
  };
}

/** "420 KB", "1.5 GB": the size of a database for its description. */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text =
    unit === 0 || value >= 100
      ? Math.round(value).toString()
      : value.toFixed(1).replace(/\.0$/, '');
  return `${text} ${units[unit] ?? 'B'}`;
}

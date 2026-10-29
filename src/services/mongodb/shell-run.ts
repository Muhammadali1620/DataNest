// Runs a statement of a MongoDB query document (V7.7) on a session: finds and pipelines
// become cursors, counts and writes become commands. What a statement may change is
// decided before it runs (`statementEffect`), so read-only, production and safe mode can
// stop it first (D90). Free of `vscode`.

import { DbError } from '../../core/errors';
import { formatValue } from '../../core/mongo/shell-format';
import type { ShellCall, ShellStatement } from '../../core/mongo/shell-command';
import {
  bool,
  doc,
  field,
  int32,
  type MongoDocument,
  type MongoField,
  type MongoValue,
  str,
} from '../../core/mongo/value';
import type { MongoCursor, MongoCursorRequest, MongoSession } from '../../drivers/mongo-driver';
import { checkWrite, countDocuments } from './documents';
import { createIndexCommand } from './schema-edits';

/** What a statement does to data: reads, writes, or writes something hard to undo. */
export type StatementEffect = 'read' | 'write' | 'dangerous';

/** Commands that only read, for `db.runCommand`; anything else counts as a write. */
const READ_COMMANDS = new Set([
  'find',
  'count',
  'distinct',
  'listCollections',
  'listIndexes',
  'listDatabases',
  'dbStats',
  'collStats',
  'dataSize',
  'serverStatus',
  'buildInfo',
  'buildinfo',
  'hello',
  'isMaster',
  'ismaster',
  'ping',
  'connectionStatus',
  'hostInfo',
  'getParameter',
  'getCmdLineOpts',
  'getLog',
  'replSetGetStatus',
  'replSetGetConfig',
  'top',
  'currentOp',
  'explain',
  'whatsmyuri',
  'usersInfo',
  'rolesInfo',
  'listCommands',
  'features',
  'lockInfo',
  'getDefaultRWConcern',
]);

const READ_METHODS = new Set([
  'find',
  'findOne',
  'countDocuments',
  'estimatedDocumentCount',
  'count',
  'distinct',
  'getIndexes',
  'stats',
  'getCollectionNames',
]);

/** Pipeline stages that write their output somewhere. */
function pipelineWrites(pipeline: MongoValue | undefined): boolean {
  if (pipeline?.type !== 'array') {
    return false;
  }
  return pipeline.items.some(
    (stage) =>
      stage.type === 'document' &&
      stage.fields.some(([name]) => name === '$out' || name === '$merge'),
  );
}

function isEmptyFilter(value: MongoValue | undefined): boolean {
  return value === undefined || (value.type === 'document' && value.fields.length === 0);
}

function commandEffect(command: MongoValue | undefined): StatementEffect {
  if (command?.type !== 'document') {
    return 'write';
  }
  const [first] = command.fields;
  const name = first?.[0] ?? '';
  if (name === 'aggregate') {
    return pipelineWrites(field(command, 'pipeline')) ? 'write' : 'read';
  }
  if (name === 'drop' || name === 'dropDatabase' || name === 'shutdown') {
    return 'dangerous';
  }
  return READ_COMMANDS.has(name) ? 'read' : 'write';
}

/** What a statement may change, from its text alone and before it runs. */
export function statementEffect(statement: ShellStatement): StatementEffect {
  if (statement.kind !== 'call') {
    return 'read';
  }
  const { method, args } = statement.call;
  const explained = statement.chain.some((link) => link.method === 'explain');
  if (method === 'runCommand' || method === 'adminCommand') {
    return commandEffect(args[0]);
  }
  if (method === 'aggregate') {
    // Explaining a pipeline does not run its $out.
    return pipelineWrites(args[0]) && !explained ? 'write' : 'read';
  }
  if (method === 'drop' || method === 'dropDatabase') {
    return 'dangerous';
  }
  if ((method === 'deleteMany' || method === 'updateMany') && isEmptyFilter(args[0])) {
    return 'dangerous';
  }
  if (READ_METHODS.has(method)) {
    return 'read';
  }
  // Inserts, updates, deletes, indexes, and whatever DataNest does not know.
  return 'write';
}

/** What running a statement gave. */
export type RunOutcome =
  | { readonly kind: 'use'; readonly database: string }
  /** Documents to read from a cursor: a find or a pipeline. */
  | { readonly kind: 'cursor'; readonly cursor: MongoCursor; readonly collection?: string }
  /** A few documents at once: a reply, a listing, a single document. */
  | { readonly kind: 'documents'; readonly documents: readonly MongoDocument[] }
  | { readonly kind: 'count'; readonly count: string }
  | {
      readonly kind: 'write';
      readonly reply: MongoDocument;
      readonly inserted?: number;
      readonly matched?: number;
      readonly modified?: number;
      readonly upserted?: number;
      readonly deleted?: number;
    };

function unsupported(method: string): DbError {
  return new DbError(
    'unsupported',
    `DataNest does not run ${method}() from the editor; use find, aggregate, the counts, inserts, updates, deletes, indexes or db.runCommand`,
  );
}

function documentArg(call: ShellCall, index: number, what: string, optional = true): MongoDocument {
  const value = call.args[index];
  if (value === undefined && optional) {
    return doc([]);
  }
  if (value?.type !== 'document') {
    throw new DbError('syntax', `${call.method}() expects ${what} as a document`);
  }
  return value;
}

function numberArg(call: ShellCall): number {
  const value = call.args[0];
  const number =
    value?.type === 'int32'
      ? value.value
      : value?.type === 'int64' || value?.type === 'double'
        ? Number(value.value)
        : NaN;
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new DbError('syntax', `${call.method}() expects a whole number of 0 or more`);
  }
  return number;
}

function arrayArg(call: ShellCall, what: string): MongoValue[] {
  const value = call.args[0];
  if (value?.type !== 'array') {
    throw new DbError('syntax', `${call.method}() expects ${what} in brackets`);
  }
  return [...value.items];
}

function count(reply: MongoDocument, name: string): number {
  const value = field(reply, name);
  return value?.type === 'int32'
    ? value.value
    : value?.type === 'int64' || value?.type === 'double'
      ? Number(value.value)
      : 0;
}

/** Applies `.sort()`, `.limit()`, `.skip()`, `.projection()` … of a find. */
function findRequest(
  collection: string,
  call: ShellCall,
  chain: readonly ShellCall[],
  maxTimeMS: number,
) {
  let request: Extract<MongoCursorRequest, { kind: 'find' }> = {
    kind: 'find',
    collection,
    filter: documentArg(call, 0, 'the filter'),
    projection: documentArg(call, 1, 'the projection'),
    ...(maxTimeMS === 0 ? {} : { maxTimeMS }),
  };
  for (const link of chain) {
    switch (link.method) {
      case 'sort':
        request = { ...request, sort: documentArg(link, 0, 'the sort', false) };
        break;
      case 'limit':
        request = { ...request, limit: numberArg(link) };
        break;
      case 'skip':
        request = { ...request, skip: numberArg(link) };
        break;
      case 'projection':
      case 'project':
        request = { ...request, projection: documentArg(link, 0, 'the projection', false) };
        break;
      case 'hint': {
        const hint = link.args[0];
        if (hint === undefined) {
          throw new DbError('syntax', 'hint() expects an index name or keys');
        }
        request = { ...request, hint };
        break;
      }
      case 'collation':
        request = { ...request, collation: documentArg(link, 0, 'the collation', false) };
        break;
      case 'maxTimeMS':
        request = { ...request, maxTimeMS: numberArg(link) };
        break;
      // Nothing to change in the request; the caller runs explain() and count() apart.
      case 'toArray':
      case 'pretty':
      case 'batchSize':
      case 'explain':
      case 'count':
        break;
      default:
        throw new DbError('unsupported', `DataNest does not run .${link.method}() after find()`);
    }
  }
  return request;
}

/** `{ explain: { find: … }, verbosity: "queryPlanner" }` of a find or a pipeline. */
function explainCommand(inner: MongoDocument): MongoDocument {
  return doc([
    ['explain', inner],
    ['verbosity', str('queryPlanner')],
  ]);
}

function findCommand(request: Extract<MongoCursorRequest, { kind: 'find' }>): MongoDocument {
  const fields: MongoField[] = [['find', str(request.collection)]];
  if (request.filter !== undefined) {
    fields.push(['filter', request.filter]);
  }
  if (request.sort !== undefined) {
    fields.push(['sort', request.sort]);
  }
  if (request.projection !== undefined && request.projection.fields.length > 0) {
    fields.push(['projection', request.projection]);
  }
  if (request.skip !== undefined) {
    fields.push(['skip', int32(request.skip)]);
  }
  if (request.limit !== undefined) {
    fields.push(['limit', int32(request.limit)]);
  }
  return doc(fields);
}

function chainHas(chain: readonly ShellCall[], method: string): boolean {
  return chain.some((link) => link.method === method);
}

export interface RunOptions {
  /** Milliseconds a read may take; 0: no limit. */
  readonly maxTimeMS: number;
}

/** Runs a database method: `db.runCommand(…)`, `db.aggregate(…)`, `db.getCollectionNames()`. */
async function runDatabaseCall(
  session: MongoSession,
  database: string,
  call: ShellCall,
  chain: readonly ShellCall[],
  options: RunOptions,
): Promise<RunOutcome> {
  switch (call.method) {
    case 'runCommand':
      return {
        kind: 'documents',
        documents: [await session.command(database, documentArg(call, 0, 'the command', false))],
      };
    case 'adminCommand':
      return {
        kind: 'documents',
        documents: [await session.command('admin', documentArg(call, 0, 'the command', false))],
      };
    case 'getCollectionNames': {
      const names = (await session.listCollections(database)).map((one) => one.name).sort();
      return { kind: 'documents', documents: names.map((name) => doc([['name', str(name)]])) };
    }
    case 'stats':
      return {
        kind: 'documents',
        documents: [await session.command(database, doc([['dbStats', int32(1)]]))],
      };
    case 'aggregate': {
      const pipeline = arrayArg(call, 'the stages');
      if (chainHas(chain, 'explain')) {
        return {
          kind: 'documents',
          documents: [
            await session.command(
              database,
              explainCommand(
                doc([
                  ['aggregate', int32(1)],
                  ['pipeline', { type: 'array', items: pipeline }],
                  ['cursor', doc([])],
                ]),
              ),
            ),
          ],
        };
      }
      return {
        kind: 'cursor',
        cursor: await session.openCursor(database, {
          kind: 'aggregate',
          pipeline,
          ...(options.maxTimeMS === 0 ? {} : { maxTimeMS: options.maxTimeMS }),
        }),
      };
    }
    case 'createCollection': {
      const name = call.args[0];
      if (name?.type !== 'string') {
        throw new DbError('syntax', 'createCollection() expects a name in quotes');
      }
      const reply = await session.command(
        database,
        doc([['create', name], ...documentArg(call, 1, 'the options').fields]),
      );
      return { kind: 'documents', documents: [reply] };
    }
    case 'dropDatabase':
      return {
        kind: 'documents',
        documents: [await session.command(database, doc([['dropDatabase', int32(1)]]))],
      };
    default:
      throw unsupported(`db.${call.method}`);
  }
}

/** `updates: [{ q, u, upsert, multi }]` of an update or a replacement. */
async function runUpdate(
  session: MongoSession,
  database: string,
  collection: string,
  call: ShellCall,
): Promise<RunOutcome> {
  const filter = documentArg(call, 0, 'the filter', false);
  const update = call.args[1];
  if (update?.type !== 'document' && update?.type !== 'array') {
    throw new DbError('syntax', `${call.method}() expects the update as a document or a pipeline`);
  }
  const replacing = call.method === 'replaceOne';
  const operators =
    update.type === 'document' && update.fields.some(([name]) => name.startsWith('$'));
  if (replacing && operators) {
    throw new DbError(
      'syntax',
      'replaceOne() takes a whole document, not $set and other operators',
    );
  }
  if (!replacing && update.type === 'document' && !operators) {
    throw new DbError(
      'syntax',
      `${call.method}() needs update operators such as $set; replaceOne() replaces a whole document`,
    );
  }
  const options = documentArg(call, 2, 'the options');
  const upsert = field(options, 'upsert');
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
              ['q', filter],
              ['u', update],
              ['upsert', bool(upsert?.type === 'bool' && upsert.value)],
              ['multi', bool(call.method === 'updateMany')],
              ...options.fields.filter(
                ([name]) => name === 'collation' || name === 'arrayFilters' || name === 'hint',
              ),
            ]),
          ],
        },
      ],
    ]),
  );
  checkWrite(reply);
  const upserted = field(reply, 'upserted');
  return {
    kind: 'write',
    reply,
    matched: count(reply, 'n') - (upserted?.type === 'array' ? upserted.items.length : 0),
    modified: count(reply, 'nModified'),
    upserted: upserted?.type === 'array' ? upserted.items.length : 0,
  };
}

async function runCollectionCall(
  session: MongoSession,
  database: string,
  collection: string,
  call: ShellCall,
  chain: readonly ShellCall[],
  options: RunOptions,
): Promise<RunOutcome> {
  switch (call.method) {
    case 'find': {
      const request = findRequest(collection, call, chain, options.maxTimeMS);
      if (chainHas(chain, 'explain')) {
        return {
          kind: 'documents',
          documents: [await session.command(database, explainCommand(findCommand(request)))],
        };
      }
      if (chainHas(chain, 'count')) {
        return {
          kind: 'count',
          count: (await countDocuments(session, database, collection, request.filter ?? doc([]), 0))
            .count,
        };
      }
      return { kind: 'cursor', cursor: await session.openCursor(database, request), collection };
    }
    case 'findOne': {
      const request = { ...findRequest(collection, call, chain, options.maxTimeMS), limit: 1 };
      const cursor = await session.openCursor(database, request);
      try {
        return {
          kind: 'documents',
          documents: (await cursor.next(1)).documents.map((raw) => raw.document),
        };
      } finally {
        await cursor.close().catch(() => undefined);
      }
    }
    case 'aggregate': {
      const pipeline = arrayArg(call, 'the stages');
      const settings = documentArg(call, 1, 'the options');
      if (chainHas(chain, 'explain')) {
        return {
          kind: 'documents',
          documents: [
            await session.command(
              database,
              explainCommand(
                doc([
                  ['aggregate', str(collection)],
                  ['pipeline', { type: 'array', items: pipeline }],
                  ['cursor', doc([])],
                ]),
              ),
            ),
          ],
        };
      }
      const allowDiskUse = field(settings, 'allowDiskUse');
      return {
        kind: 'cursor',
        cursor: await session.openCursor(database, {
          kind: 'aggregate',
          collection,
          pipeline,
          ...(options.maxTimeMS === 0 ? {} : { maxTimeMS: options.maxTimeMS }),
          ...(allowDiskUse?.type === 'bool' ? { allowDiskUse: allowDiskUse.value } : {}),
        }),
        collection,
      };
    }
    case 'countDocuments':
    case 'count':
      return {
        kind: 'count',
        count: (
          await countDocuments(
            session,
            database,
            collection,
            documentArg(call, 0, 'the filter'),
            options.maxTimeMS,
          )
        ).count,
      };
    case 'estimatedDocumentCount':
      return {
        kind: 'count',
        count: (await countDocuments(session, database, collection, doc([]))).count,
      };
    case 'distinct': {
      const key = call.args[0];
      if (key?.type !== 'string') {
        throw new DbError('syntax', 'distinct() expects the field name in quotes');
      }
      const reply = await session.command(
        database,
        doc([
          ['distinct', str(collection)],
          ['key', key],
          ['query', documentArg(call, 1, 'the filter')],
        ]),
      );
      const values = field(reply, 'values');
      return {
        kind: 'documents',
        documents: (values?.type === 'array' ? values.items : []).map((value) =>
          doc([['value', value]]),
        ),
      };
    }
    case 'insertOne':
    case 'insertMany': {
      const documents =
        call.method === 'insertOne'
          ? [documentArg(call, 0, 'the document', false)]
          : arrayArg(call, 'the documents');
      if (documents.length === 0 || documents.some((one) => one.type !== 'document')) {
        throw new DbError('syntax', `${call.method}() expects documents`);
      }
      const reply = await session.command(
        database,
        doc([
          ['insert', str(collection)],
          ['documents', { type: 'array', items: documents }],
        ]),
      );
      checkWrite(reply);
      return { kind: 'write', reply, inserted: count(reply, 'n') };
    }
    case 'updateOne':
    case 'updateMany':
    case 'replaceOne':
      return await runUpdate(session, database, collection, call);
    case 'deleteOne':
    case 'deleteMany': {
      const reply = await session.command(
        database,
        doc([
          ['delete', str(collection)],
          [
            'deletes',
            {
              type: 'array',
              items: [
                doc([
                  ['q', documentArg(call, 0, 'the filter', false)],
                  ['limit', int32(call.method === 'deleteOne' ? 1 : 0)],
                ]),
              ],
            },
          ],
        ]),
      );
      checkWrite(reply);
      return { kind: 'write', reply, deleted: count(reply, 'n') };
    }
    case 'getIndexes':
      return { kind: 'documents', documents: await session.listIndexes(database, collection) };
    case 'createIndex':
      return {
        kind: 'documents',
        documents: [
          await session.command(
            database,
            createIndexCommand(
              collection,
              documentArg(call, 0, 'the keys', false),
              documentArg(call, 1, 'the options'),
            ),
          ),
        ],
      };
    case 'dropIndex': {
      const index = call.args[0];
      if (index === undefined) {
        throw new DbError('syntax', 'dropIndex() expects the name or the keys of the index');
      }
      return {
        kind: 'documents',
        documents: [
          await session.command(
            database,
            doc([
              ['dropIndexes', str(collection)],
              ['index', index],
            ]),
          ),
        ],
      };
    }
    case 'drop':
      return {
        kind: 'documents',
        documents: [await session.command(database, doc([['drop', str(collection)]]))],
      };
    case 'stats':
      return {
        kind: 'documents',
        documents: [await session.command(database, doc([['collStats', str(collection)]]))],
      };
    default:
      throw unsupported(call.method);
  }
}

/** Runs a statement in a database (the editor's, or the one `getSiblingDB` names). */
export async function runStatement(
  session: MongoSession,
  database: string,
  statement: ShellStatement,
  options: RunOptions,
): Promise<RunOutcome> {
  switch (statement.kind) {
    case 'use':
      return { kind: 'use', database: statement.database };
    case 'show': {
      if (statement.what === 'databases') {
        const databases = await session.listDatabases();
        return {
          kind: 'documents',
          documents: databases.map((one) =>
            doc([
              ['name', str(one.name)],
              ...(one.sizeOnDisk === undefined
                ? []
                : ([
                    ['sizeOnDisk', { type: 'int64', value: String(one.sizeOnDisk) }],
                  ] as MongoField[])),
            ]),
          ),
        };
      }
      const collections = await session.listCollections(database);
      return {
        kind: 'documents',
        documents: collections
          .map((one) =>
            doc([
              ['name', str(one.name)],
              ['type', str(one.type)],
            ]),
          )
          .sort((a, b) => formatValue(a).localeCompare(formatValue(b))),
      };
    }
    case 'call': {
      const target = statement.database ?? database;
      return statement.collection === undefined
        ? await runDatabaseCall(session, target, statement.call, statement.chain, options)
        : await runCollectionCall(
            session,
            target,
            statement.collection,
            statement.call,
            statement.chain,
            options,
          );
    }
  }
}

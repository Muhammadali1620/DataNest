// The shape of the connections tree. Free of `vscode` so the structure and the
// identity rules are covered by unit tests (ARCHITECTURE.md §11).

import type {
  ColumnInfo,
  ForeignKey,
  IndexInfo,
  ListedObjectKind,
  ObjectRef,
  ObjectScope,
  RelationKind,
  TableKind,
  TableRef,
  TableStats,
} from '../../core/model/objects';
import type { ElasticFieldInfo, ElasticIndexInfo } from '../../services/elasticsearch/catalog';
import type { MongoIndexInfo } from '../../services/mongodb/catalog';
import type { DriverFamily } from '../../shared/connection';
import { type RedisKeyRef, redisKeyId } from '../../shared/redis-key';
import type { ZnodeKind } from '../../shared/zk-path';

/** The view id the tree is registered under; `package.json` must declare the same. */
export const CONNECTIONS_VIEW_ID = 'datanest.connections';

/**
 * `contextValue` of every item kind. Menus in `package.json` match on these, so a
 * test can check that no menu refers to a value the tree never sets.
 */
export const TREE_CONTEXT = {
  /** A folder of connections at the top of the tree. */
  connectionFolder: 'datanest.connectionFolder',
  connection: 'datanest.connection',
  connectionConnected: 'datanest.connection.connected',
  /** The Favorites group at the top of the tree (V13.2). */
  favorites: 'datanest.favorites',
  /** A connection switched off (V13.1): only enable, edit and delete are offered. */
  connectionDisabled: 'datanest.connection.disabled',
  /** The connections of a workspace folder's `.vscode/datanest.json` (V4.7). */
  project: 'datanest.project',
  /** A connection from a project file: no user folders, other menus. */
  projectConnection: 'datanest.projectConnection',
  projectConnectionConnected: 'datanest.projectConnection.connected',
  /** Redis connections (V7.1) share the connection menus but none of the SQL ones. */
  redisConnection: 'datanest.redisConnection',
  redisConnectionConnected: 'datanest.redisConnection.connected',
  projectRedisConnection: 'datanest.projectRedisConnection',
  projectRedisConnectionConnected: 'datanest.projectRedisConnection.connected',
  /** A numbered Redis database. */
  redisDatabase: 'datanest.redisDatabase',
  /** A group of Redis keys sharing a prefix (V7.2). */
  redisFolder: 'datanest.redisFolder',
  redisKey: 'datanest.redisKey',
  /** "Load more keys" at the end of a database that SCAN has not walked yet. */
  redisMore: 'datanest.redisMore',
  /** MongoDB connections (V7.5) share the connection menus but none of the SQL ones. */
  mongoConnection: 'datanest.mongoConnection',
  mongoConnectionConnected: 'datanest.mongoConnection.connected',
  projectMongoConnection: 'datanest.projectMongoConnection',
  projectMongoConnectionConnected: 'datanest.projectMongoConnection.connected',
  mongoDatabase: 'datanest.mongoDatabase',
  mongoCollection: 'datanest.mongoCollection',
  mongoView: 'datanest.mongoView',
  mongoIndex: 'datanest.mongoIndex',
  /** The `_id_` index: every collection has it, and it cannot be dropped. */
  mongoIdIndex: 'datanest.mongoIdIndex',
  /** Elasticsearch connections (V7.8) share the connection menus but none of the SQL ones. */
  elasticConnection: 'datanest.elasticConnection',
  elasticConnectionConnected: 'datanest.elasticConnection.connected',
  projectElasticConnection: 'datanest.projectElasticConnection',
  projectElasticConnectionConnected: 'datanest.projectElasticConnection.connected',
  elasticIndex: 'datanest.elasticIndex',
  elasticField: 'datanest.elasticField',
  /** etcd connections (V13.19) share the connection menus but none of the SQL ones. */
  etcdConnection: 'datanest.etcdConnection',
  etcdConnectionConnected: 'datanest.etcdConnection.connected',
  projectEtcdConnection: 'datanest.projectEtcdConnection',
  projectEtcdConnectionConnected: 'datanest.projectEtcdConnection.connected',
  /** Keys of an etcd connection whose names share a prefix: `/app/db/` holds `/app/db/host`. */
  etcdFolder: 'datanest.etcdFolder',
  etcdKey: 'datanest.etcdKey',
  /** "Load more" at the end of a folder whose next page has not been read. */
  etcdMore: 'datanest.etcdMore',
  /** ZooKeeper connections (V13.24) share the connection menus but none of the SQL ones. */
  zookeeperConnection: 'datanest.zookeeperConnection',
  zookeeperConnectionConnected: 'datanest.zookeeperConnection.connected',
  projectZookeeperConnection: 'datanest.projectZookeeperConnection',
  projectZookeeperConnectionConnected: 'datanest.projectZookeeperConnection.connected',
  /** A znode: it holds data and may hold children. */
  zookeeperNode: 'datanest.zookeeperNode',
  /** "Load more" at the end of a znode whose next page of children has not been read. */
  zookeeperMore: 'datanest.zookeeperMore',
  /** Kafka connections (V13.23) share the connection menus but none of the SQL ones. */
  kafkaConnection: 'datanest.kafkaConnection',
  kafkaConnectionConnected: 'datanest.kafkaConnection.connected',
  projectKafkaConnection: 'datanest.projectKafkaConnection',
  projectKafkaConnectionConnected: 'datanest.projectKafkaConnection.connected',
  /** The "Topics" folder of a Kafka connection. */
  kafkaTopics: 'datanest.kafkaTopics',
  kafkaTopic: 'datanest.kafkaTopic',
  kafkaPartition: 'datanest.kafkaPartition',
  /** The "Consumer groups" folder, and one group in it. */
  kafkaGroups: 'datanest.kafkaGroups',
  kafkaGroup: 'datanest.kafkaGroup',
  /** RabbitMQ connections (V13.26) share the connection menus but none of the SQL ones. */
  rabbitConnection: 'datanest.rabbitConnection',
  rabbitConnectionConnected: 'datanest.rabbitConnection.connected',
  projectRabbitConnection: 'datanest.projectRabbitConnection',
  projectRabbitConnectionConnected: 'datanest.projectRabbitConnection.connected',
  /** A virtual host, and its "Queues" and "Exchanges" folders. */
  rabbitVhost: 'datanest.rabbitVhost',
  rabbitQueues: 'datanest.rabbitQueues',
  rabbitExchanges: 'datanest.rabbitExchanges',
  rabbitAdmin: 'datanest.rabbitAdmin',
  rabbitQueue: 'datanest.rabbitQueue',
  rabbitExchange: 'datanest.rabbitExchange',
  database: 'datanest.database',
  schema: 'datanest.schema',
  group: 'datanest.group',
  /** The Tables folder, where a new table can be created. */
  tablesGroup: 'datanest.group.tables',
  /** The Views folder, which can be dumped as a whole. */
  viewsGroup: 'datanest.group.views',
  table: 'datanest.table',
  view: 'datanest.view',
  column: 'datanest.column',
  /** A column the driver can move: it gets the up and down buttons (V11.12). */
  columnMovable: 'datanest.column.movable',
  /** Indexes, Foreign Keys and Triggers inside a table. */
  folder: 'datanest.folder',
  function: 'datanest.function',
  procedure: 'datanest.procedure',
  trigger: 'datanest.trigger',
  sequence: 'datanest.sequence',
  event: 'datanest.event',
  index: 'datanest.index',
  foreignKey: 'datanest.foreignKey',
  message: 'datanest.message',
  /** The "Query" folder of saved queries in a database or schema (V11.12). */
  queryFolder: 'datanest.queryFolder',
  savedQuery: 'datanest.savedQuery',
  /** The "Security" folder of a connection with its Users and Roles (V11.12). */
  security: 'datanest.security',
  securityGroup: 'datanest.securityGroup',
  account: 'datanest.account',
  role: 'datanest.role',
} as const;

/** Folders of a database or schema. */
export type ObjectGroup = 'tables' | 'views' | 'functions' | 'procedures' | 'sequences' | 'events';

/** The folder each listed kind lives in at the scope level (triggers live in tables). */
export const GROUP_OF_KIND: Readonly<Record<Exclude<ListedObjectKind, 'trigger'>, ObjectFolder>> = {
  function: 'functions',
  procedure: 'procedures',
  sequence: 'sequences',
  event: 'events',
};

/** Scope folders that hold listed objects rather than tables and views. */
export type ObjectFolder = Exclude<ObjectGroup, 'tables' | 'views'>;

/** The listed kind each object folder holds. */
export const KIND_OF_GROUP: Readonly<Record<ObjectFolder, ListedObjectKind>> = {
  functions: 'function',
  procedures: 'procedure',
  sequences: 'sequence',
  events: 'event',
};

/** Folders inside a table; Columns comes first and is open, the others are closed. */
export type TableFolder = 'columns' | 'indexes' | 'foreignKeys' | 'triggers';

/** A folder the user keeps connections in; it has no connection of its own. */
export interface ConnectionFolderNode {
  readonly kind: 'connectionFolder';
  readonly folder: string;
}

/** The project file of one workspace folder, holding the connections it shares. */
export interface ProjectNode {
  readonly kind: 'project';
  /** The folder's key (`ProjectFolder.key`). */
  readonly key: string;
  readonly name: string;
}

export interface ConnectionNode {
  readonly kind: 'connection';
  readonly connectionId: string;
}

export interface DatabaseNode {
  readonly kind: 'database';
  readonly connectionId: string;
  readonly database: string;
}

export interface SchemaNode {
  readonly kind: 'schema';
  readonly connectionId: string;
  readonly database?: string;
  readonly schema: string;
}

/** The "Tables", "Views", "Functions", … folders inside a scope. */
export interface GroupNode {
  readonly kind: 'group';
  readonly group: ObjectGroup;
  readonly connectionId: string;
  readonly scope: ObjectScope;
}

export interface TableNode {
  readonly kind: 'table';
  readonly connectionId: string;
  readonly scope: ObjectScope;
  readonly name: string;
  readonly tableKind: TableKind;
  /** A PostgreSQL materialized view. */
  readonly materialized?: boolean;
  /** Estimated rows, size and comment, when the server keeps them (V10.2.3). */
  readonly stats?: TableStats;
}

export interface ColumnNode {
  readonly kind: 'column';
  readonly connectionId: string;
  readonly table: TableRef;
  readonly column: ColumnInfo;
  /** The driver can change the place of the column (MySQL, SQLite, ClickHouse tables). */
  readonly movable?: boolean;
  /** The column is (part of) a foreign key. */
  readonly link?: boolean;
}

/** "Columns", "Indexes", "Foreign Keys" or "Triggers" of one table. */
export interface FolderNode {
  readonly kind: 'folder';
  readonly folder: TableFolder;
  readonly connectionId: string;
  readonly table: TableRef;
}

/** A function, procedure, trigger, sequence or event. */
export interface ObjectNode {
  readonly kind: 'object';
  readonly connectionId: string;
  readonly object: ObjectRef & { readonly kind: ListedObjectKind };
}

export interface IndexNode {
  readonly kind: 'index';
  readonly connectionId: string;
  readonly table: TableRef;
  readonly index: IndexInfo;
}

export interface ForeignKeyNode {
  readonly kind: 'foreignKey';
  readonly connectionId: string;
  readonly table: TableRef;
  readonly key: ForeignKey;
}

/** The "Query" folder of a database or schema: its saved SQL files (V11.12). */
export interface QueryFolderNode {
  readonly kind: 'queryFolder';
  readonly connectionId: string;
  readonly scope: ObjectScope;
}

/** One saved query; `name` is the file name without `.sql`. */
export interface SavedQueryNode {
  readonly kind: 'savedQuery';
  readonly connectionId: string;
  readonly scope: ObjectScope;
  readonly name: string;
}

/** The "Security" folder of a connection: its accounts and roles (V11.12). */
export interface SecurityNode {
  readonly kind: 'security';
  readonly connectionId: string;
}

export type SecurityGroup = 'users' | 'roles';

export interface SecurityGroupNode {
  readonly kind: 'securityGroup';
  readonly connectionId: string;
  readonly group: SecurityGroup;
}

/** An account or a role as the tree lists it. */
export interface AccountInfo {
  readonly name: string;
  /** MySQL accounts are `name@host`. */
  readonly host?: string;
  readonly login: boolean;
  readonly role: boolean;
  readonly flags: readonly string[];
}

export interface AccountNode {
  readonly kind: 'account';
  readonly connectionId: string;
  readonly group: SecurityGroup;
  readonly user: AccountInfo;
}

/** A numbered database of a Redis connection (V7.1). */
export interface RedisDatabaseNode {
  readonly kind: 'redisDatabase';
  readonly connectionId: string;
  readonly database: number;
  readonly keys: number;
}

/** Keys of a Redis database that share a prefix: `user:` holds `user:1`, `user:2` (V7.2). */
export interface RedisFolderNode {
  readonly kind: 'redisFolder';
  readonly connectionId: string;
  readonly database: number;
  /** Segments from the top, this folder's last. */
  readonly path: readonly string[];
  /** The prefix with its separator, e.g. `user:`: what "copy name" copies. */
  readonly prefix: string;
  /** Loaded keys below it. */
  readonly count: number;
}

export interface RedisKeyNode {
  readonly kind: 'redisKey';
  readonly connectionId: string;
  readonly database: number;
  readonly key: RedisKeyRef;
  /** The last segment, shown inside its folder. */
  readonly name: string;
  /** `string`, `hash`, …; absent when the server did not say. */
  readonly keyType?: string;
}

/** The leaf after the keys of a database that SCAN has not walked to the end. */
export interface RedisMoreNode {
  readonly kind: 'redisMore';
  readonly connectionId: string;
  readonly database: number;
  /** Keys loaded so far. */
  readonly loaded: number;
}

/** A database of a MongoDB connection (V7.5). */
export interface MongoDatabaseNode {
  readonly kind: 'mongoDatabase';
  readonly connectionId: string;
  readonly database: string;
  /** Bytes on disk, when the server says. */
  readonly sizeOnDisk?: number;
}

/** A collection, time series collection or view of a MongoDB database. */
export interface MongoCollectionNode {
  readonly kind: 'mongoCollection';
  readonly connectionId: string;
  readonly database: string;
  readonly collection: string;
  readonly collectionType: 'collection' | 'view' | 'timeseries';
  readonly capped?: boolean;
  /** The collection a view reads. */
  readonly viewOn?: string;
  /** Documents must match a validator. */
  readonly validated?: boolean;
}

export interface MongoIndexNode {
  readonly kind: 'mongoIndex';
  readonly connectionId: string;
  readonly database: string;
  readonly collection: string;
  readonly index: MongoIndexInfo;
}

/** An index of an Elasticsearch connection (V7.8). */
export interface ElasticIndexNode {
  readonly kind: 'elasticIndex';
  readonly connectionId: string;
  readonly index: ElasticIndexInfo;
}

/** A field of an index's mapping, with the fields inside it. */
export interface ElasticFieldNode {
  readonly kind: 'elasticField';
  readonly connectionId: string;
  readonly index: string;
  readonly field: ElasticFieldInfo;
}

/** Keys of an etcd connection that share a prefix, up to the slash (V13.19). */
export interface EtcdFolderNode {
  readonly kind: 'etcdFolder';
  readonly connectionId: string;
  /** The folder's whole prefix, slash included; empty for the top of the key space. */
  readonly prefix: RedisKeyRef;
  /** Its own name, shown in the tree. */
  readonly name: string;
  /** Keys below it, when the cluster was asked. */
  readonly count?: number;
}

export interface EtcdKeyNode {
  readonly kind: 'etcdKey';
  readonly connectionId: string;
  readonly key: RedisKeyRef;
  /** The part of the name inside its folder. */
  readonly name: string;
  /** The key dies with a lease. */
  readonly leased?: boolean;
}

/** The leaf after the children of a folder whose next page has not been read. */
export interface EtcdMoreNode {
  readonly kind: 'etcdMore';
  readonly connectionId: string;
  /** The folder that has more; empty for the top. */
  readonly prefix: RedisKeyRef;
  /** Children shown so far. */
  readonly loaded: number;
}

/** A znode of a ZooKeeper connection (V13.24): data, and children besides. */
export interface ZookeeperNodeNode {
  readonly kind: 'zookeeperNode';
  readonly connectionId: string;
  /** The whole path; `/` for the top (the chroot of the connection). */
  readonly path: string;
  /** Its own name, shown in the tree. */
  readonly name: string;
  /** Children it has, when the server was asked. */
  readonly numChildren?: number;
  /** Lives and dies with a session, or has a time to live (a container reads as plain). */
  readonly znodeKind?: ZnodeKind;
  /** The ACL lets this user read nothing of it. */
  readonly denied?: boolean;
}

/** The leaf after the children of a znode whose next page has not been read. */
export interface ZookeeperMoreNode {
  readonly kind: 'zookeeperMore';
  readonly connectionId: string;
  /** The znode that has more children. */
  readonly path: string;
  /** Children shown so far. */
  readonly loaded: number;
  /** All its children. */
  readonly total: number;
}

/** The "Topics" folder of a Kafka connection (V13.23). */
export interface KafkaTopicsNode {
  readonly kind: 'kafkaTopics';
  readonly connectionId: string;
  /** Topics listed, when the cluster was asked. */
  readonly count?: number;
}

export interface KafkaTopicNode {
  readonly kind: 'kafkaTopic';
  readonly connectionId: string;
  readonly topic: string;
  readonly internal: boolean;
}

/** One partition of a topic, with the offsets it holds. */
export interface KafkaPartitionNode {
  readonly kind: 'kafkaPartition';
  readonly connectionId: string;
  readonly topic: string;
  readonly partition: number;
  /** First offset stored and the offset the next message gets. */
  readonly low: string;
  readonly high: string;
  readonly leader: number;
}

/** The "Consumer groups" folder of a Kafka connection. */
export interface KafkaGroupsNode {
  readonly kind: 'kafkaGroups';
  readonly connectionId: string;
}

export interface KafkaGroupNode {
  readonly kind: 'kafkaGroup';
  readonly connectionId: string;
  readonly group: string;
  readonly state: string;
  readonly members: number;
}

/** A virtual host of a RabbitMQ connection (V13.26). */
export interface RabbitVhostNode {
  readonly kind: 'rabbitVhost';
  readonly connectionId: string;
  readonly vhost: string;
}

/** The "Queues" or "Exchanges" folder of a virtual host, or its "Administration" page. */
export interface RabbitFolderNode {
  readonly kind: 'rabbitFolder';
  readonly connectionId: string;
  readonly vhost: string;
  readonly folder: 'queues' | 'exchanges' | 'admin';
}

export interface RabbitQueueNode {
  readonly kind: 'rabbitQueue';
  readonly connectionId: string;
  readonly vhost: string;
  readonly queue: string;
  readonly state: string;
  readonly ready: number;
  readonly unacked: number;
  readonly consumers: number;
}

export interface RabbitExchangeNode {
  readonly kind: 'rabbitExchange';
  readonly connectionId: string;
  readonly vhost: string;
  /** Empty for the default exchange. */
  readonly exchange: string;
  readonly exchangeType: string;
}

/** A leaf that explains something instead of listing objects: an error or "empty". */
export interface MessageNode {
  readonly kind: 'message';
  readonly text: string;
  /** Set when the message belongs to one connection, so refresh can target it. */
  readonly connectionId?: string;
  /** Marks a failure, so the item can be shown differently. */
  readonly failed?: boolean;
  /** Set on the "empty folder" leaf, so connections dropped on it land in the folder. */
  readonly folder?: string;
}

export type TreeNode =
  | ProjectNode
  | ConnectionFolderNode
  | ConnectionNode
  | DatabaseNode
  | SchemaNode
  | GroupNode
  | TableNode
  | ColumnNode
  | FolderNode
  | ObjectNode
  | IndexNode
  | ForeignKeyNode
  | QueryFolderNode
  | SavedQueryNode
  | SecurityNode
  | SecurityGroupNode
  | AccountNode
  | RedisDatabaseNode
  | RedisFolderNode
  | RedisKeyNode
  | RedisMoreNode
  | MongoDatabaseNode
  | MongoCollectionNode
  | MongoIndexNode
  | ElasticIndexNode
  | ElasticFieldNode
  | EtcdFolderNode
  | EtcdKeyNode
  | EtcdMoreNode
  | ZookeeperNodeNode
  | ZookeeperMoreNode
  | KafkaTopicsNode
  | KafkaTopicNode
  | KafkaPartitionNode
  | KafkaGroupsNode
  | KafkaGroupNode
  | RabbitVhostNode
  | RabbitFolderNode
  | RabbitQueueNode
  | RabbitExchangeNode
  | MessageNode;

/** Where in the database a node lives; the root scope is empty. */
export function scopeOf(node: TreeNode): ObjectScope {
  switch (node.kind) {
    case 'database':
      return { database: node.database };
    case 'schema':
      return {
        ...(node.database === undefined ? {} : { database: node.database }),
        schema: node.schema,
      };
    case 'group':
    case 'table':
    case 'queryFolder':
    case 'savedQuery':
      return node.scope;
    case 'column':
    case 'folder':
    case 'index':
    case 'foreignKey':
      return scopeOfRef(node.table);
    case 'object':
      return scopeOfRef(node.object);
    case 'project':
    case 'connectionFolder':
    case 'connection':
    case 'security':
    case 'securityGroup':
    case 'account':
    case 'redisDatabase':
    case 'redisFolder':
    case 'redisKey':
    case 'redisMore':
    case 'mongoDatabase':
    case 'mongoCollection':
    case 'mongoIndex':
    case 'elasticIndex':
    case 'elasticField':
    case 'etcdFolder':
    case 'etcdKey':
    case 'etcdMore':
    case 'zookeeperNode':
    case 'zookeeperMore':
    case 'kafkaTopics':
    case 'kafkaTopic':
    case 'kafkaPartition':
    case 'kafkaGroups':
    case 'kafkaGroup':
    case 'rabbitVhost':
    case 'rabbitFolder':
    case 'rabbitQueue':
    case 'rabbitExchange':
    case 'message':
      return {};
  }
}

function scopeOfRef(table: ObjectScope): ObjectScope {
  return {
    ...(table.database === undefined ? {} : { database: table.database }),
    ...(table.schema === undefined ? {} : { schema: table.schema }),
  };
}

function scopeKey(scope: ObjectScope): string {
  return `${scope.database ?? ''}/${scope.schema ?? ''}`;
}

/**
 * A stable id per node, used by the editor to keep expanded state and by refresh.
 * Parts are escaped so a name containing a separator cannot collide with another node.
 */
export function nodeId(node: TreeNode): string {
  switch (node.kind) {
    case 'project':
      return join(['project', node.key]);
    case 'connectionFolder':
      return join(['connectionFolder', node.folder]);
    case 'connection':
      return join(['connection', node.connectionId]);
    case 'database':
      return join(['database', node.connectionId, node.database]);
    case 'schema':
      return join(['schema', node.connectionId, node.database ?? '', node.schema]);
    case 'group':
      return join(['group', node.connectionId, scopeKey(node.scope), node.group]);
    case 'table':
      return join(['table', node.connectionId, scopeKey(node.scope), node.name]);
    case 'column':
      return join([
        'column',
        node.connectionId,
        scopeKey(scopeOfRef(node.table)),
        node.table.name,
        node.column.name,
      ]);
    case 'folder':
      return join([
        'folder',
        node.connectionId,
        scopeKey(scopeOfRef(node.table)),
        node.table.name,
        node.folder,
      ]);
    case 'object':
      // Overloads share a name; the signature tells them apart. Triggers are
      // unique per table only, in some databases.
      return join([
        'object',
        node.connectionId,
        scopeKey(scopeOfRef(node.object)),
        node.object.kind,
        node.object.table ?? '',
        node.object.name,
        node.object.signature ?? '',
      ]);
    case 'index':
      return join([
        'index',
        node.connectionId,
        scopeKey(scopeOfRef(node.table)),
        node.table.name,
        node.index.name,
      ]);
    case 'foreignKey':
      return join([
        'foreignKey',
        node.connectionId,
        scopeKey(scopeOfRef(node.table)),
        node.table.name,
        node.key.name,
      ]);
    case 'queryFolder':
      return join(['queryFolder', node.connectionId, scopeKey(node.scope)]);
    case 'savedQuery':
      return join(['savedQuery', node.connectionId, scopeKey(node.scope), node.name]);
    case 'security':
      return join(['security', node.connectionId]);
    case 'securityGroup':
      return join(['securityGroup', node.connectionId, node.group]);
    case 'account':
      return join(['account', node.connectionId, node.group, node.user.name, node.user.host ?? '']);
    case 'redisDatabase':
      return join(['redisDatabase', node.connectionId, String(node.database)]);
    case 'redisFolder':
      return join(['redisFolder', node.connectionId, String(node.database), ...node.path]);
    case 'redisKey':
      return join(['redisKey', node.connectionId, String(node.database), redisKeyId(node.key)]);
    case 'redisMore':
      return join(['redisMore', node.connectionId, String(node.database)]);
    case 'mongoDatabase':
      return join(['mongoDatabase', node.connectionId, node.database]);
    case 'mongoCollection':
      return join(['mongoCollection', node.connectionId, node.database, node.collection]);
    case 'mongoIndex':
      return join([
        'mongoIndex',
        node.connectionId,
        node.database,
        node.collection,
        node.index.name,
      ]);
    case 'elasticIndex':
      return join(['elasticIndex', node.connectionId, node.index.name]);
    case 'elasticField':
      return join(['elasticField', node.connectionId, node.index, node.field.path]);
    case 'etcdFolder':
      return join(['etcdFolder', node.connectionId, redisKeyId(node.prefix)]);
    case 'etcdKey':
      return join(['etcdKey', node.connectionId, redisKeyId(node.key)]);
    case 'etcdMore':
      return join(['etcdMore', node.connectionId, redisKeyId(node.prefix)]);
    case 'zookeeperNode':
      return join(['zookeeperNode', node.connectionId, node.path]);
    case 'zookeeperMore':
      return join(['zookeeperMore', node.connectionId, node.path]);
    case 'kafkaTopics':
      return join(['kafkaTopics', node.connectionId]);
    case 'kafkaTopic':
      return join(['kafkaTopic', node.connectionId, node.topic]);
    case 'kafkaPartition':
      return join(['kafkaPartition', node.connectionId, node.topic, String(node.partition)]);
    case 'kafkaGroups':
      return join(['kafkaGroups', node.connectionId]);
    case 'kafkaGroup':
      return join(['kafkaGroup', node.connectionId, node.group]);
    case 'rabbitVhost':
      return join(['rabbitVhost', node.connectionId, node.vhost]);
    case 'rabbitFolder':
      return join(['rabbitFolder', node.connectionId, node.vhost, node.folder]);
    case 'rabbitQueue':
      return join(['rabbitQueue', node.connectionId, node.vhost, node.queue]);
    case 'rabbitExchange':
      return join(['rabbitExchange', node.connectionId, node.vhost, node.exchange]);
    case 'message':
      return join(['message', node.connectionId ?? '', node.text]);
  }
}

function join(parts: readonly string[]): string {
  return parts.map((part) => part.replaceAll('\\', '\\\\').replaceAll(':', '\\:')).join(':');
}

/**
 * The connection a node belongs to. Tree commands get the clicked node, while the
 * command palette passes a plain id (or nothing at all).
 */
export function connectionIdOf(target: TreeNode | string | undefined): string | undefined {
  if (typeof target === 'string') {
    return target === '' ? undefined : target;
  }
  if (target === undefined) {
    return undefined;
  }
  return 'connectionId' in target ? target.connectionId : undefined;
}

/** True for anything that looks like a tree node this extension produced. */
export function isTreeNode(value: unknown): value is TreeNode {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { kind } = value as { kind?: unknown };
  return (
    kind === 'project' ||
    kind === 'connectionFolder' ||
    kind === 'connection' ||
    kind === 'database' ||
    kind === 'schema' ||
    kind === 'group' ||
    kind === 'table' ||
    kind === 'column' ||
    kind === 'folder' ||
    kind === 'object' ||
    kind === 'index' ||
    kind === 'foreignKey' ||
    kind === 'queryFolder' ||
    kind === 'savedQuery' ||
    kind === 'security' ||
    kind === 'securityGroup' ||
    kind === 'account' ||
    kind === 'redisDatabase' ||
    kind === 'redisFolder' ||
    kind === 'redisKey' ||
    kind === 'redisMore' ||
    kind === 'mongoDatabase' ||
    kind === 'mongoCollection' ||
    kind === 'mongoIndex' ||
    kind === 'elasticIndex' ||
    kind === 'elasticField' ||
    kind === 'etcdFolder' ||
    kind === 'etcdKey' ||
    kind === 'etcdMore' ||
    kind === 'zookeeperNode' ||
    kind === 'zookeeperMore' ||
    kind === 'kafkaTopics' ||
    kind === 'kafkaTopic' ||
    kind === 'kafkaPartition' ||
    kind === 'kafkaGroups' ||
    kind === 'kafkaGroup' ||
    kind === 'rabbitVhost' ||
    kind === 'rabbitFolder' ||
    kind === 'rabbitQueue' ||
    kind === 'rabbitExchange' ||
    kind === 'message'
  );
}

/** The name a "copy name" command puts on the clipboard. */
export function nameOf(node: TreeNode): string | undefined {
  switch (node.kind) {
    case 'database':
      return node.database;
    case 'schema':
      return node.schema;
    case 'table':
      return node.name;
    case 'column':
      return node.column.name;
    case 'object':
      return node.object.name;
    case 'index':
      return node.index.name;
    case 'foreignKey':
      return node.key.name;
    case 'savedQuery':
      return node.name;
    case 'account':
      return node.user.name;
    case 'connectionFolder':
      return node.folder;
    case 'redisKey':
      return node.key.text;
    case 'redisFolder':
      return node.prefix;
    case 'mongoDatabase':
      return node.database;
    case 'mongoCollection':
      return node.collection;
    case 'mongoIndex':
      return node.index.name;
    case 'elasticIndex':
      return node.index.name;
    case 'elasticField':
      return node.field.path;
    case 'etcdKey':
      return node.key.text;
    case 'etcdFolder':
      return node.prefix.text;
    case 'zookeeperNode':
      return node.path;
    case 'kafkaTopic':
      return node.topic;
    case 'kafkaGroup':
      return node.group;
    case 'rabbitVhost':
      return node.vhost;
    case 'rabbitQueue':
      return node.queue;
    case 'rabbitExchange':
      return node.exchange === '' ? undefined : node.exchange;
    case 'project':
    case 'connection':
    case 'group':
    case 'folder':
    case 'queryFolder':
    case 'security':
    case 'securityGroup':
    case 'redisDatabase':
    case 'redisMore':
    case 'etcdMore':
    case 'zookeeperMore':
    case 'kafkaTopics':
    case 'kafkaPartition':
    case 'kafkaGroups':
    case 'rabbitFolder':
    case 'message':
      return undefined;
  }
}

/** What DDL calls the relation of a table node. */
export function relationKindOf(node: TableNode): RelationKind {
  if (node.tableKind === 'table') {
    return 'table';
  }
  return node.materialized === true ? 'materialized-view' : 'view';
}

/** The table a node points at, for "open table" and column lookups. */
export function tableRefOf(node: TableNode): TableRef {
  return { ...node.scope, name: node.name };
}

/** The object whose definition a node stands for; folders and columns have none. */
export function objectRefOf(node: TreeNode): ObjectRef | undefined {
  switch (node.kind) {
    case 'table':
      return {
        ...node.scope,
        kind: node.tableKind,
        name: node.name,
        ...(node.materialized === true ? { materialized: true } : {}),
      };
    case 'object':
      return node.object;
    case 'project':
    case 'connectionFolder':
    case 'connection':
    case 'database':
    case 'schema':
    case 'group':
    case 'column':
    case 'folder':
    case 'index':
    case 'foreignKey':
    case 'queryFolder':
    case 'savedQuery':
    case 'security':
    case 'securityGroup':
    case 'account':
    case 'redisDatabase':
    case 'redisFolder':
    case 'redisKey':
    case 'redisMore':
    case 'mongoDatabase':
    case 'mongoCollection':
    case 'mongoIndex':
    case 'elasticIndex':
    case 'elasticField':
    case 'etcdFolder':
    case 'etcdKey':
    case 'etcdMore':
    case 'zookeeperNode':
    case 'zookeeperMore':
    case 'kafkaTopics':
    case 'kafkaTopic':
    case 'kafkaPartition':
    case 'kafkaGroups':
    case 'kafkaGroup':
    case 'rabbitVhost':
    case 'rabbitFolder':
    case 'rabbitQueue':
    case 'rabbitExchange':
    case 'message':
      return undefined;
  }
}

/** The context value of a connection item, which the menus of package.json match. */
export function connectionContext(options: {
  readonly project: boolean;
  readonly connected: boolean;
  readonly family: DriverFamily;
}): string {
  const { project, connected, family } = options;
  if (family === 'rabbitmq') {
    return project
      ? connected
        ? TREE_CONTEXT.projectRabbitConnectionConnected
        : TREE_CONTEXT.projectRabbitConnection
      : connected
        ? TREE_CONTEXT.rabbitConnectionConnected
        : TREE_CONTEXT.rabbitConnection;
  }
  if (family === 'zookeeper') {
    return project
      ? connected
        ? TREE_CONTEXT.projectZookeeperConnectionConnected
        : TREE_CONTEXT.projectZookeeperConnection
      : connected
        ? TREE_CONTEXT.zookeeperConnectionConnected
        : TREE_CONTEXT.zookeeperConnection;
  }
  if (family === 'kafka') {
    return project
      ? connected
        ? TREE_CONTEXT.projectKafkaConnectionConnected
        : TREE_CONTEXT.projectKafkaConnection
      : connected
        ? TREE_CONTEXT.kafkaConnectionConnected
        : TREE_CONTEXT.kafkaConnection;
  }
  if (family === 'etcd') {
    return project
      ? connected
        ? TREE_CONTEXT.projectEtcdConnectionConnected
        : TREE_CONTEXT.projectEtcdConnection
      : connected
        ? TREE_CONTEXT.etcdConnectionConnected
        : TREE_CONTEXT.etcdConnection;
  }
  if (family === 'elasticsearch') {
    return project
      ? connected
        ? TREE_CONTEXT.projectElasticConnectionConnected
        : TREE_CONTEXT.projectElasticConnection
      : connected
        ? TREE_CONTEXT.elasticConnectionConnected
        : TREE_CONTEXT.elasticConnection;
  }
  if (family === 'mongodb') {
    return project
      ? connected
        ? TREE_CONTEXT.projectMongoConnectionConnected
        : TREE_CONTEXT.projectMongoConnection
      : connected
        ? TREE_CONTEXT.mongoConnectionConnected
        : TREE_CONTEXT.mongoConnection;
  }
  if (family === 'redis') {
    return project
      ? connected
        ? TREE_CONTEXT.projectRedisConnectionConnected
        : TREE_CONTEXT.projectRedisConnection
      : connected
        ? TREE_CONTEXT.redisConnectionConnected
        : TREE_CONTEXT.redisConnection;
  }
  return project
    ? connected
      ? TREE_CONTEXT.projectConnectionConnected
      : TREE_CONTEXT.projectConnection
    : connected
      ? TREE_CONTEXT.connectionConnected
      : TREE_CONTEXT.connection;
}

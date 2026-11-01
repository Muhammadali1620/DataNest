// What the tree and completion read from Neo4j: databases, labels (listed as tables),
// relationship types (listed as views, written `[TYPE]`), the property keys of each, and
// the indexes and constraints. Every question is Cypher with parameters; nothing is built
// from user text.

import { DbError } from '../../core/errors';
import type {
  ColumnInfo,
  ForeignKey,
  IndexInfo,
  ListedObjectKind,
  ObjectInfo,
  ObjectRef,
  ObjectScope,
  TableInfo,
  TableRef,
  TableStructure,
} from '../../core/model/objects';
import { msg } from '../../core/user-message';
import type { CellValue } from '../../shared/cell-value';
import type { MetadataReader, TableDump, TypeDump } from '../driver';
import { NODE_PARTS, RELATIONSHIP_PARTS, relationshipName } from './table-query';

/** What the session offers its metadata reader. */
export interface CypherReader {
  queryRows(cypher: string, parameters?: Readonly<Record<string, unknown>>): Promise<CellValue[][]>;
}

function text(cell: CellValue | undefined): string {
  return typeof cell === 'string' ? cell : '';
}

/** A list cell comes as JSON text (`["a","b"]`); its items as strings. */
export function stringsOf(cell: CellValue | undefined): string[] {
  if (typeof cell !== 'object' || cell === null || !('text' in cell)) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(cell.text);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

/** The types the server samples for a property (`Long`, `String`, …) as one short name. */
function typeOfProperty(types: readonly string[]): string {
  return types.length === 0 ? 'any' : types.map((type) => type.toLowerCase()).join(' | ');
}

function refuse(reason: string): never {
  throw new DbError('unsupported', reason);
}

export class Neo4jMetadata implements MetadataReader {
  constructor(private readonly session: CypherReader) {}

  async listDatabases(): Promise<string[]> {
    const rows = await this.session.queryRows(
      'SHOW DATABASES YIELD name RETURN name ORDER BY name',
    );
    return rows.map((row) => text(row[0])).filter((name) => name !== '');
  }

  listSchemas(): Promise<string[]> {
    return Promise.resolve([]);
  }

  async listTables(_scope: ObjectScope): Promise<TableInfo[]> {
    const labels = await this.session.queryRows(
      'CALL db.labels() YIELD label RETURN label ORDER BY label',
    );
    const types = await this.session.queryRows(
      'CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType ORDER BY relationshipType',
    );
    return [
      ...labels.map((row) => ({ name: text(row[0]), kind: 'table' as const })),
      ...types.map((row) => ({ name: `[${text(row[0])}]`, kind: 'view' as const })),
    ].filter((entry) => entry.name !== '' && entry.name !== '[]');
  }

  async listColumns(table: TableRef): Promise<ColumnInfo[]> {
    const type = relationshipName(table.name);
    const parts = (type === undefined ? NODE_PARTS : RELATIONSHIP_PARTS).map<ColumnInfo>(
      (name) => ({
        name,
        dataType: name === '_labels' ? 'list' : 'string',
        nullable: false,
        primaryKey: false,
      }),
    );
    const rows =
      type === undefined
        ? await this.session.queryRows(
            'CALL db.schema.nodeTypeProperties() YIELD nodeLabels, propertyName, propertyTypes, mandatory ' +
              'WHERE $name IN nodeLabels AND propertyName IS NOT NULL ' +
              'RETURN propertyName, propertyTypes, mandatory',
            { name: table.name },
          )
        : await this.session.queryRows(
            'CALL db.schema.relTypeProperties() YIELD relType, propertyName, propertyTypes, mandatory ' +
              'WHERE relType = $name AND propertyName IS NOT NULL ' +
              'RETURN propertyName, propertyTypes, mandatory',
            { name: `:\`${type.replaceAll('`', '``')}\`` },
          );
    const seen = new Set<string>();
    const properties: ColumnInfo[] = [];
    for (const row of rows) {
      const name = text(row[0]);
      if (name === '' || seen.has(name)) {
        continue;
      }
      seen.add(name);
      properties.push({
        name,
        dataType: typeOfProperty(stringsOf(row[1])),
        nullable: row[2] !== true,
        primaryKey: false,
      });
    }
    return [...parts, ...properties.sort((a, b) => a.name.localeCompare(b.name))];
  }

  /** Uniqueness constraints are shown as indexes; a row is edited by Cypher, not by a key. */
  listUniqueKeys(): Promise<string[][]> {
    return Promise.resolve([]);
  }

  listForeignKeys(): Promise<ForeignKey[]> {
    return Promise.resolve([]);
  }

  listObjects(_scope: ObjectScope, _kind: ListedObjectKind): Promise<ObjectInfo[]> {
    return Promise.resolve([]);
  }

  async listIndexes(table: TableRef): Promise<IndexInfo[]> {
    const rows = await this.session.queryRows(
      'SHOW INDEXES YIELD name, type, labelsOrTypes, properties, owningConstraint ' +
        'WHERE $name IN labelsOrTypes AND type <> "LOOKUP" ' +
        'RETURN name, type, properties, owningConstraint IS NOT NULL AS isUnique ORDER BY name',
      { name: relationshipName(table.name) ?? table.name },
    );
    return rows.map((row) => ({
      name: text(row[0]),
      columns: stringsOf(row[2]),
      unique: row[3] === true,
      primary: false,
      method: text(row[1]),
    }));
  }

  describeTable(): Promise<TableStructure> {
    return Promise.reject(
      new DbError(
        'unsupported',
        msg('Neo4j has no table designer: a label appears with its first node'),
      ),
    );
  }

  /** The indexes and constraints of a label, as the statements that create them. */
  async getDefinition(object: ObjectRef): Promise<string[]> {
    if (object.kind !== 'table' && object.kind !== 'view') {
      return refuse(msg('Neo4j keeps no routines inside a database'));
    }
    const name = relationshipName(object.name) ?? object.name;
    const indexes = await this.session.queryRows(
      'SHOW INDEXES YIELD name, labelsOrTypes, type, owningConstraint, createStatement ' +
        'WHERE $name IN labelsOrTypes AND type <> "LOOKUP" AND owningConstraint IS NULL ' +
        'RETURN createStatement ORDER BY name',
      { name },
    );
    const constraints = await this.session.queryRows(
      'SHOW CONSTRAINTS YIELD name, labelsOrTypes, createStatement ' +
        'WHERE $name IN labelsOrTypes RETURN createStatement ORDER BY name',
      { name },
    );
    const statements = [...indexes, ...constraints]
      .map((row) => text(row[0]).trim())
      .filter((statement) => statement !== '');
    return statements.length > 0
      ? statements
      : [msg('// {0} has no indexes or constraints', object.name)];
  }

  getTableDump(): Promise<TableDump> {
    return Promise.reject(
      new DbError('unsupported', msg('Neo4j has no SQL dump: use apoc.export or neo4j-admin')),
    );
  }

  listTypeDumps(): Promise<TypeDump[]> {
    return Promise.resolve([]);
  }
}

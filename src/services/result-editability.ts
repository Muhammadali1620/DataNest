// Works out whether a result can be edited in place (V2.1). Reads the statement and
// asks the server about the one table it names; any failure means "read-only",
// never an error, because being unable to edit must not break showing the rows.

import { errorMessage } from '../core/errors';
import {
  findByName,
  readOnlyResult,
  resolveEditability,
  type ResultEdit,
} from '../core/model/editability';
import type { ForeignKey, ObjectScope, TableRef } from '../core/model/objects';
import { parseSelectSource } from '../core/sql/select-source';
import type { SqlSyntax } from '../core/sql/tokenizer';
import type { Logger } from '../core/logging/logger';
import type { MetadataReader } from '../drivers/driver';
import type { DriverId } from '../shared/connection';

export interface EditabilityContext {
  readonly metadata: MetadataReader;
  readonly syntax: SqlSyntax;
  /** Names are `schema.table` (PostgreSQL) rather than `database.table`. */
  readonly schemas: boolean;
  readonly logger: Logger;
  /** The connection refuses every change, so nothing is editable whatever the query. */
  readonly readOnly?: boolean;
  /** For the types whose meaning depends on the database (Oracle's DATE). */
  readonly driver?: DriverId;
}

/** The scope and name a table reference points at; parts are outermost first. */
export function tableRefOf(parts: readonly string[], schemas: boolean): TableRef | undefined {
  const name = parts.at(-1);
  if (name === undefined) {
    return undefined;
  }
  const qualifiers = parts.slice(0, -1);
  if (schemas) {
    // [database.]schema.table: the database must be the one connected, which the
    // session is already on, so only the schema is used.
    const schema = qualifiers.at(-1);
    return schema === undefined ? { name } : { schema, name };
  }
  const database = qualifiers.at(-1);
  return database === undefined ? { name } : { database, name };
}

export async function analyzeEditability(
  context: EditabilityContext,
  sql: string,
  resultColumns: readonly string[],
): Promise<ResultEdit> {
  if (context.readOnly === true) {
    return readOnlyResult('connection-read-only');
  }
  const parsed = parseSelectSource(sql, context.syntax);
  if (!parsed.ok) {
    return readOnlyResult(parsed.refusal);
  }
  const ref = tableRefOf(parsed.source.tableParts, context.schemas);
  if (ref === undefined) {
    return readOnlyResult('complex');
  }
  try {
    const schema =
      ref.schema === undefined ? undefined : await schemaNamed(context.metadata, ref.schema);
    const scope: ObjectScope = {
      ...(ref.database === undefined ? {} : { database: ref.database }),
      ...(schema === undefined ? {} : { schema }),
    };
    const info = findByName(await context.metadata.listTables(scope), ref.name);
    if (info === undefined) {
      return readOnlyResult('table-not-found');
    }
    const table: TableRef = { ...ref, ...scope, name: info.name };
    const columns = await context.metadata.listColumns(table);
    if (columns.length === 0) {
      return readOnlyResult('table-not-found');
    }
    // Unique keys matter only when there is no primary key.
    const uniqueKeys = columns.some((column) => column.primaryKey)
      ? []
      : await context.metadata.listUniqueKeys(table);
    const resolved = resolveEditability({
      table,
      kind: info.kind,
      columns,
      uniqueKeys,
      items: parsed.source.items,
      resultColumns,
      ...(context.driver === undefined ? {} : { driver: context.driver }),
    });
    if (!resolved.editable) {
      return resolved;
    }
    const foreignKeys = await foreignKeysOf(context, table);
    return foreignKeys.length === 0 ? resolved : { ...resolved, foreignKeys };
  } catch (error) {
    context.logger.debug(`Could not tell if the result is editable: ${errorMessage(error)}`);
    return readOnlyResult('failed');
  }
}

/**
 * The schema a written name means, found the way table names are: exactly, else regardless
 * of case. Oracle keeps unquoted names in upper case, so `shop.orders` is SHOP.ORDERS there.
 */
async function schemaNamed(metadata: MetadataReader, written: string): Promise<string> {
  const schemas = (await metadata.listSchemas()).map((name) => ({ name }));
  return findByName(schemas, written)?.name ?? written;
}

/** Foreign keys are a convenience: not being able to read them must not cost editing. */
async function foreignKeysOf(context: EditabilityContext, table: TableRef): Promise<ForeignKey[]> {
  try {
    return await context.metadata.listForeignKeys(table);
  } catch (error) {
    context.logger.debug(`Could not read the foreign keys: ${errorMessage(error)}`);
    return [];
  }
}

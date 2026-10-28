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
import type { ObjectScope, TableRef } from '../core/model/objects';
import { parseSelectSource } from '../core/sql/select-source';
import type { SqlSyntax } from '../core/sql/tokenizer';
import type { Logger } from '../core/logging/logger';
import type { MetadataReader } from '../drivers/driver';

export interface EditabilityContext {
  readonly metadata: MetadataReader;
  readonly syntax: SqlSyntax;
  /** Names are `schema.table` (PostgreSQL) rather than `database.table`. */
  readonly schemas: boolean;
  readonly logger: Logger;
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
  const parsed = parseSelectSource(sql, context.syntax);
  if (!parsed.ok) {
    return readOnlyResult(parsed.refusal);
  }
  const ref = tableRefOf(parsed.source.tableParts, context.schemas);
  if (ref === undefined) {
    return readOnlyResult('complex');
  }
  try {
    const scope: ObjectScope = {
      ...(ref.database === undefined ? {} : { database: ref.database }),
      ...(ref.schema === undefined ? {} : { schema: ref.schema }),
    };
    const info = findByName(await context.metadata.listTables(scope), ref.name);
    if (info === undefined) {
      return readOnlyResult('table-not-found');
    }
    const table: TableRef = { ...ref, name: info.name };
    const columns = await context.metadata.listColumns(table);
    if (columns.length === 0) {
      return readOnlyResult('table-not-found');
    }
    // Unique keys matter only when there is no primary key.
    const uniqueKeys = columns.some((column) => column.primaryKey)
      ? []
      : await context.metadata.listUniqueKeys(table);
    return resolveEditability({
      table,
      kind: info.kind,
      columns,
      uniqueKeys,
      items: parsed.source.items,
      resultColumns,
    });
  } catch (error) {
    context.logger.debug(`Could not tell if the result is editable: ${errorMessage(error)}`);
    return readOnlyResult('failed');
  }
}

// What the ER diagram page (V8.1) shows, free of `vscode`: the tables read for a
// scope, where the user left the boxes, and how much each box lists.

import type { ObjectScope, TableRef } from '../../core/model/objects';
import type { MetadataReader } from '../../drivers/driver';
import { readErSchema, type ErSchema } from '../../services/er-diagram';
import type { ErDetails, ErDiagramState, ErPosition } from '../../shared/protocols/er-diagram';

export interface ErDiagramModelDeps {
  /** The reader to use now; after a refresh it must not answer from a stale cache. */
  readonly metadata: () => Promise<MetadataReader>;
  readonly scope: ObjectScope;
  /** Only these tables; the whole scope when absent. */
  readonly tables?: readonly string[];
  /** `shop.public`, for the heading and file names. */
  readonly scopeLabel: string;
  readonly connectionName: string;
}

export class ErDiagramModel {
  private schema: ErSchema | undefined;
  private positions = new Map<string, { x: number; y: number }>();
  private details: ErDetails = 'all';

  constructor(private readonly deps: ErDiagramModelDeps) {}

  get loaded(): boolean {
    return this.schema !== undefined;
  }

  /**
   * Reads the tables. Boxes keep their places when every table still has one;
   * a table that is new to the diagram makes the page lay everything out again.
   */
  async load(
    options: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {},
  ): Promise<ErDiagramState> {
    const schema = await readErSchema(await this.deps.metadata(), this.deps.scope, {
      ...(this.deps.tables === undefined ? {} : { tables: this.deps.tables }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
    });
    this.schema = schema;
    if (schema.tables.some((table) => !this.positions.has(table.id))) {
      this.positions.clear();
    }
    return this.state();
  }

  /** What a reloaded page needs; empty until the first read finished. */
  state(): ErDiagramState {
    const schema = this.schema ?? { tables: [], relations: [] };
    const ids = new Set(schema.tables.map((table) => table.id));
    return {
      scope: this.deps.scopeLabel,
      connection: this.deps.connectionName,
      tables: schema.tables.map((table) => ({
        id: table.id,
        label: table.label,
        columns: table.columns.map((column) => ({ ...column })),
        ...(table.external === true ? { external: true as const } : {}),
      })),
      relations: schema.relations.map((relation) => ({
        ...relation,
        columns: [...relation.columns],
        targetColumns: [...relation.targetColumns],
      })),
      positions: [...this.positions]
        .filter(([id]) => ids.has(id))
        .map(([id, at]) => ({ id, x: at.x, y: at.y })),
      details: this.details,
    };
  }

  setPositions(positions: readonly ErPosition[]): void {
    for (const { id, x, y } of positions) {
      this.positions.set(id, { x, y });
    }
  }

  setDetails(details: ErDetails): void {
    this.details = details;
  }

  /** The table behind a box, or undefined for a table of another scope or an unknown id. */
  tableOf(id: string): TableRef | undefined {
    const table = this.schema?.tables.find((candidate) => candidate.id === id);
    if (table === undefined || table.external === true) {
      return undefined;
    }
    return { ...this.deps.scope, name: table.id };
  }
}

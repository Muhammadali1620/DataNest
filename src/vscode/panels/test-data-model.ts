// What the test data page (V5.5) shows and does, free of `vscode`: the columns and
// their suggested generators, a preview for a seed, the run, and the SQL script.

import type { TableRef, TableStructure } from '../../core/model/objects';
import type { Dialect, Session } from '../../drivers/driver';
import type { SessionTarget } from '../../services/connection-manager';
import type { ImportReport, TableImporter } from '../../services/import/table-import';
import type { PlanColumn } from '../../services/test-data/column-plan';
import {
  asRecords,
  type ColumnChoice,
  columnSettings,
  filledColumns,
  type GenerationContext,
  generateRows,
  insertScript,
  loadContext,
  planColumns,
  suggestChoices,
} from '../../services/test-data/test-data';
import type { DriverId } from '../../shared/connection';
import {
  PREVIEW_ROWS,
  type TestDataColumn,
  type TestDataState,
} from '../../shared/protocols/test-data';

export interface TestDataModelDeps {
  readonly target: SessionTarget;
  readonly table: TableRef;
  readonly driver: DriverId;
  readonly dialect: Dialect;
  readonly structure: TableStructure;
  /** A session to read existing keys and the highest ids on. */
  readonly session: () => Promise<Session>;
  readonly importer: Pick<TableImporter, 'run'>;
  /** A seed for a page that has none yet. */
  readonly newSeed?: () => number;
}

/** Why a column cannot be filled as chosen. */
export type ChoiceProblem = 'no-references' | 'no-options' | 'not-nullable';

export class TestDataModel {
  readonly columns: PlanColumn[];

  constructor(private readonly deps: TestDataModelDeps) {
    this.columns = planColumns(deps.structure, deps.driver);
  }

  /** What the page starts with. */
  initialState(tableLabel: string): TestDataState {
    return {
      driver: this.deps.driver,
      table: tableLabel,
      columns: this.columns.map(columnView),
      choices: suggestChoices(this.columns),
      count: 100,
      seed: (this.deps.newSeed ?? (() => Math.floor(Math.random() * 0xffffffff)))(),
    };
  }

  async preview(
    choices: readonly ColumnChoice[],
    seed: number,
  ): Promise<{
    rows: (string | null)[][];
    problems: { column: string; problem: ChoiceProblem }[];
  }> {
    const context = await this.context(choices);
    const settings = columnSettings(this.columns, choices, context);
    return {
      rows: [...generateRows(settings, choices, this.columns, PREVIEW_ROWS, seed)].map((row) =>
        row.map((value, index) =>
          (choices[index]?.generator ?? 'default') === 'default' ? null : value,
        ),
      ),
      problems: this.problems(choices, context),
    };
  }

  async run(
    choices: readonly ColumnChoice[],
    count: number,
    seed: number,
    control: { readonly signal?: AbortSignal; readonly onProgress?: (done: number) => void } = {},
  ): Promise<ImportReport> {
    const context = await this.context(choices);
    const settings = columnSettings(this.columns, choices, context);
    return await this.deps.importer.run({
      target: this.deps.target,
      table: this.deps.table,
      columns: filledColumns(this.columns, choices),
      records: asRecords(generateRows(settings, choices, this.columns, count, seed)),
      values: { emptyIsNull: false, nullText: '' },
      mode: 'all',
      ...(control.signal === undefined ? {} : { signal: control.signal }),
      onProgress: (progress) => {
        control.onProgress?.(progress.inserted);
      },
    });
  }

  async script(choices: readonly ColumnChoice[], count: number, seed: number): Promise<string> {
    const context = await this.context(choices);
    const settings = columnSettings(this.columns, choices, context);
    return insertScript(
      this.deps.dialect,
      this.deps.driver,
      this.deps.table,
      filledColumns(this.columns, choices),
      generateRows(settings, choices, this.columns, count, seed),
    );
  }

  /** What stands in the way of filling the columns as chosen. */
  problems(
    choices: readonly ColumnChoice[],
    context: GenerationContext,
  ): { column: string; problem: ChoiceProblem }[] {
    return this.columns.flatMap((column, index): { column: string; problem: ChoiceProblem }[] => {
      const generator = choices[index]?.generator;
      if (generator === 'reference' && (context.references.get(column.name)?.length ?? 0) === 0) {
        return [{ column: column.name, problem: 'no-references' }];
      }
      if (generator === 'enum' && !/^enum\s*\(/iu.test(column.dataType)) {
        return [{ column: column.name, problem: 'no-options' }];
      }
      if (generator === 'null' && !column.nullable) {
        return [{ column: column.name, problem: 'not-nullable' }];
      }
      return [];
    });
  }

  private async context(choices: readonly ColumnChoice[]): Promise<GenerationContext> {
    const needed = choices.some(
      (choice) => choice.generator === 'reference' || choice.generator === 'sequence',
    );
    if (!needed) {
      return { references: new Map(), starts: new Map() };
    }
    return await loadContext(
      await this.deps.session(),
      this.deps.dialect,
      this.deps.table,
      this.deps.structure,
      choices,
    );
  }
}

function columnView(column: PlanColumn): TestDataColumn {
  return {
    name: column.name,
    dataType: column.dataType,
    nullable: column.nullable,
    ...(column.autoIncrement ? { locked: 'auto' as const } : {}),
    ...(column.generated ? { locked: 'generated' as const } : {}),
    unique: column.unique,
    ...(column.reference === undefined
      ? {}
      : { reference: `${column.reference.table}.${column.reference.column}` }),
  };
}

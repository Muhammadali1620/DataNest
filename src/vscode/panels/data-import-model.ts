// What the data import page (V5.3) shows and does, free of `vscode`: reading the start
// of the file, guessing how it is written, suggesting which field fills which
// column, previewing the converted values, and running the import.

import type { ColumnDetail, TableRef } from '../../core/model/objects';
import type { SessionTarget } from '../../services/connection-manager';
import { guessCsv } from '../../services/import/csv-parser';
import {
  formatOf,
  sampleSource,
  type SourceOptions,
  type SourceRecord,
  sourceRecords,
} from '../../services/import/import-source';
import {
  convertValue,
  type SourceValue,
  type ValueOptions,
} from '../../services/import/import-values';
import type {
  ImportColumn,
  ImportMode,
  ImportReport,
  TableImporter,
} from '../../services/import/table-import';
import type { ScriptChunk } from '../../services/script-runner';
import { cellText } from '../../shared/cell-text';
import type { DriverId } from '../../shared/connection';
import {
  type ImportMapping,
  type ImportOptions,
  type ImportPreviewRow,
  type ImportSourceView,
  type ImportTargetColumn,
  SAMPLE_ROWS,
} from '../../shared/protocols/data-import';

/** How much of the file the CSV guess looks at. */
const GUESS_CHARS = 64 * 1024;

export interface DataImportModelDeps {
  readonly target: SessionTarget;
  readonly table: TableRef;
  readonly driver: DriverId;
  /** The database can undo a stopped import (all but ClickHouse). */
  readonly transactional?: boolean;
  readonly file: string;
  readonly columns: readonly ColumnDetail[];
  readonly readChunks: (file: string) => AsyncIterable<ScriptChunk>;
  readonly importer: Pick<TableImporter, 'run'>;
}

export class DataImportModel {
  readonly columns: ImportTargetColumn[];

  constructor(private readonly deps: DataImportModelDeps) {
    this.columns = deps.columns.map((column) => ({
      name: column.name,
      dataType: column.dataType,
      nullable: column.nullable,
      hasDefault:
        column.defaultExpression !== undefined || column.autoIncrement || column.generated,
      autoIncrement: column.autoIncrement,
      generated: column.generated,
    }));
  }

  get driver(): DriverId {
    return this.deps.driver;
  }

  get transactional(): boolean {
    return this.deps.transactional ?? true;
  }

  /** How the file is most likely written: the format by its name, CSV details by its start. */
  async guessOptions(): Promise<ImportOptions> {
    const base: ImportOptions = {
      format: formatOf(this.deps.file),
      delimiter: ',',
      header: true,
      emptyIsNull: true,
      nullText: '',
    };
    if (base.format !== 'csv') {
      return base;
    }
    let sample = '';
    for await (const chunk of this.deps.readChunks(this.deps.file)) {
      sample += chunk.text;
      if (sample.length >= GUESS_CHARS) {
        break;
      }
    }
    const guess = guessCsv(sample.slice(0, GUESS_CHARS));
    return { ...base, delimiter: guess.delimiter, header: guess.header };
  }

  /** The start of the file read with `options`, and the mapping it suggests. */
  async load(
    options: ImportOptions,
  ): Promise<{ source: ImportSourceView; mapping: ImportMapping }> {
    const sample = await sampleSource(
      this.deps.readChunks(this.deps.file),
      sourceOptions(options),
      SAMPLE_ROWS,
    );
    return {
      source: {
        columns: sample.columns,
        rows: sample.records.map((record) =>
          'error' in record
            ? { line: record.line, cells: [], error: record.error }
            : {
                line: record.line,
                cells: sample.columns.map((_c, i) => sourceText(record.values[i])),
              },
        ),
      },
      mapping: suggestMapping(
        this.columns,
        sample.columns,
        options.format === 'csv' && !options.header,
      ),
    };
  }

  /** The first rows as they would go into the table, with what does not fit marked. */
  async preview(options: ImportOptions, mapping: ImportMapping): Promise<ImportPreviewRow[]> {
    const sample = await sampleSource(
      this.deps.readChunks(this.deps.file),
      sourceOptions(options),
      SAMPLE_ROWS,
    );
    const values = valueOptions(options);
    return sample.records.map((record) => {
      if ('error' in record) {
        return { line: record.line, cells: [], error: record.error };
      }
      return {
        line: record.line,
        cells: this.columns.map((column, index) => {
          const source = mapping[index];
          if (source === null || source === undefined || column.generated) {
            return { fill: 'default' as const };
          }
          const converted = convertValue(
            record.values[source],
            column.dataType,
            values,
            this.driver,
          );
          return converted.ok
            ? { text: cellText(converted.value, { nullText: 'NULL' }) }
            : { problem: converted.problem };
        }),
      };
    });
  }

  /** Runs the import over the whole file. */
  async run(
    options: ImportOptions,
    mapping: ImportMapping,
    mode: ImportMode,
    control: {
      readonly signal?: AbortSignal;
      readonly onProgress?: (read: number, inserted: number, failed: number, bytes: number) => void;
    } = {},
  ): Promise<ImportReport> {
    const sample = await sampleSource(
      this.deps.readChunks(this.deps.file),
      sourceOptions(options),
      SAMPLE_ROWS,
    );
    let bytes = 0;
    const records: AsyncIterable<SourceRecord> = sourceRecords(
      this.deps.readChunks(this.deps.file),
      sourceOptions(options),
      sample.columns,
      (read) => {
        bytes = read;
      },
    );
    return await this.deps.importer.run({
      target: this.deps.target,
      table: this.deps.table,
      columns: importColumns(this.columns, this.deps.columns, mapping),
      records,
      values: valueOptions(options),
      mode,
      ...(control.signal === undefined ? {} : { signal: control.signal }),
      onProgress: (progress) => {
        control.onProgress?.(progress.read, progress.inserted, progress.failed, bytes);
      },
    });
  }
}

function sourceOptions(options: ImportOptions): SourceOptions {
  return { format: options.format, delimiter: options.delimiter, header: options.header };
}

/** JSON says null itself; the CSV conventions for NULL do not apply to it. */
export function valueOptions(options: ImportOptions): ValueOptions {
  return options.format === 'csv'
    ? { emptyIsNull: options.emptyIsNull, nullText: options.nullText }
    : { emptyIsNull: false, nullText: '' };
}

/** A field as the page shows it; null is a missing value or JSON null. */
export function sourceText(value: SourceValue): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  return 'number' in value ? value.number : value.json;
}

function comparable(name: string): string {
  return name.toLowerCase().replace(/[\s_-]+/gu, '');
}

/**
 * A field of the same name fills each column (ignoring case, spaces and
 * underscores). A CSV without a header has no names, so fields go in order.
 */
export function suggestMapping(
  columns: readonly ImportTargetColumn[],
  source: readonly string[],
  byPosition: boolean,
): ImportMapping {
  let position = 0;
  return columns.map((column) => {
    if (column.generated) {
      return null;
    }
    if (byPosition) {
      const index = position;
      position += 1;
      return index < source.length ? index : null;
    }
    const index = source.findIndex((name) => comparable(name) === comparable(column.name));
    return index === -1 ? null : index;
  });
}

/** The columns that get values, in table order, with where their values come from. */
export function importColumns(
  columns: readonly ImportTargetColumn[],
  details: readonly ColumnDetail[],
  mapping: ImportMapping,
): ImportColumn[] {
  return columns.flatMap((column, index) => {
    const source = mapping[index];
    if (source === null || source === undefined || column.generated) {
      return [];
    }
    const detail = details[index];
    return [
      {
        name: column.name,
        dataType: column.dataType,
        source,
        autoIncrement: column.autoIncrement,
        sequenced: column.autoIncrement || /\bnextval\s*\(/iu.test(detail?.defaultExpression ?? ''),
      },
    ];
  });
}

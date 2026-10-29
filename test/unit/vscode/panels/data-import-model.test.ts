import { describe, expect, it } from 'vitest';
import type { ColumnDetail } from '../../../../src/core/model/objects';
import type { ImportRequest, ImportReport } from '../../../../src/services/import/table-import';
import type { ScriptChunk } from '../../../../src/services/script-runner';
import type { ImportOptions } from '../../../../src/shared/protocols/data-import';
import {
  DataImportModel,
  importColumns,
  sourceText,
  suggestMapping,
  valueOptions,
} from '../../../../src/vscode/panels/data-import-model';

const COLUMNS: ColumnDetail[] = [
  {
    name: 'id',
    dataType: 'integer',
    nullable: false,
    autoIncrement: false,
    generated: false,
    defaultExpression: "nextval('people_id_seq'::regclass)",
  },
  { name: 'full_name', dataType: 'text', nullable: true, autoIncrement: false, generated: false },
  { name: 'born', dataType: 'date', nullable: true, autoIncrement: false, generated: false },
  { name: 'twice', dataType: 'integer', nullable: true, autoIncrement: false, generated: true },
];

const CSV: ImportOptions = {
  format: 'csv',
  delimiter: ',',
  header: true,
  emptyIsNull: true,
  nullText: '',
};

async function* chunks(text: string): AsyncGenerator<ScriptChunk> {
  for (let offset = 0; offset < text.length; offset += 7) {
    await Promise.resolve();
    const piece = text.slice(offset, offset + 7);
    yield { text: piece, bytes: piece.length };
  }
}

function model(file: string, text: string, requests: ImportRequest[] = []): DataImportModel {
  return new DataImportModel({
    target: { connectionId: 'c' },
    table: { schema: 'public', name: 'people' },
    driver: 'postgres',
    file,
    columns: COLUMNS,
    readChunks: () => chunks(text),
    importer: {
      run: async (request) => {
        requests.push(request);
        let read = 0;
        for await (const _record of request.records) {
          read += 1;
          request.onProgress?.({ read, inserted: read, failed: 0 });
        }
        const report: ImportReport = {
          outcome: 'done',
          read,
          inserted: read,
          failedCount: 0,
          failures: [],
          rolledBack: false,
          durationMs: 1,
        };
        return report;
      },
    },
  });
}

const PEOPLE = 'ID;Full Name;born\n1;Anna;2000-01-31\n2;Bob;not a date\n';

describe('DataImportModel', () => {
  it('describes the columns of the table for the page', () => {
    expect(model('a.csv', '').columns.map((column) => [column.name, column.hasDefault])).toEqual([
      ['id', true],
      ['full_name', false],
      ['born', false],
      ['twice', true],
    ]);
  });

  it('guesses the format from the name and the CSV details from the start', async () => {
    expect(await model('people.csv', PEOPLE).guessOptions()).toEqual({ ...CSV, delimiter: ';' });
    expect((await model('people.json', '[]').guessOptions()).format).toBe('json');
    expect((await model('n.csv', '1,2\n3,4\n').guessOptions()).header).toBe(false);
  });

  it('loads the start of the file and suggests a mapping by name', async () => {
    const loaded = await model('people.csv', PEOPLE).load({ ...CSV, delimiter: ';' });
    expect(loaded.source.columns).toEqual(['ID', 'Full Name', 'born']);
    expect(loaded.source.rows[0]).toEqual({ line: 2, cells: ['1', 'Anna', '2000-01-31'] });
    expect(loaded.mapping).toEqual([0, 1, 2, null]);
  });

  it('marks records it cannot read', async () => {
    const loaded = await model('p.json', '[{"id": 1}, 7]').load({ ...CSV, format: 'json' });
    expect(loaded.source.rows[1]).toEqual({
      line: 1,
      cells: [],
      error: 'A record must be an object',
    });
  });

  it('previews converted values, problems and what the database fills', async () => {
    const rows = await model('people.csv', PEOPLE).preview({ ...CSV, delimiter: ';' }, [
      0,
      null,
      2,
      2,
    ]);
    expect(rows).toEqual([
      {
        line: 2,
        cells: [{ text: '1' }, { fill: 'default' }, { text: '2000-01-31' }, { fill: 'default' }],
      },
      {
        line: 3,
        cells: [
          { text: '2' },
          { fill: 'default' },
          { problem: 'invalid-date' },
          { fill: 'default' },
        ],
      },
    ]);
  });

  it('runs the import with the mapped columns over every record', async () => {
    const requests: ImportRequest[] = [];
    const progress: number[] = [];
    const report = await model('people.csv', PEOPLE, requests).run(
      { ...CSV, delimiter: ';' },
      [0, 1, null, null],
      'skip',
      { onProgress: (read) => progress.push(read) },
    );
    expect(report.read).toBe(2);
    expect(progress).toEqual([1, 2]);
    const request = requests[0];
    expect(request?.mode).toBe('skip');
    expect(request?.table).toEqual({ schema: 'public', name: 'people' });
    expect(
      request?.columns.map((column) => [column.name, column.source, column.sequenced]),
    ).toEqual([
      ['id', 0, true],
      ['full_name', 1, false],
    ]);
  });
});

describe('suggestMapping', () => {
  const columns = model('a.csv', '').columns;

  it('matches names ignoring case, spaces and underscores, never a computed column', () => {
    expect(suggestMapping(columns, ['FULLNAME', 'twice', 'Born'], false)).toEqual([
      null,
      0,
      2,
      null,
    ]);
  });

  it('goes by position for a file without names', () => {
    expect(suggestMapping(columns, ['Column 1', 'Column 2'], true)).toEqual([0, 1, null, null]);
  });
});

describe('importColumns', () => {
  it('leaves out unmapped and computed columns and spots sequences', () => {
    const columns = model('a.csv', '').columns;
    expect(importColumns(columns, COLUMNS, [null, 0, 1, 2])).toEqual([
      { name: 'full_name', dataType: 'text', source: 0, autoIncrement: false, sequenced: false },
      { name: 'born', dataType: 'date', source: 1, autoIncrement: false, sequenced: false },
    ]);
  });
});

describe('valueOptions and sourceText', () => {
  it('keeps the CSV NULL conventions away from JSON', () => {
    expect(valueOptions({ ...CSV, nullText: 'NULL' })).toEqual({
      emptyIsNull: true,
      nullText: 'NULL',
    });
    expect(valueOptions({ ...CSV, format: 'json', nullText: 'NULL' })).toEqual({
      emptyIsNull: false,
      nullText: '',
    });
  });

  it('shows every kind of field', () => {
    expect(sourceText('a')).toBe('a');
    expect(sourceText(undefined)).toBeNull();
    expect(sourceText(null)).toBeNull();
    expect(sourceText(true)).toBe('true');
    expect(sourceText({ number: '1.50' })).toBe('1.50');
    expect(sourceText({ json: '[1]' })).toBe('[1]');
  });
});

describe('DataImportModel: transactions (V6.3)', () => {
  const base = {
    target: { connectionId: 'c' },
    table: { database: 'events', name: 'hits' },
    file: '/tmp/hits.csv',
    columns: COLUMNS,
    readChunks: () => chunks(''),
    importer: { run: () => Promise.reject(new Error('not used')) },
  };

  it('can undo a stopped import unless the driver says otherwise', () => {
    expect(new DataImportModel({ ...base, driver: 'postgres' }).transactional).toBe(true);
    expect(
      new DataImportModel({ ...base, driver: 'mysql', transactional: true }).transactional,
    ).toBe(true);
    const clickhouse = new DataImportModel({ ...base, driver: 'clickhouse', transactional: false });
    expect(clickhouse.transactional).toBe(false);
    expect(clickhouse.driver).toBe('clickhouse');
  });
});

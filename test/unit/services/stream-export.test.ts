import { describe, expect, it } from 'vitest';
import type { Driver, ResultColumn, Session } from '../../../src/drivers/driver';
import { postgresDialect } from '../../../src/drivers/postgres/dialect';
import { INSERT_ROWS } from '../../../src/services/dump-script';
import type { ExportFormat } from '../../../src/services/result-export';
import { type StreamExportRequest, StreamExporter } from '../../../src/services/stream-export';
import { XLSX_MAX_ROWS } from '../../../src/services/xlsx';
import { retainBytes } from '../../../src/shared/binary-bytes';
import type { BinaryValue, CellValue } from '../../../src/shared/cell-value';
import { FakeDriver, FakeSession } from '../../helpers/fake-driver';
import { RecordingLogger } from '../../helpers/fakes';
import { entryText, unzip } from '../../helpers/unzip';

class MemorySink {
  text = '';
  readonly bytes: Buffer[] = [];

  write(text: string): Promise<void> {
    this.text += text;
    return Promise.resolve();
  }

  writeBytes(data: Uint8Array): Promise<void> {
    this.bytes.push(Buffer.from(data));
    return Promise.resolve();
  }
}

class Harness {
  readonly driver = new FakeDriver('postgres');
  readonly session = new FakeSession({ id: 'c', name: 'c', driver: 'postgres' });
  readonly released: string[] = [];
  readonly sink = new MemorySink();

  constructor(columns: ResultColumn[], rows: CellValue[][]) {
    this.driver.dialect = postgresDialect;
    this.session.columns = columns;
    this.session.rows = rows;
  }

  async export(format: ExportFormat, overrides: Partial<StreamExportRequest> = {}) {
    return await new StreamExporter({
      manager: {
        driverOf: () => Promise.resolve(this.driver as Driver),
        acquire: () => Promise.resolve(this.session as Session),
        release: (owner) => {
          this.released.push(owner);
          return Promise.resolve();
        },
      },
      logger: new RecordingLogger(),
      now: () => 0,
    }).export({
      target: { connectionId: 'c' },
      sql: 'SELECT * FROM t',
      format,
      sink: this.sink,
      ...overrides,
    });
  }
}

const COLUMNS: ResultColumn[] = [{ name: 'id' }, { name: 'name' }, { name: 'amount' }];
const ROWS: CellValue[][] = [
  [1, 'Anna, "A"', { kind: 'decimal', text: '10.50' }],
  [2, null, { kind: 'decimal', text: '0.10' }],
];

describe('StreamExporter', () => {
  it('runs the statement on a session of its own and lets it go', async () => {
    const harness = new Harness(COLUMNS, ROWS);
    const report = await harness.export('csv');
    expect(harness.session.executed).toEqual(['SELECT * FROM t']);
    expect(harness.released).toHaveLength(1);
    expect(harness.released[0]).toMatch(/^task:export-/u);
    expect(report).toEqual({ rows: 2, durationMs: 0 });
  });

  it('writes CSV with a header', async () => {
    const harness = new Harness(COLUMNS, ROWS);
    await harness.export('csv');
    expect(harness.sink.text).toBe('id,name,amount\r\n1,"Anna, ""A""",10.50\r\n2,,0.10\r\n');
  });

  it('writes JSON one record per line, exact numbers as text', async () => {
    const harness = new Harness(COLUMNS, ROWS);
    await harness.export('json');
    expect(JSON.parse(harness.sink.text)).toEqual([
      { id: 1, name: 'Anna, "A"', amount: '10.50' },
      { id: 2, name: null, amount: '0.10' },
    ]);
    expect(harness.sink.text.split('\n')).toHaveLength(5);
  });

  it('writes an empty JSON array and a CSV header only when there are no rows', async () => {
    const json = new Harness(COLUMNS, []);
    await json.export('json');
    expect(json.sink.text).toBe('[]\n');
    const csv = new Harness(COLUMNS, []);
    await csv.export('csv');
    expect(csv.sink.text).toBe('id,name,amount\r\n');
  });

  it('writes a Markdown table, numbers aligned right', async () => {
    const harness = new Harness(COLUMNS, [[1, 'a|b\nc', { kind: 'decimal', text: '2' }]]);
    await harness.export('markdown');
    expect(harness.sink.text).toBe(
      '| id | name | amount |\n| ---: | --- | ---: |\n| 1 | a\\|b<br>c | 2 |\n',
    );
    const empty = new Harness(COLUMNS, []);
    await empty.export('markdown');
    expect(empty.sink.text).toBe('| id | name | amount |\n| --- | --- | --- |\n');
  });

  it('writes INSERT statements for the table, in batches', async () => {
    const many = Array.from({ length: INSERT_ROWS + 1 }, (_, i) => [i, `n${i}`, null]);
    const harness = new Harness(COLUMNS, many);
    await harness.export('sql', { table: { schema: 's', name: 't' }, identity: true });
    const statements = harness.sink.text.trimEnd().split(';\n');
    expect(statements).toHaveLength(2);
    expect(statements[0]).toMatch(
      /^INSERT INTO "s"\."t" \("id", "name", "amount"\) OVERRIDING SYSTEM VALUE VALUES\n\(0, 'n0', NULL\),/u,
    );
  });

  it('names a placeholder table for a result that is not one', async () => {
    const harness = new Harness(COLUMNS, ROWS);
    await harness.export('sql');
    expect(harness.sink.text).toContain('INSERT INTO "table_name"');
  });

  it('writes binary values whole when the host kept their bytes', async () => {
    const value: BinaryValue = { kind: 'binary', size: 3, preview: '01' };
    retainBytes(value, new Uint8Array([1, 2, 3]));
    const harness = new Harness([{ name: 'data' }], [[value]]);
    await harness.export('csv');
    expect(harness.sink.text).toBe('data\r\n0x010203\r\n');
  });

  it('writes an Excel workbook whose sheet holds every row', async () => {
    const rows = Array.from({ length: 450 }, (_, i): CellValue[] => [i, `n${i}`, null]);
    const harness = new Harness(COLUMNS, rows);
    harness.session.rowsFor = undefined;
    await harness.export('xlsx', { sheetName: 'People' });
    const entries = unzip(Buffer.concat(harness.sink.bytes));
    expect(entryText(entries, 'xl/workbook.xml')).toContain('name="People"');
    const sheet = entryText(entries, 'xl/worksheets/sheet1.xml');
    expect(sheet.match(/<row /gu)).toHaveLength(451);
    expect(sheet).toContain('<c r="B451" t="inlineStr"><is><t>n449</t></is></c>');
    expect(sheet.endsWith('</sheetData></worksheet>')).toBe(true);
    expect(harness.sink.text).toBe('');
  });

  it('writes a workbook with a header only when there are no rows', async () => {
    const harness = new Harness(COLUMNS, []);
    await harness.export('xlsx');
    const sheet = entryText(unzip(Buffer.concat(harness.sink.bytes)), 'xl/worksheets/sheet1.xml');
    expect(sheet.match(/<row /gu)).toHaveLength(1);
  });

  it('refuses more rows than Excel holds', async () => {
    const harness = new Harness([{ name: 'n' }], []);
    const batch = Array.from({ length: 50_000 }, (_, i): CellValue[] => [i]);
    harness.session.execute = (sql: string) => {
      harness.session.executed.push(sql);
      return (async function* stream() {
        await Promise.resolve();
        yield { kind: 'columns' as const, columns: [{ name: 'n' }] };
        for (let sent = 0; sent < XLSX_MAX_ROWS; sent += batch.length) {
          yield { kind: 'rows' as const, rows: batch };
        }
        yield { kind: 'done' as const };
      })();
    };
    await expect(harness.export('xlsx')).rejects.toThrow(/at most/u);
    expect(harness.released).toHaveLength(1);
    // A million rows through the XLSX writer: over 5 s on CI Windows with coverage.
  }, 60_000);

  it('stops when cancelled and when a statement returns no rows', async () => {
    const harness = new Harness(COLUMNS, ROWS);
    const abort = new AbortController();
    abort.abort();
    await expect(harness.export('csv', { signal: abort.signal })).rejects.toMatchObject({
      code: 'cancelled',
    });
    const update = new Harness(COLUMNS, ROWS);
    update.session.execute = () =>
      (async function* stream() {
        await Promise.resolve();
        yield { kind: 'done' as const, affectedRows: 3 };
      })();
    await expect(update.export('csv')).rejects.toThrow(/no rows/u);
  });

  it('reports progress after each batch', async () => {
    const harness = new Harness(COLUMNS, ROWS);
    const seen: number[] = [];
    await harness.export('csv', { onProgress: (rows) => seen.push(rows) });
    expect(seen).toEqual([2]);
  });
});

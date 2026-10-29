// Exporting whole tables from real servers (V5.4): every row of the 10 000-row seed
// table reaches the file in every format, through a file written in parts.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Session } from '../../../src/drivers/driver';
import { driver as mysqlDriver } from '../../../src/drivers/mysql';
import { driver as postgresDriver } from '../../../src/drivers/postgres';
import { FileSink } from '../../../src/services/file-sink';
import type { ExportFormat } from '../../../src/services/result-export';
import { StreamExporter } from '../../../src/services/stream-export';
import type { ResolvedConnectionConfig } from '../../../src/shared/connection';
import { testDatabase, type TestDatabaseId } from '../../helpers/databases';
import { RecordingLogger } from '../../helpers/fakes';
import { entryText, unzip } from '../../helpers/unzip';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'datanest-export-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function config(id: TestDatabaseId): ResolvedConnectionConfig {
  const db = testDatabase(id);
  return {
    id: `exp-${id}`,
    name: id,
    driver: id === 'postgres' ? 'postgres' : 'mysql',
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    database: db.database,
  };
}

describe.each([
  { id: 'mysql' as const, driver: mysqlDriver },
  { id: 'mariadb' as const, driver: mysqlDriver },
  { id: 'postgres' as const, driver: postgresDriver },
])('$id', ({ id, driver }) => {
  async function exportTo(format: ExportFormat, name: string): Promise<Buffer> {
    const sessions = new Map<string, Session>();
    const exporter = new StreamExporter({
      manager: {
        driverOf: () => Promise.resolve(driver),
        acquire: async (owner) => {
          const session = await driver.openSession(config(id));
          sessions.set(owner, session);
          return session;
        },
        release: async (owner) => {
          await sessions.get(owner)?.close();
        },
      },
      logger: new RecordingLogger(),
    });
    const path = join(dir, `${id}-${name}`);
    const sink = await FileSink.create(path);
    const report = await exporter.export({
      target: { connectionId: 'c' },
      sql: 'SELECT id, label, value_mod FROM big_table ORDER BY id',
      format,
      sink,
      table: { name: 'big_table' },
    });
    await sink.close();
    expect(report.rows).toBe(10_000);
    return readFileSync(path);
  }

  it('writes every row as CSV', async () => {
    const lines = (await exportTo('csv', 'big.csv')).toString('utf8').trimEnd().split('\r\n');
    expect(lines).toHaveLength(10_001);
    expect(lines[0]).toBe('id,label,value_mod');
    expect(lines[10_000]).toBe('10000,row-10000,0');
  });

  it('writes every row as JSON', async () => {
    const records = JSON.parse((await exportTo('json', 'big.json')).toString('utf8')) as unknown[];
    expect(records).toHaveLength(10_000);
    expect(records[9_999]).toEqual({ id: 10_000, label: 'row-10000', value_mod: 0 });
  });

  it('writes every row as SQL INSERT statements', async () => {
    const text = (await exportTo('sql', 'big.sql')).toString('utf8');
    expect(text.match(/^INSERT INTO /gmu)).toHaveLength(100);
    expect(text).toContain("(10000, 'row-10000', 0);");
  });

  it('writes every row into an Excel sheet', async () => {
    const sheet = entryText(unzip(await exportTo('xlsx', 'big.xlsx')), 'xl/worksheets/sheet1.xml');
    expect(sheet.match(/<row /gu)).toHaveLength(10_001);
    expect(sheet).toContain('<c r="B10001" t="inlineStr"><is><t>row-10000</t></is></c>');
  });

  it('writes every row as a Markdown table', async () => {
    const lines = (await exportTo('markdown', 'big.md')).toString('utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(10_002);
    expect(lines[1]).toBe('| ---: | --- | ---: |');
  });
});

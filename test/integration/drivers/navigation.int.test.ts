// Hover over the seed tables of the real servers: what the symbol under the cursor
// names, and what the hover then says about it.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Session } from '../../../src/drivers/driver';
import { driver as mysqlDriver } from '../../../src/drivers/mysql';
import { driver as postgresDriver } from '../../../src/drivers/postgres';
import type { DriverId, ResolvedConnectionConfig } from '../../../src/shared/connection';
import { type HoverTexts, hoverMarkdown } from '../../../src/vscode/editor/sql-hover';
import { symbolAt } from '../../../src/vscode/editor/sql-symbols';
import { testDatabase, type TestDatabaseId } from '../../helpers/databases';

const TEXTS: HoverTexts = {
  table: 'table',
  view: 'view',
  cte: 'cte',
  primaryKey: 'PK',
  nullable: 'NULL',
  notNull: 'NOT NULL',
  defaultIs: (value) => `default ${value}`,
  autoIncrement: 'auto',
  more: (count) => `${count} more`,
};

function config(id: TestDatabaseId, driver: DriverId): ResolvedConnectionConfig {
  const db = testDatabase(id);
  return {
    id: `nav-${id}`,
    name: id,
    driver,
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    database: db.database,
  };
}

describe.each([
  ['mysql', 'mysql', { database: 'datanest_test' }],
  ['postgres', 'postgres', {}],
] as const)('hover on %s', (id, driverId, scope) => {
  let session: Session;

  beforeAll(async () => {
    session = await (driverId === 'mysql' ? mysqlDriver : postgresDriver).openSession(
      config(id, driverId),
    );
  });

  afterAll(async () => {
    await session.close();
  });

  async function hover(text: string): Promise<string | undefined> {
    const found = symbolAt(text.replace('|', ''), text.indexOf('|'), driverId, scope);
    return found === undefined
      ? undefined
      : await hoverMarkdown(found.symbol, session.metadata, TEXTS);
  }

  it('describes a table with its key, foreign keys and comment', async () => {
    const text = await hover('SELECT * FROM ord|ers o');
    expect(text).toContain('**orders** — table');
    expect(text).toMatch(/\| `id` \| `(int|integer)` \| NOT NULL · PK/);
    expect(text).toContain('→ customers.id');
    expect(await hover('SELECT * FROM custom|ers')).toContain('_Shop customers_');
  });

  it('describes a column through its alias and finds an unqualified one', async () => {
    expect(await hover('SELECT o.stat|us FROM orders o')).toMatch(/^\*\*orders\.status\*\*/);
    const loose = await hover(
      'SELECT em|ail FROM orders o JOIN customers c ON c.id = o.customer_id',
    );
    expect(loose).toMatch(/^\*\*customers\.email\*\*/);
  });

  it('describes a view from its columns', async () => {
    const text = await hover('SELECT * FROM order_tot|als');
    // The underscore is escaped, so Markdown shows it as it is.
    expect(text).toContain('**order\\_totals** — view');
    expect(text).not.toContain('_VIEW_');
  });

  it('says nothing about a word that is no table or column', async () => {
    expect(await hover('SELECT * FROM orders WHERE nothi|ng = 1')).toBeUndefined();
  });
});

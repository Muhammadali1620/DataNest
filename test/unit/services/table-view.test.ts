import { beforeEach, describe, expect, it } from 'vitest';
import { DbError } from '../../../src/core/errors';
import { ConnectionManager } from '../../../src/services/connection-manager';
import { ConnectionStore } from '../../../src/services/connection-store';
import { MetadataCache } from '../../../src/services/metadata-cache';
import { ResultStore } from '../../../src/services/result-store';
import { TableViewer, tableDocumentUri } from '../../../src/services/table-view';
import type { ConnectionConfig } from '../../../src/shared/connection';
import { FakeDriverProvider } from '../../helpers/fake-driver';
import { FakeMemento, FakeSecretStorage, RecordingLogger } from '../../helpers/fakes';

describe('tableDocumentUri', () => {
  it('is stable for the same table', () => {
    const target = { connectionId: 'c1', database: 'app' };
    expect(tableDocumentUri(target, { name: 'orders' })).toBe(
      tableDocumentUri(target, { name: 'orders' }),
    );
  });

  it('tells tables, schemas, databases and connections apart', () => {
    const uris = new Set([
      tableDocumentUri({ connectionId: 'c1' }, { name: 'orders' }),
      tableDocumentUri({ connectionId: 'c2' }, { name: 'orders' }),
      tableDocumentUri({ connectionId: 'c1' }, { name: 'customers' }),
      tableDocumentUri({ connectionId: 'c1', database: 'app' }, { name: 'orders' }),
      tableDocumentUri({ connectionId: 'c1' }, { schema: 'public', name: 'orders' }),
    ]);
    expect(uris.size).toBe(5);
  });

  it('escapes names so a slash cannot forge another table', () => {
    const sneaky = tableDocumentUri({ connectionId: 'c1' }, { name: 'a/b' });
    const plain = tableDocumentUri({ connectionId: 'c1' }, { schema: 'a', name: 'b' });
    expect(sneaky).not.toBe(plain);
  });
});

describe('TableViewer', () => {
  let store: ConnectionStore;
  let drivers: FakeDriverProvider;
  let manager: ConnectionManager;
  let results: ResultStore;
  let viewer: TableViewer;
  let pageSize: number;
  let connection: ConnectionConfig;

  beforeEach(async () => {
    const logger = new RecordingLogger();
    store = new ConnectionStore({
      state: new FakeMemento(),
      secrets: new FakeSecretStorage(),
      logger,
    });
    drivers = new FakeDriverProvider();
    manager = new ConnectionManager({ store, drivers, logger });
    results = new ResultStore();
    pageSize = 100;
    viewer = new TableViewer({
      manager,
      results,
      cache: new MetadataCache({ logger }),
      limits: { pageSize: () => pageSize },
      logger,
    });
    connection = await store.add({ name: 'Local', driver: 'mysql', host: 'h' });
  });

  function target(database?: string) {
    return database === undefined
      ? { connectionId: connection.id }
      : { connectionId: connection.id, database };
  }

  it('reads the first page and counts the table', async () => {
    const driver = drivers.driver('mysql');
    driver.sessionRows = [[1], [2]];
    const summary = await viewer.open({ target: target(), table: { name: 'orders' } });
    expect(summary.page).toEqual({ offset: 0, pageSize: 100, totalRows: 1 });
    expect(driver.lastSession?.executed[0]).toBe('SELECT * FROM "orders" LIMIT 100 OFFSET 0');
    expect(driver.lastSession?.executed[1]).toBe('SELECT COUNT(*) FROM "orders"');
  });

  it('marks the page editable when the table has a key', async () => {
    const driver = drivers.driver('postgres');
    driver.sessionMetadata.tables = [{ name: 'orders', kind: 'table' }];
    driver.sessionMetadata.columns = [
      { name: 'one', dataType: 'int', nullable: false, primaryKey: true },
    ];
    const pg = await store.add({ name: 'Pg', driver: 'postgres', host: 'h' });
    const summary = await viewer.open({
      target: { connectionId: pg.id },
      table: { name: 'orders' },
    });
    expect(summary.edit).toMatchObject({ editable: true, table: { name: 'orders' } });
  });

  it('marks the page of a view read-only', async () => {
    const driver = drivers.driver('postgres');
    driver.sessionMetadata.tables = [{ name: 'orders', kind: 'view' }];
    const pg = await store.add({ name: 'Pg', driver: 'postgres', host: 'h' });
    const summary = await viewer.open({
      target: { connectionId: pg.id },
      table: { name: 'orders' },
    });
    expect(summary.edit).toEqual({ editable: false, reason: 'view' });
  });

  it('quotes the table through the dialect, never by hand', async () => {
    const driver = drivers.driver('mysql');
    await viewer.open({ target: target(), table: { name: 'a"weird' } });
    // The fake dialect quotes with double quotes; the point is that it is asked.
    expect(driver.lastSession?.executed[0]).toContain('"a"weird"');
  });

  it('asks for another page at the right offset', async () => {
    const driver = drivers.driver('mysql');
    pageSize = 50;
    await viewer.open({ target: target(), table: { name: 'orders' }, offset: 150 });
    expect(driver.lastSession?.executed[0]).toBe('SELECT * FROM "orders" LIMIT 50 OFFSET 150');
  });

  it('does not count again when the total is already known', async () => {
    const driver = drivers.driver('mysql');
    await viewer.open({
      target: target(),
      table: { name: 'orders' },
      offset: 100,
      totalRows: 4242,
    });
    expect(driver.lastSession?.executed).toHaveLength(1);
    expect(results.forDocument(tableDocumentUri(target(), { name: 'orders' }))[0]?.page).toEqual({
      offset: 100,
      pageSize: 100,
      totalRows: 4242,
    });
  });

  it('stores the page under the table document, not an editor', async () => {
    const summary = await viewer.open({ target: target('app'), table: { name: 'orders' } });
    expect(summary.documentUri).toBe(tableDocumentUri(target('app'), { name: 'orders' }));
    expect(summary.documentUri.startsWith('datanest-table:')).toBe(true);
  });

  it('opens the session against the database the table lives in', async () => {
    await viewer.open({ target: target('shop'), table: { name: 'orders' } });
    expect(drivers.driver('mysql').opened[0]?.database).toBe('shop');
  });

  it('keeps the page even when counting fails', async () => {
    const driver = drivers.driver('mysql');
    // The count runs after the page, so failing only the second statement leaves
    // the rows intact and the total unknown.
    driver.failExecuteWhen = (sql) => sql.startsWith('SELECT COUNT');
    const summary = await viewer.open({ target: target(), table: { name: 'orders' } });
    expect(summary.error).toBeUndefined();
    expect(summary.rowCount).toBeGreaterThan(0);
    expect(summary.page).toEqual({ offset: 0, pageSize: 100 });
  });

  it('stores a failure as a result instead of throwing', async () => {
    drivers.driver('mysql').executeError = new DbError('not-found', 'no such table');
    const summary = await viewer.open({ target: target(), table: { name: 'gone' } });
    expect(summary.error).toMatchObject({ code: 'not-found', message: 'no such table' });
    expect(summary.page).toEqual({ offset: 0, pageSize: 100 });
  });

  it('reports a connection that cannot be opened', async () => {
    drivers.driver('mysql').openError = new DbError('auth-failed', 'Access denied');
    const summary = await viewer.open({ target: target(), table: { name: 'orders' } });
    expect(summary.error?.code).toBe('auth-failed');
  });

  it('treats a nonsense page size as at least one row', async () => {
    pageSize = 0;
    await viewer.open({ target: target(), table: { name: 'orders' } });
    expect(drivers.driver('mysql').lastSession?.executed[0]).toContain('LIMIT 1 ');
  });

  it('treats a negative offset as the first page', async () => {
    const summary = await viewer.open({
      target: target(),
      table: { name: 'orders' },
      offset: -10,
    });
    expect(summary.page?.offset).toBe(0);
  });

  it('reuses one session per table view', async () => {
    await viewer.open({ target: target(), table: { name: 'orders' } });
    await viewer.open({ target: target(), table: { name: 'orders' }, offset: 100 });
    expect(drivers.driver('mysql').sessions).toHaveLength(1);
  });

  describe('filtering and sorting', () => {
    const table = { name: 'orders' };

    function executed(): string[] {
      return drivers.driver('mysql').lastSession?.executed ?? [];
    }

    it('reads and counts only the matching rows', async () => {
      const summary = await viewer.open({
        target: target(),
        table,
        filter: { conditions: [{ column: 'status', operator: 'isNull' }], where: 'total > 5' },
      });
      expect(executed()[0]).toBe(
        'SELECT * FROM "orders" WHERE "status" IS NULL AND (\ntotal > 5\n) LIMIT 100 OFFSET 0',
      );
      expect(executed()[1]).toBe(
        'SELECT COUNT(*) FROM "orders" WHERE "status" IS NULL AND (\ntotal > 5\n)',
      );
      expect(summary.filter?.where).toBe('total > 5');
    });

    it('orders by a quoted column before paging, and tells the grid which column', async () => {
      drivers.driver('mysql').sessionColumns = [{ name: 'id' }, { name: 'total' }];
      const summary = await viewer.open({
        target: target(),
        table,
        sort: { column: 'total', direction: 'desc' },
      });
      expect(executed()[0]).toBe('SELECT * FROM "orders" ORDER BY "total" DESC LIMIT 100 OFFSET 0');
      expect(summary.sort).toEqual({ column: 1, direction: 'desc' });
    });

    it('puts WHERE before ORDER BY', async () => {
      await viewer.open({
        target: target(),
        table,
        filter: { conditions: [{ column: 'a', operator: 'notNull' }] },
        sort: { column: 'a', direction: 'asc' },
      });
      expect(executed()[0]).toContain('WHERE "a" IS NOT NULL ORDER BY "a" ASC LIMIT');
    });

    it('ignores an empty filter', async () => {
      const summary = await viewer.open({
        target: target(),
        table,
        filter: { conditions: [], where: '  ' },
      });
      expect(executed()[0]).toBe('SELECT * FROM "orders" LIMIT 100 OFFSET 0');
      expect(summary.filter).toBeUndefined();
    });

    it('shows an unusable WHERE as an error that keeps the filter', async () => {
      const summary = await viewer.open({
        target: target(),
        table,
        filter: { conditions: [], where: '1=1; DROP TABLE orders' },
      });
      expect(summary.error?.message).toContain(';');
      expect(summary.filter?.where).toBe('1=1; DROP TABLE orders');
      expect(summary.page).toEqual({ offset: 0, pageSize: 100 });
      // Nothing reached the server.
      expect(executed().some((sql) => sql.includes('DROP'))).toBe(false);
    });

    it('does not report a sort on a column the result does not have', async () => {
      const summary = await viewer.open({
        target: target(),
        table,
        sort: { column: 'missing', direction: 'asc' },
      });
      expect(summary.sort).toBeUndefined();
    });

    describe('reload', () => {
      it('applies a filter from the first page and counts again', async () => {
        const first = await viewer.open({ target: target(), table, offset: 200, totalRows: 999 });
        const ok = await viewer.reload(first.id, {
          filter: { conditions: [{ column: 'a', operator: 'isNull' }] },
        });
        expect(ok).toBe(true);
        const sqls = executed();
        expect(sqls.at(-2)).toBe('SELECT * FROM "orders" WHERE "a" IS NULL LIMIT 100 OFFSET 0');
        expect(sqls.at(-1)).toBe('SELECT COUNT(*) FROM "orders" WHERE "a" IS NULL');
      });

      it('keeps the filter while paging and does not count again', async () => {
        const first = await viewer.open({
          target: target(),
          table,
          filter: { conditions: [{ column: 'a', operator: 'isNull' }] },
        });
        const before = executed().length;
        await viewer.reload(first.id, { offset: 100 });
        expect(executed().slice(before)).toEqual([
          'SELECT * FROM "orders" WHERE "a" IS NULL LIMIT 100 OFFSET 100',
        ]);
      });

      it('sorts from the first page, keeping filter and count', async () => {
        const first = await viewer.open({
          target: target(),
          table,
          offset: 100,
          totalRows: 500,
          filter: { conditions: [{ column: 'a', operator: 'isNull' }] },
        });
        await viewer.reload(first.id, { sort: { column: 'b', direction: 'asc' } });
        expect(executed().at(-1)).toBe(
          'SELECT * FROM "orders" WHERE "a" IS NULL ORDER BY "b" ASC LIMIT 100 OFFSET 0',
        );
        const latest = results.forDocument(tableDocumentUri(target(), table)).at(-1);
        expect(latest?.page?.totalRows).toBe(500);
      });

      it('keeps the sort when the filter changes and when paging', async () => {
        const first = await viewer.open({
          target: target(),
          table,
          sort: { column: 'b', direction: 'desc' },
        });
        const second = await viewer.reload(first.id, {
          filter: { conditions: [{ column: 'a', operator: 'isNull' }] },
        });
        expect(second).toBe(true);
        expect(executed().find((sql) => sql.includes('WHERE'))).toContain('ORDER BY "b" DESC');
      });

      it('removes a filter and a sort with null', async () => {
        const first = await viewer.open({
          target: target(),
          table,
          filter: { conditions: [{ column: 'a', operator: 'isNull' }] },
          sort: { column: 'b', direction: 'asc' },
        });
        const reads = (): string[] => executed().filter((sql) => sql.startsWith('SELECT *'));
        await viewer.reload(first.id, { filter: null });
        expect(reads().at(-1)).toBe('SELECT * FROM "orders" ORDER BY "b" ASC LIMIT 100 OFFSET 0');
        const latest = results.forDocument(tableDocumentUri(target(), table)).at(-1);
        await viewer.reload(latest?.id ?? '', { sort: null });
        expect(reads().at(-1)).toBe('SELECT * FROM "orders" LIMIT 100 OFFSET 0');
      });

      it('can fix a failed filter, because the failed result is still a table view', async () => {
        const first = await viewer.open({
          target: target(),
          table,
          filter: { conditions: [], where: 'a = ;' },
        });
        expect(first.error).toBeDefined();
        expect(await viewer.reload(first.id, { filter: null })).toBe(true);
        const latest = results.forDocument(tableDocumentUri(target(), table)).at(-1);
        expect(latest?.error).toBeUndefined();
      });

      it('refuses a result that is not a table view or no longer exists', async () => {
        const plain = results.add({
          documentUri: 'file:///q.sql',
          statement: 'SELECT 1',
          statementStart: 0,
          columns: [],
          rows: [],
          truncated: false,
          durationMs: 1,
        });
        expect(await viewer.reload(plain.id, { offset: 10 })).toBe(false);
        expect(await viewer.reload('result-nope', { offset: 10 })).toBe(false);
      });
    });
  });
});

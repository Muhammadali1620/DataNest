import { beforeEach, describe, expect, it } from 'vitest';
import { DbError } from '../../../src/core/errors';
import { ConnectionManager } from '../../../src/services/connection-manager';
import { ConnectionStore } from '../../../src/services/connection-store';
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
});

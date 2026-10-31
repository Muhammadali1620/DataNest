import { describe, expect, it } from 'vitest';
import {
  connectionForFile,
  connectionOfFile,
  SQLITE_FILE_EXTENSIONS,
} from '../../../src/services/sqlite-files';
import type { ConnectionConfig } from '../../../src/shared/connection';

const shop: ConnectionConfig = {
  id: 'a',
  name: 'shop.db',
  driver: 'sqlite',
  file: '/data/shop.db',
};
const server: ConnectionConfig = { id: 'b', name: 'shop.db (2)', driver: 'postgres', host: 'db' };

describe('SQLITE_FILE_EXTENSIONS', () => {
  it('offers the usual SQLite extensions', () => {
    expect(SQLITE_FILE_EXTENSIONS).toEqual(['.db', '.sqlite', '.sqlite3', '.db3']);
  });
});

describe('connectionOfFile', () => {
  it('finds the SQLite connection of the file', () => {
    expect(connectionOfFile('/data/shop.db', [server, shop], false)).toBe(shop);
  });

  it('compares paths as the system writes them', () => {
    expect(connectionOfFile('/data/./x/../shop.db', [shop], false)).toBe(shop);
    expect(connectionOfFile('/DATA/SHOP.DB', [shop], false)).toBeUndefined();
    expect(connectionOfFile('/DATA/SHOP.DB', [shop], true)).toBe(shop);
  });

  it('ignores other files, other kinds of connections and connections without a file', () => {
    const noFile: ConnectionConfig = { id: 'c', name: 'n', driver: 'sqlite' };
    expect(connectionOfFile('/data/other.db', [shop, server, noFile], false)).toBeUndefined();
    expect(connectionOfFile('db', [server], true)).toBeUndefined();
  });
});

describe('connectionForFile', () => {
  it('names a new connection after the file', () => {
    expect(connectionForFile('/data/sales.sqlite', [])).toEqual({
      name: 'sales.sqlite',
      driver: 'sqlite',
      file: '/data/sales.sqlite',
    });
  });

  it('gives a taken name a number, without regard to case', () => {
    expect(connectionForFile('/other/shop.db', [shop]).name).toBe('shop.db (2)');
    expect(connectionForFile('/other/SHOP.DB', [shop, server]).name).toBe('SHOP.DB (3)');
  });
});

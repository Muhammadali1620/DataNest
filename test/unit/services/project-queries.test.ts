import { describe, expect, it } from 'vitest';
import { DbError } from '../../../src/core/errors';
import { projectConnectionId, type ProjectFolder } from '../../../src/services/project-connections';
import {
  MAX_PROJECT_QUERIES,
  parseQueryPlace,
  ProjectQueries,
  projectLocalId,
  type ProjectQueryFiles,
  stripQueryPlace,
  withQueryPlace,
} from '../../../src/services/project-queries';

const folder: ProjectFolder = { key: 'file:///work/shop', name: 'shop', root: '/work/shop' };

function memoryFiles(initial: Record<string, string> = {}): ProjectQueryFiles & {
  files: Map<string, string>;
} {
  const files = new Map(Object.entries(initial));
  return {
    files,
    list: () => Promise.resolve([...files.keys()]),
    read: (_folder, name) => Promise.resolve(files.get(name)),
    write: (_folder, name, text) => {
      files.set(name, text);
      return Promise.resolve();
    },
    remove: (_folder, name) => {
      files.delete(name);
      return Promise.resolve();
    },
  };
}

describe('parseQueryPlace', () => {
  it('reads the connection and database from the comment lines at the start', () => {
    expect(
      parseQueryPlace('-- datanest: connection=staging\n-- datanest: database=shop\nSELECT 1'),
    ).toEqual({ connection: 'staging', database: 'shop' });
  });

  it('accepts spaces, capitals and CRLF', () => {
    expect(parseQueryPlace('--   DataNest:  Connection = prod \r\nSELECT 1')).toEqual({
      connection: 'prod',
    });
  });

  it('reads a file that starts with a byte order mark', () => {
    expect(parseQueryPlace('﻿-- datanest: connection=a\nSELECT 1')).toEqual({
      connection: 'a',
    });
  });

  it('ignores the lines after the first line that is not a header', () => {
    expect(parseQueryPlace('SELECT 1\n-- datanest: connection=late')).toEqual({});
    expect(parseQueryPlace('-- a comment\n-- datanest: connection=late')).toEqual({});
  });

  it('ignores an empty value and unknown keys', () => {
    expect(parseQueryPlace('-- datanest: connection=\n-- datanest: colour=red\nSELECT 1')).toEqual(
      {},
    );
  });

  it('knows nothing of an empty text', () => {
    expect(parseQueryPlace('')).toEqual({});
  });
});

describe('stripQueryPlace and withQueryPlace', () => {
  it('takes the header off and leaves the query as written', () => {
    expect(stripQueryPlace('-- datanest: connection=a\n-- note\nSELECT 1;')).toBe(
      '-- note\nSELECT 1;',
    );
  });

  it('puts a header in front of a query that had none', () => {
    expect(withQueryPlace('SELECT 1', { connection: 'a', database: 'b' })).toBe(
      '-- datanest: connection=a\n-- datanest: database=b\nSELECT 1',
    );
  });

  it('replaces the header it finds instead of stacking another', () => {
    const once = withQueryPlace('SELECT 1', { connection: 'a' });
    expect(withQueryPlace(once, { connection: 'b' })).toBe('-- datanest: connection=b\nSELECT 1');
  });

  it('writes no header for a query that runs anywhere', () => {
    expect(withQueryPlace('-- datanest: connection=a\nSELECT 1', {})).toBe('SELECT 1');
  });

  it('round-trips through parse', () => {
    const place = { connection: 'staging', database: 'shop' };
    expect(parseQueryPlace(withQueryPlace('SELECT 1', place))).toEqual(place);
  });
});

describe('projectLocalId', () => {
  it('gives back the id the project file has', () => {
    expect(projectLocalId(folder, projectConnectionId(folder.key, 'staging'))).toBe('staging');
  });

  it('knows nothing of a connection that is not the folder’s', () => {
    expect(projectLocalId(folder, 'some-uuid')).toBeUndefined();
    expect(projectLocalId(folder, projectConnectionId('file:///other', 'staging'))).toBeUndefined();
    expect(projectLocalId(folder, projectConnectionId(folder.key, ''))).toBeUndefined();
  });
});

describe('ProjectQueries', () => {
  it('saves a query with its place and lists it with the place', async () => {
    const files = memoryFiles();
    const queries = new ProjectQueries(files);
    const name = await queries.save(folder, 'Top customers.sql', 'SELECT 1', { connection: 'a' });
    expect(name).toBe('Top customers');
    expect(files.files.get('Top customers')).toBe('-- datanest: connection=a\nSELECT 1\n');
    expect(await queries.list([folder])).toEqual([
      { folder, name: 'Top customers', place: { connection: 'a' } },
    ]);
  });

  it('does not double the final newline', async () => {
    const files = memoryFiles();
    await new ProjectQueries(files).save(folder, 'q', 'SELECT 1\n');
    expect(files.files.get('q')).toBe('SELECT 1\n');
  });

  it('lists names in natural order', async () => {
    const queries = new ProjectQueries(memoryFiles({ q10: '', q2: '', a: '' }));
    expect((await queries.list([folder])).map((query) => query.name)).toEqual(['a', 'q2', 'q10']);
  });

  it('lists no more than the limit from a folder', async () => {
    const many = Object.fromEntries(
      Array.from({ length: MAX_PROJECT_QUERIES + 3 }, (_, index) => [`q${index}`, '']),
    );
    expect(await new ProjectQueries(memoryFiles(many)).list([folder])).toHaveLength(
      MAX_PROJECT_QUERIES,
    );
  });

  it('lists the queries of every folder', async () => {
    const other: ProjectFolder = { key: 'file:///work/blog', name: 'blog', root: '/work/blog' };
    const queries = new ProjectQueries(memoryFiles({ a: '' }));
    const listed = await queries.list([folder, other]);
    expect(listed.map((query) => query.folder.name)).toEqual(['shop', 'blog']);
  });

  it('knows whether a name is taken, with or without .sql', async () => {
    const queries = new ProjectQueries(memoryFiles({ report: 'SELECT 1' }));
    expect(await queries.exists(folder, 'report.sql')).toBe(true);
    expect(await queries.exists(folder, 'other')).toBe(false);
  });

  it('refuses a name a file cannot have, and an empty query', async () => {
    const queries = new ProjectQueries(memoryFiles());
    await expect(queries.save(folder, 'a/b', 'SELECT 1')).rejects.toBeInstanceOf(DbError);
    await expect(queries.save(folder, '', 'SELECT 1')).rejects.toBeInstanceOf(DbError);
    await expect(queries.save(folder, 'ok', '  \n ')).rejects.toBeInstanceOf(DbError);
  });

  it('removes a query', async () => {
    const files = memoryFiles({ a: 'SELECT 1' });
    await new ProjectQueries(files).remove(folder, 'a');
    expect(files.files.size).toBe(0);
  });

  it('replaces the query of the same name', async () => {
    const files = memoryFiles({ a: 'SELECT 1' });
    await new ProjectQueries(files).save(folder, 'a', 'SELECT 2');
    expect(files.files.get('a')).toBe('SELECT 2\n');
  });
});

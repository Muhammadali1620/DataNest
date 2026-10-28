import { describe, expect, it } from 'vitest';
import {
  type EntryResult,
  entryJson,
  localIdFor,
  MAX_FILE_CONNECTIONS,
  readConnectionFile,
  writeConnectionFile,
} from '../../../src/shared/connection-file';

function read(text: string) {
  const result = readConnectionFile(text);
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.file;
}

function entries(text: string): EntryResult[] {
  return [...read(text).entries];
}

describe('readConnectionFile', () => {
  it('reads connections with their ids, in order', () => {
    const file = read(`{
      "version": 1,
      "connections": [
        { "id": "staging", "name": "Staging", "driver": "postgres", "host": "db", "port": 5432 },
        { "name": "Local", "driver": "sqlite", "file": "data/dev.db" }
      ]
    }`);
    expect(file.entries).toEqual([
      {
        ok: true,
        entry: {
          id: 'staging',
          input: { name: 'Staging', driver: 'postgres', host: 'db', port: 5432 },
        },
      },
      { ok: true, entry: { input: { name: 'Local', driver: 'sqlite', file: 'data/dev.db' } } },
    ]);
    expect(file.folders).toEqual([]);
  });

  it('accepts comments and trailing commas, as VS Code does in .vscode', () => {
    const file = read(`{
      // shared with the team
      "connections": [ { "name": "A", "driver": "mysql", "host": "h", }, ],
    }`);
    expect(file.entries).toHaveLength(1);
  });

  it('treats a missing list as empty and keeps unknown top-level keys in raw', () => {
    const file = read('{ "$schema": "x", "note": "hi" }');
    expect(file.entries).toEqual([]);
    expect(file.raw).toEqual({ $schema: 'x', note: 'hi' });
  });

  it('keeps the production, read-only, TLS and color settings', () => {
    const [result] = entries(`{ "connections": [ {
      "name": "Prod", "driver": "mysql", "host": "db", "production": true, "readOnly": true,
      "color": "red", "ssl": { "mode": "verify-full", "ca": "certs/ca.pem" }
    } ] }`);
    expect(result).toEqual({
      ok: true,
      entry: {
        input: {
          name: 'Prod',
          driver: 'mysql',
          host: 'db',
          production: true,
          readOnly: true,
          color: 'red',
          ssl: { mode: 'verify-full', ca: 'certs/ca.pem' },
        },
      },
    });
  });

  it('gives SSH hops without an id one by position', () => {
    const [result] = entries(`{ "connections": [ {
      "name": "Far", "driver": "postgres", "host": "db",
      "ssh": { "host": "bastion", "user": "deploy", "auth": "agent",
               "jumps": [ { "host": "edge", "user": "j", "auth": "key", "keyFile": "~/.ssh/id" },
                          { "id": "mine", "host": "mid", "user": "j", "auth": "password" } ] }
    } ] }`);
    expect(result?.ok && result.entry.input.ssh).toEqual({
      id: 'ssh',
      host: 'bastion',
      user: 'deploy',
      auth: 'agent',
      jumps: [
        { id: 'jump-1', host: 'edge', user: 'j', auth: 'key', keyFile: '~/.ssh/id' },
        { id: 'mine', host: 'mid', user: 'j', auth: 'password' },
      ],
    });
  });

  it('skips a broken entry with the reason and keeps the others', () => {
    const results = entries(`{ "connections": [
      { "name": "Good", "driver": "mysql", "host": "h" },
      { "name": "No host", "driver": "mysql" },
      { "name": "Typo", "driver": "mysql", "host": "h", "pasword": "x" },
      { "name": "Bad driver", "driver": "oracle", "host": "h" },
      "not an object",
      { "id": "has space", "name": "Bad id", "driver": "mysql", "host": "h" }
    ] }`);
    expect(results.map((result) => result.ok)).toEqual([true, false, false, false, false, false]);
    expect(results[1]).toEqual({ ok: false, problem: 'host-empty' });
    expect(results[2]).toEqual({ ok: false, problem: 'pasword: unexpected field' });
    expect(results[3]?.ok === false && results[3].problem).toContain('driver');
    expect(results[4]?.ok === false && results[4].problem).toContain('expected object');
    expect(results[5]?.ok === false && results[5].problem).toContain('letters, digits');
  });

  it('never accepts a password field, so a secret cannot hide in a shared file', () => {
    const [result] = entries(`{ "connections": [
      { "name": "P", "driver": "mysql", "host": "h", "password": "hunter2" }
    ] }`);
    expect(result).toEqual({ ok: false, problem: 'password: unexpected field' });
  });

  it('reads the folder list of an export and ignores what is not a name', () => {
    const file = read(`{ "folders": ["Work", "", 3, "Home"], "connections": [] }`);
    expect(file.folders).toEqual(['Work', 'Home']);
  });

  it('refuses text that is not a connection file', () => {
    expect(readConnectionFile('[]')).toEqual({
      ok: false,
      error: 'The file must hold a JSON object with a "connections" list',
    });
    expect(readConnectionFile('{"connections": {}}')).toEqual({
      ok: false,
      error: '"connections" must be a list',
    });
    expect(readConnectionFile('{ oops').ok).toBe(false);
  });

  it('refuses a list longer than the limit', () => {
    const list = Array.from({ length: MAX_FILE_CONNECTIONS + 1 }, () => ({}));
    const result = readConnectionFile(JSON.stringify({ connections: list }));
    expect(result.ok).toBe(false);
  });
});

describe('entryJson', () => {
  it('puts the id first and leaves out empty fields', () => {
    const json = entryJson({
      id: 'dev',
      input: { name: 'Dev', driver: 'mysql', host: 'h', port: undefined },
    });
    expect(Object.keys(json)).toEqual(['id', 'name', 'driver', 'host']);
  });

  it('omits the id when there is none', () => {
    expect(entryJson({ input: { name: 'A', driver: 'sqlite', file: 'a.db' } })).toEqual({
      name: 'A',
      driver: 'sqlite',
      file: 'a.db',
    });
  });
});

describe('writeConnectionFile', () => {
  it('writes version first and the list last, with two-space indents', () => {
    const text = writeConnectionFile({ connections: [{ name: 'A', driver: 'mysql', host: 'h' }] });
    expect(text).toBe(
      [
        '{',
        '  "version": 1,',
        '  "connections": [',
        '    {',
        '      "name": "A",',
        '      "driver": "mysql",',
        '      "host": "h"',
        '    }',
        '  ]',
        '}',
        '',
      ].join('\n'),
    );
  });

  it('keeps $schema first and other keys of the old file', () => {
    const text = writeConnectionFile({
      raw: { note: 'team', $schema: 's', version: 7, connections: ['old'] },
      connections: [],
    });
    expect(JSON.parse(text)).toEqual({ $schema: 's', version: 1, note: 'team', connections: [] });
    expect(text.indexOf('$schema')).toBeLessThan(text.indexOf('version'));
  });

  it('writes folders when given, keeps the old ones when not, and drops an empty list', () => {
    const withFolders = writeConnectionFile({ connections: [], folders: ['Work'] });
    expect(JSON.parse(withFolders)).toEqual({ version: 1, folders: ['Work'], connections: [] });
    const kept = writeConnectionFile({ raw: { folders: ['Old'] }, connections: [] });
    expect(JSON.parse(kept)).toEqual({ version: 1, folders: ['Old'], connections: [] });
    expect(JSON.parse(writeConnectionFile({ connections: [], folders: [] }))).toEqual({
      version: 1,
      connections: [],
    });
  });

  it('round-trips: what it writes reads back the same', () => {
    const input = {
      name: 'Far',
      driver: 'postgres' as const,
      host: 'db',
      ssh: { id: 'ssh', host: 'b', user: 'u', auth: 'agent' as const },
    };
    const text = writeConnectionFile({ connections: [entryJson({ id: 'far', input })] });
    expect(read(text).entries).toEqual([{ ok: true, entry: { id: 'far', input } }]);
  });
});

describe('localIdFor', () => {
  it('makes a short id from the name', () => {
    expect(localIdFor('Staging EU (read)', new Set())).toBe('staging-eu-read');
    expect(localIdFor('my_db-2', new Set())).toBe('my_db-2');
  });

  it('adds a number when the id is taken', () => {
    expect(localIdFor('Dev', new Set(['dev']))).toBe('dev-2');
    expect(localIdFor('Dev', new Set(['dev', 'dev-2']))).toBe('dev-3');
  });

  it('falls back to "connection" for names without Latin letters or digits', () => {
    expect(localIdFor('Боевая', new Set())).toBe('connection');
    expect(localIdFor('---', new Set(['connection']))).toBe('connection-2');
  });

  it('keeps ids short enough for a secret key', () => {
    const id = localIdFor('x'.repeat(200), new Set(['x'.repeat(48)]));
    expect(id.length).toBeLessThanOrEqual(64);
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

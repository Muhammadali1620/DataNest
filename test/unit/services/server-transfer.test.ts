import { describe, expect, it } from 'vitest';
import {
  exportServers,
  MAX_SERVERS,
  parseServerFile,
  SERVER_FILE_VERSION,
} from '../../../src/services/server-transfer';
import type { SshServerConfig } from '../../../src/shared/ssh-server';

const web: SshServerConfig = {
  id: 'id-1',
  name: 'Web',
  ssh: { id: 'main', host: 'web.example.com', port: 2222, user: 'deploy', auth: 'password' },
  startPath: '/var/www',
  readOnly: true,
  color: 'green',
};

const bastion: SshServerConfig = {
  id: 'id-2',
  name: 'Behind a bastion',
  ssh: {
    id: 'main',
    host: 'inner',
    user: 'me',
    auth: 'key',
    keyFile: '~/.ssh/id',
    jumps: [{ id: 'jump', host: 'bastion', user: 'jumper', auth: 'agent' }],
  },
  proxy: { kind: 'socks5', host: 'px', user: 'u' },
};

describe('exportServers', () => {
  it('writes the servers without their ids', () => {
    const parsed = JSON.parse(exportServers([web, bastion])) as {
      version: number;
      servers: Record<string, unknown>[];
    };
    expect(parsed.version).toBe(SERVER_FILE_VERSION);
    expect(parsed.servers).toHaveLength(2);
    expect(parsed.servers.every((server) => !('id' in server))).toBe(true);
    expect(parsed.servers[0]).toMatchObject({ name: 'Web', startPath: '/var/www', readOnly: true });
  });

  it('carries no secret: a stray field of the config never reaches the file', () => {
    const text = exportServers([
      { ...web, ...({ password: 'hunter2', token: 't0k3n' } as object) },
    ]);
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('t0k3n');
    expect(text).not.toContain('"id": "id-1"');
    expect(parseServerFile(text).servers[0]?.name).toBe('Web');
  });

  it('writes an empty list', () => {
    expect(parseServerFile(exportServers([])).servers).toEqual([]);
  });
});

describe('parseServerFile', () => {
  it('reads back what was written, jump hosts and proxy included', () => {
    const plan = parseServerFile(exportServers([web, bastion]));
    expect(plan.skipped).toEqual([]);
    expect(plan.servers.map((server) => server.name)).toEqual(['Web', 'Behind a bastion']);
    expect(plan.servers[1]?.ssh.jumps).toHaveLength(1);
    expect(plan.servers[1]?.proxy).toEqual({ kind: 'socks5', host: 'px', user: 'u' });
  });

  it('refuses text that is not JSON, and JSON that is not a servers file', () => {
    expect(() => parseServerFile('not json')).toThrow(/not valid JSON/u);
    expect(() => parseServerFile('[]')).toThrow(/not a DataNest servers file/u);
    expect(() => parseServerFile('null')).toThrow(/not a DataNest servers file/u);
    expect(() => parseServerFile('{"version":2,"servers":[]}')).toThrow(
      /not a DataNest servers file/u,
    );
    expect(() => parseServerFile('{"version":1}')).toThrow(/not a DataNest servers file/u);
    expect(() => parseServerFile('{"version":1,"servers":{}}')).toThrow(
      /not a DataNest servers file/u,
    );
  });

  it('refuses a file with more entries than a person has', () => {
    const many = JSON.stringify({ version: 1, servers: new Array(MAX_SERVERS + 1).fill({}) });
    expect(() => parseServerFile(many)).toThrow(/not a DataNest servers file/u);
  });

  it('skips an entry that is broken, telling its position, and keeps the rest', () => {
    const text = JSON.stringify({
      version: 1,
      servers: [
        { name: 'Good', ssh: { id: 'main', host: 'h', user: 'u', auth: 'agent' } },
        'a string',
        { name: 'No ssh' },
        { name: '', ssh: { id: 'main', host: 'h', user: 'u', auth: 'agent' } },
        { name: 'No host', ssh: { id: 'main', host: ' ', user: 'u', auth: 'agent' } },
        { name: 'Bad auth', ssh: { id: 'main', host: 'h', user: 'u', auth: 'telepathy' } },
        { name: 'Also good', ssh: { id: 'main', host: 'h2', user: 'u', auth: 'agent' } },
      ],
    });
    const plan = parseServerFile(text);
    expect(plan.servers.map((server) => server.name)).toEqual(['Good', 'Also good']);
    expect(plan.skipped.map((item) => item.position)).toEqual([2, 3, 4, 5, 6]);
    expect(plan.skipped.every((item) => item.problem !== '')).toBe(true);
  });

  it('trims names and hosts, as saving does', () => {
    const plan = parseServerFile(
      JSON.stringify({
        version: 1,
        servers: [
          { name: '  Spaced  ', ssh: { id: 'main', host: ' h ', user: ' u ', auth: 'agent' } },
        ],
      }),
    );
    expect(plan.servers[0]?.name).toBe('Spaced');
    expect(plan.servers[0]?.ssh).toMatchObject({ host: 'h', user: 'u' });
  });
});

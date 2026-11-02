// A command that stays open over SSH (V13.33), against an SSH server inside the test process;
// and the whole way a change takes to a SQLite file: the writer, a real login, the command line
// the extension really sends, a real Python and a real SQLite.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import type { RemoteFileSpec } from '../../../../src/services/remote-snapshots';
import { CLI_COMMAND, openRemoteWriter } from '../../../../src/services/remote-sqlite-cli';
import { RemoteSqliteWriter } from '../../../../src/services/remote-sqlite-writer';
import type { ExecChannel, ExecOpener } from '../../../../src/services/shell-types';
import { openExecChannel } from '../../../../src/services/ssh/shell-session';
import { RecordingLogger } from '../../../helpers/fakes';
import { HAS_PYTHON, HAS_SQLITE_CLI, runThroughShell } from '../../../helpers/python-exec';
import { startSshServer, type TestSshServer } from '../../../helpers/ssh-server';

const TRUST = () => Promise.resolve(true);
const users = [{ name: 'deploy', password: 'pw' }];
const logger = new RecordingLogger();

function specFor(server: TestSshServer, password = 'pw'): RemoteFileSpec {
  return {
    hops: [{ host: '127.0.0.1', port: server.port, user: 'deploy', auth: 'password', password }],
    checkHostKey: TRUST,
    timeoutMs: 5000,
  };
}

let server: TestSshServer | undefined;
const channels: ExecChannel[] = [];

afterEach(async () => {
  for (const channel of channels.splice(0)) {
    channel.close();
  }
  await server?.close();
  server = undefined;
});

async function open(options: Parameters<typeof startSshServer>[0]): Promise<ExecChannel> {
  server = await startSshServer(options);
  const channel = await openExecChannel(specFor(server), 'helper --serve', logger);
  channels.push(channel);
  return channel;
}

function collect(channel: ExecChannel): { out(): string; err(): string } {
  let out = '';
  let err = '';
  channel.onData((chunk, error) => {
    if (error) {
      err += chunk.toString('utf8');
    } else {
      out += chunk.toString('utf8');
    }
  });
  return { out: () => out, err: () => err };
}

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

describe('openExecChannel', () => {
  it('runs the command the extension asked for', async () => {
    await open({
      users,
      exec: (_command, channel) => {
        channel.exit(0);
        channel.end();
      },
    });
    expect(server?.execs).toEqual(['helper --serve']);
  });

  it('talks both ways: what is written reaches the command, what it prints comes back', async () => {
    const channel = await open({
      users,
      exec: (_command, serverChannel) => {
        serverChannel.on('data', (chunk: Buffer) => {
          serverChannel.write(`echo:${chunk.toString('utf8')}`);
          serverChannel.stderr.write(`seen:${chunk.length}`);
        });
      },
    });
    const heard = collect(channel);
    channel.write('hello\n');
    await until(() => heard.out().includes('echo:hello') && heard.err().includes('seen:6'), 'echo');
    expect(heard.out()).toBe('echo:hello\n');
    expect(heard.err()).toBe('seen:6');
  });

  it('keeps what the command printed before anyone listened', async () => {
    const channel = await open({
      users,
      exec: (_command, serverChannel) => {
        serverChannel.write('greeting\n');
        serverChannel.stderr.write('warning\n');
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const heard = collect(channel);
    expect(heard.out()).toBe('greeting\n');
    expect(heard.err()).toBe('warning\n');
  });

  it('says how the command ended', async () => {
    const channel = await open({
      users,
      exec: (_command, serverChannel) => {
        serverChannel.exit(3);
        serverChannel.end();
      },
    });
    await expect(channel.closed).resolves.toMatchObject({ reason: 'exit', code: 3 });
  });

  it('says we closed it when we did, and can be closed twice', async () => {
    const channel = await open({ users, exec: () => undefined });
    channel.close();
    channel.close();
    await expect(channel.closed).resolves.toMatchObject({ reason: 'closed' });
    // Writing to a closed command is ignored, not thrown.
    expect(() => {
      channel.write('late');
    }).not.toThrow();
  });

  it('says the link dropped when the server goes away', async () => {
    const channel = await open({ users, exec: () => undefined });
    await server?.close();
    await expect(channel.closed).resolves.toMatchObject({ reason: 'dropped' });
  });

  it('fails when the server will not run commands', async () => {
    server = await startSshServer({ users });
    await expect(openExecChannel(specFor(server), 'x', logger)).rejects.toMatchObject({
      code: 'connection-failed',
    });
  });

  it('fails with the login’s own error when the password is wrong', async () => {
    server = await startSshServer({ users, exec: () => undefined });
    const error = await openExecChannel(specFor(server, 'wrong'), 'x', logger).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DbError);
    expect(error).toMatchObject({ code: 'auth-failed' });
  });
});

describe.skipIf(!HAS_PYTHON || process.platform === 'win32')(
  'changing a SQLite file through SSH, end to end',
  () => {
    let dir: string;
    let file: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'datanest-e2e-'));
      file = join(dir, 'app.db');
      const db = new DatabaseSync(file);
      db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
      db.close();
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    const opener: ExecOpener = {
      openExec: (spec, command) => openExecChannel(spec, command, logger),
    };

    it('runs a statement on the file, with the command line the extension sends', async () => {
      server = await startSshServer({ users, exec: runThroughShell });
      const writer = await RemoteSqliteWriter.open(opener, specFor(server), file, { logger });
      try {
        const outcome = await writer.run("INSERT INTO t (name) VALUES ('привет 😀 it''s')");
        expect(outcome).toEqual({ affectedRows: 1, inTransaction: false });
        await writer.run('BEGIN');
        await writer.run("INSERT INTO t (name) VALUES ('in a transaction')");
        expect(writer.inTransaction).toBe(true);
        await writer.run('COMMIT');
      } finally {
        await writer.close();
      }
      const command = server.execs[0] ?? '';
      expect(command.startsWith("python3 -u -c '")).toBe(true);
      expect(command).not.toContain(file);
      expect(command).not.toContain('INSERT');
      const db = new DatabaseSync(file, { readOnly: true });
      expect(
        db
          .prepare('SELECT name FROM t ORDER BY id')
          .all()
          .map((row) => row.name),
      ).toEqual(["привет 😀 it's", 'in a transaction']);
      db.close();
    });

    it('says python3 is missing when the shell on the server cannot find it', async () => {
      server = await startSshServer({
        users,
        exec: (command, channel) => {
          runThroughShell(command.replace('python3', 'python3-that-is-not-installed'), channel);
        },
      });
      const error = await RemoteSqliteWriter.open(opener, specFor(server), file, { logger }).catch(
        (e: unknown) => e,
      );
      expect(error).toMatchObject({ code: 'unsupported' });
      expect((error as DbError).message).toMatch(/needs Python 3/);
    });

    it.skipIf(!HAS_SQLITE_CLI)(
      'falls back to the sqlite3 program when there is no Python 3, with a constant command line',
      async () => {
        server = await startSshServer({
          users,
          exec: (command, channel) => {
            runThroughShell(command.replace('python3', 'python3-that-is-not-installed'), channel);
          },
        });
        const writer = await openRemoteWriter(opener, specFor(server), file, { logger });
        try {
          const outcome = await writer.run("INSERT INTO t (name) VALUES ('привет 😀 it''s')");
          expect(outcome).toEqual({ affectedRows: 1, inTransaction: false });
          await writer.run('BEGIN');
          await writer.run("INSERT INTO t (name) VALUES ('in a transaction')");
          expect(writer.inTransaction).toBe(true);
          expect((await writer.run('SELECT count(*) AS n FROM t')).rows).toEqual([[2]]);
          await writer.run('COMMIT');
        } finally {
          await writer.close();
        }
        expect(server.execs).toHaveLength(2);
        expect(server.execs[1]).toBe(CLI_COMMAND);
        expect(server.execs[1]).not.toContain(file);
        const db = new DatabaseSync(file, { readOnly: true });
        expect(
          db
            .prepare('SELECT name FROM t ORDER BY id')
            .all()
            .map((row) => row.name),
        ).toEqual(["привет 😀 it's", 'in a transaction']);
        db.close();
      },
    );

    it('stops a running statement by dropping the link, and the file stays whole', async () => {
      server = await startSshServer({ users, exec: runThroughShell });
      const writer = await RemoteSqliteWriter.open(opener, specFor(server), file, { logger });
      await writer.run('BEGIN');
      await writer.run("INSERT INTO t (name) VALUES ('never committed')");
      const long = writer.run(
        'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c',
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      writer.abort();
      await expect(long).rejects.toBeInstanceOf(DbError);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const db = new DatabaseSync(file, { readOnly: true });
      expect(db.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 0 });
      db.close();
    });
  },
);

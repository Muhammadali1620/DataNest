import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import {
  listAlarms,
  listMembers,
  memberStatus,
  SNAPSHOT_HASH_BYTES,
  takeSnapshot,
} from '../../../../src/services/etcd/etcd-cluster';

/** A cluster that answers each path with a fixed answer. */
function answering(answers: Record<string, unknown>): {
  call: (path: string, body: Readonly<Record<string, unknown>>) => Promise<unknown>;
  seen: { path: string; body: Readonly<Record<string, unknown>> }[];
} {
  const seen: { path: string; body: Readonly<Record<string, unknown>> }[] = [];
  return {
    seen,
    call: (path, body) => {
      seen.push({ path, body });
      return Promise.resolve(answers[path] ?? {});
    },
  };
}

describe('listMembers', () => {
  it('reads the members with their urls and the learner flag', async () => {
    const cluster = answering({
      'cluster/member/list': {
        members: [
          {
            ID: '10276657743932975437',
            name: 'one',
            peerURLs: ['http://a:2380'],
            clientURLs: ['http://a:2379', 'http://b:2379'],
          },
          { ID: '5', peerURLs: ['http://c:2380'], isLearner: true },
        ],
      },
    });
    expect(await listMembers(cluster)).toEqual([
      {
        id: '10276657743932975437',
        name: 'one',
        peerUrls: ['http://a:2380'],
        clientUrls: ['http://a:2379', 'http://b:2379'],
        learner: false,
      },
      { id: '5', name: '', peerUrls: ['http://c:2380'], clientUrls: [], learner: true },
    ]);
  });

  it('survives an answer with no members or odd fields', async () => {
    expect(await listMembers(answering({}))).toEqual([]);
    expect(
      await listMembers(
        answering({ 'cluster/member/list': { members: [null, { name: 7, peerURLs: 'x' }] } }),
      ),
    ).toEqual([
      { id: '0', name: '', peerUrls: [], clientUrls: [], learner: false },
      { id: '0', name: '', peerUrls: [], clientUrls: [], learner: false },
    ]);
  });
});

describe('memberStatus', () => {
  it('reads the figures of the connected member', async () => {
    const cluster = answering({
      'maintenance/status': {
        header: { member_id: '9' },
        version: '3.5.17',
        dbSize: '28672',
        dbSizeInUse: '24576',
        leader: '9',
        raftIndex: '7',
        raftAppliedIndex: '6',
        raftTerm: '2',
        errors: ['no space'],
      },
    });
    expect(await memberStatus(cluster)).toEqual({
      memberId: '9',
      leaderId: '9',
      version: '3.5.17',
      dbSize: 28672,
      dbSizeInUse: 24576,
      raftIndex: '7',
      raftAppliedIndex: '6',
      raftTerm: '2',
      learner: false,
      errors: ['no space'],
    });
  });

  it('turns absent fields into zeros', async () => {
    const status = await memberStatus(answering({}));
    expect(status).toMatchObject({ memberId: '0', dbSize: 0, version: '', errors: [] });
  });
});

describe('listAlarms', () => {
  it('lists the alarms and leaves out the "none" entry', async () => {
    const cluster = answering({
      'maintenance/alarm': {
        alarms: [
          { memberID: '4', alarm: 'NOSPACE' },
          { memberID: '5', alarm: 'NONE' },
        ],
      },
    });
    expect(await listAlarms(cluster)).toEqual([{ memberId: '4', kind: 'NOSPACE' }]);
    expect(cluster.seen[0]).toEqual({ path: 'maintenance/alarm', body: { action: 'GET' } });
  });

  it('is empty when the cluster has none', async () => {
    expect(await listAlarms(answering({}))).toEqual([]);
  });
});

/** A snapshot of `data` in the gateway's pieces: the bytes and their SHA-256 at the end. */
function snapshotOf(data: Uint8Array, sizes: number[]): Uint8Array {
  const file = new Uint8Array(data.length + SNAPSHOT_HASH_BYTES);
  file.set(data);
  file.set(createHash('sha256').update(data).digest(), data.length);
  expect(sizes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(file.length);
  return file;
}

function streaming(
  file: Uint8Array,
  chunk: number,
  options: { error?: unknown } = {},
): {
  watch: (
    path: string,
    body: Readonly<Record<string, unknown>>,
    onMessage: (message: unknown) => void,
    signal: AbortSignal,
  ) => Promise<void>;
} {
  return {
    watch: (path, _body, onMessage) => {
      expect(path).toBe('maintenance/snapshot');
      for (let at = 0; at < file.length; at += chunk) {
        onMessage({
          result: { blob: Buffer.from(file.subarray(at, at + chunk)).toString('base64') },
        });
      }
      if (options.error !== undefined) {
        onMessage({ error: options.error });
      }
      return Promise.resolve();
    },
  };
}

const noCalls = { call: () => Promise.resolve({}) };

describe('takeSnapshot', () => {
  const data = Uint8Array.from({ length: 5000 }, (_, index) => (index * 7) % 256);

  it('writes the whole file, checksum included, and says it checked out', async () => {
    const file = snapshotOf(data, [1]);
    const written: Uint8Array[] = [];
    const result = await takeSnapshot(
      { ...noCalls, ...streaming(file, 1000) },
      (chunk) => {
        written.push(chunk.slice());
        return Promise.resolve();
      },
      new AbortController().signal,
    );
    expect(result).toEqual({ bytes: file.length, verified: true });
    expect(Buffer.concat(written)).toEqual(Buffer.from(file));
  });

  it.each([1, 7, 31, 32, 33, 4999, 100_000])(
    'cuts the checksum off correctly when the pieces are %i bytes',
    async (size) => {
      const file = snapshotOf(data, [1]);
      const written: Uint8Array[] = [];
      const result = await takeSnapshot(
        { ...noCalls, ...streaming(file, size) },
        (chunk) => {
          written.push(chunk.slice());
          return Promise.resolve();
        },
        new AbortController().signal,
      );
      expect(result.verified).toBe(true);
      expect(Buffer.concat(written)).toEqual(Buffer.from(file));
    },
  );

  it('says so when the checksum does not match', async () => {
    const file = snapshotOf(data, [1]);
    file[10] = (file[10] ?? 0) ^ 0xff;
    const result = await takeSnapshot(
      { ...noCalls, ...streaming(file, 1000) },
      () => Promise.resolve(),
      new AbortController().signal,
    );
    expect(result.verified).toBe(false);
  });

  it('refuses something too short to hold a checksum', async () => {
    await expect(
      takeSnapshot(
        { ...noCalls, ...streaming(new Uint8Array(10), 10) },
        () => Promise.resolve(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'connection-failed' });
    await expect(
      takeSnapshot(
        { ...noCalls, ...streaming(new Uint8Array(), 10) },
        () => Promise.resolve(),
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(DbError);
  });

  it("reports the cluster's refusal with the kind its code stands for", async () => {
    await expect(
      takeSnapshot(
        {
          ...noCalls,
          ...streaming(snapshotOf(data, [1]), 1000, { error: { code: 7, message: 'no' } }),
        },
        () => Promise.resolve(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'permission-denied', message: 'no' });
    await expect(
      takeSnapshot(
        { ...noCalls, ...streaming(new Uint8Array(), 1, { error: {} }) },
        () => Promise.resolve(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'constraint' });
  });

  it('stops at the first write that fails and reports it', async () => {
    const file = snapshotOf(data, [1]);
    let writes = 0;
    let aborted = false;
    const streamer = {
      watch: (
        _path: string,
        _body: Readonly<Record<string, unknown>>,
        onMessage: (message: unknown) => void,
        signal: AbortSignal,
      ) => {
        signal.addEventListener('abort', () => {
          aborted = true;
        });
        for (let at = 0; at < file.length; at += 1000) {
          onMessage({
            result: { blob: Buffer.from(file.subarray(at, at + 1000)).toString('base64') },
          });
        }
        return Promise.resolve();
      },
    };
    await expect(
      takeSnapshot(
        { ...noCalls, ...streamer },
        () => {
          writes += 1;
          return Promise.reject(new Error('disk full'));
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow('disk full');
    expect(writes).toBe(1);
    expect(aborted).toBe(true);
  });

  it('is cancelled when the signal aborts', async () => {
    const abort = new AbortController();
    const streamer = {
      watch: (
        _path: string,
        _body: Readonly<Record<string, unknown>>,
        _onMessage: (message: unknown) => void,
        signal: AbortSignal,
      ) =>
        new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => {
            resolve();
          });
          abort.abort();
        }),
    };
    await expect(
      takeSnapshot({ ...noCalls, ...streamer }, () => Promise.resolve(), abort.signal),
    ).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('passes on a failure of the link', async () => {
    const streamer = {
      watch: () => Promise.reject(new DbError('connection-failed', 'gone')),
    };
    await expect(
      takeSnapshot(
        { ...noCalls, ...streamer },
        () => Promise.resolve(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'connection-failed' });
  });

  it('ignores a message with no data', async () => {
    const file = snapshotOf(data, [1]);
    const streamer = {
      watch: (
        _path: string,
        _body: Readonly<Record<string, unknown>>,
        onMessage: (message: unknown) => void,
      ) => {
        onMessage({ result: {} });
        onMessage(null);
        onMessage({ result: { blob: Buffer.from(file).toString('base64') } });
        return Promise.resolve();
      },
    };
    const result = await takeSnapshot(
      { ...noCalls, ...streamer },
      () => Promise.resolve(),
      new AbortController().signal,
    );
    expect(result.verified).toBe(true);
  });
});

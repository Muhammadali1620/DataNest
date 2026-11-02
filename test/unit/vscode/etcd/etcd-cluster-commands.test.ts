import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import type { EtcdCaller } from '../../../../src/services/etcd/etcd-client';
import type { EtcdWatcher } from '../../../../src/services/etcd/etcd-watch';
import type { SnapshotSink } from '../../../../src/services/etcd/etcd-cluster';
import type { ConnectionConfig } from '../../../../src/shared/connection';
import type { AccessPickItem } from '../../../../src/vscode/etcd/etcd-access-commands';
import {
  alarmText,
  etcdClusterHandler,
  type EtcdClusterUi,
  memberLabel,
  snapshotName,
  statusLines,
} from '../../../../src/vscode/etcd/etcd-cluster-commands';
import type { TreeNode } from '../../../../src/vscode/tree/nodes';

const config = (id: string, extra: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
  id,
  name: `etcd ${id}`,
  driver: 'etcd',
  host: 'h',
  ...extra,
});

const MEMBERS = {
  members: [
    { ID: '1', name: 'alpha', peerURLs: ['http://a:2380'], clientURLs: ['http://a:2379'] },
    { ID: '2', name: 'beta', peerURLs: ['http://b:2380'], clientURLs: ['http://b:2379'] },
    { ID: '3', peerURLs: ['http://c:2380'], isLearner: true },
  ],
};
const STATUS = {
  header: { member_id: '1' },
  version: '3.5.17',
  dbSize: '28672',
  dbSizeInUse: '24576',
  leader: '2',
  raftIndex: '7',
  raftAppliedIndex: '7',
  raftTerm: '2',
};

let configs: ConnectionConfig[];
let answers: Record<string, unknown>;
let infos: string[];
let picks: (string | undefined)[];
let shown: { labels: string[]; descriptions: (string | undefined)[] }[];
let saveAnswer: string | undefined;
let saveOptions: { defaultName: string; extensions: readonly string[] }[];
let pickedConnection: string | undefined;
let sinkWrites: Uint8Array[];
let sinkClosed: boolean[];
let progress: string[];
let snapshot: Uint8Array;
let streamError: Error | undefined;
let withoutWatch: boolean;
let sinkFails: boolean;

function handler() {
  const caller: EtcdCaller & Partial<EtcdWatcher> = {
    call: (path) => Promise.resolve(answers[path] ?? {}),
    ...(withoutWatch
      ? {}
      : {
          watch: (_path, _body, onMessage) => {
            for (let at = 0; at < snapshot.length; at += 20) {
              onMessage({
                result: { blob: Buffer.from(snapshot.subarray(at, at + 20)).toString('base64') },
              });
            }
            if (streamError !== undefined) {
              return Promise.reject(streamError);
            }
            return Promise.resolve();
          },
        }),
  };
  const ui: EtcdClusterUi = {
    input: () => Promise.resolve(undefined),
    pickKey: () => Promise.resolve(undefined),
    confirm: () => Promise.resolve(true),
    pickConnection: () => Promise.resolve(pickedConnection),
    info: (message) => {
      infos.push(message);
    },
    pick: <T>(options: {
      title: string;
      placeHolder?: string;
      items: readonly AccessPickItem<T>[];
    }): Promise<T | undefined> => {
      shown.push({
        labels: options.items.map((item) => item.label),
        descriptions: options.items.map((item) => item.description),
      });
      const answer = picks.shift();
      const item = options.items.find((one) => one.label === answer);
      if (answer !== undefined && item === undefined) {
        throw new Error(
          `No item "${answer}" among ${options.items.map((i) => i.label).join(', ')}`,
        );
      }
      return Promise.resolve(item?.value);
    },
    saveFile: (options) => {
      saveOptions.push({ defaultName: options.defaultName, extensions: options.extensions });
      return Promise.resolve(saveAnswer);
    },
    withProgress: async <T>(title: string, task: (signal: AbortSignal) => Promise<T>) => {
      progress.push(title);
      return await task(new AbortController().signal);
    },
  };
  const sink: SnapshotSink = {
    write: (chunk) => {
      if (sinkFails) {
        return Promise.reject(new Error('disk full'));
      }
      sinkWrites.push(chunk.slice());
      return Promise.resolve();
    },
    close: (keep) => {
      sinkClosed.push(keep);
      return Promise.resolve();
    },
  };
  return etcdClusterHandler({
    store: { get: (id) => configs.find((one) => one.id === id), list: () => configs },
    session: () => Promise.resolve(caller),
    ui,
    openSink: () => Promise.resolve(sink),
    today: () => '2026-11-02',
    texts: { noEtcd: 'no etcd' },
  });
}

const connectionNode = (connectionId = 'c1'): TreeNode => ({ kind: 'connection', connectionId });

beforeEach(() => {
  configs = [config('c1')];
  answers = { 'cluster/member/list': MEMBERS, 'maintenance/status': STATUS };
  infos = [];
  picks = [];
  shown = [];
  saveAnswer = '/tmp/out.db';
  saveOptions = [];
  pickedConnection = undefined;
  sinkWrites = [];
  sinkClosed = [];
  progress = [];
  const data = Uint8Array.from({ length: 100 }, (_, index) => index);
  snapshot = new Uint8Array(data.length + 32);
  snapshot.set(data);
  snapshot.set(createHash('sha256').update(data).digest(), data.length);
  streamError = undefined;
  withoutWatch = false;
  sinkFails = false;
});

describe('the pure helpers', () => {
  it('names a member by its name, or its id before it has started', () => {
    expect(memberLabel({ id: '9', name: 'm', peerUrls: [], clientUrls: [], learner: false })).toBe(
      'm',
    );
    expect(memberLabel({ id: '9', name: '', peerUrls: [], clientUrls: [], learner: false })).toBe(
      '9',
    );
  });

  it('suggests a safe file name', () => {
    expect(snapshotName(undefined, '2026-11-02')).toBe('etcd-cluster-2026-11-02.db');
    expect(
      snapshotName(
        { id: '1', name: 'infra 1/b', peerUrls: [], clientUrls: [], learner: false },
        '2026-11-02',
      ),
    ).toBe('etcd-infra-1-b-2026-11-02.db');
  });

  it('tells an alarm in words, with the member it belongs to', () => {
    const members = [{ id: '1', name: 'alpha', peerUrls: [], clientUrls: [], learner: false }];
    expect(alarmText({ memberId: '1', kind: 'NOSPACE' }, members)).toContain('alpha');
    expect(alarmText({ memberId: '7', kind: 'CORRUPT' }, members)).toContain('7');
    expect(alarmText({ memberId: '1', kind: 'ODD' }, members)).toBe('alpha: ODD');
  });

  it('lists the figures of the connected member, with its problems', () => {
    const lines = statusLines({
      memberId: '1',
      leaderId: '1',
      version: '3.5.17',
      dbSize: 28672,
      dbSizeInUse: 24576,
      raftIndex: '7',
      raftAppliedIndex: '7',
      raftTerm: '2',
      learner: false,
      errors: ['bad'],
    });
    expect(lines.join('\n')).toContain('3.5.17');
    expect(lines.join('\n')).toContain('28 KB');
    expect(lines.join('\n')).toContain('bad');
  });
});

describe('the cluster command', () => {
  it('lists the snapshot, then every member with its role', async () => {
    await handler()(connectionNode());
    expect(shown[0]?.labels).toEqual(['Save a snapshot…', 'alpha', 'beta', '3']);
    expect(shown[0]?.descriptions.slice(1)).toEqual(['follower, connected', 'leader', 'learner']);
  });

  it('shows an alarm line when the cluster has raised one', async () => {
    answers['maintenance/alarm'] = { alarms: [{ memberID: '2', alarm: 'NOSPACE' }] };
    picks = ['1 alarms'];
    await handler()(connectionNode());
    expect(shown[0]?.labels[1]).toBe('1 alarms');
    expect(infos[0]).toContain('beta');
  });

  it('tells what it knows of a member, with the figures when it is the connected one', async () => {
    picks = ['alpha'];
    await handler()(connectionNode());
    expect(infos[0]).toContain('alpha (1)');
    expect(infos[0]).toContain('http://a:2379');
    expect(infos[0]).toContain('3.5.17');
    picks = ['beta'];
    await handler()(connectionNode());
    expect(infos[1]).toContain('beta (2), leader');
    expect(infos[1]).not.toContain('3.5.17');
  });

  it('does nothing when the list is dismissed', async () => {
    await handler()(connectionNode());
    expect(infos).toEqual([]);
    expect(sinkClosed).toEqual([]);
  });

  it('saves a snapshot, checks it and reports its size', async () => {
    picks = ['Save a snapshot…'];
    await handler()(connectionNode());
    expect(saveOptions).toEqual([{ defaultName: 'etcd-alpha-2026-11-02.db', extensions: ['db'] }]);
    expect(Buffer.concat(sinkWrites)).toEqual(Buffer.from(snapshot));
    expect(sinkClosed).toEqual([true]);
    expect(progress).toHaveLength(1);
    expect(infos[0]).toContain('/tmp/out.db');
    expect(infos[0]).toContain('checksum checked');
  });

  it('warns about a snapshot whose checksum does not match', async () => {
    snapshot[3] = (snapshot[3] ?? 0) ^ 0xff;
    picks = ['Save a snapshot…'];
    await handler()(connectionNode());
    expect(infos[0]).toContain('did not match');
    expect(sinkClosed).toEqual([true]);
  });

  it('asks for nothing more when the save box is dismissed', async () => {
    saveAnswer = undefined;
    picks = ['Save a snapshot…'];
    await handler()(connectionNode());
    expect(sinkClosed).toEqual([]);
    expect(infos).toEqual([]);
  });

  it('removes the half file when the stream fails', async () => {
    streamError = new DbError('connection-failed', 'link lost');
    picks = ['Save a snapshot…'];
    await expect(handler()(connectionNode())).rejects.toMatchObject({ message: 'link lost' });
    expect(sinkClosed).toEqual([false]);
    expect(infos).toEqual([]);
  });

  it('removes the half file when the disk refuses', async () => {
    sinkFails = true;
    picks = ['Save a snapshot…'];
    await expect(handler()(connectionNode())).rejects.toThrow('disk full');
    expect(sinkClosed).toEqual([false]);
  });

  it('says when the connection cannot stream', async () => {
    withoutWatch = true;
    picks = ['Save a snapshot…'];
    await expect(handler()(connectionNode())).rejects.toMatchObject({ code: 'unsupported' });
    expect(saveOptions).toEqual([]);
  });

  it('is allowed on a read-only connection and on a production one', async () => {
    configs = [config('c1', { readOnly: true, production: true })];
    picks = ['Save a snapshot…'];
    await handler()(connectionNode());
    expect(infos).toHaveLength(1);
  });

  it('picks the connection from the palette, uses the only one, and refuses others', async () => {
    configs = [config('c1'), config('c2')];
    pickedConnection = 'c2';
    await handler()(undefined);
    expect(shown).toHaveLength(1);
    pickedConnection = undefined;
    await handler()(undefined);
    expect(shown).toHaveLength(1);
    configs = [config('c1')];
    await handler()(undefined);
    expect(shown).toHaveLength(2);
    configs = [config('c1', { driver: 'redis' })];
    await expect(handler()(connectionNode())).rejects.toMatchObject({ message: 'no etcd' });
    configs = [];
    await expect(handler()(undefined)).rejects.toMatchObject({ code: 'not-found' });
  });
});

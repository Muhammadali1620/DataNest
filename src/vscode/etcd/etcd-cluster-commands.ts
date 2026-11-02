// "Cluster" of an etcd connection (V13.35), free of `vscode`: one command that lists the
// members with how the connected one is doing, shows the alarms, and takes a snapshot of
// the store into a file. All of it is reading, so a read-only connection may use it; the
// snapshot only writes a file on this computer. What the dialogs and the file need comes in
// through `EtcdClusterUi` and `EtcdClusterDeps`, so every path (a refused cluster, a
// snapshot that fails halfway, backing out) is tested without an editor or a disk.

import { DbError } from '../../core/errors';
import { msg } from '../../core/user-message';
import type { ConnectionStore } from '../../services/connection-store';
import {
  type EtcdAlarm,
  type EtcdMember,
  type EtcdMemberStatus,
  listAlarms,
  listMembers,
  memberStatus,
  type SnapshotSink,
  takeSnapshot,
} from '../../services/etcd/etcd-cluster';
import type { EtcdCaller } from '../../services/etcd/etcd-client';
import type { EtcdWatcher } from '../../services/etcd/etcd-watch';
import { formatSize } from '../../shared/byte-size';
import { connectionIdOf } from '../tree/nodes';
import type { CommandTarget } from '../tree/tree-commands';
import type { AccessPickItem, EtcdAccessUi } from './etcd-access-commands';

export interface EtcdClusterUi extends EtcdAccessUi {
  /** Asks where to save a file; undefined when the user backs out. */
  saveFile(options: {
    readonly title: string;
    readonly defaultName: string;
    readonly filterName: string;
    readonly extensions: readonly string[];
  }): Promise<string | undefined>;
  /** Runs `task` under a progress notice the user may cancel. */
  withProgress<T>(title: string, task: (signal: AbortSignal) => Promise<T>): Promise<T>;
}

export interface EtcdClusterDeps {
  readonly store: Pick<ConnectionStore, 'get' | 'list'>;
  /** The tree's session of a connection. */
  readonly session: (connectionId: string) => Promise<EtcdCaller & Partial<EtcdWatcher>>;
  readonly ui: EtcdClusterUi;
  /** Opens the file a snapshot goes to. */
  readonly openSink: (path: string) => Promise<SnapshotSink>;
  /** Today's date as `YYYY-MM-DD`, for the file's suggested name. */
  readonly today: () => string;
  readonly texts: {
    readonly noEtcd: string;
  };
}

type Choice =
  | { readonly to: 'snapshot' }
  | { readonly to: 'member'; readonly member: EtcdMember }
  | { readonly to: 'alarms' };

/** A member's name, or its id when it has none yet. */
export function memberLabel(member: EtcdMember): string {
  return member.name === '' ? member.id : member.name;
}

/** What one member's line says it is. */
function roleOf(member: EtcdMember, status: EtcdMemberStatus): string {
  if (member.learner) {
    return msg('learner');
  }
  return member.id === status.leaderId ? msg('leader') : msg('follower');
}

/** The lines the message about the connected member is made of. */
export function statusLines(status: EtcdMemberStatus): string[] {
  const free = Math.max(0, status.dbSize - status.dbSizeInUse);
  return [
    msg('Version: {0}', status.version),
    msg(
      'Store file: {0} ({1} in use, {2} free)',
      formatSize(status.dbSize),
      formatSize(status.dbSizeInUse),
      formatSize(free),
    ),
    msg(
      'Raft: term {0}, index {1}, applied {2}',
      status.raftTerm,
      status.raftIndex,
      status.raftAppliedIndex,
    ),
    ...status.errors.map((problem) => msg('Problem: {0}', problem)),
  ];
}

/** The text that names an alarm in words. */
export function alarmText(alarm: EtcdAlarm, members: readonly EtcdMember[]): string {
  const member = members.find((one) => one.id === alarm.memberId);
  const where = member === undefined ? alarm.memberId : memberLabel(member);
  switch (alarm.kind) {
    case 'NOSPACE':
      return msg('{0}: the store is full, so writes are refused', where);
    case 'CORRUPT':
      return msg('{0}: the store is corrupt', where);
    default:
      return `${where}: ${alarm.kind}`;
  }
}

/** A suggested file name for a snapshot of the cluster this member belongs to. */
export function snapshotName(member: EtcdMember | undefined, date: string): string {
  const name = (member === undefined ? '' : memberLabel(member)).replaceAll(/[^\w.-]+/gu, '-');
  return `etcd-${name === '' ? 'cluster' : name}-${date}.db`;
}

export function etcdClusterHandler(
  deps: EtcdClusterDeps,
): (target?: CommandTarget) => Promise<undefined> {
  const { ui } = deps;

  const connectionOf = async (target: CommandTarget): Promise<string | undefined> => {
    const given = connectionIdOf(target);
    if (given !== undefined) {
      if (deps.store.get(given)?.driver !== 'etcd') {
        throw new DbError('unsupported', deps.texts.noEtcd);
      }
      return given;
    }
    const all = deps.store.list().filter((config) => config.driver === 'etcd');
    if (all.length === 0) {
      throw new DbError('not-found', deps.texts.noEtcd);
    }
    return all.length === 1 ? all[0]?.id : await ui.pickConnection(all.map((config) => config.id));
  };

  /** Takes the snapshot into the file the user names; returns the words to tell them. */
  const snapshot = async (
    session: EtcdCaller & Partial<EtcdWatcher>,
    members: readonly EtcdMember[],
    status: EtcdMemberStatus,
  ): Promise<void> => {
    if (session.watch === undefined) {
      throw new DbError('unsupported', msg('This cluster connection cannot stream a snapshot'));
    }
    const self = members.find((member) => member.id === status.memberId);
    const path = await ui.saveFile({
      title: msg('Save the etcd snapshot'),
      defaultName: snapshotName(self, deps.today()),
      filterName: msg('etcd snapshot'),
      extensions: ['db'],
    });
    if (path === undefined) {
      return;
    }
    const sink = await deps.openSink(path);
    let done = false;
    try {
      const result = await ui.withProgress(
        msg('Saving the etcd snapshot…'),
        async (signal) =>
          await takeSnapshot(
            session as EtcdCaller & EtcdWatcher,
            (chunk) => sink.write(chunk),
            signal,
          ),
      );
      await sink.close(true);
      done = true;
      ui.info(
        result.verified
          ? msg('Snapshot saved to {0}: {1}, checksum checked', path, formatSize(result.bytes))
          : msg(
              'Snapshot saved to {0}: {1}, but its checksum did not match: do not rely on it',
              path,
              formatSize(result.bytes),
            ),
      );
    } finally {
      if (!done) {
        // A snapshot that failed or was cancelled is not left behind as a backup.
        await sink.close(false);
      }
    }
  };

  return async (target?: CommandTarget) => {
    const connectionId = await connectionOf(target);
    if (connectionId === undefined) {
      return undefined;
    }
    const session = await deps.session(connectionId);
    const [members, status, alarms] = await Promise.all([
      listMembers(session),
      memberStatus(session),
      listAlarms(session),
    ]);
    const items: AccessPickItem<Choice>[] = [
      {
        label: msg('Save a snapshot…'),
        description: msg('the whole store, as one file'),
        icon: 'save',
        value: { to: 'snapshot' },
      },
    ];
    if (alarms.length > 0) {
      items.push({
        label: msg('{0} alarms', alarms.length),
        description: alarms.map((alarm) => alarmText(alarm, members)).join('; '),
        icon: 'warning',
        value: { to: 'alarms' },
      });
    }
    for (const member of members) {
      const connected = member.id === status.memberId;
      items.push({
        label: memberLabel(member),
        description: `${roleOf(member, status)}${connected ? msg(', connected') : ''}`,
        detail: [...member.clientUrls, ...member.peerUrls].join('  '),
        icon: connected ? 'vm-active' : 'vm',
        value: { to: 'member', member },
      });
    }
    const choice = await ui.pick<Choice>({
      title: msg('etcd cluster'),
      placeHolder: msg('{0} members; pick one to see it, or save a snapshot', members.length),
      items,
    });
    if (choice === undefined) {
      return undefined;
    }
    switch (choice.to) {
      case 'snapshot':
        await snapshot(session, members, status);
        return undefined;
      case 'alarms':
        ui.info(alarms.map((alarm) => alarmText(alarm, members)).join('\n'));
        return undefined;
      case 'member':
        ui.info(
          [
            `${memberLabel(choice.member)} (${choice.member.id}), ${roleOf(choice.member, status)}`,
            msg('Clients: {0}', choice.member.clientUrls.join(', ') || '-'),
            msg('Peers: {0}', choice.member.peerUrls.join(', ') || '-'),
            ...(choice.member.id === status.memberId ? statusLines(status) : []),
          ].join('\n'),
        );
        return undefined;
    }
  };
}

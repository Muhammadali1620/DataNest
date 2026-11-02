// The RabbitMQ cluster page and the limits of a virtual host (V13.35) without an editor.

import { describe, expect, it } from 'vitest';
import {
  RabbitObjectModel,
  type RabbitObjectModelDeps,
  uptimeText,
} from '../../../../src/vscode/panels/rabbitmq-object-model';
import { FakeRabbitSession } from '../../../helpers/fake-rabbitmq';

function setup(over: Partial<RabbitObjectModelDeps> = {}) {
  const session = new FakeRabbitSession();
  session.server = { version: '3.13.7', clusterName: 'rabbit@fake', user: 'admin' };
  const make = (kind: 'queue' | 'exchange' | 'vhost' | 'cluster', name = '') =>
    new RabbitObjectModel({
      kind,
      vhost: kind === 'cluster' ? '' : '/',
      name,
      connectionName: 'Broker',
      readOnly: false,
      session: () => Promise.resolve(session),
      ...over,
    });
  return {
    session,
    cluster: make('cluster'),
    vhost: make('vhost', '/'),
    queue: make('queue', 'q'),
  };
}

describe('uptimeText', () => {
  it('says days and hours, hours and minutes, minutes and seconds, or seconds', () => {
    expect(uptimeText(3 * 86_400_000 + 4 * 3_600_000 + 59_000)).toBe('3 d 4 h');
    expect(uptimeText(2 * 3_600_000 + 5 * 60_000 + 59_000)).toBe('2 h 5 min');
    expect(uptimeText(5 * 60_000 + 7000)).toBe('5 min 7 s');
    expect(uptimeText(40_000)).toBe('40 s');
    expect(uptimeText(0)).toBe('0 s');
    expect(uptimeText(-5)).toBe('0 s');
  });
});

describe('the cluster page', () => {
  it('shows the totals, the nodes with their resources, the listeners and the settings', async () => {
    const { cluster } = setup();
    const state = await cluster.refresh();
    expect(state.kind).toBe('cluster');
    expect(state.cluster).toMatchObject({
      clusterName: 'rabbit@fake',
      version: '3.13.7',
      erlang: '26.2',
      node: 'rabbit@fake',
      queues: 2,
      exchanges: 3,
      connections: 1,
      channels: 1,
      consumers: 1,
      ready: 5,
      unacked: 2,
    });
    expect(state.cluster?.nodes).toHaveLength(1);
    expect(state.cluster?.nodes[0]).toMatchObject({
      name: 'rabbit@fake',
      type: 'disc',
      running: true,
      uptime: '1 min 30 s',
      memUsed: 170_000_000,
      memLimit: 400_000_000,
      memAlarm: false,
      fdUsed: 43,
      fdTotal: 1024,
      draining: false,
      partitions: [],
    });
    expect(state.cluster?.listeners).toEqual([
      { protocol: 'amqp', ip: '::', port: 5672, node: 'rabbit@fake' },
    ]);
    expect(state.cluster?.parameters).toEqual([{ key: 'cluster_name', value: 'rabbit@fake' }]);
    expect(state.facts.map((fact) => fact.key)).toContain('Erlang');
    expect(state.bindings).toEqual([]);
    expect(state.admin).toBeUndefined();
  });

  it('says a stopped node is stopped, with no uptime, and a split with the nodes it lost', async () => {
    const { session, cluster } = setup();
    session.broker.nodes[0] = {
      ...session.broker.nodes[0],
      running: false,
      partitions: ['rabbit@other'],
      mem_alarm: true,
      disk_free_alarm: true,
      being_drained: true,
    };
    const node = (await cluster.refresh()).cluster?.nodes[0];
    expect(node).toMatchObject({
      running: false,
      uptime: '',
      partitions: ['rabbit@other'],
      memAlarm: true,
      diskAlarm: true,
      draining: true,
    });
  });

  it('keeps the page when the settings are refused, and says why', async () => {
    const { session, cluster } = setup();
    session.listGlobalParameters = () => Promise.reject(new Error('not allowed'));
    const state = await cluster.refresh();
    expect(state.cluster?.parameters).toEqual([]);
    expect(state.cluster?.parametersError).toBe('not allowed');
    expect(state.cluster?.nodes).toHaveLength(1);
  });

  it('passes on a broker that cannot be read at all', async () => {
    const { session, cluster } = setup();
    session.readCluster = () => Promise.reject(new Error('no link'));
    await expect(cluster.refresh()).rejects.toThrow('no link');
  });

  it('has nothing to bind, publish, delete or limit', async () => {
    const { cluster } = setup();
    await expect(
      cluster.addBinding({ direction: 'toQueue', peer: 'x', routingKey: '', arguments: '' }),
    ).rejects.toMatchObject({ code: 'unsupported' });
    await expect(
      cluster.publish({ routingKey: 'k', payload: { text: 'x' }, persistent: true, headers: [] }),
    ).rejects.toMatchObject({ code: 'unsupported' });
    await expect(cluster.deleteObject()).rejects.toMatchObject({ code: 'unsupported' });
    await expect(cluster.setLimit('max-queues', 5)).rejects.toMatchObject({ code: 'unsupported' });
    await expect(cluster.peek(5)).rejects.toMatchObject({ code: 'unsupported' });
  });
});

describe('the limits of a virtual host', () => {
  it('shows none when none is set', async () => {
    const { vhost } = setup();
    expect((await vhost.refresh()).admin?.limits).toEqual({});
  });

  it('sets a limit, shows it, and lifts it', async () => {
    const { session, vhost } = setup();
    let state = await vhost.setLimit('max-queues', 50);
    expect(state.admin?.limits).toEqual({ maxQueues: 50 });
    state = await vhost.setLimit('max-connections', 0);
    expect(state.admin?.limits).toEqual({ maxConnections: 0, maxQueues: 50 });
    state = await vhost.setLimit('max-queues', undefined);
    expect(state.admin?.limits).toEqual({ maxConnections: 0 });
    expect(session.calls).toContain('setVhostLimit');
    expect(session.calls).toContain('clearVhostLimit');
  });

  it('refuses what is not a whole number from 0, and a limit it does not know', async () => {
    const { vhost } = setup();
    await expect(vhost.setLimit('max-queues', -1)).rejects.toMatchObject({ code: 'syntax' });
    await expect(vhost.setLimit('max-queues', 1.5)).rejects.toMatchObject({ code: 'syntax' });
    await expect(vhost.setLimit('max-queues', Number.NaN)).rejects.toMatchObject({
      code: 'syntax',
    });
    await expect(vhost.setLimit('max-everything' as 'max-queues', 5)).rejects.toMatchObject({
      code: 'syntax',
    });
  });

  it('hides only the limits when the broker refuses them', async () => {
    const { session, vhost } = setup();
    session.listVhostLimits = () => Promise.reject(new Error('no permission'));
    const state = await vhost.refresh();
    expect(state.admin?.limitsError).toBe('no permission');
    expect(state.admin?.connections).toBeDefined();
  });

  it('is refused on a read-only connection and on a page that is not a host', async () => {
    const { queue } = setup();
    await expect(queue.setLimit('max-queues', 5)).rejects.toMatchObject({ code: 'unsupported' });
    const readOnly = setup({ readOnly: true });
    await expect(readOnly.vhost.setLimit('max-queues', 5)).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });
});

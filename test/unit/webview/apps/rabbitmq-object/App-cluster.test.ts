// The RabbitMQ cluster page, the limits of a virtual host and the fields of a policy (V13.35).

import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import {
  rabbitObjectProtocol,
  type RabbitClusterView,
  type RabbitNodeView,
  type RabbitObjectProtocol,
  type RabbitObjectState,
} from '../../../../../src/shared/protocols/rabbitmq-object';
import { RpcPeer } from '../../../../../src/shared/rpc';
import App from '../../../../../webview/src/apps/rabbitmq-object/App.svelte';
import { createTranslator } from '../../../../../webview/src/lib/i18n';
import { must } from '../../../../helpers/must';
import { createLinkedTransports, flush } from '../../../../helpers/rpc';

type HostPeer = RpcPeer<RabbitObjectProtocol['host'], RabbitObjectProtocol['webview']>;

const node = (over: Partial<RabbitNodeView> = {}): RabbitNodeView => ({
  name: 'rabbit@a',
  type: 'disc',
  running: true,
  uptime: '3 d 4 h',
  memUsed: 200_000_000,
  memLimit: 400_000_000,
  memAlarm: false,
  diskFree: 100_000_000_000,
  diskFreeLimit: 50_000_000,
  diskAlarm: false,
  fdUsed: 43,
  fdTotal: 1024,
  socketsUsed: 2,
  socketsTotal: 800,
  procUsed: 400,
  procTotal: 1_000_000,
  processors: 4,
  partitions: [],
  draining: false,
  ...over,
});

const cluster = (over: Partial<RabbitClusterView> = {}): RabbitClusterView => ({
  clusterName: 'rabbit@a',
  version: '3.13.7',
  erlang: '26.2',
  node: 'rabbit@a',
  queues: 4,
  exchanges: 7,
  connections: 2,
  channels: 3,
  consumers: 1,
  ready: 5,
  unacked: 1,
  listeners: [
    { protocol: 'amqp', ip: '::', port: 5672, node: 'rabbit@a' },
    { protocol: 'http', ip: '127.0.0.1', port: 15672, node: 'rabbit@a' },
    { protocol: 'amqp', ip: '::1', port: 5671, node: 'rabbit@a' },
  ],
  nodes: [node()],
  parameters: [{ key: 'cluster_name', value: 'rabbit@a' }],
  ...over,
});

function clusterState(over: Partial<RabbitClusterView> = {}, readOnly = false): RabbitObjectState {
  return {
    kind: 'cluster',
    vhost: '',
    name: '',
    connectionName: 'Local MQ',
    readOnly,
    type: '',
    state: '',
    ready: 0,
    unacked: 0,
    total: 0,
    consumers: 0,
    facts: [{ key: 'Cluster', value: 'rabbit@a' }],
    arguments: [],
    bindings: [],
    bindingsCut: false,
    consumersList: [],
    count: 10,
    messages: [],
    peeked: false,
    cluster: cluster(over),
  };
}

function vhostState(
  admin: Partial<NonNullable<RabbitObjectState['admin']>> = {},
  readOnly = false,
): RabbitObjectState {
  return {
    ...clusterState({}, readOnly),
    kind: 'vhost',
    vhost: '/',
    name: '/',
    cluster: undefined,
    admin: {
      me: 'admin',
      connections: [],
      connectionsTotal: 0,
      users: [],
      policies: [
        {
          name: 'mixed',
          pattern: '^q\\.',
          applyTo: 'queues',
          priority: 1,
          definition:
            '{\n  "message-ttl": 5000,\n  "overflow": "reject-publish",\n  "queue-version": 2\n}',
        },
      ],
      limits: { maxQueues: 50 },
      ...admin,
    },
  };
}

interface Opened {
  host: HostPeer;
  requests: { method: string; params: unknown }[];
}

async function open(initial: RabbitObjectState, language: 'en' | 'ru' = 'en'): Promise<Opened> {
  const transports = createLinkedTransports();
  const host: HostPeer = new RpcPeer({
    local: rabbitObjectProtocol.host,
    remote: rabbitObjectProtocol.webview,
    transport: transports.host,
  });
  const rpc = new RpcPeer({
    local: rabbitObjectProtocol.webview,
    remote: rabbitObjectProtocol.host,
    transport: transports.webview,
  });
  const requests: Opened['requests'] = [];
  host.handle('refresh', (params) => {
    requests.push({ method: 'refresh', params });
    return {};
  });
  host.handle('setPolicy', (params) => {
    requests.push({ method: 'setPolicy', params });
    return { done: true };
  });
  host.handle('setLimit', (params) => {
    requests.push({ method: 'setLimit', params });
    return { done: true };
  });
  render(App, { props: { rpc, t: createTranslator(language) } });
  await flush();
  host.emit('state', initial);
  await waitFor(() => {
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeNull();
  });
  return { host, requests };
}

const sent = (opened: Opened, method: string): unknown[] =>
  opened.requests.filter((request) => request.method === method).map((request) => request.params);

describe('RabbitMQ page: the cluster', () => {
  it('names the cluster, and shows none of a queue', async () => {
    await open(clusterState());
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('rabbit@a');
    expect(screen.getByTestId('meta').textContent).toContain('Cluster');
    expect(screen.queryByTestId('counts')).toBeNull();
    expect(screen.queryByTestId('bindings')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Publish a message' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add a binding' })).toBeNull();
  });

  it('shows the totals of the broker', async () => {
    await open(clusterState());
    const totals = within(screen.getByTestId('cluster-totals'));
    const expected: [string, string][] = [
      ['Queues', '4'],
      ['Exchanges', '7'],
      ['Connections', '2'],
      ['Channels', '3'],
      ['Consumers', '1'],
    ];
    for (const [label, value] of expected) {
      expect(totals.getByText(label).parentElement?.textContent).toContain(value);
    }
  });

  it('draws a node with its meters filled to what it has used', async () => {
    await open(clusterState());
    const one = within(screen.getByTestId('node'));
    expect(one.getByText('rabbit@a')).toBeTruthy();
    expect(one.getByText('running')).toBeTruthy();
    expect(one.getByText('answering this page')).toBeTruthy();
    expect(one.getByText('up 3 d 4 h')).toBeTruthy();
    expect(one.getByText('4 cores')).toBeTruthy();
    const memory = within(screen.getByTestId('meter-memory')).getByRole('meter');
    expect(memory.getAttribute('aria-valuenow')).toBe('50');
    expect(memory.querySelector('.fill')?.className).toContain('ok');
    expect(
      within(screen.getByTestId('meter-fd')).getByRole('meter').getAttribute('aria-valuenow'),
    ).toBe('4');
    expect(screen.getByTestId('meter-disk').textContent).toContain('93 GB free');
  });

  it('warms a meter as it fills and reddens it at an alarm', async () => {
    await open(
      clusterState({
        nodes: [
          node({
            memUsed: 380_000_000,
            memAlarm: true,
            fdUsed: 800,
            diskAlarm: true,
            partitions: ['rabbit@b'],
            draining: true,
          }),
        ],
      }),
    );
    expect(
      within(screen.getByTestId('meter-memory')).getByRole('meter').querySelector('.fill')
        ?.className,
    ).toContain('bad');
    expect(
      within(screen.getByTestId('meter-fd')).getByRole('meter').querySelector('.fill')?.className,
    ).toContain('warn');
    expect(screen.getByTestId('mem-alarm')).toBeTruthy();
    expect(screen.getByTestId('disk-alarm')).toBeTruthy();
    expect(screen.getByTestId('partition').textContent).toContain('split from 1 node(s)');
    expect(screen.getByText('draining')).toBeTruthy();
  });

  it('shows a stopped node without meters, and the other nodes of the cluster', async () => {
    await open(
      clusterState({
        node: 'rabbit@a',
        nodes: [node(), node({ name: 'rabbit@b', running: false, uptime: '' })],
      }),
    );
    const nodes = screen.getAllByTestId('node');
    expect(nodes).toHaveLength(2);
    expect(within(must(nodes[1])).getByText('stopped')).toBeTruthy();
    expect(within(must(nodes[1])).queryByRole('meter')).toBeNull();
    expect(within(must(nodes[0])).queryByText('answering this page')).toBeTruthy();
    expect(within(must(nodes[1])).queryByText('answering this page')).toBeNull();
  });

  it('lists the listeners with addresses written as they are dialled', async () => {
    await open(clusterState());
    const listeners = within(screen.getByTestId('cluster-listeners'));
    expect(listeners.getByText('*:5672')).toBeTruthy();
    expect(listeners.getByText('127.0.0.1:15672')).toBeTruthy();
    expect(listeners.getByText('[::1]:5671')).toBeTruthy();
  });

  it('says so when there are no listeners or settings, and shows a refusal', async () => {
    await open(clusterState({ listeners: [], parameters: [] }));
    expect(screen.getByText('The broker reports no listeners')).toBeTruthy();
    expect(screen.getByText('No global parameters')).toBeTruthy();
  });

  it('shows why the settings could not be read, and keeps the nodes', async () => {
    await open(clusterState({ parametersError: 'Not allowed', parameters: [] }));
    expect(
      within(screen.getByTestId('cluster-parameters')).getByRole('alert').textContent,
    ).toContain('Not allowed');
    expect(screen.getAllByTestId('node')).toHaveLength(1);
  });

  it('asks the host to read the broker again', async () => {
    const opened = await open(clusterState());
    await fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => {
      expect(sent(opened, 'refresh')).toHaveLength(1);
    });
  });

  it('speaks Russian', async () => {
    await open(clusterState(), 'ru');
    expect(screen.getByText('Узлы')).toBeTruthy();
    expect(screen.getByText('Слушатели')).toBeTruthy();
    expect(screen.getByText('Глобальные параметры')).toBeTruthy();
    expect(screen.getByText('работает')).toBeTruthy();
  });
});

describe('RabbitMQ page: the limits of a virtual host', () => {
  it('shows the limit that is set and the one that is not', async () => {
    await open(vhostState());
    const queues = within(screen.getByTestId('limit-max-queues'));
    expect(queues.getByText('50')).toBeTruthy();
    const connections = within(screen.getByTestId('limit-max-connections'));
    expect(connections.getByText('no limit')).toBeTruthy();
    expect(connections.getByRole('button', { name: 'Lift' })).toHaveProperty('disabled', true);
  });

  it('sets a limit from the box', async () => {
    const opened = await open(vhostState());
    const row = within(screen.getByTestId('limit-max-connections'));
    await fireEvent.input(row.getByLabelText('max-connections'), { target: { value: ' 200 ' } });
    await fireEvent.click(row.getByRole('button', { name: 'Set' }));
    await waitFor(() => {
      expect(sent(opened, 'setLimit')).toEqual([{ limit: 'max-connections', value: 200 }]);
    });
  });

  it('lifts a limit', async () => {
    const opened = await open(vhostState());
    await fireEvent.click(
      within(screen.getByTestId('limit-max-queues')).getByRole('button', { name: 'Lift' }),
    );
    await waitFor(() => {
      expect(sent(opened, 'setLimit')).toEqual([{ limit: 'max-queues' }]);
    });
  });

  it('refuses something that is not a whole number without asking the host', async () => {
    const opened = await open(vhostState());
    const row = within(screen.getByTestId('limit-max-connections'));
    for (const value of ['', 'many', '-1', '1.5']) {
      await fireEvent.input(row.getByLabelText('max-connections'), { target: { value } });
      await fireEvent.click(row.getByRole('button', { name: 'Set' }));
      expect(screen.getByTestId('limit-problem').textContent).toContain('whole number');
    }
    expect(sent(opened, 'setLimit')).toEqual([]);
  });

  it('shows why the limits could not be read', async () => {
    await open(vhostState({ limits: undefined, limitsError: 'No permission' }));
    expect(within(screen.getByTestId('limits')).getByRole('alert').textContent).toContain(
      'No permission',
    );
  });

  it('offers no change on a read-only connection', async () => {
    await open(vhostState({}, true));
    const limits = within(screen.getByTestId('limits'));
    expect(limits.queryByRole('button', { name: 'Set' })).toBeNull();
    expect(limits.queryByRole('button', { name: 'Lift' })).toBeNull();
    expect(limits.getByText('50')).toBeTruthy();
  });
});

describe('RabbitMQ page: the fields of a policy', () => {
  const editMixed = async (): Promise<HTMLElement> => {
    await fireEvent.click(
      within(screen.getByTestId('policies')).getByRole('button', { name: 'Edit the policy' }),
    );
    return screen.getByTestId('policy-form');
  };

  it('puts the usual keys of a definition in fields and the rest in the box', async () => {
    await open(vhostState());
    const form = within(await editMixed());
    expect(form.getByTestId<HTMLInputElement>('field-message-ttl').value).toBe('5000');
    expect(form.getByTestId<HTMLSelectElement>('field-overflow').value).toBe('reject-publish');
    expect(form.getByLabelText<HTMLTextAreaElement>('Definition (JSON)').value).toBe(
      '{\n  "queue-version": 2\n}',
    );
  });

  it('puts the fields and the rest back together when it saves', async () => {
    const opened = await open(vhostState());
    const form = within(await editMixed());
    await fireEvent.input(form.getByTestId('field-max-length'), { target: { value: '1000' } });
    await fireEvent.input(form.getByTestId('field-dead-letter-exchange'), {
      target: { value: 'dlx' },
    });
    await fireEvent.input(form.getByTestId('field-message-ttl'), { target: { value: '' } });
    await fireEvent.click(form.getByRole('button', { name: 'Save the policy' }));
    await waitFor(() => {
      expect(sent(opened, 'setPolicy')).toHaveLength(1);
    });
    const params = sent(opened, 'setPolicy')[0] as { definition: string };
    expect(JSON.parse(params.definition)).toEqual({
      'queue-version': 2,
      overflow: 'reject-publish',
      'max-length': 1000,
      'dead-letter-exchange': 'dlx',
    });
  });

  it('makes a policy from empty fields', async () => {
    const opened = await open(vhostState());
    await fireEvent.click(
      within(screen.getByTestId('policies')).getByRole('button', { name: 'New policy' }),
    );
    const form = within(screen.getByTestId('policy-form'));
    expect(form.getByLabelText<HTMLInputElement>('Name').value).toBe('');
    expect(form.getByTestId<HTMLInputElement>('field-message-ttl').value).toBe('');
    await fireEvent.input(form.getByLabelText('Name'), { target: { value: 'short' } });
    await fireEvent.input(form.getByLabelText('Pattern'), { target: { value: '^tmp\\.' } });
    await fireEvent.input(form.getByTestId('field-message-ttl'), { target: { value: '60000' } });
    await fireEvent.change(form.getByTestId('field-overflow'), {
      target: { value: 'drop-head' },
    });
    await fireEvent.click(form.getByRole('button', { name: 'Save the policy' }));
    await waitFor(() => {
      expect(sent(opened, 'setPolicy')).toHaveLength(1);
    });
    const params = sent(opened, 'setPolicy')[0] as Record<string, unknown>;
    expect(params).toMatchObject({
      name: 'short',
      pattern: '^tmp\\.',
      applyTo: 'all',
      priority: 0,
    });
    expect(JSON.parse(params.definition as string)).toEqual({
      'message-ttl': 60000,
      overflow: 'drop-head',
    });
  });

  it('refuses a number that is not one, and a rest that is not an object, without asking the host', async () => {
    const opened = await open(vhostState());
    const form = within(await editMixed());
    await fireEvent.input(form.getByTestId('field-message-ttl'), { target: { value: '1.5s' } });
    await fireEvent.click(form.getByRole('button', { name: 'Save the policy' }));
    expect(screen.getByTestId('policy-problem').textContent).toContain('message-ttl');
    await fireEvent.input(form.getByTestId('field-message-ttl'), { target: { value: '9' } });
    await fireEvent.input(form.getByLabelText('Definition (JSON)'), { target: { value: '[1]' } });
    await fireEvent.click(form.getByRole('button', { name: 'Save the policy' }));
    expect(screen.getByTestId('policy-problem').textContent).toContain('JSON object');
    expect(sent(opened, 'setPolicy')).toEqual([]);
  });

  it('shows the keys that fit what the policy applies to, and any that already hold a value', async () => {
    await open(vhostState());
    const form = within(await editMixed());
    // "queues": the exchange key is hidden.
    expect(form.queryByTestId('field-alternate-exchange')).toBeNull();
    expect(form.getByTestId('field-delivery-limit')).toBeTruthy();
    await fireEvent.change(form.getByLabelText('Applies to'), { target: { value: 'exchanges' } });
    expect(form.getByTestId('field-alternate-exchange')).toBeTruthy();
    expect(form.queryByTestId('field-max-length')).toBeNull();
    // A queue key that is set stays in view even then.
    expect(form.getByTestId('field-message-ttl')).toBeTruthy();
    await fireEvent.change(form.getByLabelText('Applies to'), { target: { value: 'all' } });
    expect(form.getByTestId('field-alternate-exchange')).toBeTruthy();
    expect(form.getByTestId('field-max-length')).toBeTruthy();
  });

  it('names the fields in Russian', async () => {
    await open(vhostState(), 'ru');
    await fireEvent.click(
      within(screen.getByTestId('policies')).getByRole('button', { name: 'Изменить политику' }),
    );
    const form = within(screen.getByTestId('policy-form'));
    expect(form.getByText('Настройки')).toBeTruthy();
    expect(form.getByText('Прочие настройки (JSON)')).toBeTruthy();
  });
});

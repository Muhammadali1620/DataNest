import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import {
  rabbitObjectProtocol,
  type RabbitMessageView,
  type RabbitObjectProtocol,
  type RabbitObjectState,
  type RabbitSampleView,
} from '../../../../../src/shared/protocols/rabbitmq-object';
import { RpcPeer } from '../../../../../src/shared/rpc';
import App from '../../../../../webview/src/apps/rabbitmq-object/App.svelte';
import { createTranslator } from '../../../../../webview/src/lib/i18n';
import { must } from '../../../../helpers/must';
import { createLinkedTransports, flush } from '../../../../helpers/rpc';

type HostPeer = RpcPeer<RabbitObjectProtocol['host'], RabbitObjectProtocol['webview']>;

const message = (index: number, extra: Partial<RabbitMessageView> = {}): RabbitMessageView => ({
  payload: { text: `body-${index}` },
  payloadBytes: 6,
  redelivered: true,
  exchange: '',
  routingKey: 'orders',
  messagesLeft: 1,
  properties: '{\n  "content_type": "text/plain"\n}',
  ...extra,
});

function state(overrides: Partial<RabbitObjectState> = {}): RabbitObjectState {
  return {
    kind: 'queue',
    vhost: '/',
    name: 'orders',
    connectionName: 'Local MQ',
    readOnly: false,
    type: 'quorum',
    state: 'running',
    ready: 6,
    unacked: 2,
    total: 8,
    consumers: 3,
    facts: [
      { key: 'Type', value: 'quorum' },
      { key: 'Durable', value: 'yes' },
    ],
    arguments: [{ key: 'x-max-length', value: '100' }],
    bindings: [
      {
        source: 'events',
        destination: 'orders',
        destinationType: 'queue',
        routingKey: 'order.#',
        arguments: '',
      },
    ],
    bindingsCut: false,
    consumersList: [],
    count: 10,
    messages: [],
    peeked: false,
    ...overrides,
  };
}

interface Opened {
  host: HostPeer;
  requests: { method: string; params: unknown }[];
}

async function open(
  initial: RabbitObjectState,
  language: 'en' | 'ru' = 'en',
  answers: Record<string, unknown> = {},
): Promise<Opened> {
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
  const reply = (method: string, fallback: unknown) => (params: unknown) => {
    requests.push({ method, params });
    const answer = answers[method];
    if (answer instanceof Error) {
      throw answer;
    }
    return (answer ?? fallback) as never;
  };
  host.handle('refresh', reply('refresh', {}));
  host.handle('peek', reply('peek', {}));
  host.handle('publish', reply('publish', { published: true, routed: true }));
  host.handle('purge', reply('purge', { purged: true }));
  host.handle('deleteObject', reply('deleteObject', { deleted: true }));
  host.handle('copyText', reply('copyText', {}));
  host.handle('setLive', reply('setLive', {}));
  for (const method of [
    'addBinding',
    'removeBinding',
    'closeConnection',
    'createUser',
    'updateUser',
    'deleteUser',
    'setPermission',
    'clearPermission',
    'setPolicy',
    'deletePolicy',
  ] as const) {
    host.handle(method, reply(method, { done: true }));
  }
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

describe('RabbitMQ page: a queue', () => {
  it('waits for the host, then shows the queue', () => {
    const transports = createLinkedTransports();
    const rpc = new RpcPeer({
      local: rabbitObjectProtocol.webview,
      remote: rabbitObjectProtocol.host,
      transport: transports.webview,
    });
    render(App, { props: { rpc, t: createTranslator('en') } });
    expect(screen.getByText('Loading…')).toBeTruthy();
    expect(transports.webview.posted.length).toBeGreaterThan(0);
  });

  it('names the queue, its type, state, virtual host and connection', async () => {
    await open(state());
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('orders');
    const meta = screen.getByTestId('meta').textContent;
    expect(meta).toContain('Queue');
    expect(meta).toContain('quorum');
    expect(meta).toContain('/');
    expect(meta).toContain('Local MQ');
    expect(screen.getByTestId('state').textContent).toBe('running');
    expect(screen.getByTestId('state').className).toContain('success');
  });

  it('shows the four figures and the facts, arguments and bindings', async () => {
    await open(state());
    const counts = screen.getByTestId('counts').textContent;
    for (const word of ['Ready', 'Unacknowledged', 'Total', 'Consumers']) {
      expect(counts).toContain(word);
    }
    expect(within(screen.getByTestId('counts')).getByText('6')).toBeTruthy();
    expect(within(screen.getByTestId('counts')).getByText('8')).toBeTruthy();
    expect(screen.getByTestId('facts').textContent).toContain('quorum');
    expect(screen.getByTestId('arguments').textContent).toContain('x-max-length');
    const bindings = screen.getByTestId('bindings').textContent;
    expect(bindings).toContain('events');
    expect(bindings).toContain('order.#');
  });

  it('says so when there are no arguments or bindings, or more bindings than listed', async () => {
    await open(state({ arguments: [], bindings: [] }));
    expect(screen.getByText('No arguments')).toBeTruthy();
    expect(screen.getByTestId('no-bindings').textContent).toBe('No bindings');
  });

  it('warns when the binding list was cut', async () => {
    await open(state({ bindingsCut: true }));
    expect(screen.getByText(/more bindings than are listed/u)).toBeTruthy();
  });

  it('shows the default exchange of a binding by its own name', async () => {
    await open(
      state({
        bindings: [
          {
            source: '',
            destination: 'orders',
            destinationType: 'queue',
            routingKey: '',
            arguments: '{"x":1}',
          },
        ],
      }),
    );
    const bindings = screen.getByTestId('bindings').textContent;
    expect(bindings).toContain('(AMQP default)');
    expect(bindings).toContain('{"x":1}');
  });

  it('colours a queue that is down', async () => {
    await open(state({ state: 'down' }));
    expect(screen.getByTestId('state').className).toContain('error');
  });

  it('speaks Russian', async () => {
    await open(state(), 'ru');
    expect(screen.getByTestId('counts').textContent).toContain('Готовы');
    expect(screen.getByText('Привязки')).toBeTruthy();
  });
});

describe('RabbitMQ page: peeking', () => {
  it('asks the host to look at the number of messages typed, and says that nothing is taken', async () => {
    const opened = await open(state());
    expect(screen.getByText(/put back at once/u)).toBeTruthy();
    const count = within(screen.getByTestId('peeker')).getByLabelText<HTMLInputElement>('Count');
    await fireEvent.input(count, { target: { value: '3' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Look at the first messages' }));
    await waitFor(() => {
      expect(sent(opened, 'peek')).toEqual([{ count: 3 }]);
    });
  });

  it('lists the messages that came back, marking the redelivered ones', async () => {
    await open(state({ peeked: true, messages: [message(1), message(2, { redelivered: false })] }));
    const table = screen.getByTestId('messages');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('body-1');
    expect(rows[0]?.textContent).toContain('redelivered');
    expect(rows[1]?.textContent).not.toContain('redelivered');
    expect(rows[0]?.textContent).toContain('6 bytes');
  });

  it('shows the payload, the exchange and the properties of the message clicked', async () => {
    await open(state({ peeked: true, messages: [message(1), message(2)] }));
    const rows = within(screen.getByTestId('messages')).getAllByRole('row').slice(1);
    await fireEvent.click(must(rows[1]));
    const detail = await screen.findByTestId('detail');
    expect(detail.textContent).toContain('Message 2');
    expect(detail.textContent).toContain('(AMQP default)');
    expect(screen.getByTestId('properties').textContent).toContain('content_type');
  });

  it('shows a notice and no table when the queue was empty', async () => {
    await open(state({ peeked: true, messages: [], notice: 'The queue holds no messages' }));
    expect(screen.getByTestId('notice').textContent).toContain('The queue holds no messages');
    expect(screen.queryByTestId('messages')).toBeNull();
  });

  it('shows no peek section before anything was peeked', async () => {
    await open(state());
    expect(screen.queryByTestId('messages')).toBeNull();
    expect(screen.queryByTestId('notice')).toBeNull();
  });

  it('shows the error of a failed peek and carries on', async () => {
    const opened = await open(state(), 'en', { peek: new Error('not-found: gone') });
    await fireEvent.click(screen.getByRole('button', { name: 'Look at the first messages' }));
    expect((await screen.findByTestId('error')).textContent).toContain('gone');
    expect(sent(opened, 'peek')).toHaveLength(1);
  });
});

describe('RabbitMQ page: publishing', () => {
  it('sends a message to the queue with the content type, persistence and headers', async () => {
    const opened = await open(state());
    expect(screen.queryByTestId('publish')).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Publish a message' }));
    const form = await screen.findByTestId('publish');
    expect(form.textContent).toContain('default exchange to this queue');
    expect(within(form).queryByLabelText('Routing key')).toBeNull();
    await fireEvent.input(within(form).getByLabelText('Content type'), {
      target: { value: 'text/plain' },
    });
    await fireEvent.input(within(form).getByLabelText('Headers'), {
      target: { value: 'trace-id: 42' },
    });
    const editor = within(form).getByRole('textbox', { name: 'Payload' });
    await fireEvent.input(editor, { target: { value: 'hello' } });
    await fireEvent.click(within(form).getByRole('button', { name: 'Publish' }));
    await waitFor(() => {
      expect(sent(opened, 'publish')).toHaveLength(1);
    });
    expect(sent(opened, 'publish')[0]).toMatchObject({
      routingKey: '',
      contentType: 'text/plain',
      persistent: true,
      payload: { text: 'hello' },
      headers: [{ name: 'trace-id', value: '42' }],
    });
  });

  it('asks for the routing key on an exchange', async () => {
    const opened = await open(state({ kind: 'exchange', name: 'events', type: 'topic' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Publish a message' }));
    const form = await screen.findByTestId('publish');
    await fireEvent.input(within(form).getByLabelText('Routing key'), {
      target: { value: 'order.created' },
    });
    await fireEvent.click(within(form).getByRole('button', { name: 'Publish' }));
    await waitFor(() => {
      expect(sent(opened, 'publish')).toHaveLength(1);
    });
    expect(sent(opened, 'publish')[0]).toMatchObject({ routingKey: 'order.created' });
  });

  it('offers no way to publish, purge or delete on a read-only connection', async () => {
    await open(state({ readOnly: true }));
    expect(screen.queryByRole('button', { name: 'Publish a message' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove all messages' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete the queue' })).toBeNull();
    expect(screen.getByTestId('meta').textContent).toContain('read-only');
  });
});

describe('RabbitMQ page: the toolbar', () => {
  it('copies the name, refreshes, purges and deletes through the host', async () => {
    const opened = await open(state());
    // The page runs one request at a time, so each click waits for the answer to the one before.
    const press = async (name: string, method: string, total: number): Promise<void> => {
      await fireEvent.click(screen.getByRole('button', { name }));
      await waitFor(() => {
        expect(sent(opened, method)).toHaveLength(total);
      });
      await flush();
    };
    await press('Copy the name', 'copyText', 1);
    await press('Refresh', 'refresh', 1);
    await press('Remove all messages', 'purge', 1);
    await press('Delete the queue', 'deleteObject', 1);
    expect(sent(opened, 'copyText')).toEqual([{ text: 'orders' }]);
  });

  it('has no purge on an exchange, and no delete for the broker’s own', async () => {
    await open(state({ kind: 'exchange', name: 'amq.topic', type: 'topic' }));
    expect(screen.queryByRole('button', { name: 'Remove all messages' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete the exchange' })).toBeNull();
    expect(screen.queryByTestId('counts')).toBeNull();
    expect(screen.queryByTestId('peeker')).toBeNull();
  });

  it('names the default exchange and cannot copy or delete it', async () => {
    await open(state({ kind: 'exchange', name: '', type: 'direct' }));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('(AMQP default)');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Copy the name' }).disabled).toBe(
      true,
    );
    expect(screen.queryByRole('button', { name: 'Delete the exchange' })).toBeNull();
  });

  it('deletes an exchange of the user’s', async () => {
    const opened = await open(state({ kind: 'exchange', name: 'events', type: 'topic' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Delete the exchange' }));
    await waitFor(() => {
      expect(sent(opened, 'deleteObject')).toHaveLength(1);
    });
  });

  it('follows the states the host pushes', async () => {
    const { host } = await open(state());
    host.emit('state', state({ ready: 99, total: 101 }));
    await waitFor(() => {
      expect(within(screen.getByTestId('counts')).getByText('99')).toBeTruthy();
    });
  });
});

const consumer = {
  tag: 'amq.ctag-1',
  connection: '10.0.0.5:4000 -> 10.0.0.1:5672',
  channel: '10.0.0.5:4000 -> 10.0.0.1:5672 (1)',
  user: 'app',
  prefetch: 20,
  ackRequired: true,
  exclusive: false,
  active: true,
};

describe('RabbitMQ page: consumers and bindings', () => {
  it('lists who consumes the queue', async () => {
    await open(
      state({
        consumersList: [
          consumer,
          {
            ...consumer,
            tag: 'tag-2',
            prefetch: 0,
            ackRequired: false,
            active: false,
            exclusive: true,
          },
        ],
      }),
    );
    const table = within(screen.getByTestId('consumers'));
    expect(table.getByText('amq.ctag-1')).toBeTruthy();
    expect(table.getByText('20')).toBeTruthy();
    expect(table.getByText('∞')).toBeTruthy();
    expect(table.getByText('exclusive')).toBeTruthy();
    expect(table.getByText('waiting')).toBeTruthy();
  });

  it('says so when nobody consumes the queue, and has no consumers on an exchange', async () => {
    await open(state());
    expect(
      within(screen.getByTestId('consumers')).getByText('Nobody consumes this queue'),
    ).toBeTruthy();
  });

  it('has no consumers section on an exchange', async () => {
    await open(state({ kind: 'exchange', name: 'events', type: 'topic' }));
    expect(screen.queryByTestId('consumers')).toBeNull();
  });

  it('removes a binding by its place in the list', async () => {
    const opened = await open(state());
    await fireEvent.click(screen.getByRole('button', { name: 'Remove the binding' }));
    await waitFor(() => {
      expect(sent(opened, 'removeBinding')).toEqual([{ index: 0 }]);
    });
  });

  it('offers no way to remove the binding of the default exchange', async () => {
    await open(
      state({
        bindings: [
          {
            source: '',
            destination: 'orders',
            destinationType: 'queue',
            routingKey: 'orders',
            arguments: '',
          },
        ],
      }),
    );
    expect(screen.queryByRole('button', { name: 'Remove the binding' })).toBeNull();
  });

  it('binds a queue to an exchange with a key and arguments, then empties the form', async () => {
    const opened = await open(state());
    await fireEvent.click(screen.getByRole('button', { name: 'Add a binding' }));
    const form = within(screen.getByTestId('bind'));
    // A queue only receives, so there is no choice of direction.
    expect(form.queryByLabelText('Direction')).toBeNull();
    await fireEvent.input(form.getByLabelText('The other end of the binding'), {
      target: { value: 'amq.topic' },
    });
    await fireEvent.input(form.getByLabelText('Routing key'), { target: { value: 'order.#' } });
    await fireEvent.input(form.getByLabelText('Arguments'), { target: { value: '{"a": 1}' } });
    await fireEvent.click(form.getByRole('button', { name: 'Bind' }));
    await waitFor(() => {
      expect(sent(opened, 'addBinding')).toEqual([
        {
          direction: 'fromExchange',
          peer: 'amq.topic',
          routingKey: 'order.#',
          arguments: '{"a": 1}',
        },
      ]);
    });
    await waitFor(() => {
      expect(form.getByLabelText<HTMLInputElement>('Routing key').value).toBe('');
    });
  });

  it('lets an exchange choose the direction of a binding', async () => {
    const opened = await open(state({ kind: 'exchange', name: 'events', type: 'topic' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Add a binding' }));
    const form = within(screen.getByTestId('bind'));
    await fireEvent.change(form.getByLabelText('Direction'), { target: { value: 'toQueue' } });
    await fireEvent.input(form.getByLabelText('The other end of the binding'), {
      target: { value: 'orders' },
    });
    await fireEvent.click(form.getByRole('button', { name: 'Bind' }));
    await waitFor(() => {
      expect(sent(opened, 'addBinding')).toEqual([
        { direction: 'toQueue', peer: 'orders', routingKey: '', arguments: '' },
      ]);
    });
  });

  it('shows the error of a refused binding and keeps the form', async () => {
    await open(state(), 'en', { addBinding: new Error('The default exchange cannot be bound') });
    await fireEvent.click(screen.getByRole('button', { name: 'Add a binding' }));
    const form = within(screen.getByTestId('bind'));
    await fireEvent.input(form.getByLabelText('The other end of the binding'), {
      target: { value: 'x' },
    });
    await fireEvent.click(form.getByRole('button', { name: 'Bind' }));
    await waitFor(() => {
      expect(screen.getByTestId('error').textContent).toContain('cannot be bound');
    });
    expect(form.getByLabelText<HTMLInputElement>('The other end of the binding').value).toBe('x');
  });

  it('hides the binding forms on a read-only connection and on the default exchange', async () => {
    await open(state({ readOnly: true }));
    expect(screen.queryByRole('button', { name: 'Add a binding' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove the binding' })).toBeNull();
  });

  it('does not offer to bind the default exchange', async () => {
    await open(state({ kind: 'exchange', name: '', type: 'direct' }));
    expect(screen.queryByRole('button', { name: 'Add a binding' })).toBeNull();
  });
});

function vhostState(
  over: Partial<NonNullable<RabbitObjectState['admin']>> = {},
): RabbitObjectState {
  return state({
    kind: 'vhost',
    name: '/',
    type: '',
    state: '',
    ready: 0,
    unacked: 0,
    total: 0,
    consumers: 0,
    arguments: [],
    bindings: [],
    facts: [{ key: 'Virtual host', value: '/' }],
    admin: {
      me: 'admin',
      connections: [
        {
          name: '10.0.0.5:4000 -> 10.0.0.1:5672',
          user: 'app',
          state: 'running',
          protocol: 'AMQP 0-9-1',
          peer: '10.0.0.5:4000',
          channels: 3,
          connectedAt: '2026-11-02 10:15:00 UTC',
          clientName: 'billing',
          product: 'pika',
          received: '1 KB',
          sent: '2 KB',
        },
      ],
      connectionsTotal: 1,
      users: [
        {
          name: 'admin',
          tags: ['administrator'],
          permission: { configure: '.*', write: '.*', read: '.*' },
        },
        { name: 'app', tags: [], permission: { configure: '', write: '^q\\.', read: '^q\\.' } },
        { name: 'idle', tags: ['monitoring'] },
      ],
      policies: [
        {
          name: 'ttl',
          pattern: '^tmp\\.',
          applyTo: 'queues',
          priority: 2,
          definition: '{\n  "message-ttl": 60000\n}',
        },
      ],
      ...over,
    },
  });
}

describe('RabbitMQ page: a virtual host', () => {
  it('shows connections, users and policies, and nothing of a queue', async () => {
    await open(vhostState());
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('/');
    expect(screen.queryByTestId('counts')).toBeNull();
    expect(screen.queryByTestId('peeker')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Publish a message' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete the queue' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete the exchange' })).toBeNull();
    expect(screen.queryByTestId('bindings')).toBeNull();
    const connections = within(screen.getByTestId('connections'));
    expect(connections.getByText('billing')).toBeTruthy();
    expect(connections.getByText('pika')).toBeTruthy();
    expect(connections.getByText('↓ 1 KB · ↑ 2 KB')).toBeTruthy();
    const users = within(screen.getByTestId('users'));
    expect(users.getByText('you')).toBeTruthy();
    expect(users.getByText('no access to this virtual host')).toBeTruthy();
    expect(users.getByText('administrator')).toBeTruthy();
    const policies = within(screen.getByTestId('policies'));
    expect(policies.getByText('ttl')).toBeTruthy();
    expect(policies.getByText('queues')).toBeTruthy();
  });

  it('closes a connection by its name', async () => {
    const opened = await open(vhostState());
    await fireEvent.click(screen.getByRole('button', { name: 'Close the connection' }));
    await waitFor(() => {
      expect(sent(opened, 'closeConnection')).toEqual([{ name: '10.0.0.5:4000 -> 10.0.0.1:5672' }]);
    });
  });

  it('says how many connections are not shown', async () => {
    await open(vhostState({ connectionsTotal: 700 }));
    expect(screen.getByText('… and 699 more that are not shown')).toBeTruthy();
  });

  it('says there are no connections and no policies', async () => {
    await open(vhostState({ connections: [], connectionsTotal: 0, policies: [] }));
    expect(screen.getByText('No client is connected to this virtual host')).toBeTruthy();
    expect(screen.getByText('No policies in this virtual host')).toBeTruthy();
  });

  it('shows the error of a part the user may not read, and the others still show', async () => {
    await open(
      vhostState({
        users: [],
        usersError: 'This needs the administrator tag',
        connectionsError: 'refused',
      }),
    );
    expect(within(screen.getByTestId('users')).getByRole('alert').textContent).toContain(
      'administrator tag',
    );
    expect(within(screen.getByTestId('connections')).getByRole('alert').textContent).toContain(
      'refused',
    );
    expect(screen.queryByRole('button', { name: 'New user' })).toBeNull();
    expect(within(screen.getByTestId('policies')).getByText('ttl')).toBeTruthy();
  });

  it('gives a user access with three patterns', async () => {
    const opened = await open(vhostState());
    const buttons = within(screen.getByTestId('users')).getAllByRole('button', {
      name: 'Set access',
    });
    // The row of "app" is the second one.
    await fireEvent.click(must(buttons[1]));
    const form = within(screen.getByTestId('grant'));
    expect(form.getByLabelText<HTMLInputElement>('Write').value).toBe('^q\\.');
    await fireEvent.input(form.getByLabelText('Configure'), { target: { value: '^c' } });
    await fireEvent.click(form.getByRole('button', { name: 'Save access' }));
    await waitFor(() => {
      expect(sent(opened, 'setPermission')).toEqual([
        { user: 'app', configure: '^c', write: '^q\\.', read: '^q\\.' },
      ]);
    });
    await waitFor(() => {
      expect(screen.queryByTestId('grant')).toBeNull();
    });
  });

  it('starts a user without access from open patterns', async () => {
    await open(vhostState());
    const buttons = within(screen.getByTestId('users')).getAllByRole('button', {
      name: 'Set access',
    });
    await fireEvent.click(must(buttons[2]));
    const form = within(screen.getByTestId('grant'));
    expect(form.getByLabelText<HTMLInputElement>('Configure').value).toBe('.*');
  });

  it('takes access away only from a user who has some', async () => {
    const opened = await open(vhostState());
    const clear = within(screen.getByTestId('users')).getAllByRole('button', {
      name: 'Take away access',
    });
    expect(clear).toHaveLength(2);
    await fireEvent.click(must(clear[1]));
    await waitFor(() => {
      expect(sent(opened, 'clearPermission')).toEqual([{ user: 'app' }]);
    });
  });

  it('will not delete the user it is signed in as', async () => {
    const opened = await open(vhostState());
    const deletes = within(screen.getByTestId('users')).getAllByRole<HTMLButtonElement>('button', {
      name: 'Delete the user',
    });
    expect(deletes[0]?.disabled).toBe(true);
    await fireEvent.click(must(deletes[1]));
    await waitFor(() => {
      expect(sent(opened, 'deleteUser')).toEqual([{ name: 'app' }]);
    });
  });

  it('creates a user with tags split by commas and spaces', async () => {
    const opened = await open(vhostState());
    await fireEvent.click(screen.getByRole('button', { name: 'New user' }));
    const form = within(screen.getByTestId('new-user'));
    await fireEvent.input(form.getByLabelText('Name'), { target: { value: 'ann' } });
    await fireEvent.input(form.getByLabelText('Password'), { target: { value: 'pw' } });
    await fireEvent.input(form.getByLabelText('Tags'), {
      target: { value: 'management, policymaker  monitoring' },
    });
    await fireEvent.click(form.getByRole('button', { name: 'Create' }));
    await waitFor(() => {
      expect(sent(opened, 'createUser')).toEqual([
        { name: 'ann', password: 'pw', tags: ['management', 'policymaker', 'monitoring'] },
      ]);
    });
    await waitFor(() => {
      expect(screen.queryByTestId('new-user')).toBeNull();
    });
  });

  it('saves a policy from the form, and fills the form to edit one', async () => {
    const opened = await open(vhostState());
    await fireEvent.click(
      within(screen.getByTestId('policies')).getByRole('button', { name: 'Edit the policy' }),
    );
    const form = within(screen.getByTestId('policy-form'));
    expect(form.getByLabelText<HTMLInputElement>('Name').value).toBe('ttl');
    expect(form.getByLabelText<HTMLInputElement>('Pattern').value).toBe('^tmp\\.');
    await fireEvent.input(form.getByLabelText('Priority'), { target: { value: '7' } });
    await fireEvent.click(form.getByRole('button', { name: 'Save the policy' }));
    await waitFor(() => {
      expect(sent(opened, 'setPolicy')).toEqual([
        {
          name: 'ttl',
          pattern: '^tmp\\.',
          applyTo: 'queues',
          priority: 7,
          definition: '{\n  "message-ttl": 60000\n}',
        },
      ]);
    });
  });

  it('deletes a policy', async () => {
    const opened = await open(vhostState());
    await fireEvent.click(
      within(screen.getByTestId('policies')).getByRole('button', { name: 'Delete the policy' }),
    );
    await waitFor(() => {
      expect(sent(opened, 'deletePolicy')).toEqual([{ name: 'ttl' }]);
    });
  });

  it('is read-only on a read-only connection', async () => {
    await open({ ...vhostState(), readOnly: true });
    for (const name of [
      'Close the connection',
      'New user',
      'Set access',
      'Take away access',
      'Delete the user',
      'New policy',
      'Edit the policy',
      'Delete the policy',
    ]) {
      expect(screen.queryByRole('button', { name }), name).toBeNull();
    }
  });

  it('speaks Russian', async () => {
    await open(vhostState(), 'ru');
    expect(within(screen.getByTestId('users')).getByText('Пользователи и права')).toBeTruthy();
    expect(within(screen.getByTestId('policies')).getByText('Политики')).toBeTruthy();
  });
});

describe('RabbitMQ page: changing a user (V13.32)', () => {
  const editButtons = (): HTMLElement[] =>
    within(screen.getByTestId('users')).getAllByRole('button', {
      name: 'Change password or tags',
    });

  it('opens a form with the tags of the user and no password', async () => {
    await open(vhostState());
    await fireEvent.click(must(editButtons()[2]));
    const form = within(screen.getByTestId('edit-user'));
    expect(form.getByLabelText<HTMLInputElement>('Tags').value).toBe('monitoring');
    expect(form.getByLabelText<HTMLInputElement>('New password').value).toBe('');
    expect(screen.getByText('Change the user idle')).toBeTruthy();
  });

  it('sends only the password when the tags are as they were', async () => {
    const opened = await open(vhostState());
    await fireEvent.click(must(editButtons()[2]));
    const form = within(screen.getByTestId('edit-user'));
    await fireEvent.input(form.getByLabelText('New password'), { target: { value: 'fresh' } });
    await fireEvent.click(form.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(sent(opened, 'updateUser')).toEqual([{ name: 'idle', password: 'fresh' }]);
    });
    await waitFor(() => {
      expect(screen.queryByTestId('edit-user')).toBeNull();
    });
  });

  it('sends only the tags when no password is typed, and can empty them', async () => {
    const opened = await open(vhostState());
    await fireEvent.click(must(editButtons()[2]));
    const form = within(screen.getByTestId('edit-user'));
    await fireEvent.input(form.getByLabelText('Tags'), {
      target: { value: 'management, policymaker' },
    });
    await fireEvent.click(form.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(sent(opened, 'updateUser')).toEqual([
        { name: 'idle', tags: ['management', 'policymaker'] },
      ]);
    });
    await fireEvent.click(must(editButtons()[2]));
    await fireEvent.input(within(screen.getByTestId('edit-user')).getByLabelText('Tags'), {
      target: { value: '' },
    });
    await fireEvent.click(
      within(screen.getByTestId('edit-user')).getByRole('button', { name: 'Save' }),
    );
    await waitFor(() => {
      expect(sent(opened, 'updateUser')).toContainEqual({ name: 'idle', tags: [] });
    });
  });

  it('closes on Cancel and keeps the form when the broker refuses', async () => {
    const opened = await open(vhostState(), 'en', {
      updateUser: new Error('refused by the broker'),
    });
    await fireEvent.click(must(editButtons()[0]));
    await fireEvent.input(within(screen.getByTestId('edit-user')).getByLabelText('New password'), {
      target: { value: 'x' },
    });
    await fireEvent.click(
      within(screen.getByTestId('edit-user')).getByRole('button', { name: 'Save' }),
    );
    await waitFor(() => {
      expect(screen.getByTestId('error').textContent).toContain('refused by the broker');
    });
    expect(sent(opened, 'updateUser')).toHaveLength(1);
    expect(screen.queryByTestId('edit-user')).not.toBeNull();
    await fireEvent.click(
      within(screen.getByTestId('edit-user')).getByRole('button', { name: 'Cancel' }),
    );
    expect(screen.queryByTestId('edit-user')).toBeNull();
  });

  it('offers no way to change a user on a read-only connection', async () => {
    await open({ ...vhostState(), readOnly: true });
    expect(
      within(screen.getByTestId('users')).queryAllByRole('button', {
        name: 'Change password or tags',
      }),
    ).toEqual([]);
  });

  it('speaks Russian', async () => {
    await open(vhostState(), 'ru');
    expect(
      within(screen.getByTestId('users')).getAllByRole('button', {
        name: 'Сменить пароль или метки',
      }),
    ).toHaveLength(3);
  });
});

describe('RabbitMQ page: live graphs (V13.32)', () => {
  const sample = (index: number, over: Partial<RabbitSampleView> = {}): RabbitSampleView => ({
    at: Date.parse('2026-11-02T10:00:00Z') + index * 4000,
    ready: 10 + index,
    unacked: index,
    publish: 2.5,
    deliver: 2,
    ack: 1.5,
    ...over,
  });

  it('shows a hint and a Start button before anything is read', async () => {
    await open(state());
    const live = within(screen.getByTestId('live'));
    expect(live.getByRole('button', { name: 'Start' }).getAttribute('aria-pressed')).toBe('false');
    expect(live.getByText(/Start to read the queue every few seconds/u)).toBeTruthy();
    expect(live.queryAllByTestId('chart')).toEqual([]);
  });

  it('asks the host to start, then draws two graphs of what comes back', async () => {
    const opened = await open(state());
    await fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => {
      expect(sent(opened, 'setLive')).toEqual([{ on: true }]);
    });
    opened.host.emit(
      'state',
      state({ live: { on: true, samples: [sample(0), sample(1), sample(2)] } }),
    );
    await waitFor(() => {
      expect(screen.getAllByTestId('chart')).toHaveLength(2);
    });
    const live = within(screen.getByTestId('live'));
    expect(live.getByRole('button', { name: 'Stop' }).getAttribute('aria-pressed')).toBe('true');
    expect(live.getAllByText('Messages in the queue').length).toBeGreaterThan(0);
    expect(live.getAllByText('Messages per second').length).toBeGreaterThan(0);
    for (const name of ['Ready', 'Unacknowledged', 'Published', 'Delivered', 'Acknowledged']) {
      expect(live.getAllByText(name).length).toBeGreaterThan(0);
    }
    expect(live.getByText(/Reading the queue every few seconds/u)).toBeTruthy();
  });

  it('asks the host to stop, and keeps the graphs of what was read', async () => {
    const opened = await open(state({ live: { on: true, samples: [sample(0), sample(1)] } }));
    await fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => {
      expect(sent(opened, 'setLive')).toEqual([{ on: false }]);
    });
    opened.host.emit('state', state({ live: { on: false, samples: [sample(0), sample(1)] } }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Start' })).toBeTruthy();
    });
    expect(screen.getAllByTestId('chart')).toHaveLength(2);
    expect(screen.getByText(/Stopped\. What was read stays here/u)).toBeTruthy();
  });

  it('shows the error when the host cannot start', async () => {
    await open(state(), 'en', { setLive: new Error('no statistics') });
    await fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => {
      expect(screen.getByTestId('error').textContent).toContain('no statistics');
    });
  });

  it('has no graphs on an exchange', async () => {
    await open(state({ kind: 'exchange', name: 'events' }));
    expect(screen.queryByTestId('live')).toBeNull();
  });

  it('speaks Russian', async () => {
    await open(state({ live: { on: true, samples: [sample(0)] } }), 'ru');
    const live = within(screen.getByTestId('live'));
    expect(live.getByText('Графики в реальном времени')).toBeTruthy();
    expect(live.getByRole('button', { name: 'Остановить' })).toBeTruthy();
    expect(live.getAllByText('Сообщений в секунду').length).toBeGreaterThan(0);
  });
});

describe('RabbitMQ page: the look (V13.37)', () => {
  it('opens with the mark of RabbitMQ on a tile', async () => {
    await open(state());
    expect(
      document.querySelector('.top-icon.tile.plain [data-driver="rabbitmq"] svg'),
    ).not.toBeNull();
  });
});

import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import {
  rabbitObjectProtocol,
  type RabbitMessageView,
  type RabbitObjectProtocol,
  type RabbitObjectState,
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

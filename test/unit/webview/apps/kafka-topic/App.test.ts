import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import {
  kafkaTopicProtocol,
  type KafkaMessageView,
  type KafkaTopicProtocol,
  type KafkaTopicState,
} from '../../../../../src/shared/protocols/kafka-topic';
import { RpcPeer } from '../../../../../src/shared/rpc';
import App from '../../../../../webview/src/apps/kafka-topic/App.svelte';
import { createTranslator } from '../../../../../webview/src/lib/i18n';
import { must } from '../../../../helpers/must';
import { createLinkedTransports, flush } from '../../../../helpers/rpc';

type HostPeer = RpcPeer<KafkaTopicProtocol['host'], KafkaTopicProtocol['webview']>;

const message = (offset: string, extra: Partial<KafkaMessageView> = {}): KafkaMessageView => ({
  partition: 1,
  offset,
  timestamp: '1700000000000',
  key: { text: `key-${offset}` },
  value: { text: `value-${offset}` },
  headers: [],
  ...extra,
});

function state(overrides: Partial<KafkaTopicState> = {}): KafkaTopicState {
  return {
    topic: 'orders',
    internal: false,
    connectionName: 'Local Kafka',
    readOnly: false,
    partitions: [
      { partition: 0, low: '0', high: '0', leader: 1, replicas: 1, inSync: 1 },
      { partition: 1, low: '0', high: '8', leader: 1, replicas: 2, inSync: 1 },
      { partition: 2, low: '4', high: '6', leader: -1, replicas: 1, inSync: 1 },
    ],
    partition: 1,
    mode: 'last',
    count: 50,
    messages: [],
    read: false,
    ...overrides,
  };
}

interface Opened {
  host: HostPeer;
  requests: { method: string; params: unknown }[];
}

async function open(
  initial: KafkaTopicState,
  language: 'en' | 'ru' = 'en',
  answers: Record<string, unknown> = {},
): Promise<Opened> {
  const transports = createLinkedTransports();
  const host: HostPeer = new RpcPeer({
    local: kafkaTopicProtocol.host,
    remote: kafkaTopicProtocol.webview,
    transport: transports.host,
  });
  const rpc = new RpcPeer({
    local: kafkaTopicProtocol.webview,
    remote: kafkaTopicProtocol.host,
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
  host.handle('read', reply('read', {}));
  host.handle('produce', reply('produce', { produced: true, partition: 1, offset: '9' }));
  host.handle('deleteTopic', reply('deleteTopic', { deleted: true }));
  host.handle('copyText', reply('copyText', {}));
  host.handle('tail', reply('tail', {}));
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

describe('Kafka topic page: the topic', () => {
  it('waits for the host, then shows the topic with its partitions and messages', () => {
    const transports = createLinkedTransports();
    const rpc = new RpcPeer({
      local: kafkaTopicProtocol.webview,
      remote: kafkaTopicProtocol.host,
      transport: transports.webview,
    });
    render(App, { props: { rpc, t: createTranslator('en') } });
    expect(screen.getByText('Loading the topic…')).toBeTruthy();
    expect(transports.webview.posted.length).toBeGreaterThan(0);
  });

  it('names the topic, the partitions, the total of messages and the connection', async () => {
    await open(state());
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('orders');
    const meta = screen.getByTestId('meta').textContent;
    expect(meta).toContain('3 partitions');
    // 0 + 8 + 2
    expect(meta).toContain('10 messages');
    expect(meta).toContain('Local Kafka');
    expect(meta).not.toContain('internal');
  });

  it('marks an internal topic and a read-only connection', async () => {
    await open(state({ internal: true, readOnly: true }));
    const meta = screen.getByTestId('meta').textContent;
    expect(meta).toContain('internal');
    expect(meta).toContain('read-only');
  });

  it('lists the partitions with offsets, leader and sync state', async () => {
    await open(state());
    const rows = within(screen.getByTestId('partitions')).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[1]?.textContent).toContain('0 – 8');
    expect(rows[1]?.textContent).toContain('1/2');
    // No leader is a dash.
    expect(rows[2]?.textContent).toContain('—');
  });

  it('is in Russian when asked', async () => {
    await open(state(), 'ru');
    expect(screen.getByTestId('meta').textContent).toContain('Партиций: 3');
    expect(screen.getByRole('button', { name: 'Прочитать' })).toBeTruthy();
  });
});

describe('Kafka topic page: reading', () => {
  it('starts from the last messages of the partition the host chose', async () => {
    await open(state({ partition: 2, count: 20 }));
    expect(screen.getByLabelText<HTMLSelectElement>('Count').value).toBe('20');
    expect(
      within(screen.getByTestId('reader')).getByLabelText<HTMLSelectElement>('Partition').value,
    ).toBe('2');
  });

  it('asks the host to read the last messages', async () => {
    const opened = await open(state());
    await fireEvent.click(screen.getByRole('button', { name: 'Read' }));
    await flush();
    expect(sent(opened, 'read')).toEqual([{ partition: 1, mode: 'last', count: 50 }]);
  });

  it('picks the partition from the table', async () => {
    const opened = await open(state());
    const rows = within(screen.getByTestId('partitions')).getAllByRole('row').slice(1);
    await fireEvent.click(must(rows[2]));
    await fireEvent.click(screen.getByRole('button', { name: 'Read' }));
    await flush();
    expect(sent(opened, 'read')).toEqual([{ partition: 2, mode: 'last', count: 50 }]);
  });

  it('reads from an offset, and will not read from one that is not a number', async () => {
    const opened = await open(state());
    await fireEvent.click(screen.getByRole('button', { name: 'From offset' }));
    const offset = screen.getByLabelText<HTMLInputElement>('Offset');
    await fireEvent.input(offset, { target: { value: 'abc' } });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Read' }).disabled).toBe(true);
    await fireEvent.input(offset, { target: { value: ' 5 ' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Read' }));
    await flush();
    expect(sent(opened, 'read')).toEqual([
      { partition: 1, mode: 'offset', count: 50, offset: '5' },
    ]);
  });

  it('reads from a time, and will not read from one that is not a time', async () => {
    const opened = await open(state());
    await fireEvent.click(screen.getByRole('button', { name: 'From time' }));
    const time = screen.getByLabelText<HTMLInputElement>('Time', { selector: 'input' });
    await fireEvent.input(time, { target: { value: 'yesterday-ish' } });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Read' }).disabled).toBe(true);
    await fireEvent.input(time, { target: { value: '2026-11-01 12:00' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Read' }));
    await flush();
    expect(sent(opened, 'read')).toEqual([
      { partition: 1, mode: 'time', count: 50, time: '2026-11-01 12:00' },
    ]);
  });

  it('shows the messages with offset, time, key and value, and says nothing before a read', async () => {
    const opened = await open(state());
    expect(screen.queryByTestId('messages')).toBeNull();
    opened.host.emit(
      'state',
      state({ read: true, messages: [message('6'), message('7', { value: null })] }),
    );
    await waitFor(() => {
      expect(screen.getByTestId('messages')).toBeTruthy();
    });
    const rows = within(screen.getByTestId('messages')).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('value-6');
    expect(rows[0]?.textContent).toContain('key-6');
    expect(rows[1]?.textContent).toContain('tombstone');
  });

  it('marks a message that was decoded with a registry schema, in both languages (V13.34)', async () => {
    const decoded = message('6', {
      value: { text: '{"id":1}' },
      schema: { id: 12, format: 'AVRO' },
    });
    await open(state({ read: true, messages: [decoded, message('7')] }));
    const rows = within(screen.getByTestId('messages')).getAllByRole('row').slice(1);
    expect(rows[0]?.textContent).toContain('AVRO');
    expect(rows[0]?.querySelector('[title="Decoded with registry schema 12"]')).not.toBeNull();
    expect(rows[1]?.textContent).not.toContain('AVRO');
    await fireEvent.click(must(rows[0]));
    await waitFor(() => {
      expect(screen.getByTestId('schema-note').textContent).toContain('registry schema 12');
    });
    await fireEvent.click(must(rows[1]));
    await waitFor(() => {
      expect(screen.queryByTestId('schema-note')).toBeNull();
    });
  });

  it('says in Russian which schema decoded a message (V13.34)', async () => {
    await open(
      state({
        read: true,
        messages: [message('6', { schema: { id: 3, format: 'PROTOBUF' } })],
      }),
      'ru',
    );
    const row = within(screen.getByTestId('messages')).getAllByRole('row')[1];
    await fireEvent.click(must(row));
    await waitFor(() => {
      expect(screen.getByTestId('schema-note').textContent).toContain('схемой реестра 3');
    });
  });

  it('shows what the read did not bring', async () => {
    await open(state({ read: true, notice: 'The partition holds no messages' }));
    expect(screen.getByTestId('notice').textContent).toContain('holds no messages');
    expect(screen.queryByTestId('messages')).toBeNull();
  });

  it('opens a message: key, value and headers', async () => {
    await open(
      state({
        read: true,
        messages: [
          message('6', { headers: [{ name: 'trace', value: { text: 'abc' } }] }),
          message('7'),
        ],
      }),
    );
    const rows = within(screen.getByTestId('messages')).getAllByRole('row').slice(1);
    await fireEvent.click(must(rows[0]));
    const detail = screen.getByTestId('detail');
    expect(detail.textContent).toContain('Partition 1, offset 6');
    expect(within(detail).getByLabelText<HTMLTextAreaElement>('Value').value).toBe('value-6');
    expect(within(detail).getByLabelText<HTMLTextAreaElement>('Key').value).toBe('key-6');
    expect(within(detail).getByLabelText<HTMLTextAreaElement>('Value').readOnly).toBe(true);
    expect(detail.textContent).toContain('trace');
    expect(detail.textContent).toContain('abc');
  });

  it('explains a message that has no value', async () => {
    await open(state({ read: true, messages: [message('6', { value: null, key: null })] }));
    const rows = within(screen.getByTestId('messages')).getAllByRole('row').slice(1);
    await fireEvent.click(must(rows[0]));
    expect(screen.getByTestId('detail').textContent).toContain('marks the key as deleted');
  });

  it('closes the detail of a message that a new read took away', async () => {
    const opened = await open(state({ read: true, messages: [message('6')] }));
    const rows = within(screen.getByTestId('messages')).getAllByRole('row').slice(1);
    await fireEvent.click(must(rows[0]));
    expect(screen.queryByTestId('detail')).not.toBeNull();
    opened.host.emit('state', state({ read: true, messages: [message('9')] }));
    await waitFor(() => {
      expect(screen.queryByTestId('detail')).toBeNull();
    });
  });

  it('shows the error of a failed read', async () => {
    const opened = await open(state(), 'en', { read: new Error('The topic is gone') });
    await fireEvent.click(screen.getByRole('button', { name: 'Read' }));
    await flush();
    expect(sent(opened, 'read')).toHaveLength(1);
    await waitFor(() => {
      expect(screen.getByTestId('error').textContent).toContain('The topic is gone');
    });
  });
});

describe('Kafka topic page: sending', () => {
  async function openProduce(overrides: Partial<KafkaTopicState> = {}) {
    const opened = await open(state(overrides));
    await fireEvent.click(screen.getByRole('button', { name: 'Send a message' }));
    return opened;
  }

  it('offers a form that sends a message with key, value and headers', async () => {
    const opened = await openProduce();
    const form = screen.getByTestId('produce');
    await fireEvent.input(within(form).getByLabelText('Key'), { target: { value: 'id-1' } });
    await fireEvent.input(within(form).getByLabelText<HTMLTextAreaElement>('Value'), {
      target: { value: '{"a":1}' },
    });
    await fireEvent.input(within(form).getByLabelText('Headers'), {
      target: { value: 'trace: 42\n\nflag' },
    });
    await fireEvent.click(within(form).getByRole('button', { name: 'Send' }));
    await flush();
    expect(sent(opened, 'produce')).toEqual([
      {
        key: { text: 'id-1' },
        value: { text: '{"a":1}' },
        headers: [
          { name: 'trace', value: '42' },
          { name: 'flag', value: '' },
        ],
      },
    ]);
  });

  it('sends to the partition that was picked', async () => {
    const opened = await openProduce();
    const form = screen.getByTestId('produce');
    await fireEvent.change(within(form).getByLabelText<HTMLSelectElement>('Partition'), {
      target: { value: '2' },
    });
    await fireEvent.click(within(form).getByRole('button', { name: 'Send' }));
    await flush();
    expect((sent(opened, 'produce')[0] as { partition: number }).partition).toBe(2);
  });

  it('sends a tombstone and hides the value box', async () => {
    const opened = await openProduce();
    const form = screen.getByTestId('produce');
    await fireEvent.click(within(form).getByLabelText('Tombstone (no value)'));
    expect(within(form).queryByLabelText('Value')).toBeNull();
    await fireEvent.click(within(form).getByRole('button', { name: 'Send' }));
    await flush();
    expect((sent(opened, 'produce')[0] as { value: unknown }).value).toBeNull();
  });

  it('empties the form once the message was sent', async () => {
    await openProduce();
    const form = screen.getByTestId('produce');
    const key = within(form).getByLabelText<HTMLInputElement>('Key');
    await fireEvent.input(key, { target: { value: 'id-1' } });
    await fireEvent.click(within(form).getByRole('button', { name: 'Send' }));
    await flush();
    await waitFor(() => {
      expect(
        within(screen.getByTestId('produce')).getByLabelText<HTMLInputElement>('Key').value,
      ).toBe('');
    });
  });

  it('is not offered on a read-only connection', async () => {
    await open(state({ readOnly: true }));
    expect(screen.queryByRole('button', { name: 'Send a message' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete the topic' })).toBeNull();
    expect(screen.queryByTestId('produce')).toBeNull();
  });
});

describe('Kafka topic page: the toolbar', () => {
  it('refreshes, copies the name and deletes', async () => {
    const opened = await open(state());
    // One request at a time: the page ignores a click while another is running.
    await fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await flush();
    await fireEvent.click(screen.getByRole('button', { name: 'Copy the topic name' }));
    await flush();
    await fireEvent.click(screen.getByRole('button', { name: 'Delete the topic' }));
    await flush();
    expect(sent(opened, 'refresh')).toHaveLength(1);
    expect(sent(opened, 'copyText')).toEqual([{ text: 'orders' }]);
    expect(sent(opened, 'deleteTopic')).toHaveLength(1);
  });
});

describe('Kafka topic page: following live (V13.29)', () => {
  it('asks the host to follow the chosen partition', async () => {
    const opened = await open(state());
    const live = screen.getByTestId<HTMLButtonElement>('live');
    expect(live.textContent.trim()).toBe('Follow live');
    expect(live.getAttribute('aria-pressed')).toBe('false');
    const rows = within(screen.getByTestId('partitions')).getAllByRole('row').slice(1);
    await fireEvent.click(must(rows[2]));
    await fireEvent.click(live);
    await flush();
    expect(sent(opened, 'tail')).toEqual([{ partition: 2, on: true }]);
  });

  it('says it is live and waiting, then that messages are being added', async () => {
    const opened = await open(state());
    opened.host.emit('state', state({ read: true, tailing: true }));
    await waitFor(() => {
      expect(screen.getByTestId('live-note').textContent).toMatch(/waiting for new messages/u);
    });
    expect(screen.getByTestId('live').textContent.trim()).toBe('Stop');
    expect(screen.getByTestId('live').getAttribute('aria-pressed')).toBe('true');
    opened.host.emit('state', state({ read: true, tailing: true, messages: [message('8')] }));
    await waitFor(() => {
      expect(screen.getByTestId('live-note').textContent).toMatch(/added below/u);
    });
    expect(screen.getByTestId('messages')).toBeTruthy();
  });

  it('asks the host to stop when it is live', async () => {
    const opened = await open(state({ read: true, tailing: true }));
    await fireEvent.click(screen.getByTestId('live'));
    await flush();
    expect(sent(opened, 'tail')).toEqual([{ partition: 1, on: false }]);
  });

  it('shows no live note once it has stopped', async () => {
    const opened = await open(state({ read: true, tailing: true }));
    opened.host.emit('state', state({ read: true, notice: 'Live reading stopped: gone' }));
    await waitFor(() => {
      expect(screen.queryByTestId('live-note')).toBeNull();
    });
    expect(screen.getByTestId('notice').textContent).toMatch(/Live reading stopped/u);
    expect(screen.getByTestId('live').textContent.trim()).toBe('Follow live');
  });

  it('cannot follow a topic without partitions', async () => {
    await open(state({ partitions: [] }));
    expect(screen.getByTestId<HTMLButtonElement>('live').disabled).toBe(true);
  });

  it('speaks Russian when asked', async () => {
    await open(state({ read: true, tailing: true }), 'ru');
    expect(screen.getByTestId('live').textContent.trim()).toBe('Остановить');
    expect(screen.getByTestId('live-note').textContent).toMatch(/Вживую/u);
  });
});

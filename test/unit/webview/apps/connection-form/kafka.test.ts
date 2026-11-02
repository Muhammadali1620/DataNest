import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import {
  connectionFormProtocol,
  type ConnectionDraft,
  type ConnectionFormProtocol,
  type ConnectionFormState,
} from '../../../../../src/shared/protocols/connection-form';
import { RpcPeer } from '../../../../../src/shared/rpc';
import App from '../../../../../webview/src/apps/connection-form/App.svelte';
import { toKafka } from '../../../../../webview/src/apps/connection-form/form-model';
import { createTranslator } from '../../../../../webview/src/lib/i18n';
import { must } from '../../../../helpers/must';
import { createLinkedTransports, flush } from '../../../../helpers/rpc';

type HostPeer = RpcPeer<ConnectionFormProtocol['host'], ConnectionFormProtocol['webview']>;

const DRIVERS: ConnectionFormState['drivers'] = [
  { id: 'mysql', defaultPort: 3306, file: false },
  { id: 'postgres', defaultPort: 5432, file: false },
  { id: 'kafka', defaultPort: 9092, file: false },
];

function kafka(overrides: Partial<ConnectionFormState> = {}): ConnectionFormState {
  return {
    input: { name: 'Events', driver: 'kafka', host: 'b1:9092,b2:9092', user: 'bob' },
    hasStoredPassword: false,
    storedSsh: [],
    drivers: DRIVERS,
    ...overrides,
  };
}

async function withState(state: ConnectionFormState, lang = 'en') {
  const transports = createLinkedTransports();
  const host: HostPeer = new RpcPeer({
    local: connectionFormProtocol.host,
    remote: connectionFormProtocol.webview,
    transport: transports.host,
  });
  const rpc = new RpcPeer({
    local: connectionFormProtocol.webview,
    remote: connectionFormProtocol.host,
    transport: transports.webview,
  });
  host.on('ready', () => undefined);
  host.on('close', () => undefined);
  render(App, { props: { rpc, t: createTranslator(lang) } });
  await flush();
  host.emit('state', state);
  await waitFor(() => {
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeNull();
  });
  return { host };
}

function field(name: string): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>(name, { selector: 'input' });
}

function cards(): HTMLElement[] {
  return within(screen.getByRole('radiogroup', { name: 'Database' })).getAllByRole('radio');
}

describe('connection form: Kafka (V13.23)', () => {
  it('lists Kafka by its name, with its own mark', async () => {
    await withState(kafka({ input: { name: '', driver: 'mysql', host: 'h' } }));
    const card = cards().find((item) => item.getAttribute('data-value') === 'kafka');
    expect(card?.textContent.trim()).toBe('Apache Kafka');
    expect(card?.querySelector('svg')).not.toBeNull();
  });

  it('shows the default port and asks for the bootstrap brokers', async () => {
    await withState(kafka());
    expect(field('Port').value).toBe('');
    expect(screen.getByText('Default: 9092')).toBeTruthy();
    expect(field('Host').value).toBe('b1:9092,b2:9092');
    expect(screen.getByText(/bootstrap brokers/u)).toBeTruthy();
  });

  it('asks how to sign in, and for no database', async () => {
    await withState(kafka());
    const sasl = screen.getByLabelText<HTMLSelectElement>('Sign-in (SASL)');
    expect([...sasl.options].map((option) => option.value)).toEqual([
      'none',
      'plain',
      'scram-sha-256',
      'scram-sha-512',
    ]);
    expect(sasl.value).toBe('none');
    expect(screen.queryByLabelText('Database name', { selector: 'input' })).toBeNull();
  });

  it('keeps the database field and drops the SASL choice for other drivers', async () => {
    await withState(kafka());
    const card = cards().find((item) => item.getAttribute('data-value') === 'postgres');
    await fireEvent.click(must(card));
    await waitFor(() => {
      expect(screen.queryByLabelText('Database name', { selector: 'input' })).not.toBeNull();
    });
    expect(screen.queryByLabelText('Sign-in (SASL)')).toBeNull();
  });

  it('shows the mechanism a saved connection uses', async () => {
    await withState(
      kafka({
        input: {
          name: 'Events',
          driver: 'kafka',
          host: 'b',
          kafka: { sasl: 'scram-sha-512' },
        },
      }),
    );
    expect(screen.getByLabelText<HTMLSelectElement>('Sign-in (SASL)').value).toBe('scram-sha-512');
  });

  it('keeps the TLS section, which a secured cluster needs', async () => {
    await withState(kafka());
    expect(screen.queryByLabelText('SSL / TLS')).not.toBeNull();
  });

  it('saves the brokers, the user, the password and the mechanism, and no database', async () => {
    const { host } = await withState(kafka());
    const drafts: ConnectionDraft[] = [];
    host.handle('save', (draft) => {
      drafts.push(draft);
      return { connectionId: 'c1' };
    });
    await fireEvent.change(screen.getByLabelText('Sign-in (SASL)'), {
      target: { value: 'scram-sha-256' },
    });
    await fireEvent.input(screen.getByLabelText('Password'), { target: { value: 'secret' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(drafts).toHaveLength(1);
    });
    expect(drafts[0]?.input).toMatchObject({
      driver: 'kafka',
      host: 'b1:9092,b2:9092',
      user: 'bob',
      kafka: { sasl: 'scram-sha-256' },
    });
    expect(drafts[0]?.input).not.toHaveProperty('database');
    expect(drafts[0]?.password).toEqual({ kind: 'set', value: 'secret' });
  });

  it('sends no Kafka settings when the brokers ask for no sign-in', async () => {
    const { host } = await withState(kafka());
    const drafts: ConnectionDraft[] = [];
    host.handle('save', (draft) => {
      drafts.push(draft);
      return { connectionId: 'c1' };
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(drafts).toHaveLength(1);
    });
    expect(drafts[0]?.input).not.toHaveProperty('kafka');
  });

  it('warns that a tunnel or proxy only reaches the first address, and only for Kafka', async () => {
    await withState(kafka());
    expect(screen.queryByTestId('kafka-tunnel-note')).toBeNull();
    await fireEvent.click(screen.getByLabelText(/Connect through an SSH tunnel/u));
    await waitFor(() => {
      expect(screen.queryByTestId('kafka-tunnel-note')?.textContent).toMatch(
        /advertised listeners|names themselves/u,
      );
    });
    await fireEvent.click(screen.getByTestId('use-proxy'));
    await waitFor(() => {
      expect(screen.queryByTestId('kafka-proxy-note')).not.toBeNull();
    });
    const card = cards().find((item) => item.getAttribute('data-value') === 'postgres');
    await fireEvent.click(must(card));
    await waitFor(() => {
      expect(screen.queryByTestId('kafka-tunnel-note')).toBeNull();
    });
    expect(screen.queryByTestId('kafka-proxy-note')).toBeNull();
  });

  it('speaks Russian when asked', async () => {
    await withState(kafka(), 'ru');
    expect(screen.getByLabelText('Вход (SASL)')).toBeTruthy();
    expect(screen.getByText(/Начальные брокеры/u)).toBeTruthy();
  });
});

describe('toKafka', () => {
  const fields = (driver: string, sasl: string) =>
    ({ driver, kafkaSasl: sasl }) as unknown as Parameters<typeof toKafka>[0];

  it('sends the mechanism of a Kafka connection that uses one', () => {
    expect(toKafka(fields('kafka', 'plain'))).toEqual({ sasl: 'plain' });
  });

  it('sends nothing for no sign-in, or for another driver', () => {
    expect(toKafka(fields('kafka', 'none'))).toBeUndefined();
    expect(toKafka(fields('mysql', 'plain'))).toBeUndefined();
  });
});

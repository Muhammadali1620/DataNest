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
import { createTranslator } from '../../../../../webview/src/lib/i18n';
import { createLinkedTransports, flush } from '../../../../helpers/rpc';

type HostPeer = RpcPeer<ConnectionFormProtocol['host'], ConnectionFormProtocol['webview']>;

const DRIVERS: ConnectionFormState['drivers'] = [
  { id: 'mysql', defaultPort: 3306, file: false },
  { id: 'postgres', defaultPort: 5432, file: false },
  { id: 'sqlite', file: true },
  { id: 'influxdb', defaultPort: 8086, file: false },
];

function influx(overrides: Partial<ConnectionFormState> = {}): ConnectionFormState {
  return {
    input: {
      name: 'Metrics',
      driver: 'influxdb',
      host: 'influx.local',
      port: 8086,
      user: 'acme',
      database: 'metrics',
    },
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

function cards(): HTMLElement[] {
  return within(screen.getByRole('radiogroup', { name: 'Database' })).getAllByRole('radio');
}

describe('connection form: InfluxDB (V13.20)', () => {
  it('lists InfluxDB by its name, with its own mark', async () => {
    await withState(influx({ input: { name: '', driver: 'mysql', host: 'h' } }));
    const card = cards().find((item) => item.getAttribute('data-value') === 'influxdb');
    expect(card?.textContent.trim()).toBe('InfluxDB');
    expect(card?.querySelector('svg')).not.toBeNull();
  });

  it('names the fields by what they mean: organization, API token, bucket', async () => {
    await withState(influx());
    expect(screen.getByLabelText('Organization')).toBeTruthy();
    expect(screen.getByLabelText('API token')).toBeTruthy();
    expect(screen.getByLabelText('Bucket')).toBeTruthy();
    expect(screen.queryByLabelText('User')).toBeNull();
    expect(screen.queryByLabelText('Password')).toBeNull();
    expect(screen.queryByLabelText('Database name', { selector: 'input' })).toBeNull();
  });

  it('keeps the usual labels for the other drivers', async () => {
    await withState(influx());
    const card = cards().find((item) => item.getAttribute('data-value') === 'postgres');
    if (card === undefined) {
      throw new Error('No card');
    }
    await fireEvent.click(card);
    await waitFor(() => {
      expect(screen.queryByLabelText('User')).not.toBeNull();
    });
    expect(screen.queryByLabelText('API token')).toBeNull();
    expect(screen.queryByLabelText('Organization')).toBeNull();
  });

  it('offers no init SQL: there is no session to run it in', async () => {
    await withState(influx());
    expect(screen.queryByLabelText('Init SQL')).toBeNull();
  });

  it('saves the organization as the user, the bucket as the database and the token as a secret', async () => {
    const { host } = await withState(influx());
    const drafts: ConnectionDraft[] = [];
    host.handle('save', (draft) => {
      drafts.push(draft);
      return { connectionId: 'c1' };
    });
    await fireEvent.input(screen.getByLabelText('API token'), { target: { value: 'tok==' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(drafts).toHaveLength(1);
    });
    expect(drafts[0]?.input).toMatchObject({
      driver: 'influxdb',
      host: 'influx.local',
      port: 8086,
      user: 'acme',
      database: 'metrics',
    });
    expect(drafts[0]?.password).toEqual({ kind: 'set', value: 'tok==' });
  });

  it('says the same in Russian', async () => {
    await withState(influx(), 'ru');
    expect(screen.queryByLabelText('Организация')).not.toBeNull();
    expect(screen.queryByLabelText('API-токен')).not.toBeNull();
    expect(screen.queryByLabelText('Корзина (bucket)')).not.toBeNull();
  });
});

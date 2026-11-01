import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import {
  connectionFormProtocol,
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
  { id: 'sqlite', file: true },
  { id: 'cassandra', defaultPort: 9042, file: false },
];

function cassandra(overrides: Partial<ConnectionFormState> = {}): ConnectionFormState {
  return {
    input: { name: 'Ring', driver: 'cassandra', host: 'localhost', user: 'app', database: 'shop' },
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

function cards(lang = 'Database'): HTMLElement[] {
  return within(screen.getByRole('radiogroup', { name: lang })).getAllByRole('radio');
}

describe('connection form: Cassandra (V13.22)', () => {
  it('lists Cassandra by its name, with its own mark', async () => {
    await withState(cassandra({ input: { name: '', driver: 'mysql', host: 'h' } }));
    const card = cards().find((item) => item.getAttribute('data-value') === 'cassandra');
    expect(card?.textContent.trim()).toBe('Apache Cassandra');
    expect(card?.querySelector('svg')).not.toBeNull();
  });

  it('asks for a user, a password and a keyspace, and explains the address', async () => {
    await withState(cassandra());
    expect(field('User').value).toBe('app');
    expect(screen.queryByLabelText('Password')).not.toBeNull();
    expect(field('Keyspace').value).toBe('shop');
    expect(screen.getByText(/CQL port \(9042\)/u)).toBeTruthy();
    expect(screen.getByText('Optional: the keyspace to open right away')).toBeTruthy();
  });

  it('names the default port, 9042, and leaves the field to the user', async () => {
    await withState(cassandra());
    expect(screen.getByText('Default: 9042')).toBeTruthy();
  });

  it('starts a new Cassandra connection with the CQL port', async () => {
    await withState(cassandra({ input: { name: '', driver: 'mysql', host: 'h', port: 3306 } }));
    const card = cards().find((item) => item.getAttribute('data-value') === 'cassandra');
    if (card === undefined) {
      throw new Error('No Cassandra card');
    }
    await fireEvent.click(card);
    await waitFor(() => {
      expect(screen.getByText(/CQL port \(9042\)/u)).toBeTruthy();
    });
    expect(field('Port').value).toBe('9042');
  });

  it('speaks Russian', async () => {
    await withState(cassandra(), 'ru');
    expect(screen.getByText(/порт CQL \(9042\)/u)).toBeTruthy();
    expect(field('Пространство ключей (keyspace)').value).toBe('shop');
  });
});

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
  { id: 'neo4j', defaultPort: 7474, file: false },
];

function neo4j(overrides: Partial<ConnectionFormState> = {}): ConnectionFormState {
  return {
    input: { name: 'Graph', driver: 'neo4j', host: 'localhost', user: 'neo4j' },
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

describe('connection form: Neo4j (V13.21)', () => {
  it('lists Neo4j by its name, with its own mark', async () => {
    await withState(neo4j({ input: { name: '', driver: 'mysql', host: 'h' } }));
    const card = cards().find((item) => item.getAttribute('data-value') === 'neo4j');
    expect(card?.textContent.trim()).toBe('Neo4j');
    expect(card?.querySelector('svg')).not.toBeNull();
  });

  it('asks for a user, a password and a database, and explains the address', async () => {
    await withState(neo4j());
    expect(field('User').value).toBe('neo4j');
    expect(screen.queryByLabelText('Password')).not.toBeNull();
    expect(screen.queryByLabelText('Database name', { selector: 'input' })).not.toBeNull();
    expect(screen.getByText(/HTTP port \(7474\)/u)).toBeTruthy();
  });

  it('leaves the port empty, and names the default: 7474 without TLS, 443 with it', async () => {
    await withState(neo4j());
    expect(field('Port').value).toBe('');
    expect(screen.getByText('Default: 7474')).toBeTruthy();
  });

  it('shows 443 as the default of a connection with TLS', async () => {
    await withState(
      neo4j({
        input: {
          name: 'Aura',
          driver: 'neo4j',
          host: 'x.databases.neo4j.io',
          ssl: { mode: 'verify-full' },
        },
      }),
    );
    expect(screen.getByText('Default: 443')).toBeTruthy();
  });

  it('starts a new Neo4j connection with an empty port', async () => {
    await withState(neo4j({ input: { name: '', driver: 'mysql', host: 'h', port: 3306 } }));
    const card = cards().find((item) => item.getAttribute('data-value') === 'neo4j');
    if (card === undefined) {
      throw new Error('No Neo4j card');
    }
    await fireEvent.click(card);
    await waitFor(() => {
      expect(screen.getByText(/HTTP port \(7474\)/u)).toBeTruthy();
    });
    expect(field('Port').value).toBe('');
  });

  it('speaks Russian', async () => {
    await withState(neo4j(), 'ru');
    expect(screen.getByText(/HTTP-порт \(7474\)/u)).toBeTruthy();
  });
});

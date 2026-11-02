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
import { must } from '../../../../helpers/must';
import { createLinkedTransports, flush } from '../../../../helpers/rpc';

type HostPeer = RpcPeer<ConnectionFormProtocol['host'], ConnectionFormProtocol['webview']>;

const DRIVERS: ConnectionFormState['drivers'] = [
  { id: 'mysql', defaultPort: 3306, file: false },
  { id: 'postgres', defaultPort: 5432, file: false },
  { id: 'zookeeper', defaultPort: 2181, file: false },
];

function zookeeper(overrides: Partial<ConnectionFormState> = {}): ConnectionFormState {
  return {
    input: {
      name: 'Ensemble',
      driver: 'zookeeper',
      host: 'zk1:2181,zk2:2181',
      user: 'alice',
      database: '/app',
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

function field(name: string): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>(name, { selector: 'input' });
}

function cards(): HTMLElement[] {
  return within(screen.getByRole('radiogroup', { name: 'Database' })).getAllByRole('radio');
}

describe('connection form: ZooKeeper (V13.24)', () => {
  it('lists ZooKeeper by its name, with its own mark', async () => {
    await withState(zookeeper({ input: { name: '', driver: 'mysql', host: 'h' } }));
    const card = cards().find((item) => item.getAttribute('data-value') === 'zookeeper');
    expect(card?.textContent.trim()).toBe('Apache ZooKeeper');
    expect(card?.querySelector('svg')).not.toBeNull();
  });

  it('shows the default port of the client and says a list of servers fits the host box', async () => {
    await withState(zookeeper());
    expect(field('Port').value).toBe('');
    expect(screen.getByText('Default: 2181')).toBeTruthy();
    expect(field('Host').value).toBe('zk1:2181,zk2:2181');
    expect(screen.getByText(/several go in a list separated by commas/u)).toBeTruthy();
  });

  it('asks for a user and a password, and calls the database a chroot', async () => {
    await withState(zookeeper());
    expect(field('User').value).toBe('alice');
    expect(screen.getByLabelText('Password')).toBeTruthy();
    expect(field('Chroot').value).toBe('/app');
    expect(screen.queryByLabelText('Database name', { selector: 'input' })).toBeNull();
    expect(screen.getByText(/digest scheme/u)).toBeTruthy();
  });

  it('keeps the database field for the other drivers', async () => {
    await withState(zookeeper());
    const card = cards().find((item) => item.getAttribute('data-value') === 'postgres');
    await fireEvent.click(must(card));
    await waitFor(() => {
      expect(screen.queryByLabelText('Database name', { selector: 'input' })).not.toBeNull();
    });
  });

  it('keeps the TLS section, which the secure client port needs', async () => {
    await withState(zookeeper());
    expect(screen.queryByLabelText('SSL / TLS')).not.toBeNull();
  });

  it('asks for the session timeout and sends it as seconds (V13.27)', async () => {
    const { host } = await withState(zookeeper());
    const drafts: ConnectionDraft[] = [];
    host.handle('save', (draft) => {
      drafts.push(draft);
      return { connectionId: 'c1' };
    });
    await fireEvent.input(field('Session timeout, s'), { target: { value: '30' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(drafts).toHaveLength(1);
    });
    expect(drafts[0]?.input.options).toEqual({ sessionTimeout: 30 });
  });

  it('does not offer the session timeout to the other drivers', async () => {
    await withState(zookeeper({ input: { name: '', driver: 'postgres', host: 'h' } }));
    expect(screen.queryByLabelText('Session timeout, s')).toBeNull();
  });

  it('has no init SQL to offer', async () => {
    await withState(zookeeper());
    expect(screen.queryByLabelText('Init SQL')).toBeNull();
  });

  it('saves the servers, the user, the password and the chroot', async () => {
    const { host } = await withState(zookeeper());
    const drafts: ConnectionDraft[] = [];
    host.handle('save', (draft) => {
      drafts.push(draft);
      return { connectionId: 'c1' };
    });
    await fireEvent.input(screen.getByLabelText('Password'), { target: { value: 'secret' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(drafts).toHaveLength(1);
    });
    expect(drafts[0]?.input).toMatchObject({
      driver: 'zookeeper',
      host: 'zk1:2181,zk2:2181',
      user: 'alice',
      database: '/app',
    });
    expect(drafts[0]?.password).toEqual({ kind: 'set', value: 'secret' });
  });

  it('says in Russian what the chroot is', async () => {
    await withState(zookeeper(), 'ru');
    expect(field('Корень (chroot)').value).toBe('/app');
    expect(screen.getByText(/znode вроде \/app, который станет корнем дерева/u)).toBeTruthy();
  });
});

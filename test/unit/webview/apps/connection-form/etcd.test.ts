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
  { id: 'etcd', defaultPort: 2379, file: false },
];

function etcd(overrides: Partial<ConnectionFormState> = {}): ConnectionFormState {
  return {
    input: { name: 'Cluster', driver: 'etcd', host: 'etcd.local', user: 'root' },
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

describe('connection form: etcd (V13.19)', () => {
  it('lists etcd by its name, with its own mark', async () => {
    await withState(etcd({ input: { name: '', driver: 'mysql', host: 'h' } }));
    const card = cards().find((item) => item.getAttribute('data-value') === 'etcd');
    expect(card?.textContent.trim()).toBe('etcd');
    expect(card?.querySelector('svg')).not.toBeNull();
  });

  it('shows the default port of the client', async () => {
    await withState(etcd());
    expect(field('Port').value).toBe('');
    expect(screen.getByText('Default: 2379')).toBeTruthy();
  });

  it('asks for the address, a user and a password, and for no database', async () => {
    await withState(etcd());
    expect(field('Host').value).toBe('etcd.local');
    expect(field('User').value).toBe('root');
    expect(screen.getByLabelText('Password')).toBeTruthy();
    expect(screen.queryByLabelText('Database name', { selector: 'input' })).toBeNull();
    expect(
      screen.getByText('Leave the user and password empty when the cluster has no authentication'),
    ).toBeTruthy();
  });

  it('keeps the database field for the other drivers', async () => {
    await withState(etcd());
    const card = cards().find((item) => item.getAttribute('data-value') === 'postgres');
    await fireEvent.click(must(card));
    await waitFor(() => {
      expect(screen.queryByLabelText('Database name', { selector: 'input' })).not.toBeNull();
    });
  });

  it('keeps the TLS section, which a secured cluster needs', async () => {
    await withState(etcd());
    expect(screen.queryByLabelText('SSL / TLS')).not.toBeNull();
  });

  it('has no init SQL to offer', async () => {
    await withState(etcd());
    expect(screen.queryByLabelText('Init SQL')).toBeNull();
  });

  it('saves the host, the user and the password, and no database', async () => {
    const { host } = await withState(etcd());
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
    expect(drafts[0]?.input).toMatchObject({ driver: 'etcd', host: 'etcd.local', user: 'root' });
    expect(drafts[0]?.input).not.toHaveProperty('database');
    expect(drafts[0]?.password).toEqual({ kind: 'set', value: 'secret' });
  });

  it('says in Russian what to do without authentication', async () => {
    await withState(etcd(), 'ru');
    expect(
      screen.getByText(
        'Если в кластере нет аутентификации, оставьте пользователя и пароль пустыми',
      ),
    ).toBeTruthy();
  });
});

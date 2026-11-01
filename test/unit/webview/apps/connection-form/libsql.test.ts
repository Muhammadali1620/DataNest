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
  { id: 'libsql', defaultPort: 8080, file: false },
];

function libsql(overrides: Partial<ConnectionFormState> = {}): ConnectionFormState {
  return {
    input: {
      name: 'Turso',
      driver: 'libsql',
      host: 'db-org.turso.io',
      ssl: { mode: 'verify-full' },
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

async function chooseDatabase(value: string): Promise<void> {
  const card = cards().find((item) => item.getAttribute('data-value') === value);
  if (card === undefined) {
    throw new Error(`No database card ${value}`);
  }
  await fireEvent.click(card);
}

describe('connection form: libSQL (V13.17)', () => {
  it('lists libSQL by its name, with its own mark', async () => {
    await withState(libsql({ input: { name: '', driver: 'mysql', host: 'h' } }));
    const card = cards().find((item) => item.getAttribute('data-value') === 'libsql');
    expect(card?.textContent.trim()).toBe('libSQL / Turso');
    expect(card?.querySelector('svg')).not.toBeNull();
  });

  it('leaves the port empty, and says the default depends on TLS', async () => {
    await withState(libsql({ input: { name: '', driver: 'mysql', host: 'h' } }));
    await chooseDatabase('libsql');
    await waitFor(() => {
      expect(screen.queryByLabelText('Auth token')).not.toBeNull();
    });
    expect(field('Port').value).toBe('');
    // TLS is off in a new form: a local sqld listens on 8080.
    expect(screen.getByText('Default: 8080')).toBeTruthy();
  });

  it('shows 443 as the default of a connection with TLS', async () => {
    await withState(libsql());
    expect(field('Port').value).toBe('');
    expect(screen.getByText('Default: 443')).toBeTruthy();
  });

  it('asks for the address and an auth token, and for no user or database', async () => {
    await withState(libsql());
    expect(field('Host').value).toBe('db-org.turso.io');
    expect(screen.queryByLabelText('User')).toBeNull();
    expect(screen.queryByLabelText('Database name', { selector: 'input' })).toBeNull();
    expect(screen.queryByLabelText('Password')).toBeNull();
    expect(screen.getByLabelText('Auth token')).toBeTruthy();
    expect(screen.getByText(/libsql:\/\/ URL/u)).toBeTruthy();
  });

  it('keeps the user and database fields for the other drivers', async () => {
    await withState(libsql());
    await chooseDatabase('postgres');
    await waitFor(() => {
      expect(screen.queryByLabelText('User')).not.toBeNull();
    });
    expect(screen.queryByLabelText('Database name', { selector: 'input' })).not.toBeNull();
    expect(screen.queryByLabelText('Auth token')).toBeNull();
  });

  it('keeps the TLS section, which a hosted server needs', async () => {
    await withState(libsql());
    expect(screen.queryByLabelText('SSL / TLS')).not.toBeNull();
  });

  it('saves the host, the token and TLS, and no user or database', async () => {
    const { host } = await withState(libsql());
    const drafts: ConnectionDraft[] = [];
    host.handle('save', (draft) => {
      drafts.push(draft);
      return { connectionId: 'c1' };
    });
    await fireEvent.input(screen.getByLabelText('Auth token'), { target: { value: 'tok.en' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(drafts).toHaveLength(1);
    });
    expect(drafts[0]?.input).toMatchObject({
      driver: 'libsql',
      host: 'db-org.turso.io',
      ssl: { mode: 'verify-full' },
    });
    expect(drafts[0]?.input).not.toHaveProperty('user');
    expect(drafts[0]?.input).not.toHaveProperty('database');
    expect(drafts[0]?.password).toEqual({ kind: 'set', value: 'tok.en' });
  });

  it('suggests a PRAGMA as init SQL, as SQLite does', async () => {
    await withState(libsql());
    expect(screen.getByLabelText('Init SQL').getAttribute('placeholder')).toBe(
      'PRAGMA foreign_keys = ON;',
    );
  });

  it('says in Russian what the token is', async () => {
    await withState(libsql(), 'ru');
    expect(screen.queryByLabelText('Токен доступа')).not.toBeNull();
  });
});

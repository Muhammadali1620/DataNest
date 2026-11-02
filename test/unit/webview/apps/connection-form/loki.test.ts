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
  { id: 'loki', defaultPort: 3100, file: false },
];

function loki(overrides: Partial<ConnectionFormState> = {}): ConnectionFormState {
  return {
    input: {
      name: 'Logs',
      driver: 'loki',
      host: 'logs.local',
      port: 3100,
      user: 'ann',
      database: 'acme',
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

describe('connection form: Grafana Loki (V13.25)', () => {
  it('lists Loki by its name, with its own mark', async () => {
    await withState(loki({ input: { name: '', driver: 'mysql', host: 'h' } }));
    const card = cards().find((item) => item.getAttribute('data-value') === 'loki');
    expect(card?.textContent.trim()).toBe('Grafana Loki');
    expect(card?.querySelector('svg')).not.toBeNull();
  });

  it('names the fields by what they mean: user (basic auth), password or token, tenant', async () => {
    await withState(loki());
    expect(screen.getByLabelText('User (basic auth)')).toBeTruthy();
    expect(screen.getByLabelText('Password or token')).toBeTruthy();
    expect(screen.getByLabelText('Tenant (X-Scope-OrgID)')).toBeTruthy();
    expect(screen.queryByLabelText('Database name', { selector: 'input' })).toBeNull();
  });

  it('keeps the usual labels for the other drivers', async () => {
    await withState(loki());
    const card = cards().find((item) => item.getAttribute('data-value') === 'postgres');
    if (card === undefined) {
      throw new Error('No card');
    }
    await fireEvent.click(card);
    await waitFor(() => {
      expect(screen.queryByLabelText('User')).not.toBeNull();
    });
    expect(screen.queryByLabelText('Password or token')).toBeNull();
    expect(screen.queryByLabelText('Tenant (X-Scope-OrgID)')).toBeNull();
  });

  it('offers init SQL, where a `# range:` comment sets the window of the session', async () => {
    await withState(loki());
    expect(screen.queryByLabelText('Init SQL')).not.toBeNull();
  });

  it('saves the tenant as the database, the user as the user and the token as a secret', async () => {
    const { host } = await withState(loki());
    const drafts: ConnectionDraft[] = [];
    host.handle('save', (draft) => {
      drafts.push(draft);
      return { connectionId: 'c1' };
    });
    await fireEvent.input(screen.getByLabelText('Password or token'), {
      target: { value: 'tok==' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(drafts).toHaveLength(1);
    });
    expect(drafts[0]?.input).toMatchObject({
      driver: 'loki',
      host: 'logs.local',
      port: 3100,
      user: 'ann',
      database: 'acme',
    });
    expect(drafts[0]?.password).toEqual({ kind: 'set', value: 'tok==' });
  });

  it('says the same in Russian', async () => {
    await withState(loki(), 'ru');
    expect(screen.queryByLabelText('Пользователь (basic auth)')).not.toBeNull();
    expect(screen.queryByLabelText('Пароль или токен')).not.toBeNull();
    expect(screen.queryByLabelText('Арендатор (X-Scope-OrgID)')).not.toBeNull();
  });
});

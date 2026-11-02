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
  { id: 'rabbitmq', defaultPort: 15672, file: false },
];

function rabbit(overrides: Partial<ConnectionFormState> = {}): ConnectionFormState {
  return {
    input: { name: 'Queues', driver: 'rabbitmq', host: 'mq.local', user: 'bob', database: 'app' },
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

describe('connection form: RabbitMQ (V13.26)', () => {
  it('lists RabbitMQ by its name, with its own mark', async () => {
    await withState(rabbit({ input: { name: '', driver: 'mysql', host: 'h' } }));
    const card = cards().find((item) => item.getAttribute('data-value') === 'rabbitmq');
    expect(card?.textContent.trim()).toBe('RabbitMQ');
    expect(card?.querySelector('svg')).not.toBeNull();
  });

  it('shows the default port of the management plugin and says it is not the AMQP one', async () => {
    await withState(rabbit());
    expect(field('Port').value).toBe('');
    expect(screen.getByText('Default: 15672')).toBeTruthy();
    expect(screen.getByText(/management plugin/u)).toBeTruthy();
  });

  it('asks for a user with the management tag', async () => {
    await withState(rabbit());
    expect(field('User').value).toBe('bob');
    expect(screen.getByText(/management tag/u)).toBeTruthy();
  });

  it('calls the database field the virtual host and keeps its value', async () => {
    await withState(rabbit());
    expect(field('Virtual host').value).toBe('app');
    expect(screen.getByText(/only this virtual host/u)).toBeTruthy();
    expect(screen.queryByLabelText('Database name', { selector: 'input' })).toBeNull();
  });

  it('goes back to the database field for other drivers', async () => {
    await withState(rabbit());
    const card = cards().find((item) => item.getAttribute('data-value') === 'postgres');
    await fireEvent.click(must(card));
    await waitFor(() => {
      expect(screen.queryByLabelText('Database name', { selector: 'input' })).not.toBeNull();
    });
    expect(screen.queryByLabelText('Virtual host')).toBeNull();
  });

  it('keeps the TLS section, which a secured broker needs', async () => {
    await withState(rabbit());
    expect(screen.queryByLabelText('SSL / TLS')).not.toBeNull();
  });

  it('saves the host, the user, the password and the virtual host', async () => {
    const { host } = await withState(rabbit());
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
      driver: 'rabbitmq',
      host: 'mq.local',
      user: 'bob',
      database: 'app',
    });
    expect(drafts[0]?.password).toEqual({ kind: 'set', value: 'secret' });
  });

  it('speaks Russian when asked', async () => {
    await withState(rabbit(), 'ru');
    expect(screen.getByLabelText('Виртуальный хост', { selector: 'input' })).toBeTruthy();
    expect(screen.getByText(/плагина управления/u)).toBeTruthy();
  });
});

import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
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
];

function newState(overrides: Partial<ConnectionFormState> = {}): ConnectionFormState {
  return {
    input: { name: '', driver: 'mysql', host: '127.0.0.1', port: 3306 },
    hasStoredPassword: false,
    storedSsh: [],
    drivers: DRIVERS,
    ...overrides,
  };
}

function setup(lang = 'en') {
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
  const ready = vi.fn();
  const closed = vi.fn();
  host.on('ready', ready);
  host.on('close', closed);
  const view = render(App, { props: { rpc, t: createTranslator(lang) } });
  return { host, rpc, ready, closed, view };
}

function field(name: string): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>(name, { selector: 'input' });
}

function notice(): string | null {
  return screen.queryByTestId('notice')?.textContent.trim() ?? null;
}

async function withState(state: ConnectionFormState = newState()) {
  const harness = setup();
  await flush();
  harness.host.emit('state', state);
  await waitFor(() => {
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeNull();
  });
  return harness;
}

describe('connection form App', () => {
  it('tells the host it is ready and waits for state', async () => {
    const { ready } = setup();
    await flush();
    expect(ready).toHaveBeenCalledOnce();
    expect(screen.getByText('Loading…')).toBeTruthy();
  });

  it('shows the new-connection title and the driver defaults', async () => {
    await withState();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('New connection');
    expect(field('Host').value).toBe('127.0.0.1');
    expect(field('Port').value).toBe('3306');
  });

  it('shows the edit title for a saved connection', async () => {
    await withState(
      newState({ connectionId: 'c1', input: { name: 'Local', driver: 'mysql', host: 'db' } }),
    );
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Edit connection');
    expect(field('Name').value).toBe('Local');
  });

  it('never renders a stored password, only a hint', async () => {
    await withState(
      newState({
        connectionId: 'c1',
        input: { name: 'L', driver: 'mysql', host: 'h' },
        hasStoredPassword: true,
        storedSsh: [],
      }),
    );
    expect(field('Password').value).toBe('');
    expect(screen.getByText('A password is saved; leave empty to keep it')).toBeTruthy();
  });

  it('swaps the fields when a file driver is chosen', async () => {
    await withState();
    await fireEvent.change(screen.getByLabelText('Database'), { target: { value: 'sqlite' } });
    await waitFor(() => {
      expect(screen.queryByLabelText('Database file')).not.toBeNull();
    });
    expect(screen.queryByLabelText('Host')).toBeNull();
    expect(screen.queryByLabelText('Port')).toBeNull();
  });

  it('offers the default port of the newly chosen driver', async () => {
    await withState();
    await fireEvent.change(screen.getByLabelText('Database'), { target: { value: 'postgres' } });
    await waitFor(() => {
      expect(field('Port').value).toBe('5432');
    });
  });

  describe('saving', () => {
    it('sends the trimmed draft and reports success', async () => {
      const { host } = await withState();
      const save = vi.fn(() => ({ connectionId: 'c1' }));
      host.handle('save', save);
      await fireEvent.input(field('Name'), { target: { value: '  Local  ' } });
      await fireEvent.input(field('User'), { target: { value: 'root' } });
      await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => {
        expect(notice()).toBe('Connection saved');
      });
      expect(save).toHaveBeenCalledWith({
        input: { name: 'Local', driver: 'mysql', host: '127.0.0.1', port: 3306, user: 'root' },
        password: { kind: 'keep' },
      });
    });

    it('sends a typed password as a replacement', async () => {
      const { host } = await withState();
      const drafts: ConnectionDraft[] = [];
      host.handle('save', (draft) => {
        drafts.push(draft);
        return { connectionId: 'c1' };
      });
      await fireEvent.input(field('Name'), { target: { value: 'Local' } });
      await fireEvent.input(field('Password'), { target: { value: 'hunter2' } });
      await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => {
        expect(drafts).toHaveLength(1);
      });
      expect(drafts[0]?.password).toEqual({ kind: 'set', value: 'hunter2' });
    });

    it('blocks saving while fields are missing and marks them', async () => {
      const { host } = await withState();
      const save = vi.fn(() => ({ connectionId: 'c1' }));
      host.handle('save', save);
      await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => {
        expect(notice()).toBe('Fill in the highlighted fields');
      });
      expect(save).not.toHaveBeenCalled();
      expect(screen.getByText('Give the connection a name')).toBeTruthy();
      expect(field('Name').getAttribute('aria-invalid')).toBe('true');
    });

    it('does not mark fields before the first attempt', async () => {
      await withState();
      expect(screen.queryByText('Give the connection a name')).toBeNull();
      expect(field('Name').getAttribute('aria-invalid')).toBe('false');
    });

    it('reports a bad port without contacting the host', async () => {
      const { host } = await withState();
      const save = vi.fn(() => ({ connectionId: 'c1' }));
      host.handle('save', save);
      await fireEvent.input(field('Name'), { target: { value: 'Local' } });
      await fireEvent.input(field('Port'), { target: { value: '99999' } });
      await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => {
        expect(screen.getByText('Port must be a number from 1 to 65535')).toBeTruthy();
      });
      expect(save).not.toHaveBeenCalled();
    });

    it('shows the error the host reports', async () => {
      const { host } = await withState();
      host.handle('save', () => {
        throw new Error('The name is already taken');
      });
      await fireEvent.input(field('Name'), { target: { value: 'Local' } });
      await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => {
        expect(notice()).toBe('The name is already taken');
      });
    });

    it('disables the buttons while saving', async () => {
      const { host } = await withState();
      let finish: (() => void) | undefined;
      host.handle(
        'save',
        () =>
          new Promise((resolve) => {
            finish = () => {
              resolve({ connectionId: 'c1' });
            };
          }),
      );
      await fireEvent.input(field('Name'), { target: { value: 'Local' } });
      await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Saving…' })).toBeTruthy();
      });
      expect(
        screen.getByRole<HTMLButtonElement>('button', { name: 'Test connection' }).disabled,
      ).toBe(true);
      finish?.();
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
      });
    });
  });

  describe('testing', () => {
    it('reports a working connection', async () => {
      const { host } = await withState();
      host.handle('test', () => ({}));
      await fireEvent.input(field('Name'), { target: { value: 'Local' } });
      await fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
      await waitFor(() => {
        expect(notice()).toBe('Connection works');
      });
    });

    it('shows the failure from the host', async () => {
      const { host } = await withState();
      host.handle('test', () => {
        throw new Error('Access denied for user');
      });
      await fireEvent.input(field('Name'), { target: { value: 'Local' } });
      await fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
      await waitFor(() => {
        expect(notice()).toBe('Access denied for user');
      });
    });
  });

  describe('file driver', () => {
    it('fills the path from the file dialog', async () => {
      const { host } = await withState(newState({ input: { name: 'db', driver: 'sqlite' } }));
      host.handle('pickFile', ({ create }) => ({ file: create ? '/new.db' : '/chosen.db' }));
      await fireEvent.click(screen.getByRole('button', { name: 'Browse…' }));
      await waitFor(() => {
        expect(field('Database file').value).toBe('/chosen.db');
      });
      await fireEvent.click(screen.getByRole('button', { name: 'New file…' }));
      await waitFor(() => {
        expect(field('Database file').value).toBe('/new.db');
      });
    });

    it('keeps the current path when the dialog is dismissed', async () => {
      const { host } = await withState(
        newState({ input: { name: 'db', driver: 'sqlite', file: '/keep.db' } }),
      );
      host.handle('pickFile', () => ({}));
      await fireEvent.click(screen.getByRole('button', { name: 'Browse…' }));
      await flush();
      expect(field('Database file').value).toBe('/keep.db');
    });
  });

  it('asks the host to close on Cancel', async () => {
    const { closed } = await withState();
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(closed).toHaveBeenCalledOnce();
    });
  });

  it('replaces what is on screen when the host sends new state', async () => {
    const { host } = await withState();
    await fireEvent.input(field('Name'), { target: { value: 'typed over' } });
    host.emit(
      'state',
      newState({ connectionId: 'c1', input: { name: 'From host', driver: 'mysql', host: 'h' } }),
    );
    await waitFor(() => {
      expect(field('Name').value).toBe('From host');
    });
  });

  it('uses the page language', async () => {
    const harness = setup('ru');
    await flush();
    harness.host.emit('state', newState());
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Новое подключение');
    });
    expect(screen.getByRole('button', { name: 'Сохранить' })).toBeTruthy();
  });

  describe('SSH tunnel', () => {
    function checkbox(name: string): HTMLInputElement {
      return screen.getByRole<HTMLInputElement>('checkbox', { name });
    }

    async function enableSsh(): Promise<void> {
      await fireEvent.click(checkbox('Connect through an SSH tunnel'));
      await waitFor(() => {
        expect(screen.queryByLabelText('SSH host')).not.toBeNull();
      });
    }

    it('hides the SSH fields until the tunnel is turned on', async () => {
      await withState();
      expect(screen.queryByLabelText('SSH host')).toBeNull();
      await enableSsh();
      expect(field('SSH port').value).toBe('');
      expect(screen.getByText('Default: 22')).toBeTruthy();
    });

    it('offers no tunnel for file databases', async () => {
      await withState();
      await fireEvent.change(screen.getByLabelText('Database'), { target: { value: 'sqlite' } });
      await waitFor(() => {
        expect(screen.queryByLabelText('Database file')).not.toBeNull();
      });
      expect(screen.queryByRole('checkbox', { name: 'Connect through an SSH tunnel' })).toBeNull();
    });

    it('sends the hop and its typed password', async () => {
      const { host } = await withState();
      const drafts: ConnectionDraft[] = [];
      host.handle('save', (draft) => {
        drafts.push(draft);
        return { connectionId: 'c1' };
      });
      await fireEvent.input(field('Name'), { target: { value: 'Prod' } });
      await enableSsh();
      await fireEvent.input(field('SSH host'), { target: { value: ' bastion ' } });
      await fireEvent.input(field('SSH port'), { target: { value: '2222' } });
      await fireEvent.input(field('SSH user'), { target: { value: 'deploy' } });
      await fireEvent.input(field('SSH password'), { target: { value: 'sshpw' } });
      await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => {
        expect(drafts).toHaveLength(1);
      });
      const [draft] = drafts;
      expect(draft?.input.ssh).toMatchObject({
        host: 'bastion',
        port: 2222,
        user: 'deploy',
        auth: 'password',
      });
      expect(draft?.ssh).toEqual([
        {
          hopId: draft?.input.ssh?.id,
          password: { kind: 'set', value: 'sshpw' },
          passphrase: { kind: 'clear' },
        },
      ]);
    });

    it('marks missing SSH fields and does not save', async () => {
      const { host } = await withState();
      const save = vi.fn(() => ({ connectionId: 'c1' }));
      host.handle('save', save);
      await fireEvent.input(field('Name'), { target: { value: 'Prod' } });
      await enableSsh();
      await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => {
        expect(screen.getByText('Enter the SSH user')).toBeTruthy();
      });
      expect(field('SSH host').getAttribute('aria-invalid')).toBe('true');
      expect(save).not.toHaveBeenCalled();
    });

    it('asks for a key file and passphrase when signing in with a key', async () => {
      const { host } = await withState();
      host.handle('pickKeyFile', () => ({ file: '/home/me/.ssh/id_ed25519' }));
      const drafts: ConnectionDraft[] = [];
      host.handle('save', (draft) => {
        drafts.push(draft);
        return { connectionId: 'c1' };
      });
      await fireEvent.input(field('Name'), { target: { value: 'Prod' } });
      await enableSsh();
      await fireEvent.input(field('SSH host'), { target: { value: 'bastion' } });
      await fireEvent.input(field('SSH user'), { target: { value: 'deploy' } });
      await fireEvent.change(screen.getByLabelText('Sign in with'), { target: { value: 'key' } });
      await waitFor(() => {
        expect(screen.queryByLabelText('Private key file')).not.toBeNull();
      });
      expect(screen.queryByLabelText('SSH password')).toBeNull();
      const [browse] = screen.getAllByRole('button', { name: 'Browse…' });
      if (browse === undefined) {
        throw new Error('expected a Browse button');
      }
      await fireEvent.click(browse);
      await waitFor(() => {
        expect(field('Private key file').value).toBe('/home/me/.ssh/id_ed25519');
      });
      await fireEvent.input(field('Key passphrase'), { target: { value: 'pp' } });
      await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => {
        expect(drafts).toHaveLength(1);
      });
      expect(drafts[0]?.input.ssh).toMatchObject({
        auth: 'key',
        keyFile: '/home/me/.ssh/id_ed25519',
      });
      expect(drafts[0]?.ssh?.[0]).toMatchObject({
        password: { kind: 'clear' },
        passphrase: { kind: 'set', value: 'pp' },
      });
    });

    it('offers an agent socket, empty meaning the usual one', async () => {
      await withState();
      await enableSsh();
      await fireEvent.change(screen.getByLabelText('Sign in with'), { target: { value: 'agent' } });
      await waitFor(() => {
        expect(field('Agent socket').value).toBe('');
      });
      expect(screen.queryByLabelText('Key passphrase')).toBeNull();
    });

    it('shows a saved SSH password as a hint and keeps it when untouched', async () => {
      const { host } = await withState(
        newState({
          connectionId: 'c1',
          input: {
            name: 'Prod',
            driver: 'mysql',
            host: 'db',
            ssh: { id: 'main', host: 'bastion', user: 'deploy', auth: 'password' },
          },
          storedSsh: [{ hopId: 'main', password: true, passphrase: false }],
        }),
      );
      expect(checkbox('Connect through an SSH tunnel').checked).toBe(true);
      expect(field('SSH password').value).toBe('');
      expect(screen.getAllByText('A password is saved; leave empty to keep it')).toHaveLength(1);
      const drafts: ConnectionDraft[] = [];
      host.handle('save', (draft) => {
        drafts.push(draft);
        return { connectionId: 'c1' };
      });
      await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => {
        expect(drafts).toHaveLength(1);
      });
      expect(drafts[0]?.ssh).toEqual([
        { hopId: 'main', password: { kind: 'keep' }, passphrase: { kind: 'clear' } },
      ]);
    });

    it('sends no hop once the tunnel is turned off again', async () => {
      const { host } = await withState(
        newState({
          connectionId: 'c1',
          input: {
            name: 'Prod',
            driver: 'mysql',
            host: 'db',
            ssh: { id: 'main', host: 'bastion', user: 'deploy', auth: 'agent' },
          },
        }),
      );
      const drafts: ConnectionDraft[] = [];
      host.handle('save', (draft) => {
        drafts.push(draft);
        return { connectionId: 'c1' };
      });
      await fireEvent.click(checkbox('Connect through an SSH tunnel'));
      await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => {
        expect(drafts).toHaveLength(1);
      });
      expect(drafts[0]?.input.ssh).toBeUndefined();
      expect(drafts[0]?.ssh).toBeUndefined();
    });

    it('adds, orders and removes jump hosts, and sends them in order', async () => {
      const { host } = await withState();
      const drafts: ConnectionDraft[] = [];
      host.handle('save', (draft) => {
        drafts.push(draft);
        return { connectionId: 'c1' };
      });
      await fireEvent.input(field('Name'), { target: { value: 'Deep' } });
      await enableSsh();
      await fireEvent.input(field('SSH host'), { target: { value: 'inner' } });
      await fireEvent.input(field('SSH user'), { target: { value: 'deploy' } });
      const add = screen.getByRole('button', { name: 'Add jump host' });
      await fireEvent.click(add);
      await fireEvent.click(add);
      await fireEvent.click(add);
      await waitFor(() => {
        expect(screen.queryByLabelText('Jump 3: SSH host')).not.toBeNull();
      });
      for (const n of [1, 2, 3]) {
        await fireEvent.input(field(`Jump ${n}: SSH host`), { target: { value: `j${n}` } });
        await fireEvent.input(field(`Jump ${n}: SSH user`), { target: { value: 'u' } });
      }
      expect(
        screen.getByRole<HTMLButtonElement>('button', { name: 'Jump 1: Move up' }).disabled,
      ).toBe(true);
      await fireEvent.click(screen.getByRole('button', { name: 'Jump 1: Move down' }));
      await fireEvent.click(screen.getByRole('button', { name: 'Jump 3: Remove' }));
      await waitFor(() => {
        expect(screen.queryByLabelText('Jump 3: SSH host')).toBeNull();
      });
      expect(field('Jump 1: SSH host').value).toBe('j2');
      await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => {
        expect(drafts).toHaveLength(1);
      });
      const ssh = drafts[0]?.input.ssh;
      expect(ssh?.host).toBe('inner');
      expect(ssh?.jumps?.map((hop) => hop.host)).toEqual(['j2', 'j1']);
      expect(drafts[0]?.ssh?.map((change) => change.hopId)).toEqual([
        ...(ssh?.jumps ?? []).map((hop) => hop.id),
        ssh?.id,
      ]);
    });

    it('stops offering jump hosts at the limit', async () => {
      await withState();
      await enableSsh();
      for (let i = 0; i < 5; i++) {
        await fireEvent.click(screen.getByRole('button', { name: 'Add jump host' }));
      }
      await waitFor(() => {
        expect(screen.queryByRole('button', { name: 'Add jump host' })).toBeNull();
      });
    });

    it('marks a missing field of a jump host', async () => {
      const { host } = await withState();
      const save = vi.fn(() => ({ connectionId: 'c1' }));
      host.handle('save', save);
      await fireEvent.input(field('Name'), { target: { value: 'Deep' } });
      await enableSsh();
      await fireEvent.input(field('SSH host'), { target: { value: 'inner' } });
      await fireEvent.input(field('SSH user'), { target: { value: 'deploy' } });
      await fireEvent.click(screen.getByRole('button', { name: 'Add jump host' }));
      await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => {
        expect(field('Jump 1: SSH host').getAttribute('aria-invalid')).toBe('true');
      });
      expect(field('SSH host').getAttribute('aria-invalid')).toBe('false');
      expect(save).not.toHaveBeenCalled();
    });
  });

  describe('SSL / TLS', () => {
    it('shows the certificate files only once TLS is on', async () => {
      await withState();
      expect(screen.queryByLabelText('CA certificate')).toBeNull();
      await fireEvent.change(screen.getByLabelText('SSL / TLS'), {
        target: { value: 'verify-full' },
      });
      await waitFor(() => {
        expect(screen.queryByLabelText('CA certificate')).not.toBeNull();
      });
      expect(screen.getByText('Empty: the system’s trusted CAs')).toBeTruthy();
    });

    it('fills a file from the dialog and sends the settings', async () => {
      const { host } = await withState();
      host.handle('pickTlsFile', () => ({ file: '/certs/ca.pem' }));
      const drafts: ConnectionDraft[] = [];
      host.handle('save', (draft) => {
        drafts.push(draft);
        return { connectionId: 'c1' };
      });
      await fireEvent.input(field('Name'), { target: { value: 'Secure' } });
      await fireEvent.change(screen.getByLabelText('SSL / TLS'), {
        target: { value: 'verify-ca' },
      });
      await waitFor(() => {
        expect(screen.queryByLabelText('CA certificate')).not.toBeNull();
      });
      await fireEvent.click(screen.getByRole('button', { name: 'CA certificate: Browse…' }));
      await waitFor(() => {
        expect(field('CA certificate').value).toBe('/certs/ca.pem');
      });
      await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => {
        expect(drafts).toHaveLength(1);
      });
      expect(drafts[0]?.input.ssl).toEqual({ mode: 'verify-ca', ca: '/certs/ca.pem' });
    });

    it('marks the missing half of a client certificate', async () => {
      const { host } = await withState();
      const save = vi.fn(() => ({ connectionId: 'c1' }));
      host.handle('save', save);
      await fireEvent.input(field('Name'), { target: { value: 'Secure' } });
      await fireEvent.change(screen.getByLabelText('SSL / TLS'), { target: { value: 'require' } });
      await waitFor(() => {
        expect(screen.queryByLabelText('Client certificate')).not.toBeNull();
      });
      await fireEvent.input(field('Client certificate'), { target: { value: '/c.crt' } });
      await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => {
        expect(screen.getByText('Choose the key of the client certificate')).toBeTruthy();
      });
      expect(field('Client key').getAttribute('aria-invalid')).toBe('true');
      expect(save).not.toHaveBeenCalled();
    });

    it('shows saved TLS settings', async () => {
      await withState(
        newState({
          connectionId: 'c1',
          input: { name: 'S', driver: 'postgres', host: 'db', ssl: { mode: 'require', ca: '/ca' } },
        }),
      );
      expect(screen.getByLabelText<HTMLSelectElement>('SSL / TLS').value).toBe('require');
      expect(field('CA certificate').value).toBe('/ca');
    });
  });

  describe('connection URL', () => {
    it('fills the form from a pasted URL', async () => {
      const { host } = await withState();
      const drafts: ConnectionDraft[] = [];
      host.handle('save', (draft) => {
        drafts.push(draft);
        return { connectionId: 'c1' };
      });
      await fireEvent.input(field('Connection URL'), {
        target: { value: 'postgres://app:pw@db.example:6543/shop?sslmode=require' },
      });
      await fireEvent.click(screen.getByRole('button', { name: 'Fill' }));
      await waitFor(() => {
        expect(field('Host').value).toBe('db.example');
      });
      expect(field('Port').value).toBe('6543');
      expect(field('Name').value).toBe('shop');
      expect(field('Password').value).toBe('pw');
      expect(field('Connection URL').value).toBe('');
      expect(notice()).toBe('Filled from the URL; check the fields and save');
      await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => {
        expect(drafts).toHaveLength(1);
      });
      expect(drafts[0]).toEqual({
        input: {
          name: 'shop',
          driver: 'postgres',
          host: 'db.example',
          port: 6543,
          user: 'app',
          database: 'shop',
          ssl: { mode: 'require' },
        },
        password: { kind: 'set', value: 'pw' },
      });
    });

    it('fills on Enter and explains a URL it cannot read', async () => {
      await withState();
      await fireEvent.input(field('Connection URL'), { target: { value: 'redis://cache' } });
      await fireEvent.keyDown(field('Connection URL'), { key: 'Enter' });
      await waitFor(() => {
        expect(
          screen.getByText('Only mysql://, mariadb://, postgres:// and sqlite:// are supported'),
        ).toBeTruthy();
      });
      expect(field('Connection URL').getAttribute('aria-invalid')).toBe('true');
      expect(field('Host').value).toBe('127.0.0.1');
    });

    it('says when the password came from an imported URL', async () => {
      const { host } = await withState(
        newState({
          input: { name: 'shop', driver: 'postgres', host: 'db' },
          importedPassword: true,
        }),
      );
      expect(
        screen.getByText('The password from the URL will be saved; type another to replace it'),
      ).toBeTruthy();
      const drafts: ConnectionDraft[] = [];
      host.handle('save', (draft) => {
        drafts.push(draft);
        return { connectionId: 'c1' };
      });
      await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => {
        expect(drafts).toHaveLength(1);
      });
      expect(drafts[0]?.password).toEqual({ kind: 'keep' });
    });
  });

  describe('folder and color', () => {
    it('offers the existing folders and sends the chosen folder and color', async () => {
      const { host } = await withState(newState({ folders: ['Prod', 'Dev'] }));
      const options = [...document.querySelectorAll('#datanest-folders option')].map(
        (option) => (option as HTMLOptionElement).value,
      );
      expect(options).toEqual(['Prod', 'Dev']);
      const drafts: ConnectionDraft[] = [];
      host.handle('save', (draft) => {
        drafts.push(draft);
        return { connectionId: 'c1' };
      });
      await fireEvent.input(field('Name'), { target: { value: 'Live' } });
      await fireEvent.input(field('Folder'), { target: { value: 'Prod' } });
      await fireEvent.change(screen.getByLabelText('Color'), { target: { value: 'red' } });
      await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => {
        expect(drafts).toHaveLength(1);
      });
      expect(drafts[0]?.input).toMatchObject({ folder: 'Prod', color: 'red' });
    });

    it('shows the saved folder and color', async () => {
      await withState(
        newState({
          connectionId: 'c1',
          input: { name: 'L', driver: 'mysql', host: 'h', folder: 'Prod', color: 'green' },
        }),
      );
      expect(field('Folder').value).toBe('Prod');
      expect(screen.getByLabelText<HTMLSelectElement>('Color').value).toBe('green');
    });
  });

  describe('production and read-only', () => {
    it('sends the flags and explains them', async () => {
      const { host } = await withState();
      const drafts: ConnectionDraft[] = [];
      host.handle('save', (draft) => {
        drafts.push(draft);
        return { connectionId: 'c1' };
      });
      await fireEvent.input(field('Name'), { target: { value: 'Live' } });
      const production = screen.getByRole<HTMLInputElement>('checkbox', {
        name: 'Production database',
      });
      expect(production.getAttribute('aria-describedby')).toBe('production-hint');
      await fireEvent.click(production);
      await fireEvent.click(screen.getByRole('checkbox', { name: 'Read-only' }));
      await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => {
        expect(drafts).toHaveLength(1);
      });
      expect(drafts[0]?.input).toMatchObject({ production: true, readOnly: true });
    });

    it('shows the saved flags', async () => {
      await withState(
        newState({
          connectionId: 'c1',
          input: { name: 'L', driver: 'mysql', host: 'h', production: true },
        }),
      );
      expect(
        screen.getByRole<HTMLInputElement>('checkbox', { name: 'Production database' }).checked,
      ).toBe(true);
      expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'Read-only' }).checked).toBe(
        false,
      );
    });
  });

  describe('project connections (V4.7)', () => {
    const projects = [{ key: 'file:///shop', name: 'shop' }];

    it('offers to keep a new connection in the project file and sends that choice', async () => {
      const { host } = await withState(newState({ projects }));
      const drafts: ConnectionDraft[] = [];
      host.handle('save', (draft) => {
        drafts.push(draft);
        return { connectionId: 'p-1' };
      });
      const place = screen.getByLabelText<HTMLSelectElement>('Keep in');
      expect([...place.options].map((option) => option.textContent.trim())).toEqual([
        'My connections (this computer only)',
        'Project "shop" (.vscode/datanest.json, shared)',
      ]);
      expect(screen.queryByLabelText('Folder')).not.toBeNull();
      await fireEvent.change(place, { target: { value: 'file:///shop' } });
      await waitFor(() => {
        expect(screen.queryByLabelText('Folder')).toBeNull();
      });
      await fireEvent.input(field('Name'), { target: { value: 'Dev' } });
      await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => {
        expect(drafts).toHaveLength(1);
      });
      expect(drafts[0]?.project).toBe('file:///shop');
    });

    it('has no choice outside a project', async () => {
      await withState();
      expect(screen.queryByLabelText('Keep in')).toBeNull();
    });

    it('has no choice when editing a connection of the user', async () => {
      await withState(
        newState({
          projects,
          connectionId: 'c1',
          input: { name: 'L', driver: 'mysql', host: 'h' },
        }),
      );
      expect(screen.queryByLabelText('Keep in')).toBeNull();
      expect(screen.queryByLabelText('Folder')).not.toBeNull();
    });

    it('says where an edited project connection lives and hides the folder', async () => {
      await withState(
        newState({
          projects,
          connectionId: 'p-1',
          project: projects[0],
          input: { name: 'Dev', driver: 'mysql', host: 'h' },
        }),
      );
      expect(screen.getByTestId('project-note').textContent).toContain(
        'Kept in .vscode/datanest.json of the project "shop"',
      );
      expect(screen.queryByLabelText('Folder')).toBeNull();
    });
  });

  describe('session options (V4.9)', () => {
    it('keeps the section closed for a plain connection and sends nothing from it', async () => {
      const { host } = await withState();
      const drafts: ConnectionDraft[] = [];
      host.handle('save', (draft) => {
        drafts.push(draft);
        return { connectionId: 'c1' };
      });
      const section = screen
        .getByText('Session: timeouts, keep-alive, init SQL')
        .closest('details');
      expect(section?.open).toBe(false);
      await fireEvent.input(field('Name'), { target: { value: 'Local' } });
      await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => {
        expect(drafts).toHaveLength(1);
      });
      expect(drafts[0]?.input).not.toHaveProperty('options');
    });

    it('opens on a connection that sets options and sends what was typed', async () => {
      const { host } = await withState(
        newState({
          connectionId: 'c1',
          input: { name: 'L', driver: 'mysql', host: 'h', options: { timeZone: 'UTC' } },
        }),
      );
      const drafts: ConnectionDraft[] = [];
      host.handle('save', (draft) => {
        drafts.push(draft);
        return { connectionId: 'c1' };
      });
      const section = screen
        .getByText('Session: timeouts, keep-alive, init SQL')
        .closest('details');
      expect(section?.open).toBe(true);
      expect(field('Time zone').value).toBe('UTC');
      await fireEvent.input(field('Keep-alive, s'), { target: { value: '45' } });
      await fireEvent.input(screen.getByLabelText('Init SQL'), {
        target: { value: "SET SESSION sql_mode = 'ANSI'" },
      });
      await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => {
        expect(drafts).toHaveLength(1);
      });
      expect(drafts[0]?.input.options).toEqual({
        keepAlive: 45,
        timeZone: 'UTC',
        initSql: "SET SESSION sql_mode = 'ANSI'",
      });
    });

    it('shows only what the driver uses', async () => {
      await withState(newState({ input: { name: '', driver: 'sqlite', file: '/a.db' } }));
      expect(screen.queryByLabelText('Query timeout, s')).not.toBeNull();
      expect(screen.queryByLabelText('Init SQL')).not.toBeNull();
      for (const label of ['Connect timeout, s', 'Keep-alive, s', 'Time zone', 'Character set']) {
        expect(screen.queryByLabelText(label), label).toBeNull();
      }
    });

    it('marks a bad number after a save attempt and does not send it', async () => {
      const { host } = await withState();
      const save = vi.fn(() => ({ connectionId: 'c1' }));
      host.handle('save', save);
      await fireEvent.input(field('Name'), { target: { value: 'L' } });
      await fireEvent.input(field('Connect timeout, s'), { target: { value: '0' } });
      await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => {
        expect(screen.getByText('From 1 to 300 seconds')).toBeTruthy();
      });
      expect(save).not.toHaveBeenCalled();
    });
  });

  describe('visibility filter (V4.10)', () => {
    it('sends the typed patterns, schemas only for PostgreSQL', async () => {
      const { host } = await withState(
        newState({ input: { name: 'P', driver: 'postgres', host: 'h' } }),
      );
      const drafts: ConnectionDraft[] = [];
      host.handle('save', (draft) => {
        drafts.push(draft);
        return { connectionId: 'c1' };
      });
      await fireEvent.input(field('Databases'), { target: { value: 'app_*, !app_test' } });
      await fireEvent.input(field('Schemas'), { target: { value: 'public' } });
      await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => {
        expect(drafts).toHaveLength(1);
      });
      expect(drafts[0]?.input.filter).toEqual({
        databases: ['app_*', '!app_test'],
        schemas: ['public'],
      });
    });

    it('has no schemas for MySQL and no filter at all for SQLite', async () => {
      await withState();
      expect(screen.queryByLabelText('Databases')).not.toBeNull();
      expect(screen.queryByLabelText('Schemas')).toBeNull();
      await fireEvent.change(screen.getByLabelText('Database'), { target: { value: 'sqlite' } });
      await waitFor(() => {
        expect(screen.queryByText('Visible databases and schemas')).toBeNull();
      });
    });
  });
});

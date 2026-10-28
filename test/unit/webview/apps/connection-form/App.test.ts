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
  });
});

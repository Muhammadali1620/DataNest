import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import {
  serverFormProtocol,
  type ServerDraft,
  type ServerFormProtocol,
  type ServerFormState,
} from '../../../../../src/shared/protocols/server-form';
import { RpcPeer } from '../../../../../src/shared/rpc';
import App from '../../../../../webview/src/apps/server-form/App.svelte';
import { createTranslator } from '../../../../../webview/src/lib/i18n';
import { must } from '../../../../helpers/must';
import { createLinkedTransports, flush } from '../../../../helpers/rpc';

type HostPeer = RpcPeer<ServerFormProtocol['host'], ServerFormProtocol['webview']>;

function setup(lang = 'en') {
  const transports = createLinkedTransports();
  const host: HostPeer = new RpcPeer({
    local: serverFormProtocol.host,
    remote: serverFormProtocol.webview,
    transport: transports.host,
  });
  const rpc = new RpcPeer({
    local: serverFormProtocol.webview,
    remote: serverFormProtocol.host,
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

const blank: ServerFormState = { storedSsh: [] };

const saved: ServerFormState = {
  serverId: 'abc',
  input: {
    name: 'Staging',
    startPath: '/var/www',
    ssh: { id: 'main', host: 'stage.example.com', port: 2200, user: 'deploy', auth: 'password' },
  },
  storedSsh: [{ hopId: 'main', password: true, passphrase: false }],
};

async function withState(state: ServerFormState = blank, lang = 'en') {
  const harness = setup(lang);
  await flush();
  harness.host.emit('state', state);
  await waitFor(() => {
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeNull();
  });
  return harness;
}

/** Fills the three fields a server cannot be saved without. */
async function fillRequired(): Promise<void> {
  await fireEvent.input(field('Name'), { target: { value: 'Web' } });
  await fireEvent.input(field('SSH host'), { target: { value: 'web.example.com' } });
  await fireEvent.input(field('SSH user'), { target: { value: 'deploy' } });
}

describe('server form App', () => {
  it('tells the host it is ready and waits for the state', async () => {
    const { ready } = setup();
    await flush();
    expect(ready).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Loading…')).toBeTruthy();
  });

  it('shows a blank form for a new server, with the title and the sections', async () => {
    await withState();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('New server');
    for (const section of ['Name and folder', 'Server and sign-in', 'Route to the server']) {
      expect(screen.getByRole('heading', { name: section })).toBeTruthy();
    }
    expect(field('Name').value).toBe('');
    expect(field('SSH host').value).toBe('');
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
    expect(screen.queryByTestId('notice')).toBeNull();
  });

  it('fills the form from a saved server and says its password is saved', async () => {
    await withState(saved);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Edit server');
    expect(field('Name').value).toBe('Staging');
    expect(field('Start folder').value).toBe('/var/www');
    expect(field('SSH host').value).toBe('stage.example.com');
    expect(field('SSH port').value).toBe('2200');
    expect(field('SSH user').value).toBe('deploy');
    expect(screen.getByText('A password is saved; leave empty to keep it')).toBeTruthy();
    expect(field('SSH password').value).toBe('');
  });

  it('shows the form in Russian', async () => {
    await withState(blank, 'ru');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Новый сервер');
    expect(screen.getByRole('button', { name: 'Сохранить' })).toBeTruthy();
  });

  it('replaces what is on screen with a fresh state of the host', async () => {
    const { host } = await withState();
    await fireEvent.input(field('Name'), { target: { value: 'typed' } });
    host.emit('state', saved);
    await waitFor(() => {
      expect(field('Name').value).toBe('Staging');
    });
  });

  describe('saving', () => {
    it('does not ask the host while a required field is empty, and marks the fields', async () => {
      const { host } = await withState();
      const save = vi.fn(() => ({ serverId: 'x' }));
      host.handle('save', save);
      await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      expect(save).not.toHaveBeenCalled();
      expect(notice()).toBe('Fill in the highlighted fields');
      expect(screen.getByText('Give the server a name')).toBeTruthy();
      expect(field('Name').getAttribute('aria-invalid')).toBe('true');
      expect(field('SSH host').getAttribute('aria-invalid')).toBe('true');
    });

    it('stays quiet about problems until the first attempt', async () => {
      await withState();
      expect(screen.queryByText('Give the server a name')).toBeNull();
      expect(field('Name').getAttribute('aria-invalid')).not.toBe('true');
    });

    it('sends the server and the typed password, and says it was saved', async () => {
      const { host } = await withState();
      const drafts: ServerDraft[] = [];
      host.handle('save', (draft) => {
        drafts.push(draft);
        return { serverId: 'new' };
      });
      await fillRequired();
      await fireEvent.input(field('SSH password'), { target: { value: 'secret' } });
      await fireEvent.input(field('Start folder'), { target: { value: '/srv' } });
      await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => {
        expect(notice()).toBe('Server saved');
      });
      expect(drafts).toHaveLength(1);
      expect(drafts[0]?.input).toMatchObject({
        name: 'Web',
        startPath: '/srv',
        ssh: { host: 'web.example.com', user: 'deploy', auth: 'password' },
      });
      expect(drafts[0]?.ssh).toEqual([
        {
          hopId: drafts[0]?.input.ssh.id,
          password: { kind: 'set', value: 'secret' },
          passphrase: { kind: 'clear' },
        },
      ]);
    });

    it('keeps the saved password when none is typed', async () => {
      const { host } = await withState(saved);
      const drafts: ServerDraft[] = [];
      host.handle('save', (draft) => {
        drafts.push(draft);
        return { serverId: 'abc' };
      });
      await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => {
        expect(drafts).toHaveLength(1);
      });
      expect(drafts[0]?.ssh[0]).toMatchObject({ hopId: 'main', password: { kind: 'keep' } });
    });

    it('sends read-only and the colour', async () => {
      const { host } = await withState();
      const drafts: ServerDraft[] = [];
      host.handle('save', (draft) => {
        drafts.push(draft);
        return { serverId: 'x' };
      });
      await fillRequired();
      await fireEvent.click(screen.getByLabelText('Read-only'));
      await fireEvent.change(screen.getByLabelText('Color'), { target: { value: 'green' } });
      await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => {
        expect(drafts).toHaveLength(1);
      });
      expect(drafts[0]?.input).toMatchObject({ readOnly: true, color: 'green' });
    });

    it('shows what went wrong and lets the user try again', async () => {
      const { host } = await withState();
      let attempts = 0;
      host.handle('save', () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('Storage is full');
        }
        return { serverId: 'x' };
      });
      await fillRequired();
      await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => {
        expect(notice()).toBe('Storage is full');
      });
      await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => {
        expect(notice()).toBe('Server saved');
      });
    });

    it('submits with the Enter key of a field, like a click on Save', async () => {
      const { host } = await withState();
      const save = vi.fn(() => ({ serverId: 'x' }));
      host.handle('save', save);
      await fillRequired();
      const form = field('Name').closest('form');
      expect(form).not.toBeNull();
      await fireEvent.submit(must(form));
      await waitFor(() => {
        expect(save).toHaveBeenCalledTimes(1);
      });
    });

    it('disables the buttons while the host works, and says so', async () => {
      const { host } = await withState();
      let release: (value: { serverId: string }) => void = () => undefined;
      host.handle(
        'save',
        () =>
          new Promise<{ serverId: string }>((resolve) => {
            release = resolve;
          }),
      );
      await fillRequired();
      await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Saving…' })).toBeTruthy();
      });
      expect(screen.getByRole('button', { name: 'Test connection' }).hasAttribute('disabled')).toBe(
        true,
      );
      release({ serverId: 'x' });
      await waitFor(() => {
        expect(notice()).toBe('Server saved');
      });
    });
  });

  describe('testing the connection', () => {
    it('tells where the server logged in', async () => {
      const { host } = await withState();
      host.handle('test', () => ({ home: '/home/deploy', hops: 1 }));
      await fillRequired();
      await fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
      await waitFor(() => {
        expect(notice()).toBe('Logged in; the login folder is /home/deploy');
      });
    });

    it('tells how many jump hosts the way led through', async () => {
      const { host } = await withState();
      host.handle('test', () => ({ home: '/root', hops: 3 }));
      await fillRequired();
      await fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
      await waitFor(() => {
        expect(notice()).toBe('Logged in through 2 jump hosts; the login folder is /root');
      });
    });

    it('shows the refusal of the server', async () => {
      const { host } = await withState();
      host.handle('test', () => {
        throw new Error('SSH login failed for deploy@web.example.com:22');
      });
      await fillRequired();
      await fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
      await waitFor(() => {
        expect(notice()).toBe('SSH login failed for deploy@web.example.com:22');
      });
      expect(screen.getByTestId('notice').classList.contains('error')).toBe(true);
    });

    it('does not ask the host before the form is complete', async () => {
      const { host } = await withState();
      const test = vi.fn(() => ({ home: '/', hops: 1 }));
      host.handle('test', test);
      await fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
      expect(test).not.toHaveBeenCalled();
      expect(notice()).toBe('Fill in the highlighted fields');
    });
  });

  describe('the way to the server', () => {
    it('adds, orders and removes jump hosts, and sends them in order', async () => {
      const { host } = await withState();
      const drafts: ServerDraft[] = [];
      host.handle('save', (draft) => {
        drafts.push(draft);
        return { serverId: 'x' };
      });
      await fillRequired();
      const add = screen.getByTestId('add-jump');
      await fireEvent.click(add);
      await fireEvent.click(add);
      await fireEvent.click(add);
      const hosts = screen.getAllByLabelText(/^Jump \d: SSH host$/u);
      const users = screen.getAllByLabelText(/^Jump \d: SSH user$/u);
      expect(hosts).toHaveLength(3);
      for (const [index, name] of ['j1', 'j2', 'j3'].entries()) {
        await fireEvent.input(must(hosts[index]), { target: { value: name } });
        await fireEvent.input(must(users[index]), { target: { value: 'hop' } });
      }
      await fireEvent.click(screen.getByRole('button', { name: 'Jump 2: Move up' }));
      await fireEvent.click(screen.getByRole('button', { name: 'Jump 3: Remove' }));
      await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => {
        expect(drafts).toHaveLength(1);
      });
      const ssh = drafts[0]?.input.ssh;
      expect(ssh?.host).toBe('web.example.com');
      expect(ssh?.jumps?.map((hop) => hop.host)).toEqual(['j2', 'j1']);
      expect(drafts[0]?.ssh.map((change) => change.hopId)).toEqual([
        ...(ssh?.jumps ?? []).map((hop) => hop.id),
        ssh?.id,
      ]);
    });

    it('stops offering jump hosts at the limit', async () => {
      await withState();
      for (let index = 0; index < 5; index += 1) {
        await fireEvent.click(screen.getByTestId('add-jump'));
      }
      expect(screen.queryByTestId('add-jump')).toBeNull();
    });

    it('marks a missing field of a jump host', async () => {
      await withState();
      await fillRequired();
      await fireEvent.click(screen.getByTestId('add-jump'));
      await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      expect(field('Jump 1: SSH host').getAttribute('aria-invalid')).toBe('true');
    });

    it('shows the jump hosts of a saved server', async () => {
      await withState({
        ...saved,
        input: {
          ...must(saved.input),
          ssh: {
            id: 'main',
            host: 'inner',
            user: 'me',
            auth: 'password',
            jumps: [{ id: 'j1', host: 'bastion', user: 'hop', auth: 'agent' }],
          },
        },
        storedSsh: [],
      });
      expect(field('Jump 1: SSH host').value).toBe('bastion');
    });

    it('offers the proxy fields only when the proxy is on', async () => {
      await withState();
      expect(screen.queryByTestId('proxy-host')).toBeNull();
      await fireEvent.click(screen.getByTestId('use-proxy'));
      expect(screen.getByTestId('proxy-host')).toBeTruthy();
      expect(screen.getByText('Default: 1080')).toBeTruthy();
      await fireEvent.change(screen.getByLabelText('Proxy type'), { target: { value: 'http' } });
      expect(screen.getByText('Default: 8080')).toBeTruthy();
    });

    it('sends the proxy and its password', async () => {
      const { host } = await withState();
      const drafts: ServerDraft[] = [];
      host.handle('save', (draft) => {
        drafts.push(draft);
        return { serverId: 'x' };
      });
      await fillRequired();
      await fireEvent.click(screen.getByTestId('use-proxy'));
      await fireEvent.input(screen.getByTestId('proxy-host'), { target: { value: 'px.example' } });
      await fireEvent.input(field('Proxy port'), { target: { value: '9050' } });
      await fireEvent.input(field('Proxy user'), { target: { value: 'me' } });
      await fireEvent.input(field('Proxy password'), { target: { value: 'ppw' } });
      await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => {
        expect(drafts).toHaveLength(1);
      });
      expect(drafts[0]?.input.proxy).toEqual({
        kind: 'socks5',
        host: 'px.example',
        port: 9050,
        user: 'me',
      });
      expect(drafts[0]?.proxyPassword).toEqual({ kind: 'set', value: 'ppw' });
    });

    it('does not send a proxy that is on without a host', async () => {
      const { host } = await withState();
      const save = vi.fn(() => ({ serverId: 'x' }));
      host.handle('save', save);
      await fillRequired();
      await fireEvent.click(screen.getByTestId('use-proxy'));
      await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      expect(save).not.toHaveBeenCalled();
      expect(screen.getByTestId('proxy-host').getAttribute('aria-invalid')).toBe('true');
    });

    it('can erase the saved proxy password', async () => {
      const { host } = await withState({
        serverId: 'abc',
        input: {
          name: 'P',
          ssh: { id: 'main', host: 'h', user: 'u', auth: 'agent' },
          proxy: { kind: 'socks5', host: 'px', user: 'me' },
        },
        storedSsh: [],
        hasStoredProxyPassword: true,
      });
      const drafts: ServerDraft[] = [];
      host.handle('save', (draft) => {
        drafts.push(draft);
        return { serverId: 'abc' };
      });
      expect(screen.getByText('A password is saved; leave empty to keep it')).toBeTruthy();
      await fireEvent.click(screen.getByLabelText('Remove the saved password'));
      await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => {
        expect(drafts).toHaveLength(1);
      });
      expect(drafts[0]?.proxyPassword).toEqual({ kind: 'clear' });
    });
  });

  describe('a key login', () => {
    it('takes the path the key dialog gives', async () => {
      const { host } = await withState();
      host.handle('pickKeyFile', () => ({ file: '/home/me/.ssh/id_ed25519' }));
      await fireEvent.change(screen.getByLabelText('Sign in with'), { target: { value: 'key' } });
      await fireEvent.click(screen.getByRole('button', { name: 'Browse…' }));
      await waitFor(() => {
        expect(field('Private key file').value).toBe('/home/me/.ssh/id_ed25519');
      });
    });

    it('keeps what was typed when the dialog is dismissed', async () => {
      const { host } = await withState();
      host.handle('pickKeyFile', () => ({}));
      await fireEvent.change(screen.getByLabelText('Sign in with'), { target: { value: 'key' } });
      await fireEvent.input(field('Private key file'), { target: { value: '~/.ssh/id' } });
      await fireEvent.click(screen.getByRole('button', { name: 'Browse…' }));
      await flush();
      expect(field('Private key file').value).toBe('~/.ssh/id');
    });

    it('shows the error of the dialog', async () => {
      const { host } = await withState();
      host.handle('pickKeyFile', () => {
        throw new Error('No dialog');
      });
      await fireEvent.change(screen.getByLabelText('Sign in with'), { target: { value: 'key' } });
      await fireEvent.click(screen.getByRole('button', { name: 'Browse…' }));
      await waitFor(() => {
        expect(notice()).toBe('No dialog');
      });
    });
  });

  it('asks the host to close when Cancel is pressed', async () => {
    const { closed } = await withState();
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await flush();
    expect(closed).toHaveBeenCalledTimes(1);
  });
});

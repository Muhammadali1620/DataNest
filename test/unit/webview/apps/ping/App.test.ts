import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import { pingProtocol, type PingProtocol } from '../../../../../src/shared/protocols/ping';
import { RpcPeer } from '../../../../../src/shared/rpc';
import App from '../../../../../webview/src/apps/ping/App.svelte';
import { createTranslator } from '../../../../../webview/src/lib/i18n';
import { createLinkedTransports, flush } from '../../../../helpers/rpc';

type HostPeer = RpcPeer<PingProtocol['host'], PingProtocol['webview']>;

function setup(lang = 'en') {
  const transports = createLinkedTransports();
  const host: HostPeer = new RpcPeer({
    local: pingProtocol.host,
    remote: pingProtocol.webview,
    transport: transports.host,
  });
  const rpc = new RpcPeer({
    local: pingProtocol.webview,
    remote: pingProtocol.host,
    transport: transports.webview,
  });
  const ready = vi.fn();
  host.on('ready', ready);
  const view = render(App, { props: { rpc, t: createTranslator(lang) } });
  return { host, rpc, ready, view };
}

function logLines(): string[] {
  return screen.getAllByRole('listitem').map((item) => item.textContent);
}

describe('ping App', () => {
  it('tells the host it is ready after mounting', async () => {
    const { ready } = setup();
    await flush();
    expect(ready).toHaveBeenCalledOnce();
  });

  it('waits for the host until the first notice arrives', async () => {
    const { host } = setup();
    expect(screen.getByTestId('status').textContent).toBe('Waiting for the extension host…');
    // Nothing to show yet: no empty log.
    expect(screen.queryByRole('list')).toBeNull();
    host.emit('notice', { text: 'Hello from host' });
    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('Connected');
    });
    expect(logLines()).toEqual(['Hello from host']);
  });

  it('sends the typed message and shows the numbered reply', async () => {
    const { host } = setup();
    let count = 0;
    host.handle('ping', ({ text }) => ({ reply: `pong: ${text}`, count: ++count }));
    const input = screen.getByRole('textbox');
    await fireEvent.input(input, { target: { value: 'Привет' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Ping' }));
    await waitFor(() => {
      expect(logLines()).toEqual(['Reply #1: pong: Привет']);
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Ping' }));
    await waitFor(() => {
      expect(logLines()).toEqual(['Reply #1: pong: Привет', 'Reply #2: pong: Привет']);
    });
  });

  it('disables the button while waiting for the reply', async () => {
    const { host } = setup();
    let answer: (() => void) | undefined;
    host.handle(
      'ping',
      () =>
        new Promise((resolve) => {
          answer = () => {
            resolve({ reply: 'late', count: 1 });
          };
        }),
    );
    const button = screen.getByRole('button', { name: 'Ping' });
    await fireEvent.click(button);
    await waitFor(() => {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    });
    answer?.();
    await waitFor(() => {
      expect((button as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it('shows errors from the host', async () => {
    const { host } = setup();
    host.handle('ping', () => {
      throw new Error('host is busy');
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Ping' }));
    await waitFor(() => {
      expect(logLines()).toEqual(['Error: host is busy']);
    });
  });

  it('shows rejections that are not Error objects', async () => {
    const rpc = {
      handle: () => ({ dispose: () => undefined }),
      on: () => ({ dispose: () => undefined }),
      emit: () => undefined,
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- on purpose
      request: () => Promise.reject('plain failure'),
    } as unknown as RpcPeer<PingProtocol['webview'], PingProtocol['host']>;
    render(App, { props: { rpc, t: createTranslator('en') } });
    await fireEvent.click(screen.getByRole('button', { name: 'Ping' }));
    await waitFor(() => {
      expect(logLines()).toEqual(['Error: plain failure']);
    });
  });

  it('answers echo requests from the host', async () => {
    const { host } = setup();
    await flush();
    await expect(host.request('echo', { text: 'round trip 🚀' })).resolves.toEqual({
      text: 'round trip 🚀',
    });
  });

  it('limits the input to what the protocol accepts', () => {
    setup();
    expect(screen.getByRole('textbox').getAttribute('maxlength')).toBe('1000');
  });

  it('renders host text as text, not HTML', async () => {
    const { host } = setup();
    host.emit('notice', { text: '<img src=x onerror=alert(1)>' });
    await waitFor(() => {
      expect(logLines()).toEqual(['<img src=x onerror=alert(1)>']);
    });
    expect(document.querySelector('img')).toBeNull();
  });

  it('uses the page language', () => {
    setup('ru');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('DataNest: проверка связи');
    expect(screen.getByRole('button').textContent).toBe('Отправить');
  });

  it('stops handling host requests after unmounting', async () => {
    const { host, view } = setup();
    await flush();
    view.unmount();
    await expect(host.request('echo', { text: 'x' })).rejects.toMatchObject({
      code: 'unknown-method',
    });
  });
});

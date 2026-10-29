import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import {
  redisConsoleProtocol,
  type RedisConsoleProtocol,
  type RedisConsoleState,
} from '../../../../../src/shared/protocols/redis-console';
import { RpcPeer } from '../../../../../src/shared/rpc';
import App from '../../../../../webview/src/apps/redis-console/App.svelte';
import { createTranslator } from '../../../../../webview/src/lib/i18n';
import { createLinkedTransports, flush } from '../../../../helpers/rpc';

type HostPeer = RpcPeer<RedisConsoleProtocol['host'], RedisConsoleProtocol['webview']>;

const STATE: RedisConsoleState = {
  connectionName: 'Cache',
  database: 0,
  mode: 'standalone',
  readOnly: false,
  production: true,
  commands: [
    { name: 'GET', syntax: 'key', summary: 'Gets a value', keyFirst: true },
    { name: 'GETDEL', syntax: 'key', keyFirst: true },
    { name: 'PING', keyFirst: false },
  ],
  history: ['PING'],
};

async function open(state: RedisConsoleState = STATE) {
  const transports = createLinkedTransports();
  const host: HostPeer = new RpcPeer({
    local: redisConsoleProtocol.host,
    remote: redisConsoleProtocol.webview,
    transport: transports.host,
  });
  const rpc = new RpcPeer({
    local: redisConsoleProtocol.webview,
    remote: redisConsoleProtocol.host,
    transport: transports.webview,
  });
  const ready = vi.fn();
  host.on('ready', ready);
  render(App, { props: { rpc, t: createTranslator('en') } });
  await flush();
  expect(ready).toHaveBeenCalled();
  host.emit('state', state);
  const input = await screen.findByLabelText<HTMLTextAreaElement>('Command');
  return { host, input };
}

describe('Redis console page', () => {
  it('shows where it runs, and marks production', async () => {
    await open();
    expect(screen.getByTestId('where').textContent).toContain('Cache · db0');
    expect(screen.getByText('production')).toBeTruthy();
  });

  it('runs the line on Enter and shows the output', async () => {
    const { host, input } = await open();
    const run = vi.fn(({ text }: { text: string }) => {
      host.emit('output', { command: text, lines: ['"PONG"'], error: false, ms: 1 });
      return {};
    });
    host.handle('run', run);
    await fireEvent.input(input, { target: { value: 'PING' } });
    await fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(screen.getByTestId('output').textContent).toContain('"PONG"');
    });
    expect(run).toHaveBeenCalledWith({ text: 'PING' });
    expect(input.value).toBe('');
  });

  it('runs on Enter even while suggestions show, and takes one after the arrows', async () => {
    const { host, input } = await open();
    const run = vi.fn(() => ({}));
    host.handle('run', run);
    await fireEvent.input(input, { target: { value: 'GE' } });
    await screen.findAllByRole('option');
    await fireEvent.keyDown(input, { key: 'ArrowDown' });
    await fireEvent.keyDown(input, { key: 'Enter' });
    expect(input.value).toBe('GETDEL ');
    expect(run).not.toHaveBeenCalled();
  });

  it('suggests commands and completes with Tab', async () => {
    const { input } = await open();
    await fireEvent.input(input, { target: { value: 'ge' } });
    const options = await screen.findAllByRole('option');
    expect(options.map((option) => option.textContent.replace(/\s+/g, ' ').trim())).toEqual([
      'GET Gets a value',
      'GETDEL',
    ]);
    await fireEvent.keyDown(input, { key: 'ArrowDown' });
    await fireEvent.keyDown(input, { key: 'Tab' });
    expect(input.value).toBe('GETDEL ');
    expect(screen.getByTestId('syntax').textContent).toContain('GETDEL key');
  });

  it('suggests key names where a key goes', async () => {
    const { host, input } = await open();
    host.handle('completeKeys', ({ prefix }) => ({ keys: [`${prefix}1`, `${prefix} spaced`] }));
    await fireEvent.input(input, { target: { value: 'GET user:' } });
    const options = await screen.findAllByRole('option');
    expect(options.map((option) => option.textContent.trim())).toEqual(['user:1', 'user: spaced']);
    const [, spaced] = options;
    expect(spaced).toBeDefined();
    await fireEvent.mouseDown(spaced ?? input);
    expect(input.value).toBe('GET "user: spaced" ');
  });

  it('walks the history with the arrows', async () => {
    const { input } = await open();
    await fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input.value).toBe('PING');
    await fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.value).toBe('');
  });

  it('follows SELECT, clears, and stops a running command', async () => {
    const { host, input } = await open();
    let finish: () => void = () => undefined;
    host.handle(
      'run',
      () =>
        new Promise((resolve) => {
          finish = () => {
            resolve({});
          };
        }),
    );
    const stop = vi.fn(() => {
      finish();
      return {};
    });
    host.handle('stop', stop);
    host.emit('database', { database: 4 });
    await waitFor(() => {
      expect(screen.getByTestId('where').textContent).toContain('db4');
    });
    host.emit('output', { command: 'x', lines: ['(error) y'], error: true });
    await fireEvent.input(input, { target: { value: 'BLPOP q 0' } });
    await fireEvent.keyDown(input, { key: 'Enter' });
    const stopButton = screen.getByRole('button', { name: 'Stop' });
    await waitFor(() => {
      expect((stopButton as HTMLButtonElement).disabled).toBe(false);
    });
    await fireEvent.click(stopButton);
    await waitFor(() => {
      expect(stop).toHaveBeenCalled();
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.getByTestId('output').textContent).not.toContain('(error) y');
  });
});

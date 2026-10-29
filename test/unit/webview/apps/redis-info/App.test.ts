import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import {
  redisInfoProtocol,
  type RedisInfoProtocol,
  type RedisInfoState,
} from '../../../../../src/shared/protocols/redis-info';
import { RpcPeer } from '../../../../../src/shared/rpc';
import App from '../../../../../webview/src/apps/redis-info/App.svelte';
import { createTranslator } from '../../../../../webview/src/lib/i18n';
import { createLinkedTransports, flush } from '../../../../helpers/rpc';

type HostPeer = RpcPeer<RedisInfoProtocol['host'], RedisInfoProtocol['webview']>;

const node = (name: string, version: string) => ({
  name,
  sections: [
    {
      name: 'Server',
      fields: [
        ['redis_version', version],
        ['os', 'Linux'],
      ],
    },
    { name: 'Memory', fields: [['used_memory', '2048']] },
  ],
  summary: {
    version,
    mode: 'cluster',
    role: 'master',
    uptimeSeconds: 125,
    clients: 3,
    usedMemory: 2048,
    maxMemory: 4096,
    opsPerSecond: 7,
    hitRate: 0.5,
    keys: 1234,
  },
});

const STATE: RedisInfoState = {
  connectionName: 'Cluster',
  nodes: [node('master 1', '7.4.6'), node('master 2', '7.4.5')],
  at: 0,
};

async function open() {
  const transports = createLinkedTransports();
  const host: HostPeer = new RpcPeer({
    local: redisInfoProtocol.host,
    remote: redisInfoProtocol.webview,
    transport: transports.host,
  });
  const rpc = new RpcPeer({
    local: redisInfoProtocol.webview,
    remote: redisInfoProtocol.host,
    transport: transports.webview,
  });
  host.on('ready', () => {
    host.emit('state', STATE);
  });
  render(App, { props: { rpc, t: createTranslator('en') } });
  await flush();
  await screen.findByRole('heading', { level: 1 });
  return host;
}

describe('Redis server info page', () => {
  it('shows the main numbers of the first master', async () => {
    await open();
    const cards = screen.getByTestId('cards').textContent;
    for (const part of ['7.4.6', 'cluster · master', '2m 5s', '2.0 KB', '4.0 KB', '50.0%']) {
      expect(cards, part).toContain(part);
    }
    // The thousands separator follows the editor's locale.
    expect(cards).toMatch(/Keys\s*1\D?234/u);
  });

  it('switches between masters', async () => {
    await open();
    await fireEvent.click(screen.getByRole('tab', { name: 'master 2' }));
    await waitFor(() => {
      expect(screen.getByTestId('cards').textContent).toContain('7.4.5');
    });
  });

  it('filters the fields', async () => {
    await open();
    expect(screen.getByRole('heading', { name: 'Memory', level: 2 })).toBeTruthy();
    await fireEvent.input(screen.getByLabelText('Filter fields'), { target: { value: 'linux' } });
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Memory', level: 2 })).toBeNull();
    });
    await fireEvent.input(screen.getByLabelText('Filter fields'), {
      target: { value: 'nothing-like-it' },
    });
    expect(await screen.findByText('No field matches')).toBeTruthy();
  });

  it('reads again on Refresh, and shows a failure', async () => {
    const host = await open();
    const refresh = vi.fn(() => {
      throw new Error('NOPERM info');
    });
    host.handle('refresh', refresh);
    await fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(refresh).toHaveBeenCalled();
  });
});

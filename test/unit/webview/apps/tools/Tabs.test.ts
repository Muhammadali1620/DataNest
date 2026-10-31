import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toolsProtocol, type ToolsProtocol } from '../../../../../src/shared/protocols/tools';
import { RpcPeer } from '../../../../../src/shared/rpc';
import type { SettingGroup } from '../../../../../src/shared/tools/settings-map';
import App from '../../../../../webview/src/apps/tools/App.svelte';
import { createToolsState, type StateApi } from '../../../../../webview/src/apps/tools/state';
import { createTranslator } from '../../../../../webview/src/lib/i18n';
import { createLinkedTransports, flush } from '../../../../helpers/rpc';

type HostPeer = RpcPeer<ToolsProtocol['host'], ToolsProtocol['webview']>;

interface Options {
  api?: StateApi;
  language?: string;
}

async function open(setup: (host: HostPeer) => void = () => undefined, options: Options = {}) {
  const transports = createLinkedTransports();
  const host: HostPeer = new RpcPeer({
    local: toolsProtocol.host,
    remote: toolsProtocol.webview,
    transport: transports.host,
  });
  const rpc = new RpcPeer({
    local: toolsProtocol.webview,
    remote: toolsProtocol.host,
    transport: transports.webview,
  });
  host.handle('interfaces', () => ({
    items: [
      { name: 'eth0', address: '192.168.1.5', family: 'IPv4' as const, mac: 'aa', internal: false },
      { name: 'eth0', address: 'fe80::1', family: 'IPv6' as const, mac: 'aa', internal: false },
      { name: 'lo', address: '127.0.0.1', family: 'IPv4' as const, mac: '00', internal: true },
    ],
    hostname: 'build-box',
  }));
  setup(host);
  const state = createToolsState(options.api);
  render(App, { props: { rpc, t: createTranslator(options.language ?? 'en'), state } });
  await flush();
  return { host, state };
}

const goTo = (tab: string) => fireEvent.click(screen.getByRole('tab', { name: tab }));
const byId = (id: string): HTMLElement => screen.getByTestId(id);
const inputOf = (id: string): HTMLInputElement => {
  const element = byId(id).querySelector('input');
  if (element === null) {
    throw new Error(`No input in ${id}`);
  }
  return element;
};
const selectOf = (id: string): HTMLSelectElement => {
  const element = byId(id).querySelector('select');
  if (element === null) {
    throw new Error(`No select in ${id}`);
  }
  return element;
};

afterEach(() => {
  cleanup();
});

describe('Network: overview', () => {
  it('shows the host name and the local addresses at once, and no public address yet', async () => {
    const publicIp = vi.fn(() => ({ ipv4: '203.0.113.7' }));
    await open((host) => host.handle('publicIp', publicIp));
    await goTo('Network');
    await waitFor(() => {
      expect(byId('hostname').textContent).toBe('build-box');
    });
    expect(screen.getByText('IPv4 192.168.1.5')).toBeTruthy();
    expect(screen.getByText('IPv6 fe80::1')).toBeTruthy();
    expect(byId('public-v4').textContent.trim()).toBe('-');
    expect(publicIp).not.toHaveBeenCalled();
  });

  it('asks for the public address only on the button and says which service answers', async () => {
    const publicIp = vi.fn(() => ({ ipv4: '203.0.113.7', ipv6: '2001:db8::1' }));
    const { host } = await open((peer) => peer.handle('publicIp', publicIp));
    const copied = vi.fn();
    host.on('copyText', copied);
    await goTo('Network');
    expect(screen.getByText(/api\.ipify\.org/u)).toBeTruthy();
    await fireEvent.click(byId('ip-run'));
    await waitFor(() => {
      expect(byId('public-v4').textContent).toContain('203.0.113.7');
    });
    expect(byId('public-v6').textContent).toContain('2001:db8::1');
    expect(publicIp).toHaveBeenCalledOnce();
    await fireEvent.click(within(byId('public-v4')).getByRole('button', { name: 'Copy' }));
    await waitFor(() => {
      expect(copied).toHaveBeenCalledWith({ text: '203.0.113.7' });
    });
  });

  it('shows why the lookup failed', async () => {
    await open((host) => host.handle('publicIp', () => ({ error: 'timeout' as const })));
    await goTo('Network');
    await fireEvent.click(byId('ip-run'));
    await waitFor(() => {
      expect(byId('ip-problem').textContent).toContain('No answer in time');
    });
  });
});

describe('Network: DNS lookup', () => {
  it('uses the system resolver by default', async () => {
    const dnsLookup = vi.fn(() => ({ addresses: [{ address: '127.0.0.1', family: 4 as const }] }));
    const dohLookup = vi.fn(() => ({ records: [] }));
    await open((host) => {
      host.handle('dnsLookup', dnsLookup);
      host.handle('dohLookup', dohLookup);
    });
    await goTo('Network');
    await fireEvent.click(byId('dns-run'));
    await waitFor(() => {
      expect(byId('dns-result').textContent).toContain('127.0.0.1');
    });
    expect(dnsLookup).toHaveBeenCalledWith({ host: 'localhost' });
    expect(dohLookup).not.toHaveBeenCalled();
    expect(screen.queryByTestId('dns-provider')).toBeNull();
    expect(screen.queryByTestId('doh-note')).toBeNull();
  });

  it('asks Cloudflare or Google over HTTPS when chosen, with the record type, and names the server', async () => {
    const dohLookup = vi.fn((_params: { host: string; type: string; provider: string }) => {
      return {
        records: [{ name: 'example.com', type: 'MX', ttl: 60, data: '10 mail.example.com' }],
      };
    });
    await open((host) => host.handle('dohLookup', dohLookup));
    await goTo('Network');
    await fireEvent.click(byId('dns-mode-doh'));
    expect(byId('doh-note').textContent).toContain('cloudflare-dns.com');
    await fireEvent.change(byId('dns-provider'), { target: { value: 'google' } });
    expect(byId('doh-note').textContent).toContain('dns.google');
    await fireEvent.change(byId('dns-type'), { target: { value: 'MX' } });
    await fireEvent.input(byId('dns-host'), { target: { value: 'example.com' } });
    await fireEvent.click(byId('dns-run'));
    await waitFor(() => {
      expect(byId('dns-result').textContent).toContain('10 mail.example.com');
    });
    expect(byId('dns-result').textContent).toContain('TTL 60');
    expect(dohLookup).toHaveBeenCalledWith({ host: 'example.com', type: 'MX', provider: 'google' });
  });

  it('refuses a bad host name before it asks anyone', async () => {
    const dohLookup = vi.fn(() => ({ records: [] }));
    await open((host) => host.handle('dohLookup', dohLookup));
    await goTo('Network');
    await fireEvent.click(byId('dns-mode-doh'));
    await fireEvent.input(byId('dns-host'), { target: { value: 'not a host' } });
    await fireEvent.click(byId('dns-run'));
    expect(byId('dns-problem').textContent).toContain('not a valid host name');
    expect(dohLookup).not.toHaveBeenCalled();
  });

  it('shows the error of an answer that holds no records', async () => {
    await open((host) =>
      host.handle('dohLookup', () => ({ records: [], error: 'not-found' as const })),
    );
    await goTo('Network');
    await fireEvent.click(byId('dns-mode-doh'));
    await fireEvent.click(byId('dns-run'));
    await waitFor(() => {
      expect(byId('dns-result').textContent).toContain('The name was not found');
    });
  });
});

describe('Network: ping', () => {
  it('runs the system ping, shows its lines as they come and sums up', async () => {
    let sender: HostPeer | undefined;
    const icmpPing = vi.fn((params: { runId: number; host: string }) => {
      const send = (text: string, reply: boolean, ms?: number): void => {
        sender?.emit('pingLine', {
          runId: params.runId,
          text,
          reply,
          ...(ms === undefined ? {} : { ms }),
        });
      };
      send('PING 8.8.8.8 (8.8.8.8) 56(84) bytes of data.', false);
      send('64 bytes from 8.8.8.8: icmp_seq=1 ttl=57 time=11 ms', true, 11);
      send('64 bytes from 8.8.8.8: icmp_seq=2 ttl=57 time=13 ms', true, 13);
      return {
        available: true,
        attempts: [{ ok: true, ms: 11 }, { ok: true, ms: 13 }, { ok: false }],
      };
    });
    await open((peer) => {
      sender = peer;
      peer.handle('icmpPing', icmpPing);
    });
    await goTo('Network');
    await fireEvent.click(byId('icmp-run'));
    await waitFor(() => {
      expect(byId('icmp-result').textContent).toContain('2 of 3 connected');
    });
    expect(icmpPing).toHaveBeenCalledWith(
      expect.objectContaining({ host: '8.8.8.8', count: 4, timeoutMs: 2000, resolve: 'direct' }),
    );
    expect(byId('icmp-output').textContent).toContain('time=13 ms');
    expect(byId('icmp-stats').textContent).toContain('11');
  });

  it('ignores lines of an older run', async () => {
    await open((peer) =>
      peer.handle('icmpPing', (params) => {
        peer.emit('pingLine', { runId: params.runId + 99, text: 'stale line', reply: false });
        peer.emit('pingLine', { runId: params.runId, text: 'fresh line', reply: false });
        return { available: true, attempts: [{ ok: false }] };
      }),
    );
    await goTo('Network');
    await fireEvent.click(byId('icmp-run'));
    await waitFor(() => {
      expect(byId('icmp-output').textContent).toContain('fresh line');
    });
    expect(byId('icmp-output').textContent).not.toContain('stale');
  });

  it('offers a stop while it runs and cancels the run', async () => {
    let finish: (value: { available: boolean; attempts: { ok: boolean }[] }) => void = () =>
      undefined;
    const icmpCancel = vi.fn(() => ({}));
    await open((peer) => {
      peer.handle('icmpPing', () => new Promise((resolve) => (finish = resolve)));
      peer.handle('icmpCancel', icmpCancel);
    });
    await goTo('Network');
    await fireEvent.click(byId('icmp-run'));
    await waitFor(() => {
      expect(screen.queryByTestId('icmp-stop')).not.toBeNull();
    });
    expect(screen.queryByTestId('icmp-run')).toBeNull();
    await fireEvent.click(byId('icmp-stop'));
    await waitFor(() => {
      expect(icmpCancel).toHaveBeenCalledOnce();
    });
    finish({ available: true, attempts: [{ ok: false }] });
    await waitFor(() => {
      expect(screen.queryByTestId('icmp-run')).not.toBeNull();
    });
  });

  it('tells the user to use the TCP ping when the program is missing', async () => {
    await open((peer) => peer.handle('icmpPing', () => ({ available: false, attempts: [] })));
    await goTo('Network');
    await fireEvent.click(byId('icmp-run'));
    await waitFor(() => {
      expect(byId('icmp-missing').textContent).toContain('TCP ping');
    });
    expect(screen.queryByTestId('icmp-result')).toBeNull();
  });

  it('can resolve the name over HTTPS and says who is asked', async () => {
    const icmpPing = vi.fn(() => ({
      available: true,
      attempts: [{ ok: true, ms: 1 }],
      resolved: '192.0.2.1',
    }));
    await open((peer) => peer.handle('icmpPing', icmpPing));
    await goTo('Network');
    await fireEvent.click(byId('icmp-doh'));
    expect(screen.getAllByText(/cloudflare-dns\.com/u).length).toBeGreaterThan(0);
    await fireEvent.input(byId('icmp-host'), { target: { value: 'example.com' } });
    await fireEvent.click(byId('icmp-run'));
    await waitFor(() => {
      expect(icmpPing).toHaveBeenCalledWith(
        expect.objectContaining({ host: 'example.com', resolve: 'doh', provider: 'cloudflare' }),
      );
    });
  });

  it('refuses a bad host, and shows an error of the host', async () => {
    const icmpPing = vi.fn(() => ({ available: true, attempts: [], error: 'not-found' as const }));
    await open((peer) => peer.handle('icmpPing', icmpPing));
    await goTo('Network');
    await fireEvent.input(byId('icmp-host'), { target: { value: '-c 100' } });
    await fireEvent.click(byId('icmp-run'));
    expect(byId('icmp-problem')).toBeTruthy();
    expect(icmpPing).not.toHaveBeenCalled();
    await fireEvent.input(byId('icmp-host'), { target: { value: 'nope.test' } });
    await fireEvent.click(byId('icmp-run'));
    await waitFor(() => {
      expect(byId('icmp-error').textContent).toContain('The name was not found');
    });
  });
});

describe('Network: layout and the old probes', () => {
  it('lays the cards out as one flow that the browser balances into columns', async () => {
    await open();
    await goTo('Network');
    const cards = [...document.querySelectorAll('.net > section')].map((card) =>
      card.getAttribute('aria-label'),
    );
    expect(cards).toEqual([
      'Overview',
      'Network interfaces',
      'Port check',
      'DNS lookup',
      'Ping',
      'TCP ping',
    ]);
  });

  it('says what leaves the machine and when', async () => {
    await open();
    expect(screen.getByText(/unless you start a check/u)).toBeTruthy();
  });
});

describe('the page remembers its place', () => {
  function memory() {
    let saved: unknown;
    const setState = vi.fn((next: unknown) => {
      saved = next;
    });
    return { api: { getState: () => saved, setState } satisfies StateApi, setState };
  }

  it('opens on the tab it was left on, with the inputs that were typed', async () => {
    const first = memory();
    await open(() => undefined, { api: first.api });
    await goTo('Network');
    await fireEvent.input(byId('port-host'), { target: { value: 'db.internal' } });
    await fireEvent.input(byId('port-number'), { target: { value: '5432' } });
    await waitFor(() => {
      expect(first.setState).toHaveBeenCalled();
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    cleanup();

    await open(() => undefined, { api: first.api });
    expect(screen.getByRole('tab', { name: 'Network' }).getAttribute('aria-selected')).toBe('true');
    expect((byId('port-host') as HTMLInputElement).value).toBe('db.internal');
    expect((byId('port-number') as HTMLInputElement).value).toBe('5432');
  });

  it('opens on General when nothing was remembered, or the tab is gone', async () => {
    await open(() => undefined, {
      api: {
        getState: () => ({ datanestTools: { tab: 'no-such-tab' } }),
        setState: () => undefined,
      },
    });
    expect(screen.getByRole('tab', { name: 'General' }).getAttribute('aria-selected')).toBe('true');
  });

  it('keeps the task manager search and sort', async () => {
    const first = memory();
    await open((host) => host.handle('processes', () => PROCESSES), { api: first.api });
    await goTo('Task manager');
    await fireEvent.click(byId('sort-pid'));
    await fireEvent.input(byId('tasks-search'), { target: { value: 'node' } });
    await new Promise((resolve) => setTimeout(resolve, 250));
    cleanup();
    await open((host) => host.handle('processes', () => PROCESSES), { api: first.api });
    expect((byId('tasks-search') as HTMLInputElement).value).toBe('node');
    expect(byId('sort-pid').closest('[role="columnheader"]')?.getAttribute('aria-sort')).toBe(
      'ascending',
    );
  });
});

const PROCESSES = {
  platform: 'linux',
  currentUser: 'alice',
  truncated: false,
  items: [
    {
      pid: 10,
      name: 'node',
      user: 'alice',
      cpu: 5,
      memoryKb: 2048,
      runtimeSec: 100,
      command: 'node server.js',
    },
    {
      pid: 20,
      name: 'postgres',
      user: 'postgres',
      cpu: 20,
      memoryKb: 90_000,
      runtimeSec: 9000,
      command: 'postgres -D /data',
    },
    {
      pid: 30,
      name: 'zsh',
      user: 'alice',
      cpu: 0.1,
      memoryKb: 512,
      runtimeSec: 5,
      command: '-zsh',
    },
  ],
};

describe('Task manager', () => {
  const pids = () =>
    [...document.querySelectorAll('[data-testid="tasks-table"] [data-pid]')].map((row) =>
      Number(row.getAttribute('data-pid')),
    );

  it('lists the processes, the biggest CPU first, with the platform and the user', async () => {
    const processes = vi.fn(() => PROCESSES);
    await open((host) => host.handle('processes', processes));
    await goTo('Task manager');
    await waitFor(() => {
      expect(pids()).toEqual([20, 10, 30]);
    });
    expect(byId('tasks-platform').textContent).toBe('linux');
    expect(byId('tasks-user').textContent).toBe('alice');
    expect(byId('tasks-count').textContent).toContain('3 of 3 processes');
    const row = document.querySelector('[data-pid="20"]');
    expect(row?.textContent).toContain('20.0%');
    expect(row?.textContent).toContain('87.9 MB');
    expect(row?.textContent).toContain('02:30:00');
  });

  it('searches by name, pid, user and command, and says when nothing matches', async () => {
    await open((host) => host.handle('processes', () => PROCESSES));
    await goTo('Task manager');
    await waitFor(() => {
      expect(pids()).toHaveLength(3);
    });
    await fireEvent.input(byId('tasks-search'), { target: { value: '/data' } });
    expect(pids()).toEqual([20]);
    await fireEvent.input(byId('tasks-search'), { target: { value: 'alice' } });
    expect(pids()).toEqual([10, 30]);
    await fireEvent.input(byId('tasks-search'), { target: { value: 'nothing like this' } });
    expect(pids()).toEqual([]);
    expect(byId('tasks-empty')).toBeTruthy();
  });

  it("shows only the current user's processes on request", async () => {
    await open((host) => host.handle('processes', () => PROCESSES));
    await goTo('Task manager');
    await waitFor(() => {
      expect(pids()).toHaveLength(3);
    });
    await fireEvent.click(byId('tasks-mine'));
    expect(pids()).toEqual([10, 30]);
    expect(byId('tasks-count').textContent).toContain('2 of 3 processes');
  });

  it('sorts by a column and flips the order on the second click', async () => {
    await open((host) => host.handle('processes', () => PROCESSES));
    await goTo('Task manager');
    await waitFor(() => {
      expect(pids()).toHaveLength(3);
    });
    await fireEvent.click(byId('sort-name'));
    expect(pids()).toEqual([10, 20, 30]);
    await fireEvent.click(byId('sort-name'));
    expect(pids()).toEqual([30, 20, 10]);
    await fireEvent.click(byId('sort-memory'));
    expect(pids()).toEqual([20, 10, 30]);
    expect(byId('sort-memory').closest('[role="columnheader"]')?.getAttribute('aria-sort')).toBe(
      'descending',
    );
    expect(byId('sort-name').closest('[role="columnheader"]')?.getAttribute('aria-sort')).toBe(
      'none',
    );
  });

  it('draws only the rows in view, even for thousands of processes', async () => {
    const many = {
      ...PROCESSES,
      items: Array.from({ length: 3000 }, (_, i) => ({
        pid: i + 2,
        name: `p${i}`,
        user: 'u',
        cpu: 1,
        command: `p${i}`,
      })),
    };
    await open((host) => host.handle('processes', () => many));
    await goTo('Task manager');
    await waitFor(() => {
      expect(byId('tasks-count').textContent).toContain('3000 of 3000');
    });
    expect(pids().length).toBeLessThan(40);
    expect(pids().length).toBeGreaterThan(5);
  });

  it('asks the host to end a process and says it was asked', async () => {
    const killProcess = vi.fn((_params: { pid: number; name: string; force: boolean }) => {
      return { ok: true };
    });
    await open((host) => {
      host.handle('processes', () => PROCESSES);
      host.handle('killProcess', killProcess);
    });
    await goTo('Task manager');
    await waitFor(() => {
      expect(pids()).toHaveLength(3);
    });
    await fireEvent.click(byId('end-10'));
    await waitFor(() => {
      expect(byId('tasks-message').textContent).toContain('node (PID 10)');
    });
    expect(killProcess).toHaveBeenCalledWith({ pid: 10, name: 'node', force: false });
    await fireEvent.click(byId('force-20'));
    await waitFor(() => {
      expect(killProcess).toHaveBeenLastCalledWith({ pid: 20, name: 'postgres', force: true });
    });
  });

  it('is silent when the user said no, and explains a refusal', async () => {
    const answers: { ok: boolean; error?: 'cancelled' | 'denied' | 'protected' }[] = [
      { ok: false, error: 'cancelled' },
      { ok: false, error: 'denied' },
      { ok: false, error: 'protected' },
    ];
    await open((host) => {
      host.handle('processes', () => PROCESSES);
      host.handle('killProcess', () => answers.shift() ?? { ok: true });
    });
    await goTo('Task manager');
    await waitFor(() => {
      expect(pids()).toHaveLength(3);
    });
    await fireEvent.click(byId('end-10'));
    await flush();
    expect(screen.queryByTestId('tasks-message')).toBeNull();
    await fireEvent.click(byId('end-10'));
    await waitFor(() => {
      expect(byId('tasks-message').textContent).toContain('No permission to end node (PID 10)');
    });
    await fireEvent.click(byId('end-10'));
    await waitFor(() => {
      expect(byId('tasks-message').textContent).toContain('runs the editor itself');
    });
  });

  it('has no force button on Windows, where there is one way to end a process', async () => {
    await open((host) => host.handle('processes', () => ({ ...PROCESSES, platform: 'win32' })));
    await goTo('Task manager');
    await waitFor(() => {
      expect(pids()).toHaveLength(3);
    });
    expect(screen.queryByTestId('force-10')).toBeNull();
    expect(screen.queryByTestId('end-10')).not.toBeNull();
  });

  it('refreshes by hand and shows a failure of the system tool', async () => {
    const processes = vi.fn(() => PROCESSES);
    await open((host) => host.handle('processes', processes));
    await goTo('Task manager');
    await waitFor(() => {
      expect(processes).toHaveBeenCalledOnce();
    });
    await fireEvent.click(byId('tasks-refresh'));
    await waitFor(() => {
      expect(processes).toHaveBeenCalledTimes(2);
    });
    cleanup();
    await open((host) =>
      host.handle('processes', () => ({
        platform: 'linux',
        currentUser: '',
        items: [],
        truncated: false,
        error: 'failed' as const,
      })),
    );
    await goTo('Task manager');
    await waitFor(() => {
      expect(byId('tasks-failed')).toBeTruthy();
    });
  });

  it('refreshes by itself at the chosen interval', async () => {
    const processes = vi.fn(() => PROCESSES);
    await open((host) => host.handle('processes', processes));
    await goTo('Task manager');
    await waitFor(() => {
      expect(processes).toHaveBeenCalledOnce();
    });
    vi.useFakeTimers();
    try {
      await fireEvent.change(byId('tasks-every'), { target: { value: '5' } });
      await vi.advanceTimersByTimeAsync(5200);
      expect(processes.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

const PAGE_SIZE: SettingGroup['items'][number] = {
  id: 'datanest.pageSize',
  kind: 'number',
  label: 'Rows per page',
  description: 'x',
  value: 200,
  default: 200,
  min: 1,
  max: 1000,
  integer: true,
};

const GROUPS: SettingGroup[] = [
  {
    id: 'editor',
    items: [
      {
        id: 'datanest.editor.codeLens',
        kind: 'boolean',
        label: 'Show Run above each statement',
        description: 'Show Run above each statement.',
        value: true,
        default: true,
      },
    ],
  },
  {
    id: 'sql',
    items: [
      {
        id: 'datanest.safeMode',
        kind: 'choice',
        label: 'What to do with dangerous statements',
        description: 'x',
        value: 'block',
        default: 'confirm',
        choices: [
          { value: 'confirm', label: 'confirm' },
          { value: 'block', label: 'block' },
        ],
      },
    ],
  },
  { id: 'result', items: [PAGE_SIZE] },
  {
    id: 'redis',
    items: [
      {
        id: 'datanest.redis.keySeparator',
        kind: 'text',
        label: 'Key separator',
        description: 'x',
        value: ':',
        default: ':',
      },
    ],
  },
];

describe('Settings', () => {
  it('shows the real settings in groups, with their ids, and marks the ones that differ from the default', async () => {
    await open((host) => host.handle('settingsList', () => ({ groups: GROUPS })));
    await goTo('Settings');
    await waitFor(() => {
      expect(screen.getByText('Show Run above each statement')).toBeTruthy();
    });
    for (const title of ['Editor', 'SQL', 'Result', 'Redis', 'Connections', 'Other']) {
      expect(screen.getByRole('region', { name: title }), title).toBeTruthy();
    }
    const safe = byId('item-datanest.safeMode');
    expect(safe.textContent).toContain('datanest.safeMode');
    expect(safe.querySelector('.changed')).not.toBeNull();
    expect(byId('item-datanest.pageSize').querySelector('.changed')).toBeNull();
    expect(inputOf('item-datanest.editor.codeLens').checked).toBe(true);
  });

  it('writes a toggle, a choice, a number and a text when they change', async () => {
    const settingsSet = vi.fn((_params: { id: string; value: unknown }) => {
      return { ok: true };
    });
    await open((host) => {
      host.handle('settingsList', () => ({ groups: GROUPS }));
      host.handle('settingsSet', settingsSet);
    });
    await goTo('Settings');
    await waitFor(() => {
      expect(screen.getByText('Rows per page')).toBeTruthy();
    });
    await fireEvent.click(inputOf('item-datanest.editor.codeLens'));
    await fireEvent.change(selectOf('item-datanest.safeMode'), { target: { value: 'confirm' } });
    const number = inputOf('item-datanest.pageSize');
    await fireEvent.change(number, { target: { value: '500' } });
    await fireEvent.change(inputOf('item-datanest.redis.keySeparator'), { target: { value: '/' } });
    await waitFor(() => {
      expect(settingsSet).toHaveBeenCalledTimes(4);
    });
    expect(settingsSet.mock.calls.map((call) => call[0])).toEqual([
      { id: 'datanest.editor.codeLens', value: false },
      { id: 'datanest.safeMode', value: 'confirm' },
      { id: 'datanest.pageSize', value: 500 },
      { id: 'datanest.redis.keySeparator', value: '/' },
    ]);
  });

  it('does not write an empty or unchanged number', async () => {
    const settingsSet = vi.fn(() => ({ ok: true }));
    await open((host) => {
      host.handle('settingsList', () => ({ groups: GROUPS }));
      host.handle('settingsSet', settingsSet);
    });
    await goTo('Settings');
    await waitFor(() => {
      expect(screen.getByText('Rows per page')).toBeTruthy();
    });
    const number = inputOf('item-datanest.pageSize');
    await fireEvent.change(number, { target: { value: '' } });
    expect(number.value).toBe('200');
    await fireEvent.change(number, { target: { value: '200' } });
    await flush();
    expect(settingsSet).not.toHaveBeenCalled();
  });

  it('tells the user when the host rejects a value, and reloads the real one', async () => {
    const settingsList = vi.fn(() => ({ groups: GROUPS }));
    await open((host) => {
      host.handle('settingsList', settingsList);
      host.handle('settingsSet', () => ({ ok: false }));
    });
    await goTo('Settings');
    await waitFor(() => {
      expect(screen.getByText('Rows per page')).toBeTruthy();
    });
    await fireEvent.change(inputOf('item-datanest.pageSize'), { target: { value: '99999' } });
    await waitFor(() => {
      expect(byId('set-problem').textContent).toContain(
        'datanest.pageSize did not accept this value',
      );
    });
    expect(settingsList).toHaveBeenCalledTimes(2);
  });

  it('resets one group to its defaults', async () => {
    const settingsReset = vi.fn((_params: { ids: string[] }) => {
      return { ok: true };
    });
    await open((host) => {
      host.handle('settingsList', () => ({ groups: GROUPS }));
      host.handle('settingsReset', settingsReset);
    });
    await goTo('Settings');
    await waitFor(() => {
      expect(screen.getByText('Rows per page')).toBeTruthy();
    });
    await fireEvent.click(byId('reset-sql'));
    await waitFor(() => {
      expect(settingsReset).toHaveBeenCalledWith({ ids: ['datanest.safeMode'] });
    });
    await waitFor(() => {
      expect(byId('set-done').textContent).toContain('SQL: defaults restored');
    });
  });

  it("follows a change made in the editor's own settings", async () => {
    const { host } = await open((peer) => peer.handle('settingsList', () => ({ groups: GROUPS })));
    await goTo('Settings');
    await waitFor(() => {
      expect(screen.getByText('Rows per page')).toBeTruthy();
    });
    const changed: SettingGroup[] = [
      {
        id: 'result',
        items: [{ ...PAGE_SIZE, value: 777 }],
      },
    ];
    host.emit('settingsChanged', { groups: changed });
    await waitFor(() => {
      expect(inputOf('item-datanest.pageSize').value).toBe('777');
    });
    expect(screen.queryByText('Show Run above each statement')).toBeNull();
  });

  it('runs the buttons of the editor and says what they did', async () => {
    const runAction = vi.fn((_params: { action: string }) => {
      return { ok: true };
    });
    await open((host) => {
      host.handle('settingsList', () => ({ groups: GROUPS }));
      host.handle('runAction', runAction);
    });
    await goTo('Settings');
    for (const action of ['exportConnections', 'importConnections', 'reportIssue']) {
      await fireEvent.click(byId(`act-${action}`));
    }
    await fireEvent.click(byId('act-closeConnections'));
    await waitFor(() => {
      expect(byId('set-done').textContent).toContain('All connections are closed');
    });
    await fireEvent.click(byId('act-clearCache'));
    await waitFor(() => {
      expect(byId('set-done').textContent).toContain('The cache is cleared');
    });
    expect(runAction.mock.calls.map((call) => call[0].action)).toEqual([
      'exportConnections',
      'importConnections',
      'reportIssue',
      'closeConnections',
      'clearCache',
    ]);
    expect(screen.getByText(/no servers and no cloud sync/u)).toBeTruthy();
  });

  it('shows a problem when a button did not work', async () => {
    await open((host) => {
      host.handle('settingsList', () => ({ groups: GROUPS }));
      host.handle('runAction', () => ({ ok: false }));
    });
    await goTo('Settings');
    await fireEvent.click(byId('act-clearCache'));
    await waitFor(() => {
      expect(byId('set-problem').textContent).toContain('did not work');
    });
  });

  it('says there is nothing to show when the host has no settings', async () => {
    await open((host) => host.handle('settingsList', () => ({ groups: [] })));
    await goTo('Settings');
    await waitFor(() => {
      expect(screen.getByText('No settings to show')).toBeTruthy();
    });
  });

  it('is in Russian for a Russian editor', async () => {
    await open((host) => host.handle('settingsList', () => ({ groups: GROUPS })), {
      language: 'ru',
    });
    await goTo('Настройки');
    await waitFor(() => {
      expect(screen.getByRole('region', { name: 'Редактор' })).toBeTruthy();
    });
    expect(screen.getByRole('region', { name: 'Подключения' })).toBeTruthy();
  });
});

describe('Colors: preview', () => {
  it('shows the twelve samples of the original and more, in a fixed order', async () => {
    await open();
    await goTo('Colors');
    const samples = [...document.querySelectorAll('[data-testid^="pv-"]')].map((cell) =>
      cell.getAttribute('data-testid'),
    );
    expect(samples.length).toBeGreaterThanOrEqual(16);
    for (const name of [
      'button',
      'outline',
      'disabled',
      'link',
      'tag',
      'border',
      'background',
      'icon',
      'tab',
      'list',
      'badge',
      'switch',
    ]) {
      expect(samples, name).toContain(`pv-${name}`);
    }
    expect(new Set(samples).size).toBe(samples.length);
  });

  it('draws every sample from the chosen colour', async () => {
    await open();
    await goTo('Colors');
    const preview = byId('preview');
    expect(preview.getAttribute('style')).toContain('--c: rgb(52, 120, 198)');
    await fireEvent.input(byId('hex'), { target: { value: '#ff0000' } });
    expect(preview.getAttribute('style')).toContain('--c: rgb(255, 0, 0)');
    expect(within(preview).getByText('Primary')).toBeTruthy();
  });
});

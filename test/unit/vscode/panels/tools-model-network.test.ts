import { describe, expect, it, vi } from 'vitest';
import type { IcmpPing } from '../../../../src/services/tools/icmp-ping';
import { OnlineTools } from '../../../../src/services/tools/online';
import { ProcessTools } from '../../../../src/services/tools/processes';
import type { ConfigProperty } from '../../../../src/shared/tools/settings-map';
import { type SettingsAccess, ToolsModel } from '../../../../src/vscode/panels/tools-model';

const save = () => Promise.resolve('saved' as const);

function fakeIcmp(attempts = [{ ok: true, ms: 4 }]) {
  const run = vi.fn(
    (
      _runId: number,
      _host: string,
      _count: number,
      _timeoutMs: number,
      onLine: (line: { text: string; reply: boolean; ms?: number }) => void,
    ) => {
      onLine({ text: '64 bytes from x: time=4 ms', reply: true, ms: 4 });
      return Promise.resolve({ available: true, attempts });
    },
  );
  const cancel = vi.fn();
  return { icmp: { run, cancel, dispose: vi.fn() } as unknown as IcmpPing, run, cancel };
}

const doh = (records: Record<string, string[]>) =>
  new OnlineTools((url) => {
    const type = /type=(\w+)/u.exec(url)?.[1] ?? 'A';
    const data = records[type] ?? [];
    return Promise.resolve({
      status: 200,
      body: JSON.stringify(
        data.length === 0
          ? { Status: 0 }
          : {
              Status: 0,
              Answer: data.map((entry) => ({
                name: 'h.test.',
                type: type === 'A' ? 1 : 28,
                TTL: 5,
                data: entry,
              })),
            },
      ),
    });
  });

describe('icmpPing', () => {
  it('pings the host as typed and hands the lines to the page', async () => {
    const { icmp, run } = fakeIcmp();
    const lines: unknown[] = [];
    const model = new ToolsModel({ save, icmp, pingLine: (line) => lines.push(line) });
    const result = await model.icmpPing({
      runId: 7,
      host: ' 8.8.8.8 ',
      count: 2,
      timeoutMs: 1000,
      resolve: 'direct',
      provider: 'google',
    });
    expect(run.mock.calls[0]?.slice(0, 4)).toEqual([7, '8.8.8.8', 2, 1000]);
    expect(lines).toEqual([{ runId: 7, text: '64 bytes from x: time=4 ms', reply: true, ms: 4 }]);
    expect(result).toEqual({ available: true, attempts: [{ ok: true, ms: 4 }] });
  });

  it('resolves the name over HTTPS first and pings the address it got', async () => {
    const { icmp, run } = fakeIcmp();
    const lines: { text: string; reply: boolean }[] = [];
    const model = new ToolsModel({
      save,
      icmp,
      online: doh({ A: ['192.0.2.9'] }),
      pingLine: (l) => lines.push(l),
    });
    const result = await model.icmpPing({
      runId: 1,
      host: 'h.test',
      count: 1,
      timeoutMs: 500,
      resolve: 'doh',
      provider: 'cloudflare',
    });
    expect(run.mock.calls[0]?.[1]).toBe('192.0.2.9');
    expect(lines[0]).toEqual({
      runId: 1,
      text: 'h.test → 192.0.2.9 (cloudflare-dns.com)',
      reply: false,
    });
    expect(result.resolved).toBe('192.0.2.9');
  });

  it('falls back to AAAA for a name that has no A record', async () => {
    const { icmp, run } = fakeIcmp();
    const model = new ToolsModel({ save, icmp, online: doh({ AAAA: ['2001:db8::5'] }) });
    const result = await model.icmpPing({
      runId: 1,
      host: 'h.test',
      count: 1,
      timeoutMs: 500,
      resolve: 'doh',
      provider: 'google',
    });
    expect(run.mock.calls[0]?.[1]).toBe('2001:db8::5');
    expect(result.resolved).toBe('2001:db8::5');
  });

  it('does not resolve an address, and gives up when the name has no record', async () => {
    const { icmp, run } = fakeIcmp();
    const lookup = vi.fn(() => Promise.resolve({ status: 200, body: '{}' }));
    const model = new ToolsModel({ save, icmp, online: new OnlineTools(lookup) });
    await model.icmpPing({
      runId: 1,
      host: '10.1.1.1',
      count: 1,
      timeoutMs: 500,
      resolve: 'doh',
      provider: 'google',
    });
    expect(lookup).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledOnce();

    const none = new ToolsModel({ save, icmp, online: doh({}) });
    const result = await none.icmpPing({
      runId: 2,
      host: 'nope.test',
      count: 1,
      timeoutMs: 500,
      resolve: 'doh',
      provider: 'google',
    });
    expect(result).toEqual({ available: true, attempts: [], error: 'not-found' });
    expect(run).toHaveBeenCalledOnce();
  });

  it('passes a cancel to the running ping', () => {
    const { icmp, cancel } = fakeIcmp();
    new ToolsModel({ save, icmp }).icmpCancel({ runId: 5 });
    expect(cancel).toHaveBeenCalledWith(5);
  });
});

describe('processes and kill', () => {
  const kill = vi.fn();
  const processes = new ProcessTools({
    platform: 'linux',
    exec: () => Promise.resolve('  500 alice 1.0 100 00:01 /usr/bin/node\n'),
    kill,
    currentUser: () => 'alice',
    protectedPids: [900],
    now: () => 0,
  });

  it('lists processes, and an unreadable system is an error, not a throw', async () => {
    const model = new ToolsModel({ save, processes });
    expect((await model.processes()).items).toHaveLength(1);
    const broken = new ToolsModel({
      save,
      processes: new ProcessTools({
        platform: 'linux',
        exec: () => Promise.reject(new Error('no ps')),
        kill,
        currentUser: () => 'alice',
        protectedPids: [],
        now: () => 0,
      }),
    });
    expect(await broken.processes()).toMatchObject({ items: [], error: 'failed' });
  });

  it('ends a process only after a yes', async () => {
    kill.mockClear();
    const confirmKill = vi.fn(() => Promise.resolve(true));
    const model = new ToolsModel({ save, processes, confirmKill });
    expect(await model.killProcess({ pid: 500, name: 'node', force: true })).toEqual({ ok: true });
    expect(confirmKill).toHaveBeenCalledWith(500, 'node', true);
    expect(kill).toHaveBeenCalledWith(500, 'SIGKILL');
  });

  it('does nothing on a no, or when nobody can be asked', async () => {
    kill.mockClear();
    const no = new ToolsModel({ save, processes, confirmKill: () => Promise.resolve(false) });
    expect(await no.killProcess({ pid: 500, name: 'node', force: false })).toEqual({
      ok: false,
      error: 'cancelled',
    });
    const silent = new ToolsModel({ save, processes });
    expect(await silent.killProcess({ pid: 500, name: 'node', force: false })).toEqual({
      ok: false,
      error: 'cancelled',
    });
    expect(kill).not.toHaveBeenCalled();
  });

  it('refuses the editor itself and a bad pid without asking', async () => {
    const confirmKill = vi.fn(() => Promise.resolve(true));
    const model = new ToolsModel({ save, processes, confirmKill });
    expect(await model.killProcess({ pid: 900, name: 'code', force: false })).toEqual({
      ok: false,
      error: 'protected',
    });
    expect(await model.killProcess({ pid: 1, name: 'init', force: false })).toEqual({
      ok: false,
      error: 'invalid-pid',
    });
    expect(confirmKill).not.toHaveBeenCalled();
  });
});

describe('settings and actions', () => {
  const props: Record<string, ConfigProperty> = {
    'datanest.editor.codeLens': { type: 'boolean', default: true, description: 'Show Run. More.' },
    'datanest.pageSize': { type: 'integer', default: 200, minimum: 1, maximum: 1000 },
    'datanest.complicated': { type: 'object' },
  };

  function access() {
    const values: Record<string, unknown> = { 'datanest.pageSize': 50 };
    const write = vi.fn((id: string, value: unknown) => {
      values[id] = value;
      return Promise.resolve();
    });
    const settings: SettingsAccess = { properties: () => props, read: (id) => values[id], write };
    return { settings, write };
  }

  it('lists the groups with the values the editor holds', () => {
    const { settings } = access();
    const groups = new ToolsModel({ save, settings }).settingsList().groups;
    expect(groups.map((group) => group.id)).toEqual(['editor', 'result']);
    expect(groups[1]?.items[0]).toMatchObject({ id: 'datanest.pageSize', value: 50, default: 200 });
    expect(new ToolsModel({ save }).settingsList()).toEqual({ groups: [] });
  });

  it('writes a valid value and refuses an invalid or unknown one', async () => {
    const { settings, write } = access();
    const model = new ToolsModel({ save, settings });
    expect(await model.settingsSet({ id: 'datanest.pageSize', value: 300 })).toEqual({ ok: true });
    expect(write).toHaveBeenCalledWith('datanest.pageSize', 300);
    write.mockClear();
    for (const [id, value] of [
      ['datanest.pageSize', 0],
      ['datanest.pageSize', 'many'],
      ['datanest.editor.codeLens', 1],
      ['datanest.complicated', 'x'],
      ['editor.fontSize', 12],
    ] as const) {
      expect(await model.settingsSet({ id, value }), id).toEqual({ ok: false });
    }
    expect(write).not.toHaveBeenCalled();
    expect(
      await new ToolsModel({ save }).settingsSet({ id: 'datanest.pageSize', value: 1 }),
    ).toEqual({ ok: false });
  });

  it('resets only the settings it shows', async () => {
    const { settings, write } = access();
    const model = new ToolsModel({ save, settings });
    expect(
      await model.settingsReset({
        ids: ['datanest.pageSize', 'editor.fontSize', 'datanest.complicated'],
      }),
    ).toEqual({ ok: true });
    expect(write.mock.calls).toEqual([['datanest.pageSize', undefined]]);
    expect(await new ToolsModel({ save }).settingsReset({ ids: ['datanest.pageSize'] })).toEqual({
      ok: false,
    });
  });

  it('runs a button of the settings tab, if the editor gave it one', async () => {
    const clearCache = vi.fn();
    const model = new ToolsModel({ save, actions: { clearCache } });
    expect(await model.runAction({ action: 'clearCache' })).toEqual({ ok: true });
    expect(clearCache).toHaveBeenCalledOnce();
    expect(await model.runAction({ action: 'reportIssue' })).toEqual({ ok: false });
  });
});

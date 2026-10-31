import { describe, expect, it } from 'vitest';
import {
  filterProcesses,
  formatCpu,
  formatMemory,
  formatRuntime,
  parseCsvLine,
  parseElapsed,
  parsePs,
  parseTasklistUsers,
  parseWindowsProcesses,
  type ProcessInfo,
  processName,
  sortProcesses,
} from '../../../../src/shared/tools/processes';

const LINUX = `    1 root                              0.0 11584 1-02:03:04 /sbin/init splash
  563 muhammadali                       12.5 524288    05:09 /usr/lib/firefox/firefox -contentproc --flag
    2 root                              0.0     0 1-02:03:04 [kthreadd]
 4242 www-data                          0,3  2048 01:02:03 nginx: worker process
garbage line that is not a process
 9001 root                              0.0   100       00:07
`;

const MAC = `  1 root             0.0  12000  10-04:05:06 /sbin/launchd
 77 alice            3.2 204800     21:09 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --type=gpu-process
`;

describe('parseElapsed', () => {
  it('reads [[dd-]hh:]mm:ss', () => {
    expect(parseElapsed('05:09')).toBe(309);
    expect(parseElapsed('01:02:03')).toBe(3723);
    expect(parseElapsed('1-02:03:04')).toBe(86_400 + 7384);
    expect(parseElapsed('10-04:05:06')).toBe(10 * 86_400 + 4 * 3600 + 5 * 60 + 6);
  });

  it('refuses text that is no elapsed time', () => {
    expect(parseElapsed('')).toBeUndefined();
    expect(parseElapsed('abc')).toBeUndefined();
    expect(parseElapsed('12')).toBeUndefined();
  });
});

describe('processName', () => {
  it('is the file name of the program', () => {
    expect(processName('/usr/lib/firefox/firefox -contentproc')).toBe('firefox');
    expect(processName('nginx: worker process')).toBe('nginx:');
    expect(processName('C:\\Windows\\System32\\svchost.exe -k netsvcs')).toBe('svchost.exe');
    expect(processName('"C:\\Program Files\\App\\app.exe" --x')).toBe('app.exe');
  });

  it('keeps the brackets of a kernel thread', () => {
    expect(processName('[kworker/0:1-events]')).toBe('[kworker/0:1-events]');
    expect(processName('[kthreadd] extra')).toBe('[kthreadd]');
  });

  it('falls back to the whole text', () => {
    expect(processName('   ')).toBe('');
    expect(processName('/')).toBe('/');
  });
});

describe('parsePs', () => {
  it('reads Linux output, skipping lines that are no process', () => {
    const items = parsePs(LINUX);
    expect(items.map((item) => item.pid)).toEqual([1, 563, 2, 4242, 9001]);
    expect(items[0]).toEqual({
      pid: 1,
      name: 'init',
      user: 'root',
      cpu: 0,
      memoryKb: 11_584,
      runtimeSec: 86_400 + 7384,
      command: '/sbin/init splash',
    });
    expect(items[1]).toMatchObject({
      name: 'firefox',
      cpu: 12.5,
      memoryKb: 524_288,
      runtimeSec: 309,
    });
    expect(items[2]?.name).toBe('[kthreadd]');
  });

  it('accepts a comma as the decimal mark', () => {
    expect(parsePs(LINUX).find((item) => item.pid === 4242)?.cpu).toBe(0.3);
  });

  it('takes a process with no command line as unnamed', () => {
    const last = parsePs(LINUX).at(-1);
    expect(last?.pid).toBe(9001);
    expect(last?.command).toBe('');
  });

  it('reads macOS output with spaces in the path and days in the runtime', () => {
    const items = parsePs(MAC);
    expect(items[0]).toMatchObject({ pid: 1, user: 'root', runtimeSec: 10 * 86_400 + 14_706 });
    expect(items[1]?.user).toBe('alice');
    expect(items[1]?.command).toContain('Google Chrome.app');
  });

  it('gives nothing for empty output', () => {
    expect(parsePs('')).toEqual([]);
  });
});

const TASKLIST = [
  '"System Idle Process","0","Services","0","8 K","Unknown","NT AUTHORITY\\SYSTEM","12:34:56","N/A"',
  '"chrome.exe","4321","Console","1","123,456 K","Running","PC\\alice","0:01:02","New Tab - ""Chrome"""',
  '"svchost.exe","800","Services","0","9,000 K","Unknown","N/A","0:00:00","N/A"',
  'INFO: No tasks are running which match the specified criteria.',
].join('\r\n');

describe('tasklist', () => {
  it('splits a CSV line with quotes and doubled quotes', () => {
    expect(parseCsvLine('"a","b,c","d ""e"""')).toEqual(['a', 'b,c', 'd "e"']);
    expect(parseCsvLine('x')).toEqual(['x']);
  });

  it('maps pids to accounts, leaving out N/A and noise', () => {
    const users = parseTasklistUsers(TASKLIST);
    expect(users.get(4321)).toBe('PC\\alice');
    expect(users.get(0)).toBe('NT AUTHORITY\\SYSTEM');
    expect(users.has(800)).toBe(false);
    expect(users.size).toBe(2);
  });
});

describe('parseWindowsProcesses', () => {
  const NOW = Date.parse('2026-10-31T12:00:00Z');
  const rows = [
    {
      ProcessId: 4321,
      Name: 'chrome.exe',
      CommandLine: '"C:\\chrome.exe" --x',
      WorkingSetSize: 10_485_760,
      Start: '2026-10-31T11:00:00.0000000Z',
      CpuMs: 62_000,
    },
    {
      ProcessId: 4,
      Name: 'System',
      CommandLine: null,
      WorkingSetSize: null,
      Start: null,
      CpuMs: 5,
    },
    { ProcessId: 'bad', Name: 'x' },
    'not a row',
  ];

  it('reads an array, with memory in KB, runtime and account', () => {
    const items = parseWindowsProcesses(JSON.stringify(rows), new Map([[4321, 'PC\\alice']]), NOW);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      pid: 4321,
      name: 'chrome.exe',
      user: 'PC\\alice',
      cpuMs: 62_000,
      memoryKb: 10_240,
      runtimeSec: 3600,
      command: '"C:\\chrome.exe" --x',
    });
    expect(items[1]).toEqual({ pid: 4, name: 'System', user: '', cpuMs: 5, command: 'System' });
  });

  it('reads one object, which is what PowerShell prints for a single process', () => {
    const items = parseWindowsProcesses(JSON.stringify(rows[0]), new Map(), NOW);
    expect(items.map((item) => item.pid)).toEqual([4321]);
  });

  it('skips a byte order mark and survives broken JSON', () => {
    expect(
      parseWindowsProcesses(`\uFEFF${JSON.stringify([rows[0]])}`, new Map(), NOW),
    ).toHaveLength(1);
    expect(parseWindowsProcesses('{oops', new Map(), NOW)).toEqual([]);
    expect(parseWindowsProcesses('', new Map(), NOW)).toEqual([]);
  });

  it('never gives a negative runtime when the clock is behind', () => {
    const item = parseWindowsProcesses(
      JSON.stringify([{ ProcessId: 1, Name: 'a', Start: '2030-01-01T00:00:00Z' }]),
      new Map(),
      NOW,
    )[0];
    expect(item?.runtimeSec).toBe(0);
  });
});

describe('filter, sort and formats', () => {
  const items: ProcessInfo[] = [
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
      user: 'bob',
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
  ];

  it('filters by every word over name, pid, user and command', () => {
    expect(filterProcesses(items, { query: '' })).toHaveLength(3);
    expect(filterProcesses(items, { query: 'POST data' }).map((i) => i.pid)).toEqual([20]);
    expect(filterProcesses(items, { query: '30' }).map((i) => i.pid)).toEqual([30]);
    expect(filterProcesses(items, { query: 'alice' }).map((i) => i.pid)).toEqual([10, 30]);
    expect(filterProcesses(items, { query: 'nothing here' })).toEqual([]);
  });

  it('keeps only the current user when asked', () => {
    expect(filterProcesses(items, { query: '', onlyUser: 'alice' }).map((i) => i.pid)).toEqual([
      10, 30,
    ]);
    expect(filterProcesses(items, { query: 'node', onlyUser: 'bob' })).toEqual([]);
  });

  it('sorts by every column in both directions and does not touch its input', () => {
    const before = [...items];
    const pids = (key: Parameters<typeof sortProcesses>[1], desc: boolean) =>
      sortProcesses(items, key, desc).map((i) => i.pid);
    expect(pids('cpu', true)).toEqual([20, 10, 30]);
    expect(pids('memory', false)).toEqual([30, 10, 20]);
    expect(pids('runtime', true)).toEqual([20, 10, 30]);
    expect(pids('pid', false)).toEqual([10, 20, 30]);
    expect(pids('name', false)).toEqual([10, 20, 30]);
    expect(pids('user', false)).toEqual([10, 30, 20]);
    expect(pids('command', false)).toEqual([30, 10, 20]);
    expect(items).toEqual(before);
  });

  it('sorts a system without percent by processor time', () => {
    const win: ProcessInfo[] = [
      { pid: 1, name: 'a', user: '', cpuMs: 10, command: 'a' },
      { pid: 2, name: 'b', user: '', cpuMs: 9000, command: 'b' },
    ];
    expect(sortProcesses(win, 'cpu', true).map((i) => i.pid)).toEqual([2, 1]);
  });

  it('formats runtime, memory and CPU', () => {
    expect(formatRuntime(undefined)).toBe('-');
    expect(formatRuntime(59)).toBe('00:59');
    expect(formatRuntime(3723)).toBe('01:02:03');
    expect(formatRuntime(90_061)).toBe('1d 01:01:01');
    expect(formatMemory(undefined)).toBe('-');
    expect(formatMemory(512)).toBe('512 KB');
    expect(formatMemory(2048)).toBe('2.0 MB');
    expect(formatMemory(3 * 1024 * 1024)).toBe('3.00 GB');
    expect(formatCpu({ pid: 1, name: '', user: '', cpu: 12.34, command: '' })).toBe('12.3%');
    expect(formatCpu({ pid: 1, name: '', user: '', cpuMs: 61_000, command: '' })).toBe('01:01');
    expect(formatCpu({ pid: 1, name: '', user: '', command: '' })).toBe('-');
  });
});

// ICMP ping through the system's own `ping` program: its arguments per platform and how
// its lines are read. Only the numbers matter, so words in the user's language are fine.

export interface PingLine {
  readonly text: string;
  /** A reply to one request. */
  readonly reply: boolean;
  readonly ms?: number;
}

/** Arguments for one run. The host name was checked and cannot start with a dash. */
export function pingArgs(
  platform: string,
  host: string,
  count: number,
  timeoutMs: number,
): { file: string; args: string[] } {
  const seconds = String(Math.max(1, Math.ceil(timeoutMs / 1000)));
  if (platform === 'win32') {
    return { file: 'ping', args: ['-n', String(count), '-w', String(timeoutMs), host] };
  }
  if (platform === 'darwin') {
    // macOS keeps IPv6 in a separate program, and -W is in milliseconds.
    return {
      file: host.includes(':') ? 'ping6' : 'ping',
      args: ['-n', '-c', String(count), '-W', String(timeoutMs), host],
    };
  }
  return { file: 'ping', args: ['-n', '-c', String(count), '-W', seconds, host] };
}

/**
 * Linux and macOS: `ttl=57 time=12.3 ms`; Windows: `time=12ms TTL=57`, `time<1ms`, and the
 * word for "time" follows the system language, so only `=<number>ms` and TTL are matched.
 */
const MS = String.raw`[=<]\s*([\d.,]+)\s*(?:ms|мс)(?!\p{L})`;
const REPLY = new RegExp(
  String.raw`\b(?:ttl|hlim)[=: ]\s*\d+[^]*?${MS}|${MS}[^]*?\b(?:ttl|hlim)[=:]\s*\d+`,
  'iu',
);

export function parsePingLine(line: string): PingLine {
  const text = line.trimEnd();
  const match = REPLY.exec(text);
  if (match === null) {
    return { text, reply: false };
  }
  const number = (match[1] ?? match[2] ?? '0').replace(',', '.');
  const ms = Number(number);
  // Windows prints `time<1ms` for anything under a millisecond.
  return { text, reply: true, ms: Number.isFinite(ms) ? ms : 0 };
}

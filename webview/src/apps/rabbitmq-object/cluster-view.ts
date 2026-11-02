// Small helpers of the RabbitMQ cluster page (V13.35): how much of a resource a node has used
// and in which colour the meter is drawn.

/** How much of `total` is `used`, 0–100 (a node that reports no total shows nothing used). */
export function usedPercent(used: number, total: number): number {
  if (total <= 0 || used <= 0) {
    return 0;
  }
  return Math.min(100, Math.round((used * 100) / total));
}

export type MeterTone = 'ok' | 'warn' | 'bad';

/** The colour of a meter: a raised alarm is always bad; otherwise it warms up as it fills. */
export function meterTone(percent: number, alarm = false): MeterTone {
  if (alarm || percent >= 90) {
    return 'bad';
  }
  return percent >= 70 ? 'warn' : 'ok';
}

/** `host:port`, with an IPv6 address in brackets; `::` and `0.0.0.0` stand for every address. */
export function listenerAddress(ip: string, port: number): string {
  const any = ip === '::' || ip === '0.0.0.0' || ip === '';
  const host = any ? '*' : ip.includes(':') ? `[${ip}]` : ip;
  return `${host}:${port}`;
}

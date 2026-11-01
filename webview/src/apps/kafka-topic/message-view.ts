// Small helpers of the Kafka topic page (V13.23): how offsets, times and headers are shown.

import type { KafkaPartitionView } from '../../../../src/shared/protocols/kafka-topic';

type Range = Pick<KafkaPartitionView, 'low' | 'high'>;

/** Messages a partition holds: the offsets are 64-bit, so they are compared as BigInt. */
export function partitionSize(partition: Range): bigint {
  const size = BigInt(partition.high) - BigInt(partition.low);
  return size < 0n ? 0n : size;
}

/** How full a partition is next to the fullest one, 0–100, for the little bar. */
export function fillPercent(partition: Range, all: readonly Range[]): number {
  let most = 0n;
  for (const one of all) {
    const size = partitionSize(one);
    most = size > most ? size : most;
  }
  if (most === 0n) {
    return 0;
  }
  return Number((partitionSize(partition) * 100n) / most);
}

/** The total of messages in all partitions. */
export function totalMessages(partitions: readonly Range[]): bigint {
  return partitions.reduce((sum, one) => sum + partitionSize(one), 0n);
}

/** A message time in the viewer's own zone; the raw text when it is not a number. */
export function timeText(timestamp: string, locale?: string): string {
  const ms = Number(timestamp);
  if (!Number.isFinite(ms) || ms < 0) {
    return timestamp;
  }
  return new Date(ms).toLocaleString(locale, { hour12: false });
}

/** `name: value` lines → headers; blank lines are skipped, a line without a colon is a name. */
export function parseHeaders(text: string): { name: string; value: string }[] {
  const headers: { name: string; value: string }[] = [];
  for (const line of text.split(/\r?\n/u)) {
    if (line.trim() === '') {
      continue;
    }
    const colon = line.indexOf(':');
    headers.push(
      colon < 0
        ? { name: line.trim(), value: '' }
        : { name: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim() },
    );
  }
  return headers;
}

/** Digits only, as the offsets of the protocol are. */
export function isOffset(text: string): boolean {
  return /^\d+$/u.test(text.trim());
}

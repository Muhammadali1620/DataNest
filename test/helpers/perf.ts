// Measuring for the perf run (test/perf): every measurement is checked against its
// budget and written to a report that the run prints at the end (perf-report.ts).

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { expect } from 'vitest';
import { ROOT } from './repo';

/** Where the measurements of one run are collected, one JSON object per line. */
export const PERF_RESULTS = join(ROOT, 'out', 'perf', 'results.jsonl');

export interface Measurement {
  readonly name: string;
  readonly value: number;
  readonly unit: string;
  readonly budget: number;
}

/** Records a measurement and fails the test when it is over budget. */
export function record(measurement: Measurement): void {
  mkdirSync(dirname(PERF_RESULTS), { recursive: true });
  appendFileSync(PERF_RESULTS, `${JSON.stringify(measurement)}\n`);
  expect(
    measurement.value,
    `${measurement.name}: ${measurement.value} ${measurement.unit} (budget ${measurement.budget})`,
  ).toBeLessThanOrEqual(measurement.budget);
}

/** Milliseconds a piece of work takes. */
export async function timed<T>(work: () => T | Promise<T>): Promise<{ ms: number; value: T }> {
  const started = performance.now();
  const value = await work();
  return { ms: performance.now() - started, value };
}

/**
 * Milliseconds the work takes and the longest stretch the event loop could not run a
 * timer meanwhile — how long the host would ignore everything else.
 */
export async function timedWithBlocking<T>(
  work: () => Promise<T>,
): Promise<{ ms: number; longestBlockMs: number; value: T }> {
  const histogram = monitorEventLoopDelay({ resolution: 5 });
  histogram.enable();
  try {
    const { ms, value } = await timed(work);
    return { ms, longestBlockMs: histogram.max / 1e6, value };
  } finally {
    histogram.disable();
  }
}

/** Heap in use after a full collection, in bytes; the perf run starts Node with --expose-gc. */
export function settledHeap(): number {
  const collect = (globalThis as { gc?: () => void }).gc;
  if (collect === undefined) {
    throw new Error('Run the perf tests with --expose-gc (npm run test:perf)');
  }
  collect();
  collect();
  return process.memoryUsage().heapUsed;
}

/** The middle value of several runs, which shrugs off one slow outlier. */
export function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/** Rounds for the report: whole numbers above 10, one decimal below. */
export function round(value: number): number {
  return value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
}

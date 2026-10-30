// Global setup of the perf run: starts a fresh report and, when the run ends, prints it
// as a table — and adds it to the GitHub job summary in CI, so every run's numbers can
// be compared without opening logs.

import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import type { Measurement } from './perf';
import { PERF_RESULTS } from './perf';

export function setup(): () => void {
  rmSync(PERF_RESULTS, { force: true });
  return () => {
    const table = reportTable(readMeasurements());
    process.stdout.write(`\n${table}\n`);
    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (summary !== undefined && summary !== '') {
      appendFileSync(summary, `### Performance budget\n\n${table}\n`);
    }
  };
}

function readMeasurements(): Measurement[] {
  if (!existsSync(PERF_RESULTS)) {
    return [];
  }
  return readFileSync(PERF_RESULTS, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Measurement);
}

/** The measurements as a Markdown table, with how much of each budget they use. */
export function reportTable(measurements: readonly Measurement[]): string {
  const rows = measurements.map((m) => {
    const share = m.budget > 0 ? Math.round((m.value / m.budget) * 100) : 0;
    const mark = m.value <= m.budget ? '' : ' ❌';
    return `| ${m.name} | ${m.value} ${m.unit} | ${m.budget} ${m.unit} | ${share}%${mark} |`;
  });
  return ['| Measurement | Value | Budget | Used |', '|---|---:|---:|---:|', ...rows].join('\n');
}

import { defineConfig } from 'vitest/config';

// The performance budget (V9.1): measurements of the production build and of the hot
// paths with a million rows, each checked against test/perf/budgets.ts. One file at a
// time in its own process, so measurements do not compete for the CPU.
export default defineConfig({
  test: {
    include: ['test/perf/**/*.perf.test.ts'],
    environment: 'node',
    globalSetup: ['test/helpers/perf-report.ts'],
    pool: 'forks',
    execArgv: ['--expose-gc'],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 180_000,
    restoreMocks: true,
  },
});

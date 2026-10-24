import { defineConfig } from 'vitest/config';

// Integration tests talk to the databases from docker/compose.yml (`npm run db:up`).
export default defineConfig({
  test: {
    include: ['test/integration/**/*.int.test.ts'],
    environment: 'node',
    globalSetup: ['test/helpers/integration-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    restoreMocks: true,
  },
});

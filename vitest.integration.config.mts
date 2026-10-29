import { defineConfig } from 'vitest/config';
import { GROUPS_ENV, includePatterns, selectGroups } from './test/helpers/integration-groups';

// Integration tests talk to the databases from docker/compose.yml (`npm run db:up`),
// one group per compose profile (V6.1). `DATANEST_IT=mssql` runs only that group.
export default defineConfig(async () => {
  const { groups, skipped } = await selectGroups();
  // The global setup checks exactly these groups.
  process.env[GROUPS_ENV] = groups.join(',');
  if (skipped.length > 0) {
    process.stdout.write(
      `Integration groups: ${groups.join(', ')}. Not running, so skipped: ` +
        `${skipped.join(', ')} (npm run db:up -- ${skipped.join(' ')}).\n`,
    );
  }
  return {
    test: {
      include: includePatterns(groups),
      environment: 'node',
      globalSetup: ['test/helpers/integration-setup.ts'],
      testTimeout: 30_000,
      hookTimeout: 60_000,
      restoreMocks: true,
      // The files share the databases (the seed test lists their tables while others
      // create and drop theirs), so they must not overlap.
      fileParallelism: false,
    },
  };
});

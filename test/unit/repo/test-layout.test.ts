import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { IGNORED_DIRS, listFiles, ROOT } from '../../helpers/repo';

// Enforces ARCHITECTURE.md §11: all tests live only in test/.
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const ALLOWED_TEST_DIRS = ['e2e', 'fixtures', 'helpers', 'integration', 'perf', 'unit'];

describe('test layout', () => {
  it('has no test files outside test/', () => {
    const misplaced = readdirSync(ROOT, { withFileTypes: true })
      .filter(
        (entry) => entry.isDirectory() && entry.name !== 'test' && !IGNORED_DIRS.has(entry.name),
      )
      .flatMap((entry) => listFiles(entry.name))
      .filter((file) => TEST_FILE.test(file));
    expect(misplaced).toEqual([]);
  });

  it('has only the documented top-level folders in test/', () => {
    const dirs = readdirSync(join(ROOT, 'test'), { withFileTypes: true });
    const unknown = dirs
      .filter((entry) => !entry.isDirectory() || !ALLOWED_TEST_DIRS.includes(entry.name))
      .map((entry) => entry.name);
    expect(unknown).toEqual([]);
  });

  it('names unit tests *.test.ts', () => {
    const wrong = listFiles('test/unit').filter((file) => !file.endsWith('.test.ts'));
    expect(wrong).toEqual([]);
  });

  it('names integration tests *.int.test.ts', () => {
    const wrong = listFiles('test/integration').filter(
      (file) => TEST_FILE.test(file) && !file.endsWith('.int.test.ts'),
    );
    expect(wrong).toEqual([]);
  });

  it('names perf tests *.perf.test.ts and keeps only the budget beside them', () => {
    const wrong = listFiles('test/perf').filter(
      (file) => !file.endsWith('.perf.test.ts') && file !== 'test/perf/budgets.ts',
    );
    expect(wrong).toEqual([]);
    expect(listFiles('test/perf').length).toBeGreaterThan(1);
  });

  it('keeps test files out of helpers/ and fixtures/', () => {
    const wrong = [...listFiles('test/helpers'), ...listFiles('test/fixtures')].filter((file) =>
      TEST_FILE.test(file),
    );
    expect(wrong).toEqual([]);
  });
});

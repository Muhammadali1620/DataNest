import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { ESLint } from 'eslint';
import { ROOT } from '../../helpers/repo';

// Checks that the real project config enables the rules ARCHITECTURE.md §10 relies on.
const eslint = new ESLint({ cwd: ROOT });

async function ruleLevel(file: string, rule: string): Promise<unknown> {
  const config = (await eslint.calculateConfigForFile(join(ROOT, file))) as {
    rules: Record<string, unknown[]>;
  };
  return config.rules[rule]?.[0];
}

// Type-aware linting loads whole TS programs, which is slow on the first call.
describe('eslint.config.mjs', { timeout: 30_000 }, () => {
  it.each([
    ['src/core/sql/split.ts'],
    ['src/shared/protocol.ts'],
    ['src/drivers/mysql/index.ts'],
    ['src/services/history.ts'],
    ['webview/src/lib/rpc.ts'],
  ])('enforces layer boundaries in %s', async (file) => {
    expect(await ruleLevel(file, 'no-restricted-imports')).toBe(2);
  });

  it('does not restrict imports in vscode/ adapters', async () => {
    expect(await ruleLevel('src/vscode/commands.ts', 'no-restricted-imports')).toBeUndefined();
  });

  it.each([
    ['@typescript-eslint/no-floating-promises'],
    ['@typescript-eslint/no-explicit-any'],
    ['@typescript-eslint/no-non-null-assertion'],
    ['@typescript-eslint/consistent-type-imports'],
    ['no-restricted-syntax'],
    ['no-empty'],
    ['no-console'],
  ])('enables %s for source files', async (rule) => {
    expect(await ruleLevel('src/services/history.ts', rule)).toBe(2);
  });

  it('allows default exports only in tool config files', async () => {
    expect(await ruleLevel('vitest.config.mts', 'no-restricted-syntax')).toBe(0);
    expect(await ruleLevel('src/extension.ts', 'no-restricted-syntax')).toBe(2);
  });

  it('ignores build output and fixtures', async () => {
    expect(await eslint.isPathIgnored(join(ROOT, 'dist/extension.js'))).toBe(true);
    expect(await eslint.isPathIgnored(join(ROOT, 'test/fixtures/sample.ts'))).toBe(true);
  });

  it('lints Svelte components with layer boundaries', async () => {
    expect(await ruleLevel('webview/src/apps/ping/App.svelte', 'no-restricted-imports')).toBe(2);
    const [result] = await eslint.lintText(
      '<script lang="ts">\n  import { split } from \'../../../../src/core/sql/split\';\n</script>\n',
      { filePath: join(ROOT, 'webview/src/apps/ping/App.svelte') },
    );
    expect(result?.messages.map((m) => m.ruleId)).toContain('no-restricted-imports');
  });

  it('reports a default export in source code', async () => {
    const [result] = await eslint.lintText('export default 1;\n', {
      filePath: join(ROOT, 'src/extension.ts'),
    });
    expect(result?.messages.map((m) => m.ruleId)).toContain('no-restricted-syntax');
  });
});

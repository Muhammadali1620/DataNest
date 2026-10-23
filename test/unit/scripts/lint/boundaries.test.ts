import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { boundaryConfigs } from '../../../../scripts/lint/boundaries.mjs';
import { ROOT } from '../../../helpers/repo';

// Lints snippets with only the boundary rules, so files do not have to exist on disk.
const eslint = new ESLint({
  cwd: ROOT,
  overrideConfigFile: true,
  overrideConfig: [
    { files: ['**/*.ts', '**/*.svelte'], languageOptions: { parser: tseslint.parser } },
    ...boundaryConfigs,
  ],
});

async function violations(file: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: join(ROOT, file) });
  return (result?.messages ?? []).map((message) => message.ruleId ?? message.message);
}

async function isAllowed(file: string, code: string): Promise<boolean> {
  return (await violations(file, code)).length === 0;
}

const VSCODE_VALUE = "import * as vscode from 'vscode';";
const VSCODE_TYPE = "import type { Uri } from 'vscode';";

describe('layer boundaries', () => {
  describe('core/ and shared/', () => {
    for (const file of ['src/core/sql/split.ts', 'src/shared/protocol.ts']) {
      it(`forbids the vscode API in ${file}`, async () => {
        expect(await violations(file, VSCODE_VALUE)).toEqual(['no-restricted-imports']);
        expect(await isAllowed(file, VSCODE_TYPE)).toBe(false);
      });

      it(`forbids Node I/O modules in ${file}`, async () => {
        expect(await isAllowed(file, "import { readFile } from 'node:fs';")).toBe(false);
        expect(await isAllowed(file, "import * as net from 'net';")).toBe(false);
        expect(await isAllowed(file, "import { Worker } from 'node:worker_threads';")).toBe(false);
      });

      it(`forbids upper layers in ${file}`, async () => {
        expect(await isAllowed(file, "import { x } from '../../drivers/driver';")).toBe(false);
        expect(await isAllowed(file, "import { x } from '../services/history';")).toBe(false);
        expect(await isAllowed(file, "import { x } from '../vscode/commands';")).toBe(false);
        expect(await isAllowed(file, "import { activate } from '../extension';")).toBe(false);
      });
    }

    it('allows core to use shared and its own modules', async () => {
      const code = "import { a } from '../../shared/cell-value';\nimport { b } from './tokens';";
      expect(await isAllowed('src/core/sql/split.ts', code)).toBe(true);
    });

    it('does not confuse names that only contain a layer name', async () => {
      const code = "import { a } from './driverless';\nimport { b } from './my-services-list';";
      expect(await isAllowed('src/core/model/x.ts', code)).toBe(true);
    });
  });

  describe('drivers/', () => {
    const file = 'src/drivers/mysql/session.ts';

    it('forbids the vscode API', async () => {
      expect(await isAllowed(file, VSCODE_VALUE)).toBe(false);
    });

    it('forbids services/ and vscode/', async () => {
      expect(await isAllowed(file, "import { x } from '../../services/history';")).toBe(false);
      expect(await isAllowed(file, "import { x } from '../../vscode/tree/node';")).toBe(false);
    });

    it('allows core/, shared/, Node modules and other driver files', async () => {
      const code = [
        "import { split } from '../../core/sql/split';",
        "import { cell } from '../../shared/cell-value';",
        "import { Driver } from '../driver';",
        "import * as net from 'node:net';",
        "import mysql from 'mysql2';",
      ].join('\n');
      expect(await isAllowed(file, code)).toBe(true);
    });
  });

  describe('services/', () => {
    const file = 'src/services/connection-store.ts';

    it('forbids the vscode API and vscode/ adapters', async () => {
      expect(await isAllowed(file, VSCODE_TYPE)).toBe(false);
      expect(await isAllowed(file, "import { x } from '../vscode/commands';")).toBe(false);
    });

    it('allows drivers/, core/ and shared/', async () => {
      const code = [
        "import { registry } from '../drivers/registry';",
        "import { DbError } from '../core/errors';",
        "import { cell } from '../shared/cell-value';",
      ].join('\n');
      expect(await isAllowed(file, code)).toBe(true);
    });
  });

  describe('vscode/ adapters', () => {
    it('may use every layer and the editor API', async () => {
      const code = [
        VSCODE_VALUE,
        "import { store } from '../../services/connection-store';",
        "import { registry } from '../../drivers/registry';",
        "import { split } from '../../core/sql/split';",
      ].join('\n');
      expect(await isAllowed('src/vscode/tree/provider.ts', code)).toBe(true);
    });
  });

  describe('webview/', () => {
    const file = 'webview/src/apps/ping/main.ts';

    it('may import only from src/shared', async () => {
      expect(await isAllowed(file, "import { x } from '../../../../src/shared/protocol';")).toBe(
        true,
      );
      expect(await isAllowed(file, "import { x } from '../../../../src/core/sql/split';")).toBe(
        false,
      );
      expect(await isAllowed(file, "import { x } from '../../../../src/services/history';")).toBe(
        false,
      );
    });

    it('forbids the vscode API and Node modules', async () => {
      expect(await isAllowed(file, VSCODE_VALUE)).toBe(false);
      expect(await isAllowed(file, "import { readFile } from 'node:fs';")).toBe(false);
    });
  });
});

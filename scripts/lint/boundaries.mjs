// @ts-check
import { builtinModules } from 'node:module';

// Layer rules from ARCHITECTURE.md §3:
//   vscode/ → services/ → drivers/ → core/, everything → shared/, webview/ → shared/ only.

const NODE_BUILTINS = [...builtinModules, ...builtinModules.map((name) => `node:${name}`)];

const VSCODE_API = {
  name: 'vscode',
  message: 'Only src/vscode/ and src/extension.ts may use the editor API (ARCHITECTURE.md §3).',
};

/**
 * Matches relative imports that reach into one of `layers`. Bare package names
 * (like `vscode`) are handled by `paths`, so each violation is reported once.
 *
 * @param {string[]} layers
 * @param {string} message
 */
function layerPattern(layers, message) {
  return { regex: `^\\.{1,2}/(.*/)?(${layers.join('|')})(/|$)`, message };
}

/** @param {string} message */
function nodeBuiltins(message) {
  return NODE_BUILTINS.map((name) => ({ name, message }));
}

/** @type {import('eslint').Linter.Config[]} */
export const boundaryConfigs = [
  {
    name: 'datanest/boundaries/core-and-shared',
    files: ['src/core/**/*.ts', 'src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [VSCODE_API, ...nodeBuiltins('core/ and shared/ are pure logic without I/O.')],
          patterns: [
            layerPattern(
              ['drivers', 'services', 'vscode', 'webview', 'extension'],
              'core/ and shared/ must not depend on other layers.',
            ),
          ],
        },
      ],
    },
  },
  {
    name: 'datanest/boundaries/drivers',
    files: ['src/drivers/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [VSCODE_API],
          patterns: [
            layerPattern(
              ['services', 'vscode', 'webview', 'extension'],
              'drivers/ may depend only on core/ and shared/.',
            ),
          ],
        },
      ],
    },
  },
  {
    name: 'datanest/boundaries/services',
    files: ['src/services/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [VSCODE_API],
          patterns: [
            layerPattern(
              ['vscode', 'webview', 'extension'],
              'services/ get editor features through small interfaces, not the vscode API.',
            ),
          ],
        },
      ],
    },
  },
  {
    name: 'datanest/boundaries/webview',
    files: ['webview/**/*.ts', 'webview/**/*.svelte'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'vscode',
              message: 'The webview talks to the host only via src/shared/protocol.',
            },
            ...nodeBuiltins('The webview runs in a browser sandbox.'),
          ],
          patterns: [
            layerPattern(
              ['core', 'drivers', 'services', 'vscode', 'extension'],
              'The webview may import only from src/shared/.',
            ),
          ],
        },
      ],
    },
  },
];

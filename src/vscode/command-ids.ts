// Kept apart from commands.ts (no vscode import), so tests can compare it with package.json.

/** Every command the extension contributes: `<extId>.<area>.<action>` (ARCHITECTURE.md §10). */
export const COMMAND_IDS = {
  showLogs: 'datanest.logs.show',
} as const;

export type CommandId = (typeof COMMAND_IDS)[keyof typeof COMMAND_IDS];

/** Settings section and keys, read via `workspace.getConfiguration(CONFIG_SECTION)`. */
export const CONFIG_SECTION = 'datanest';

export const CONFIG_KEYS = {
  logLevel: 'logLevel',
} as const;

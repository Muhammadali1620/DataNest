import { describe, expect, it } from 'vitest';
import { LOG_LEVELS, DEFAULT_LOG_LEVEL } from '../../../src/core/logging/logger';
import {
  COMMAND_IDS,
  CONFIG_KEYS,
  CONFIG_SECTION,
  CONTEXT_KEYS,
} from '../../../src/vscode/command-ids';
import { readJson } from '../../helpers/repo';

interface Manifest {
  contributes: {
    commands: { command: string; title: string; category?: string }[];
    menus: { commandPalette: { command: string; when: string }[] };
    configuration: {
      properties: Record<
        string,
        { enum?: string[]; default?: unknown; enumDescriptions?: string[] }
      >;
    };
  };
}

const { contributes } = readJson('package.json') as Manifest;

describe('command ids', () => {
  it('match the commands contributed in package.json', () => {
    expect(contributes.commands.map((c) => c.command).sort()).toEqual(
      Object.values(COMMAND_IDS).sort(),
    );
  });

  it('follow the <extId>.<area>.<action> pattern', () => {
    for (const id of Object.values(COMMAND_IDS)) {
      expect(id).toMatch(/^datanest\.[a-z]+(?:[A-Z][a-z]+)*\.[a-z]+(?:[A-Z][a-z]+)*$/);
    }
  });

  it('are unique', () => {
    const ids = Object.values(COMMAND_IDS);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('appear in the palette under the DataNest category', () => {
    for (const command of contributes.commands) {
      expect(command.category).toBe('DataNest');
    }
  });
});

describe('command palette', () => {
  const palette = contributes.menus.commandPalette;

  it('mentions only contributed commands', () => {
    const ids = new Set(contributes.commands.map((c) => c.command));
    for (const entry of palette) {
      expect(ids.has(entry.command)).toBe(true);
    }
  });

  it('uses only context keys the extension sets', () => {
    const known = new Set<string>(Object.values(CONTEXT_KEYS));
    for (const entry of palette) {
      const keys = entry.when.match(/datanest\.[\w.]+/g) ?? [];
      for (const key of keys) {
        expect(known.has(key)).toBe(true);
      }
    }
  });

  it('hides the ping page outside development', () => {
    expect(palette).toContainEqual({
      command: COMMAND_IDS.openPing,
      when: CONTEXT_KEYS.isDevelopment,
    });
  });
});

describe('settings', () => {
  const properties = contributes.configuration.properties;

  it('declares only settings the code knows', () => {
    expect(Object.keys(properties).sort()).toEqual(
      Object.values(CONFIG_KEYS)
        .map((key) => `${CONFIG_SECTION}.${key}`)
        .sort(),
    );
  });

  it('offers exactly the logger levels with the logger default', () => {
    const logLevel = properties[`${CONFIG_SECTION}.${CONFIG_KEYS.logLevel}`];
    expect(logLevel?.enum).toEqual(LOG_LEVELS);
    expect(logLevel?.default).toBe(DEFAULT_LOG_LEVEL);
    expect(logLevel?.enumDescriptions).toHaveLength(LOG_LEVELS.length);
  });
});

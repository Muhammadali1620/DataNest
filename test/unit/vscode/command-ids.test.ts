import { describe, expect, it } from 'vitest';
import { LOG_LEVELS, DEFAULT_LOG_LEVEL } from '../../../src/core/logging/logger';
import { COMMAND_IDS, CONFIG_KEYS, CONFIG_SECTION } from '../../../src/vscode/command-ids';
import { readJson } from '../../helpers/repo';

interface Manifest {
  contributes: {
    commands: { command: string; title: string; category?: string }[];
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

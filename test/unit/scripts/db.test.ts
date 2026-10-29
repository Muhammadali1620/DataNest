import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  COMPOSE_FILE,
  composeGroups,
  DEFAULT_GROUPS,
  dockerCommands,
  profileArgs,
} from '../../../scripts/db.mjs';
import { ROOT } from '../../helpers/repo';

const KNOWN = ['core', 'mssql', 'oracle'];
const BASE = ['compose', '-f', COMPOSE_FILE];

describe('composeGroups', () => {
  it('lists every profile once, in file order', () => {
    const yaml = [
      'services:',
      '  a: { image: x, profiles: [core] }',
      '  b: { image: x, profiles: [mssql] }',
      '  c: { image: x, profiles: [core] }',
      '  d: { image: x }',
    ].join('\n');
    expect(composeGroups(yaml)).toEqual(['core', 'mssql']);
  });

  it('finds nothing in a file without services', () => {
    expect(composeGroups('name: datanest\n')).toEqual([]);
  });

  it('reads the groups of the real compose file, core among them', () => {
    expect(composeGroups(readFileSync(join(ROOT, COMPOSE_FILE), 'utf8'))).toContain('core');
  });
});

describe('profileArgs', () => {
  it('starts the default groups when none is named', () => {
    expect(DEFAULT_GROUPS).toEqual(['core']);
    expect(profileArgs([], KNOWN)).toEqual(['--profile', 'core']);
  });

  it('passes each named group once', () => {
    expect(profileArgs(['mssql', 'core', 'mssql'], KNOWN)).toEqual([
      '--profile',
      'mssql',
      '--profile',
      'core',
    ]);
  });

  it('turns all into every profile', () => {
    expect(profileArgs(['core', 'all'], KNOWN)).toEqual(['--profile', '*']);
  });

  it('refuses a group the compose file does not have, naming the known ones', () => {
    expect(() => profileArgs(['mssql', 'db2'], KNOWN)).toThrow(
      'Unknown database group "db2"; known: core, mssql, oracle, all',
    );
  });
});

describe('dockerCommands', () => {
  it('starts groups and waits for their health checks', () => {
    expect(dockerCommands('up', ['oracle'], KNOWN)).toEqual([
      [...BASE, '--profile', 'oracle', 'up', '-d', '--wait'],
    ]);
  });

  it('stops every group, with their volumes', () => {
    expect(dockerCommands('down', [], KNOWN)).toEqual([
      [...BASE, '--profile', '*', 'down', '--volumes'],
    ]);
  });

  it('refuses group names for down, which always stops everything', () => {
    expect(() => dockerCommands('down', ['core'], KNOWN)).toThrow(/takes no group names/u);
  });

  it('resets by stopping everything and starting the named groups', () => {
    expect(dockerCommands('reset', ['mssql'], KNOWN)).toEqual([
      [...BASE, '--profile', '*', 'down', '--volumes'],
      [...BASE, '--profile', 'mssql', 'up', '-d', '--wait'],
    ]);
  });

  it('follows the logs of the named groups', () => {
    expect(dockerCommands('logs', [], KNOWN)).toEqual([
      [...BASE, '--profile', 'core', 'logs', '-f'],
    ]);
  });

  it('explains the usage for an unknown action', () => {
    expect(() => dockerCommands('restart', [], KNOWN)).toThrow(
      'Usage: db.mjs up|down|reset|logs [group…|all]',
    );
    expect(() => dockerCommands('', [], KNOWN)).toThrow(/^Usage/u);
  });

  it('checks group names before anything runs', () => {
    expect(() => dockerCommands('reset', ['nope'], KNOWN)).toThrow(/Unknown database group/u);
  });
});

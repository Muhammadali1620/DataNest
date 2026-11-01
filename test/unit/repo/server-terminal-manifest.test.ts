// The terminal and "Run command" of the Servers view (V13.18) in package.json: the commands
// exist, are offered on servers and folders (also on a read-only server's, which asks first),
// stay in the palette, and have texts in both languages.

import { describe, expect, it } from 'vitest';
import { COMMAND_IDS } from '../../../src/vscode/command-ids';
import {
  entryContext,
  SERVER_CONTEXT,
  SERVERS_VIEW_ID,
} from '../../../src/vscode/servers/server-model';
import { readJson } from '../../helpers/repo';

interface Entry {
  command: string;
  when: string;
  group?: string;
}

interface Manifest {
  contributes: {
    commands: { command: string; title: string; icon?: string }[];
    menus: Record<string, Entry[]>;
  };
}

const manifest = readJson('package.json') as Manifest;
const nls = readJson('package.nls.json') as Record<string, string>;
const nlsRu = readJson('package.nls.ru.json') as Record<string, string>;
const menu = (manifest.contributes.menus['view/item/context'] ?? []).filter((entry) =>
  entry.when.includes(`view == ${SERVERS_VIEW_ID}`),
);

const COMMANDS = [COMMAND_IDS.openServerTerminal, COMMAND_IDS.runServerCommand];

/** Whether the clause of a menu entry lets the command appear on `context`. */
function offeredOn(command: string, context: string): boolean {
  return menu
    .filter((entry) => entry.command === command)
    .some((entry) => {
      const clause = /viewItem =~ \/(.+)\/$/u.exec(entry.when);
      return (
        clause?.[1] !== undefined &&
        new RegExp(clause[1].replaceAll('\\\\', '\\'), 'u').test(context)
      );
    });
}

describe('the terminal in the manifest', () => {
  it('has stable command ids', () => {
    expect(COMMANDS).toEqual(['datanest.servers.terminal', 'datanest.servers.runCommand']);
  });

  it('contributes both commands with a title and an icon', () => {
    for (const id of COMMANDS) {
      const item = manifest.contributes.commands.find((candidate) => candidate.command === id);
      expect(item, id).toBeDefined();
      expect(item?.icon, id).toMatch(/^\$\([a-z-]+\)$/u);
    }
  });

  it('has an English and a different Russian title for each', () => {
    for (const id of COMMANDS) {
      const item = manifest.contributes.commands.find((candidate) => candidate.command === id);
      const key = (item?.title ?? '').replace(/^%|%$/gu, '');
      expect(nls[key], key).toBeTruthy();
      expect(nlsRu[key], key).toBeTruthy();
      expect(nlsRu[key], key).not.toBe(nls[key]);
    }
  });

  it('offers both on a server, open or not, and on a folder, read-only or not', () => {
    for (const command of COMMANDS) {
      expect(offeredOn(command, SERVER_CONTEXT.server), command).toBe(true);
      expect(offeredOn(command, SERVER_CONTEXT.serverOpen), command).toBe(true);
      expect(offeredOn(command, entryContext({ kind: 'directory' }, false)), command).toBe(true);
      expect(offeredOn(command, entryContext({ kind: 'directory' }, true)), command).toBe(true);
    }
  });

  it('does not offer them on files or on a message line', () => {
    for (const command of COMMANDS) {
      expect(offeredOn(command, entryContext({ kind: 'file' }, false)), command).toBe(false);
      expect(offeredOn(command, entryContext({ kind: 'file' }, true)), command).toBe(false);
      expect(offeredOn(command, SERVER_CONTEXT.message), command).toBe(false);
    }
  });

  it('puts the terminal on the row of a server as a button', () => {
    const inline = menu.filter(
      (entry) =>
        entry.command === COMMAND_IDS.openServerTerminal && entry.group?.startsWith('inline'),
    );
    expect(inline).toHaveLength(1);
  });

  it('leaves both in the palette, where they ask which server', () => {
    const hidden = (manifest.contributes.menus.commandPalette ?? [])
      .filter((entry) => entry.when === 'false')
      .map((entry) => entry.command);
    for (const id of COMMANDS) {
      expect(hidden, id).not.toContain(id);
    }
  });
});

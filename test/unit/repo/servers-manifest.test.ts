// The Servers view (V13.16) in package.json: its view, commands, menus, settings and
// texts agree with the code and with each other.

import { describe, expect, it } from 'vitest';
import { COMMAND_IDS, CONFIG_KEYS } from '../../../src/vscode/command-ids';
import {
  entryContext,
  SERVER_CONTEXT,
  SERVERS_VIEW_ID,
  SFTP_SCHEME,
} from '../../../src/vscode/servers/server-model';
import { readJson } from '../../helpers/repo';

interface Entry {
  command: string;
  when: string;
  group?: string;
}

interface Manifest {
  activationEvents: string[];
  contributes: {
    views: Record<string, { id: string; name: string }[]>;
    viewsWelcome: { view: string; contents: string }[];
    commands: { command: string; title: string; icon?: string }[];
    menus: Record<string, Entry[]>;
    configuration: {
      properties: Record<string, { default: unknown; markdownDescription: string }>;
    };
  };
}

const manifest = readJson('package.json') as Manifest;
const nls = readJson('package.nls.json') as Record<string, string>;
const nlsRu = readJson('package.nls.ru.json') as Record<string, string>;
const contributes = manifest.contributes;

const SERVER_COMMANDS: string[] = Object.entries(COMMAND_IDS)
  .filter(([, id]) => id.startsWith('datanest.servers.') || id.startsWith('datanest.sftp.'))
  .map(([, id]) => id);

const forServers = (entry: Entry): boolean => entry.when.includes(`view == ${SERVERS_VIEW_ID}`);
const titleMenu = contributes.menus['view/title']?.filter(forServers) ?? [];
const itemMenu = contributes.menus['view/item/context']?.filter(forServers) ?? [];

/** The context values the tree sets, for a server that is read-write and one that is read-only. */
const contexts = [
  SERVER_CONTEXT.server,
  SERVER_CONTEXT.serverOpen,
  entryContext({ kind: 'directory' }, false),
  entryContext({ kind: 'directory' }, true),
  entryContext({ kind: 'file' }, false),
  entryContext({ kind: 'file' }, true),
  SERVER_CONTEXT.message,
];

/** The context values a `when` clause lets its command appear on. */
function matching(when: string): string[] {
  const clause = /viewItem (==|=~) (\S+(?: \S+)*?)(?: &&|$|\))/u.exec(when);
  if (clause === null) {
    return [];
  }
  const [, operator, value = ''] = clause;
  if (operator === '==') {
    return contexts.filter((context) => context === value);
  }
  const pattern = new RegExp(value.replace(/^\/|\/$/gu, ''), 'u');
  return contexts.filter((context) => pattern.test(context));
}

describe('the Servers view in the manifest', () => {
  it('is a view of the DataNest container, with a welcome text for the empty case', () => {
    expect(contributes.views.datanest?.map((view) => view.id)).toContain(SERVERS_VIEW_ID);
    expect(SERVERS_VIEW_ID.startsWith('datanest.')).toBe(true);
    expect(contributes.viewsWelcome.some((welcome) => welcome.view === SERVERS_VIEW_ID)).toBe(true);
  });

  it('activates on the view and on its file system, never at startup', () => {
    expect(manifest.activationEvents).toContain(`onView:${SERVERS_VIEW_ID}`);
    expect(manifest.activationEvents).toContain(`onFileSystem:${SFTP_SCHEME}`);
  });

  it('has the same scheme for files in code and in the activation event', () => {
    expect(SFTP_SCHEME).toBe('datanest-sftp');
  });

  it('contributes every command the code registers, with a title and an icon', () => {
    const contributed = new Map(contributes.commands.map((item) => [item.command, item]));
    expect(SERVER_COMMANDS.length).toBeGreaterThanOrEqual(20);
    for (const id of SERVER_COMMANDS) {
      const item = contributed.get(id);
      expect(item, id).toBeDefined();
      expect(item?.icon, id).toMatch(/^\$\([a-z-]+\)$/u);
    }
  });

  it('has an English and a Russian text for every title, the view and the settings', () => {
    const keys = [
      'views.servers.name',
      'viewsWelcome.servers.empty',
      'configuration.servers.maxOpenSizeMb.description',
      'configuration.servers.showHidden.description',
      ...contributes.commands
        .filter((item) => SERVER_COMMANDS.includes(item.command))
        .map((item) => item.title.replace(/^%|%$/gu, '')),
    ];
    for (const key of keys) {
      expect(nls[key], key).toBeTruthy();
      expect(nlsRu[key], key).toBeTruthy();
      expect(nlsRu[key], key).not.toBe(nls[key]);
    }
  });

  it('shows no command in the palette that needs a node of the tree', () => {
    const hidden = new Set(
      (contributes.menus.commandPalette ?? [])
        .filter((entry) => entry.when === 'false')
        .map((entry) => entry.command),
    );
    for (const id of [
      COMMAND_IDS.sftpOpen,
      COMMAND_IDS.sftpUpload,
      COMMAND_IDS.sftpUploadFolder,
      COMMAND_IDS.sftpDownload,
      COMMAND_IDS.sftpRename,
      COMMAND_IDS.sftpDelete,
      COMMAND_IDS.sftpNewFolder,
      COMMAND_IDS.sftpNewFile,
      COMMAND_IDS.sftpChmod,
      COMMAND_IDS.sftpCopyPath,
      COMMAND_IDS.sftpCopyTo,
      COMMAND_IDS.sftpMoveTo,
      COMMAND_IDS.sftpRefresh,
      COMMAND_IDS.disconnectServer,
    ]) {
      expect(hidden.has(id), id).toBe(true);
    }
    // Those that pick a server for themselves stay in the palette.
    for (const id of [COMMAND_IDS.addServer, COMMAND_IDS.editServer, COMMAND_IDS.removeServer]) {
      expect(hidden.has(id), id).toBe(false);
    }
  });
});

describe('the menus of the Servers view', () => {
  const contributed = new Set(contributes.commands.map((item) => item.command));

  it('mention only contributed commands', () => {
    for (const entry of [...titleMenu, ...itemMenu]) {
      expect(contributed.has(entry.command), entry.command).toBe(true);
    }
  });

  it('put adding, refreshing, importing and exporting in the title', () => {
    expect(titleMenu.map((entry) => entry.command)).toEqual([
      COMMAND_IDS.addServer,
      COMMAND_IDS.refreshServers,
      COMMAND_IDS.exportServers,
      COMMAND_IDS.importServers,
    ]);
  });

  it('match only items the tree actually sets', () => {
    for (const entry of itemMenu) {
      expect(matching(entry.when).length, `${entry.command}: ${entry.when}`).toBeGreaterThan(0);
    }
  });

  it('offer nothing on the message lines of the tree', () => {
    for (const entry of itemMenu) {
      expect(matching(entry.when), entry.command).not.toContain(SERVER_CONTEXT.message);
    }
  });

  const where = (command: string): string[] => [
    ...new Set(
      itemMenu
        .filter((entry) => entry.command === command)
        .flatMap((entry) => matching(entry.when)),
    ),
  ];

  const WRITES = [
    COMMAND_IDS.sftpRename,
    COMMAND_IDS.sftpDelete,
    COMMAND_IDS.sftpChmod,
    COMMAND_IDS.sftpMoveTo,
    COMMAND_IDS.sftpUpload,
    COMMAND_IDS.sftpUploadFolder,
    COMMAND_IDS.sftpNewFolder,
    COMMAND_IDS.sftpNewFile,
  ];

  it('offer no change on the entries of a read-only server', () => {
    for (const command of WRITES) {
      for (const context of where(command)) {
        expect(context.endsWith('.ro'), `${command} on ${context}`).toBe(false);
      }
    }
  });

  it('offer opening, downloading, copying and the path on files and folders of any server', () => {
    for (const command of [
      COMMAND_IDS.sftpDownload,
      COMMAND_IDS.sftpCopyTo,
      COMMAND_IDS.sftpCopyPath,
    ]) {
      expect(where(command), command).toEqual(
        expect.arrayContaining([
          entryContext({ kind: 'file' }, false),
          entryContext({ kind: 'file' }, true),
          entryContext({ kind: 'directory' }, false),
          entryContext({ kind: 'directory' }, true),
        ]),
      );
    }
    expect(where(COMMAND_IDS.sftpOpen)).toEqual([
      entryContext({ kind: 'file' }, false),
      entryContext({ kind: 'file' }, true),
    ]);
  });

  it('offer uploading and making things on servers and folders, but not on files', () => {
    for (const command of [
      COMMAND_IDS.sftpUpload,
      COMMAND_IDS.sftpNewFolder,
      COMMAND_IDS.sftpNewFile,
    ]) {
      const set = where(command);
      expect(set, command).toContain(SERVER_CONTEXT.server);
      expect(set, command).toContain(SERVER_CONTEXT.serverOpen);
      expect(set, command).toContain(SERVER_CONTEXT.folder);
      expect(set, command).not.toContain(SERVER_CONTEXT.file);
    }
  });

  it('offer disconnecting only a server that is connected, and editing every server', () => {
    expect(where(COMMAND_IDS.disconnectServer)).toEqual([SERVER_CONTEXT.serverOpen]);
    expect(where(COMMAND_IDS.editServer)).toEqual([
      SERVER_CONTEXT.server,
      SERVER_CONTEXT.serverOpen,
    ]);
    expect(where(COMMAND_IDS.removeServer)).toEqual([
      SERVER_CONTEXT.server,
      SERVER_CONTEXT.serverOpen,
    ]);
  });

  it('keep delete last, apart from the rest', () => {
    const remove = itemMenu.find((entry) => entry.command === COMMAND_IDS.sftpDelete);
    expect(remove?.group).toBe('9_delete@1');
  });
});

describe('the settings of the Servers view', () => {
  it('are in the manifest with their defaults, as the code reads them', () => {
    const properties = contributes.configuration.properties;
    expect(properties[`datanest.${CONFIG_KEYS.serversMaxOpenSizeMb}`]?.default).toBe(5);
    expect(properties[`datanest.${CONFIG_KEYS.serversShowHidden}`]?.default).toBe(true);
  });
});

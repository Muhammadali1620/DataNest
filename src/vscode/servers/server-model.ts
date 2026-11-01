// What the server tree shows (V13.16), decided without `vscode` so the rules are unit-tested:
// icons and colours by kind, the line under a name, the menu context, the editor addresses.

import { formatSize } from '../../shared/byte-size';
import { type FileKind, fileKindOf } from '../../shared/file-kind';
import { modeText } from '../../shared/remote-path';
import type { SftpEntry } from '../../services/sftp-types';

/** The id of the Servers view. */
export const SERVERS_VIEW_ID = 'datanest.servers';

/** The scheme of files opened from a server: `datanest-sftp://<server id>/<path>`. */
export const SFTP_SCHEME = 'datanest-sftp';

/** Context values the menus of package.json match. */
export const SERVER_CONTEXT = {
  server: 'datanest.server',
  serverOpen: 'datanest.server.open',
  folder: 'datanest.sftpDir',
  file: 'datanest.sftpFile',
  message: 'datanest.sftpMessage',
} as const;

/** The suffix a read-only server's entries carry, so write commands are not offered on them. */
export const READ_ONLY_SUFFIX = '.ro';

export function entryContext(entry: Pick<SftpEntry, 'kind'>, readOnly: boolean): string {
  const base = entry.kind === 'directory' ? SERVER_CONTEXT.folder : SERVER_CONTEXT.file;
  return readOnly ? `${base}${READ_ONLY_SUFFIX}` : base;
}

export interface KindLook {
  /** A codicon name. */
  readonly icon: string;
  /** A theme colour id every theme defines. */
  readonly color: string;
}

const LOOKS: Readonly<Record<FileKind, KindLook>> = {
  folder: { icon: 'folder', color: 'charts.yellow' },
  code: { icon: 'file-code', color: 'charts.blue' },
  script: { icon: 'terminal', color: 'charts.green' },
  config: { icon: 'settings-gear', color: 'charts.orange' },
  text: { icon: 'file-text', color: 'foreground' },
  markup: { icon: 'code', color: 'charts.orange' },
  data: { icon: 'json', color: 'charts.yellow' },
  image: { icon: 'file-media', color: 'charts.purple' },
  media: { icon: 'play-circle', color: 'charts.purple' },
  archive: { icon: 'file-zip', color: 'charts.red' },
  database: { icon: 'database', color: 'charts.green' },
  document: { icon: 'book', color: 'charts.blue' },
  key: { icon: 'key', color: 'charts.yellow' },
  binary: { icon: 'file-binary', color: 'disabledForeground' },
  other: { icon: 'file', color: 'foreground' },
};

/** The icon and colour of an entry; a link wears the link icon of its kind. */
export function lookOf(entry: Pick<SftpEntry, 'kind' | 'link' | 'name'>): KindLook {
  if (entry.kind === 'symlink') {
    return { icon: 'file-symlink-file', color: 'errorForeground' };
  }
  if (entry.kind === 'directory') {
    return entry.link ? { icon: 'file-symlink-directory', color: 'charts.yellow' } : LOOKS.folder;
  }
  if (entry.kind === 'other') {
    return { icon: 'question', color: 'disabledForeground' };
  }
  const look = LOOKS[fileKindOf(entry.name)];
  return entry.link ? { icon: 'file-symlink-file', color: look.color } : look;
}

/** `1.5 KB · rw-r--r-- · 3 Nov 2026`: size (files only), permissions, last change. */
export function entryDescription(
  entry: Pick<SftpEntry, 'kind' | 'size' | 'mode' | 'modified' | 'link'>,
  language: string,
): string {
  const parts: string[] = [];
  if (entry.kind === 'file') {
    parts.push(formatSize(entry.size));
  }
  if (entry.kind !== 'symlink') {
    parts.push(modeText(entry.mode));
  }
  if (entry.modified > 0) {
    parts.push(dateText(entry.modified, language));
  }
  return parts.join(' · ');
}

/** The date, and the time too when it is within the last half year. */
export function dateText(milliseconds: number, language: string, now = Date.now()): string {
  const date = new Date(milliseconds);
  const recent = Math.abs(now - milliseconds) < 183 * 24 * 3600 * 1000;
  try {
    return new Intl.DateTimeFormat(language, {
      day: 'numeric',
      month: 'short',
      ...(recent ? { hour: '2-digit', minute: '2-digit' } : { year: 'numeric' }),
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/** The address of a file of a server for the editor. */
export function sftpUriParts(
  serverId: string,
  path: string,
): {
  scheme: string;
  authority: string;
  path: string;
} {
  return {
    scheme: SFTP_SCHEME,
    authority: serverId,
    path: path.startsWith('/') ? path : `/${path}`,
  };
}

/** Id of a tree node, unique across servers. */
export function entryNodeId(serverId: string, path: string): string {
  return `datanest.server:${serverId}:${path}`;
}

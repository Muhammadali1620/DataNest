import { describe, expect, it } from 'vitest';
import type { SftpEntry } from '../../../../src/services/sftp-types';
import {
  dateText,
  entryContext,
  entryDescription,
  entryNodeId,
  lookOf,
  READ_ONLY_SUFFIX,
  SERVER_CONTEXT,
  SFTP_SCHEME,
  sftpUriParts,
} from '../../../../src/vscode/servers/server-model';

function entry(overrides: Partial<SftpEntry> = {}): SftpEntry {
  return {
    name: 'a.txt',
    path: '/a.txt',
    kind: 'file',
    link: false,
    size: 1536,
    modified: 0,
    mode: 0o100644,
    ...overrides,
  };
}

describe('entryContext', () => {
  it('names folders and files, and marks those of a read-only server', () => {
    expect(entryContext({ kind: 'directory' }, false)).toBe(SERVER_CONTEXT.folder);
    expect(entryContext({ kind: 'file' }, false)).toBe(SERVER_CONTEXT.file);
    expect(entryContext({ kind: 'directory' }, true)).toBe(
      `${SERVER_CONTEXT.folder}${READ_ONLY_SUFFIX}`,
    );
    expect(entryContext({ kind: 'file' }, true)).toBe(`${SERVER_CONTEXT.file}${READ_ONLY_SUFFIX}`);
  });

  it('treats a special file as a file', () => {
    expect(entryContext({ kind: 'other' }, false)).toBe(SERVER_CONTEXT.file);
  });
});

describe('lookOf', () => {
  it('gives folders a yellow folder', () => {
    expect(lookOf(entry({ name: 'src', kind: 'directory' }))).toEqual({
      icon: 'folder',
      color: 'charts.yellow',
    });
  });

  it('colours files by kind', () => {
    expect(lookOf(entry({ name: 'x.ts' }))).toEqual({ icon: 'file-code', color: 'charts.blue' });
    expect(lookOf(entry({ name: 'x.sh' }))).toEqual({ icon: 'terminal', color: 'charts.green' });
    expect(lookOf(entry({ name: 'x.zip' }))).toEqual({ icon: 'file-zip', color: 'charts.red' });
    expect(lookOf(entry({ name: 'x.png' }))).toEqual({
      icon: 'file-media',
      color: 'charts.purple',
    });
    expect(lookOf(entry({ name: 'x.db' }))).toEqual({ icon: 'database', color: 'charts.green' });
    expect(lookOf(entry({ name: 'noext' }))).toEqual({ icon: 'file', color: 'foreground' });
  });

  it('shows a link with the link icon, keeping the colour of what it leads to', () => {
    expect(lookOf(entry({ name: 'x.ts', link: true }))).toEqual({
      icon: 'file-symlink-file',
      color: 'charts.blue',
    });
    expect(lookOf(entry({ name: 'd', kind: 'directory', link: true }))).toEqual({
      icon: 'file-symlink-directory',
      color: 'charts.yellow',
    });
  });

  it('shows a broken link and a special file apart', () => {
    expect(lookOf(entry({ kind: 'symlink', link: true })).color).toBe('errorForeground');
    expect(lookOf(entry({ kind: 'other' })).icon).toBe('question');
  });
});

describe('entryDescription', () => {
  const when = Date.UTC(2020, 0, 15, 12, 0);

  it('shows size, permissions and date for a file', () => {
    expect(entryDescription(entry({ modified: when }), 'en')).toMatch(
      /^1\.5 KB · rw-r--r-- · .*2020/u,
    );
  });

  it('leaves the size off a folder', () => {
    expect(
      entryDescription(entry({ kind: 'directory', mode: 0o40755, modified: when }), 'en'),
    ).toMatch(/^rwxr-xr-x · .*2020/u);
  });

  it('leaves the date off when the server did not send one', () => {
    expect(entryDescription(entry({ modified: 0 }), 'en')).toBe('1.5 KB · rw-r--r--');
  });

  it('shows no permissions for a broken link', () => {
    expect(entryDescription(entry({ kind: 'symlink', link: true, modified: 0 }), 'en')).toBe('');
  });
});

describe('dateText', () => {
  it('shows the time for a recent date and the year for an old one', () => {
    const now = Date.UTC(2026, 10, 1, 12, 0);
    expect(dateText(Date.UTC(2026, 9, 30, 8, 5), 'en', now)).toMatch(/\d{1,2}:\d{2}/u);
    expect(dateText(Date.UTC(2020, 0, 2), 'en', now)).toMatch(/2020/u);
  });

  it('falls back to an ISO date for a language the runtime does not know', () => {
    expect(dateText(Date.UTC(2020, 0, 2), 'not a language!')).toBe('2020-01-02');
  });
});

describe('addresses', () => {
  it('builds the address of a file for the editor', () => {
    expect(sftpUriParts('abc', '/etc/hosts')).toEqual({
      scheme: SFTP_SCHEME,
      authority: 'abc',
      path: '/etc/hosts',
    });
    expect(sftpUriParts('abc', 'relative').path).toBe('/relative');
  });

  it('gives every node its own id, per server and per path', () => {
    expect(entryNodeId('s1', '/a')).not.toBe(entryNodeId('s2', '/a'));
    expect(entryNodeId('s1', '/a')).not.toBe(entryNodeId('s1', '/b'));
    expect(entryNodeId('s1', '/a')).toBe(entryNodeId('s1', '/a'));
  });
});

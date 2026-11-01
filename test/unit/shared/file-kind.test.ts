import { describe, expect, it } from 'vitest';
import { fileKindOf, opensAsText } from '../../../src/shared/file-kind';

describe('fileKindOf', () => {
  it.each([
    ['app.ts', 'code'],
    ['main.PY', 'code'],
    ['style.css', 'code'],
    ['deploy.sh', 'script'],
    ['run.bat', 'script'],
    ['nginx.conf', 'config'],
    ['values.yaml', 'config'],
    ['notes.txt', 'text'],
    ['README.md', 'text'],
    ['server.log', 'text'],
    ['index.html', 'markup'],
    ['data.json', 'data'],
    ['dump.sql', 'data'],
    ['photo.JPG', 'image'],
    ['clip.mp4', 'media'],
    ['backup.tar.gz', 'archive'],
    ['site.zip', 'archive'],
    ['app.sqlite', 'database'],
    ['report.pdf', 'document'],
    ['server.pem', 'key'],
    ['tool.exe', 'binary'],
    ['libc.so', 'binary'],
  ])('%s is %s', (name, kind) => {
    expect(fileKindOf(name)).toBe(kind);
  });

  it('knows some files by their whole name', () => {
    expect(fileKindOf('Dockerfile')).toBe('config');
    expect(fileKindOf('Makefile')).toBe('script');
    expect(fileKindOf('authorized_keys')).toBe('key');
    expect(fileKindOf('.gitignore')).toBe('config');
    expect(fileKindOf('id_ed25519')).toBe('key');
  });

  it('reads dot-files and names with several dots', () => {
    expect(fileKindOf('.env')).toBe('config');
    expect(fileKindOf('.env.local')).toBe('config');
    expect(fileKindOf('.env.production')).toBe('config');
    expect(fileKindOf('archive.2026.01.tar.gz')).toBe('archive');
    expect(fileKindOf('config.backup.yaml')).toBe('config');
  });

  it('says "other" for a name that tells nothing', () => {
    expect(fileKindOf('LICENSEE')).toBe('other');
    expect(fileKindOf('data')).toBe('other');
    expect(fileKindOf('file.unknownext')).toBe('other');
    expect(fileKindOf('.hiddenthing')).toBe('other');
    expect(fileKindOf('')).toBe('other');
  });
});

describe('opensAsText', () => {
  it('refuses what is plainly not text', () => {
    for (const kind of ['archive', 'database', 'binary', 'media'] as const) {
      expect(opensAsText(kind)).toBe(false);
    }
  });

  it('allows the rest, images and documents included (the editor has viewers for them)', () => {
    for (const kind of ['code', 'text', 'config', 'data', 'image', 'document', 'other'] as const) {
      expect(opensAsText(kind)).toBe(true);
    }
  });
});

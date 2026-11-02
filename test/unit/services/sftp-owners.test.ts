import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  loadOwnerNames,
  NO_OWNER_NAMES,
  ownerNamesOf,
  ownerText,
  parseNameFile,
  resolveOwner,
} from '../../../src/services/sftp-owners';
import type { SftpSession } from '../../../src/services/sftp-types';

const PASSWD = [
  '# a comment',
  'root:x:0:0:root:/root:/bin/bash',
  'deploy:x:1000:1000:Deploy,,,:/home/deploy:/bin/bash',
  'twin:x:1000:1000::/home/twin:/bin/sh',
  'broken line',
  ':x:5:5::/x:/y',
  'nobody:x:abc:1::/n:/y',
  '',
].join('\n');

const GROUP = ['root:x:0:', 'www:x:33:deploy', 'deploy:x:1000:'].join('\r\n');

describe('parseNameFile', () => {
  it('reads the name and the id of each line', () => {
    const names = parseNameFile(PASSWD);
    expect(names.get(0)).toBe('root');
    expect(names.get(1000)).toBe('deploy');
  });

  it('keeps the first name of an id, skips comments, blank names and ids that are not numbers', () => {
    const names = parseNameFile(PASSWD);
    expect([...names.keys()].sort((a, b) => a - b)).toEqual([0, 1000]);
    expect(names.get(5)).toBeUndefined();
  });

  it('copes with empty text', () => {
    expect(parseNameFile('').size).toBe(0);
  });
});

describe('ownerNamesOf', () => {
  it('maps both ways, the first name of an id winning', () => {
    const names = ownerNamesOf(PASSWD, GROUP);
    expect(names.userIds.get('deploy')).toBe(1000);
    expect(names.userIds.get('twin')).toBe(1000);
    expect(names.users.get(1000)).toBe('deploy');
    expect(names.groupIds.get('www')).toBe(33);
    expect(names.groups.get(33)).toBe('www');
  });
});

describe('ownerText', () => {
  const names = ownerNamesOf(PASSWD, GROUP);

  it('writes names, and numbers where the server has no name', () => {
    expect(ownerText(1000, 33, names)).toBe('deploy:www');
    expect(ownerText(4242, 33, names)).toBe('4242:www');
    expect(ownerText(1000, 4242, names)).toBe('deploy:4242');
  });

  it('leaves out what the server did not say, and is empty when it said neither', () => {
    expect(ownerText(1000, undefined, names)).toBe('deploy:');
    expect(ownerText(undefined, 33, names)).toBe(':www');
    expect(ownerText(undefined, undefined, names)).toBe('');
  });

  it('writes plain numbers when there are no names', () => {
    expect(ownerText(1000, 1000)).toBe('1000:1000');
    expect(ownerText(1, 2, NO_OWNER_NAMES)).toBe('1:2');
  });
});

describe('resolveOwner', () => {
  const names = ownerNamesOf(PASSWD, GROUP);

  it('takes numbers as they are, with or without names', () => {
    expect(resolveOwner('1000:33', names)).toEqual({ uid: 1000, gid: 33 });
    expect(resolveOwner('1000:33')).toEqual({ uid: 1000, gid: 33 });
    expect(resolveOwner('7')).toEqual({ uid: 7 });
    expect(resolveOwner(':9')).toEqual({ gid: 9 });
  });

  it('turns names into numbers by the server’s files', () => {
    expect(resolveOwner('deploy:www', names)).toEqual({ uid: 1000, gid: 33 });
    expect(resolveOwner('root', names)).toEqual({ uid: 0 });
    expect(resolveOwner(':www', names)).toEqual({ gid: 33 });
  });

  it('allows a name and a number together, and spaces around', () => {
    expect(resolveOwner('  deploy : 5 ', names)).toEqual({ uid: 1000, gid: 5 });
    expect(resolveOwner('5:www', names)).toEqual({ uid: 5, gid: 33 });
  });

  it('says which name the server does not know', () => {
    expect(resolveOwner('ghost:www', names)).toEqual({ unknown: 'user', name: 'ghost' });
    expect(resolveOwner('deploy:ghosts', names)).toEqual({ unknown: 'group', name: 'ghosts' });
    expect(resolveOwner('deploy')).toEqual({ unknown: 'user', name: 'deploy' });
  });

  it('is undefined for text that names nothing', () => {
    expect(resolveOwner('')).toBeUndefined();
    expect(resolveOwner(':')).toBeUndefined();
    expect(resolveOwner('  ')).toBeUndefined();
    expect(resolveOwner('a:b:c', names)).toBeUndefined();
    expect(resolveOwner('two words', names)).toBeUndefined();
  });
});

function sessionWith(files: Record<string, string | Error>): SftpSession {
  return {
    openRead: vi.fn((path: string) => {
      const content = files[path];
      if (content === undefined || content instanceof Error) {
        return Promise.reject(content ?? new Error('No such file'));
      }
      return Promise.resolve({
        stream: Readable.from([Buffer.from(content)]),
        size: content.length,
      });
    }),
  } as unknown as SftpSession;
}

describe('loadOwnerNames', () => {
  it('reads /etc/passwd and /etc/group', async () => {
    const names = await loadOwnerNames(sessionWith({ '/etc/passwd': PASSWD, '/etc/group': GROUP }));
    expect(names.users.get(1000)).toBe('deploy');
    expect(names.groups.get(33)).toBe('www');
  });

  it('gives no names for a file that is missing or cannot be read, never an error', async () => {
    const names = await loadOwnerNames(
      sessionWith({ '/etc/passwd': new Error('Permission denied') }),
    );
    expect(names.users.size).toBe(0);
    expect(names.groups.size).toBe(0);
  });

  it('keeps what one file gave when the other is missing', async () => {
    const names = await loadOwnerNames(sessionWith({ '/etc/group': GROUP }));
    expect(names.users.size).toBe(0);
    expect(names.groups.get(0)).toBe('root');
  });

  it('does not read a file that says it is huge', async () => {
    const destroy = vi.fn();
    const session = {
      openRead: vi.fn(() =>
        Promise.resolve({
          stream: Object.assign(Readable.from([]), { destroy }),
          size: 10_000_000,
        }),
      ),
    } as unknown as SftpSession;
    const names = await loadOwnerNames(session);
    expect(names.users.size).toBe(0);
    expect(destroy).toHaveBeenCalled();
  });

  it('stops reading a file that turns out larger than it said', async () => {
    const big = Buffer.alloc(1024 * 1024, 'a');
    const session = {
      openRead: vi.fn(() => Promise.resolve({ stream: Readable.from([big, big, big]), size: 10 })),
    } as unknown as SftpSession;
    const names = await loadOwnerNames(session);
    expect(names.users.size).toBe(0);
  });
});

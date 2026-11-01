import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  algorithmProblems,
  cleanAlgorithms,
  legacyAlgorithms,
  parseAlgorithmRule,
  SSH_ALGORITHM_KINDS,
  SSH_ALGORITHMS,
  ssh2Algorithms,
} from '../../../src/shared/ssh-algorithms';
import { sshHopProblems, type SshHop } from '../../../src/shared/connection';

const require = createRequire(import.meta.url);
const constants = require('ssh2/lib/protocol/constants.js') as Record<string, string[]>;

const SSH2_NAMES = {
  kex: ['SUPPORTED_KEX', 'DEFAULT_KEX'],
  serverHostKey: ['SUPPORTED_SERVER_HOST_KEY', 'DEFAULT_SERVER_HOST_KEY'],
  cipher: ['SUPPORTED_CIPHER', 'DEFAULT_CIPHER'],
  hmac: ['SUPPORTED_MAC', 'DEFAULT_MAC'],
  compress: ['SUPPORTED_COMPRESSION', 'DEFAULT_COMPRESSION'],
} as const;

describe('the lists of algorithm names', () => {
  it.each(SSH_ALGORITHM_KINDS)('match the installed ssh2 for %s', (kind) => {
    const [supported, defaults] = SSH2_NAMES[kind];
    expect([...SSH_ALGORITHMS[kind].supported].sort()).toEqual(
      [...(constants[supported] ?? [])].sort(),
    );
    expect([...SSH_ALGORITHMS[kind].defaults].sort()).toEqual(
      [...(constants[defaults] ?? [])].sort(),
    );
  });

  it('offer by default only what ssh2 supports', () => {
    for (const kind of SSH_ALGORITHM_KINDS) {
      const supported = new Set(SSH_ALGORITHMS[kind].supported);
      expect(SSH_ALGORITHMS[kind].defaults.every((name) => supported.has(name))).toBe(true);
    }
  });
});

describe('parseAlgorithmRule', () => {
  it('treats blank text as the default, never as a problem', () => {
    expect(parseAlgorithmRule('kex', undefined)).toBeUndefined();
    expect(parseAlgorithmRule('kex', '')).toBeUndefined();
    expect(parseAlgorithmRule('kex', '   ')).toBeUndefined();
  });

  it('reads the four forms of the OpenSSH syntax', () => {
    expect(parseAlgorithmRule('kex', 'diffie-hellman-group1-sha1')).toEqual({
      ok: true,
      change: { only: ['diffie-hellman-group1-sha1'] },
    });
    expect(parseAlgorithmRule('kex', '+diffie-hellman-group1-sha1')).toEqual({
      ok: true,
      change: { append: ['diffie-hellman-group1-sha1'] },
    });
    expect(parseAlgorithmRule('cipher', '-aes128-ctr, aes192-ctr')).toEqual({
      ok: true,
      change: { remove: ['aes128-ctr', 'aes192-ctr'] },
    });
    expect(parseAlgorithmRule('hmac', '^hmac-sha1')).toEqual({
      ok: true,
      change: { prepend: ['hmac-sha1'] },
    });
  });

  it('keeps the order written, drops repeats and blanks around names', () => {
    expect(parseAlgorithmRule('cipher', ' aes256-ctr , aes128-ctr,aes256-ctr ')).toEqual({
      ok: true,
      change: { only: ['aes256-ctr', 'aes128-ctr'] },
    });
  });

  it('names the algorithms ssh2 does not know, in the order written', () => {
    expect(parseAlgorithmRule('kex', '+nonsense,diffie-hellman-group1-sha1,other')).toEqual({
      ok: false,
      problem: { kind: 'unknown', names: ['nonsense', 'other'] },
    });
  });

  it('does not take a name of another kind', () => {
    expect(parseAlgorithmRule('cipher', 'hmac-sha1')).toMatchObject({ ok: false });
    expect(parseAlgorithmRule('compress', 'aes128-ctr')).toMatchObject({ ok: false });
  });

  it('refuses a sign without names and empty places between commas', () => {
    for (const text of [
      '+',
      '-',
      '^',
      '+,',
      'aes128-ctr,',
      ',aes128-ctr',
      'aes128-ctr,,aes256-ctr',
    ]) {
      expect(parseAlgorithmRule('cipher', text)).toEqual({ ok: false, problem: { kind: 'empty' } });
    }
  });

  it('is case sensitive, as the names on the wire are', () => {
    expect(parseAlgorithmRule('cipher', 'AES128-CTR')).toMatchObject({ ok: false });
  });
});

describe('algorithmProblems', () => {
  it('lists every kind with a bad rule and none for good or missing ones', () => {
    expect(algorithmProblems(undefined)).toEqual([]);
    expect(algorithmProblems({ kex: '+diffie-hellman-group1-sha1', cipher: '' })).toEqual([]);
    expect(algorithmProblems({ kex: 'x', hmac: '+', compress: 'none' })).toEqual([
      { kind: 'kex', problem: { kind: 'unknown', names: ['x'] } },
      { kind: 'hmac', problem: { kind: 'empty' } },
    ]);
  });
});

describe('legacyAlgorithms', () => {
  it('names what a rule lets in beyond the defaults', () => {
    expect(legacyAlgorithms('kex', '+diffie-hellman-group1-sha1,curve25519-sha256')).toEqual([
      'diffie-hellman-group1-sha1',
    ]);
    expect(legacyAlgorithms('cipher', 'aes128-cbc,aes128-ctr')).toEqual(['aes128-cbc']);
    expect(legacyAlgorithms('serverHostKey', '^ssh-dss')).toEqual(['ssh-dss']);
  });

  it('finds nothing weak in removals, defaults, blanks or broken rules', () => {
    expect(legacyAlgorithms('cipher', '-aes128-cbc')).toEqual([]);
    expect(legacyAlgorithms('cipher', 'aes256-ctr')).toEqual([]);
    expect(legacyAlgorithms('cipher', '')).toEqual([]);
    expect(legacyAlgorithms('cipher', '+nonsense')).toEqual([]);
  });
});

describe('ssh2Algorithms', () => {
  it('is undefined when nothing is set, so ssh2 keeps its defaults', () => {
    expect(ssh2Algorithms(undefined)).toBeUndefined();
    expect(ssh2Algorithms({ kex: '', cipher: '  ' })).toBeUndefined();
  });

  it('turns each rule into the option ssh2 takes', () => {
    expect(
      ssh2Algorithms({
        kex: '+diffie-hellman-group14-sha1',
        cipher: 'aes128-cbc,aes128-ctr',
        hmac: '-hmac-sha1',
        serverHostKey: '^ssh-rsa',
        compress: 'none',
      }),
    ).toEqual({
      kex: { append: ['diffie-hellman-group14-sha1'] },
      cipher: ['aes128-cbc', 'aes128-ctr'],
      hmac: { remove: ['hmac-sha1'] },
      serverHostKey: { prepend: ['ssh-rsa'] },
      compress: ['none'],
    });
  });

  it('leaves a rule that cannot be read out instead of sending a bad name', () => {
    expect(ssh2Algorithms({ kex: 'nonsense', cipher: 'aes128-ctr' })).toEqual({
      cipher: ['aes128-ctr'],
    });
  });
});

describe('cleanAlgorithms', () => {
  it('trims the rules and drops the blank ones', () => {
    expect(cleanAlgorithms({ kex: ' +diffie-hellman-group1-sha1 ', cipher: '  ' })).toEqual({
      kex: '+diffie-hellman-group1-sha1',
    });
  });

  it('is undefined when nothing is left', () => {
    expect(cleanAlgorithms(undefined)).toBeUndefined();
    expect(cleanAlgorithms({})).toBeUndefined();
    expect(cleanAlgorithms({ kex: '', hmac: ' ' })).toBeUndefined();
  });
});

describe('sshHopProblems and algorithms', () => {
  const hop: SshHop = { id: 'a', host: 'h', user: 'u', auth: 'password' };

  it('flags a hop whose rule names an unknown algorithm', () => {
    expect(sshHopProblems({ ...hop, algorithms: { kex: '+nonsense' } })).toEqual([
      'ssh-algorithms-invalid',
    ]);
  });

  it('accepts a hop with good rules or none', () => {
    expect(sshHopProblems({ ...hop, algorithms: { kex: '+diffie-hellman-group1-sha1' } })).toEqual(
      [],
    );
    expect(sshHopProblems(hop)).toEqual([]);
  });
});

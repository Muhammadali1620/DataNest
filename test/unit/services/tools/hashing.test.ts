import { describe, expect, it } from 'vitest';
import { hashText } from '../../../../src/services/tools/hashing';

describe('hashText', () => {
  it('matches the known digests', () => {
    expect(hashText('abc')).toEqual({
      md5: '900150983cd24fb0d6963f7d28e17f72',
      sha1: 'a9993e364706816aba3e25717850c26c9cd0d89d',
      sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      bytes: 3,
    });
  });

  it('hashes the empty text', () => {
    expect(hashText('')).toMatchObject({
      md5: 'd41d8cd98f00b204e9800998ecf8427e',
      sha1: 'da39a3ee5e6b4b0d3255bfef95601890afd80709',
      bytes: 0,
    });
  });

  it('hashes as UTF-8 and counts bytes, not characters', () => {
    expect(hashText('é').bytes).toBe(2);
    expect(hashText('😀').bytes).toBe(4);
  });
});

import { utils } from 'ssh2';
import { describe, expect, it, vi } from 'vitest';
import { testHostKey } from '../../helpers/ssh-server';

describe('testHostKey', () => {
  it('makes the key again when ssh2 wrote one it cannot read back', () => {
    const real = utils.generateKeyPairSync.bind(utils);
    const generate = vi
      .spyOn(utils, 'generateKeyPairSync')
      .mockReturnValueOnce({ private: 'not a key', public: 'not a key' })
      .mockImplementation(() => real('ed25519'));
    const key = testHostKey();
    expect(utils.parseKey(key)).not.toBeInstanceOf(Error);
    expect(generate).toHaveBeenCalledTimes(2);
    // Generated once per run, then shared.
    expect(testHostKey()).toBe(key);
    expect(generate).toHaveBeenCalledTimes(2);
    generate.mockRestore();
  });
});

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expandHome, readUserFile } from '../../../../src/drivers/common/files';

describe('expandHome', () => {
  it('expands a leading tilde and leaves other paths alone', () => {
    expect(expandHome('~', '/home/me')).toBe('/home/me');
    expect(expandHome('~/.ssh/id', '/home/me')).toBe('/home/me/.ssh/id');
    expect(expandHome('~\\.ssh\\id', 'C:\\Users\\me')).toBe('C:\\Users\\me\\.ssh\\id');
    expect(expandHome('/etc/key', '/home/me')).toBe('/etc/key');
    expect(expandHome('~other/key', '/home/me')).toBe('~other/key');
  });

  it("uses the user's home by default", () => {
    expect(expandHome('~/x')).toBe(`${homedir()}/x`);
  });
});

describe('readUserFile', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'datanest-files-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads the file, ignoring spaces around the path', async () => {
    const file = join(dir, 'ca.crt');
    writeFileSync(file, 'PEM');
    expect((await readUserFile(`  ${file} `, 'the CA')).toString()).toBe('PEM');
  });

  it('names the file and what it is for when it cannot be read', async () => {
    const missing = join(dir, 'nope.crt');
    await expect(readUserFile(missing, 'the CA certificate')).rejects.toMatchObject({
      code: 'not-found',
      message: `Cannot read the CA certificate "${missing}"`,
    });
  });
});

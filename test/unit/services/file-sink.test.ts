import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileSink, PART_SUFFIX } from '../../../src/services/file-sink';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'datanest-sink-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('FileSink', () => {
  it('writes into a part file and puts it in place on close', async () => {
    const path = join(dir, 'dump.sql');
    const sink = await FileSink.create(path);
    await sink.write('SELECT 1;\n');
    expect(existsSync(`${path}${PART_SUFFIX}`)).toBe(true);
    expect(existsSync(path)).toBe(false);
    await sink.write("SELECT 'ё';\n");
    await sink.close();
    expect(readFileSync(path, 'utf8')).toBe("SELECT 1;\nSELECT 'ё';\n");
    expect(existsSync(`${path}${PART_SUFFIX}`)).toBe(false);
    expect(sink.bytes).toBe(Buffer.byteLength("SELECT 1;\nSELECT 'ё';\n"));
  });

  it('writes a lot of text through the stream in pieces', async () => {
    const path = join(dir, 'big.sql');
    const sink = await FileSink.create(path);
    const line = `${'x'.repeat(1000)}\n`;
    for (let i = 0; i < 3000; i += 1) {
      await sink.write(line);
    }
    await sink.close();
    expect(readFileSync(path, 'utf8')).toHaveLength(3000 * line.length);
  });

  it('leaves an existing file as it was when the new one is discarded', async () => {
    const path = join(dir, 'old.sql');
    writeFileSync(path, 'old');
    const sink = await FileSink.create(path);
    await sink.write('new, half done');
    await sink.discard();
    expect(readFileSync(path, 'utf8')).toBe('old');
    expect(existsSync(`${path}${PART_SUFFIX}`)).toBe(false);
  });

  it('replaces an existing file on close', async () => {
    const path = join(dir, 'old.sql');
    writeFileSync(path, 'old');
    const sink = await FileSink.create(path);
    await sink.write('new');
    await sink.close();
    expect(readFileSync(path, 'utf8')).toBe('new');
  });

  it('fails at once for a folder that does not exist', async () => {
    await expect(FileSink.create(join(dir, 'missing', 'x.sql'))).rejects.toThrow(/ENOENT/u);
  });
});

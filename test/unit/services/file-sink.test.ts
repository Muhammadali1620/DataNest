import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WriteStream } from 'node:fs';
import { FileSink, PART_SUFFIX } from '../../../src/services/file-sink';

/** The sink's stream, to make it fail the way a full disk would. */
function streamOf(sink: FileSink): WriteStream {
  return (sink as unknown as { stream: WriteStream }).stream;
}

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

  it('writes bytes as they are, after the text written before them', async () => {
    const path = join(dir, 'mixed.bin');
    const sink = await FileSink.create(path);
    await sink.write('head:');
    await sink.writeBytes(new Uint8Array([0, 255, 10]));
    await sink.write(':tail');
    await sink.close();
    expect([...readFileSync(path)]).toEqual([
      ...Buffer.from('head:'),
      0,
      255,
      10,
      ...Buffer.from(':tail'),
    ]);
    expect(sink.bytes).toBe(5 + 3 + 5);
  });

  it('writes only the bytes of a view, not its whole buffer', async () => {
    const path = join(dir, 'view.bin');
    const sink = await FileSink.create(path);
    const whole = new Uint8Array([1, 2, 3, 4, 5]);
    await sink.writeBytes(whole.subarray(1, 3));
    await sink.close();
    expect([...readFileSync(path)]).toEqual([2, 3]);
  });

  it('can be discarded twice, and after the stream has closed', async () => {
    const path = join(dir, 'twice.sql');
    const sink = await FileSink.create(path);
    await sink.write('x');
    await sink.discard();
    await sink.discard();
    expect(existsSync(`${path}${PART_SUFFIX}`)).toBe(false);
    expect(existsSync(path)).toBe(false);
  });

  it('fails the next write after the stream failed, and does not put a file in place', async () => {
    const path = join(dir, 'full.sql');
    const sink = await FileSink.create(path);
    await sink.write('before');
    streamOf(sink).emit('error', new Error('ENOSPC: no space left on device'));
    await expect(sink.write('x'.repeat(70 * 1024))).rejects.toThrow('ENOSPC');
    await expect(sink.close()).rejects.toThrow('ENOSPC');
    expect(existsSync(path)).toBe(false);
    await sink.discard();
    expect(existsSync(`${path}${PART_SUFFIX}`)).toBe(false);
  });

  it('fails a write that waits for the disk when the stream fails meanwhile', async () => {
    const path = join(dir, 'slow.bin');
    const sink = await FileSink.create(path);
    // Far over the stream's buffer, so the write waits for "drain".
    const writing = sink.writeBytes(new Uint8Array(4 * 1024 * 1024));
    const failed = expect(writing).rejects.toThrow('EIO');
    streamOf(sink).emit('error', new Error('EIO: i/o error'));
    await failed;
    await sink.discard();
  });
});

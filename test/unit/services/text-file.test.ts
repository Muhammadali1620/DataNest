import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ScriptChunk } from '../../../src/services/script-runner';
import { encodingOf, readTextChunks } from '../../../src/services/text-file';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'datanest-text-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function readAll(path: string, size?: number): Promise<ScriptChunk[]> {
  const chunks: ScriptChunk[] = [];
  for await (const chunk of readTextChunks(path, size)) {
    chunks.push(chunk);
  }
  return chunks;
}

function file(name: string, data: Uint8Array | string): string {
  const path = join(dir, name);
  writeFileSync(path, data);
  return path;
}

describe('readTextChunks', () => {
  it('reads the text in parts and counts the bytes of each', async () => {
    const path = file('a.sql', 'SELECT 1;\nSELECT 2;\n');
    const chunks = await readAll(path, 8);
    expect(chunks.map((chunk) => chunk.text).join('')).toBe('SELECT 1;\nSELECT 2;\n');
    expect(chunks.reduce((sum, chunk) => sum + chunk.bytes, 0)).toBe(20);
    expect(chunks.length).toBeGreaterThan(2);
  });

  it('joins a character that a read cut in two', async () => {
    const text = "SELECT 'Ольга 山田 😀';";
    const path = file('utf8.sql', text);
    for (const size of [1, 2, 3, 5]) {
      const chunks = await readAll(path, size);
      expect(chunks.map((chunk) => chunk.text).join(''), `size ${size}`).toBe(text);
      expect(chunks.every((chunk) => !chunk.text.includes('�'))).toBe(true);
    }
  });

  it('drops a UTF-8 byte order mark', async () => {
    const path = file(
      'bom.sql',
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('SELECT 1')]),
    );
    const chunks = await readAll(path);
    expect(chunks.map((chunk) => chunk.text).join('')).toBe('SELECT 1');
    expect(chunks[0]?.bytes).toBe(11);
  });

  it('reads UTF-16 files that announce themselves', async () => {
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('SELECT ё;', 'utf16le')]);
    expect((await readAll(file('le.sql', le), 3)).map((chunk) => chunk.text).join('')).toBe(
      'SELECT ё;',
    );
    const swapped = Buffer.from('SELECT ё;', 'utf16le').swap16();
    const be = Buffer.concat([Buffer.from([0xfe, 0xff]), swapped]);
    expect((await readAll(file('be.sql', be))).map((chunk) => chunk.text).join('')).toBe(
      'SELECT ё;',
    );
  });

  it('gives nothing for an empty file', async () => {
    expect(await readAll(file('empty.sql', ''))).toEqual([]);
  });

  it('fails for a file that is not there', async () => {
    await expect(readAll(join(dir, 'missing.sql'))).rejects.toThrow(/ENOENT/u);
  });
});

describe('encodingOf', () => {
  it('reads the byte order mark', () => {
    expect(encodingOf(new Uint8Array([0xff, 0xfe, 0x41]))).toBe('utf-16le');
    expect(encodingOf(new Uint8Array([0xfe, 0xff, 0x00]))).toBe('utf-16be');
    expect(encodingOf(new Uint8Array([0xef, 0xbb, 0xbf]))).toBe('utf-8');
    expect(encodingOf(new Uint8Array([0x53]))).toBe('utf-8');
    expect(encodingOf(new Uint8Array([]))).toBe('utf-8');
  });
});

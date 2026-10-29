import { describe, expect, it } from 'vitest';
import { ZipStream } from '../../../src/services/zip-stream';
import { entryText, unzip } from '../../helpers/unzip';

async function archive(
  build: (zip: ZipStream) => Promise<void>,
): Promise<{ bytes: Buffer; writes: number }> {
  const parts: Uint8Array[] = [];
  const zip = new ZipStream(async (data) => {
    await Promise.resolve();
    parts.push(Buffer.from(data));
  });
  await build(zip);
  return { bytes: Buffer.concat(parts), writes: parts.length };
}

describe('ZipStream', () => {
  it('writes whole files and files in parts that any reader can open', async () => {
    const big = Array.from({ length: 5000 }, (_, i) => `<row r="${i}">${'x'.repeat(i % 50)}</row>`);
    const { bytes } = await archive(async (zip) => {
      await zip.addFile('[Content_Types].xml', Buffer.from('<Types/>'));
      const sheet = await zip.beginFile('xl/worksheets/sheet1.xml');
      for (let i = 0; i < big.length; i += 700) {
        await sheet.write(Buffer.from(big.slice(i, i + 700).join('')));
      }
      await sheet.write(new Uint8Array(0));
      await sheet.end();
      await zip.addFile('xl/styles.xml', Buffer.from('<styles/>'));
      await zip.finish();
    });
    const entries = unzip(bytes);
    expect(entries.map((entry) => entry.name)).toEqual([
      '[Content_Types].xml',
      'xl/worksheets/sheet1.xml',
      'xl/styles.xml',
    ]);
    expect(entryText(entries, 'xl/worksheets/sheet1.xml')).toBe(big.join(''));
    expect(entryText(entries, 'xl/styles.xml')).toBe('<styles/>');
    // The streamed file says its sizes come after the data.
    expect(entries[1]?.flags).toBe(0x0808);
    expect(entries[0]?.flags).toBe(0x0800);
    // Compressed: the repeated rows take far less room than their text.
    expect(bytes.length).toBeLessThan(big.join('').length / 3);
  });

  it('writes an empty streamed file', async () => {
    const { bytes } = await archive(async (zip) => {
      const file = await zip.beginFile('empty.txt');
      await file.end();
      await zip.finish();
    });
    expect(entryText(unzip(bytes), 'empty.txt')).toBe('');
  });

  it('keeps UTF-8 names and contents', async () => {
    const { bytes } = await archive(async (zip) => {
      await zip.addFile('лист/имя.xml', Buffer.from('Ольга 山田'));
      await zip.finish();
    });
    expect(entryText(unzip(bytes), 'лист/имя.xml')).toBe('Ольга 山田');
  });

  it('refuses another file while a streamed one is still open', async () => {
    await archive(async (zip) => {
      await zip.beginFile('a');
      await expect(zip.addFile('b', Buffer.from('b'))).rejects.toThrow(/still being written/u);
      await expect(zip.finish()).rejects.toThrow(/still being written/u);
    });
  });
});

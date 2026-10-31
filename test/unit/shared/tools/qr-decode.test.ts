import { describe, expect, it } from 'vitest';
import { decodeQrImage } from '../../../../src/shared/tools/qr/decode';
import {
  decodeModules,
  rsCorrect,
  transpose,
} from '../../../../src/shared/tools/qr/decode-modules';
import { encodeQr, interleave } from '../../../../src/shared/tools/qr/encode';
import { qrToPixels, qrToSvg } from '../../../../src/shared/tools/qr/render';
import { QR_ECC_LEVELS, rsDivisor, rsRemainder } from '../../../../src/shared/tools/qr/tables';

describe('Reed-Solomon correction', () => {
  const data = Array.from({ length: 30 }, (_, i) => (i * 37 + 11) % 256);
  const checks = 10;
  const clean = [...data, ...rsRemainder(data, rsDivisor(checks))];

  it('leaves a clean block alone', () => {
    const block = [...clean];
    expect(rsCorrect(block, checks)).toBe(true);
    expect(block).toEqual(clean);
  });

  it('repairs up to half as many errors as check codewords', () => {
    for (const positions of [[0], [39], [3, 20], [0, 10, 20, 30, 39], [1, 2, 3, 4, 5]]) {
      const block = [...clean];
      positions.forEach((position, i) => {
        block[position] = (block[position] ?? 0) ^ (0x55 + i * 17);
      });
      expect(rsCorrect(block, checks), positions.join()).toBe(true);
      expect(block).toEqual(clean);
    }
  });

  it('gives up beyond that', () => {
    const block = [...clean];
    for (const position of [0, 4, 8, 12, 16, 20]) {
      block[position] = (block[position] ?? 0) ^ 0xff;
    }
    const copy = [...block];
    const fixed = rsCorrect(block, checks);
    // Either it knows it failed or, by chance, landed on another valid word; never the original.
    expect(fixed && block.join() === clean.join()).toBe(false);
    expect(copy.length).toBe(block.length);
  });
});

describe('decodeModules', () => {
  it('reads what the encoder writes, at every level and a spread of versions', () => {
    const texts = [
      '1',
      'HELLO WORLD',
      'hello, world',
      'https://example.com/path?x=1&y=2',
      'Привет, мир ✓',
      '9'.repeat(300),
      'x'.repeat(700),
    ];
    for (const text of texts) {
      for (const ecc of QR_ECC_LEVELS) {
        const code = encodeQr(text, { ecc });
        const result = decodeModules(code.modules);
        expect(result?.text, `${ecc} ${text.slice(0, 12)}`).toBe(text);
        expect(result?.ecc).toBe(ecc);
        expect(result?.version).toBe(code.version);
      }
    }
  });

  it('reads the biggest code, with several blocks and version information', () => {
    const text = 'z'.repeat(2900);
    const code = encodeQr(text, { ecc: 'L' });
    expect(code.version).toBe(40);
    expect(decodeModules(code.modules)?.text).toBe(text);
  });

  it('reads every mask', () => {
    for (let mask = 0; mask < 8; mask++) {
      expect(decodeModules(encodeQr('mask test', { mask }).modules)?.text).toBe('mask test');
    }
  });

  it('corrects damaged modules within the level', () => {
    const code = encodeQr('damaged but fine', { ecc: 'H' });
    const modules = code.modules.map((row) => [...row]);
    // Wipe a few data modules away from the patterns.
    for (let i = 0; i < 6; i++) {
      const row = modules[12 + i];
      if (row !== undefined) {
        row[10 + i] = !row[10 + i];
      }
    }
    expect(decodeModules(modules)?.text).toBe('damaged but fine');
  });

  it('survives flipped format bits (the code corrects three)', () => {
    const code = encodeQr('format', { ecc: 'Q' });
    const modules = code.modules.map((row) => [...row]);
    for (const [x, y] of [
      [8, 0],
      [8, 1],
      [8, 2],
    ] as const) {
      const row = modules[y];
      if (row !== undefined) {
        row[x] = !row[x];
      }
    }
    expect(decodeModules(modules)?.text).toBe('format');
  });

  it('refuses a matrix that is not a QR size or has no valid format', () => {
    expect(decodeModules([])).toBeUndefined();
    expect(
      decodeModules(Array.from({ length: 22 }, () => new Array<boolean>(22).fill(false))),
    ).toBeUndefined();
    expect(
      decodeModules(Array.from({ length: 21 }, () => new Array<boolean>(21).fill(true))),
    ).toBeUndefined();
  });

  it('reads a transposed (mirrored) code through its own helper', () => {
    const code = encodeQr('mirror');
    expect(decodeModules(transpose(code.modules))).toBeUndefined();
    expect(decodeModules(transpose(transpose(code.modules)))?.text).toBe('mirror');
  });

  it('keeps the blocks in step with the encoder', () => {
    const data = Array.from({ length: 1276 }, (_, i) => i % 256);
    expect(interleave(data, 40, 'H')).toHaveLength(3706);
  });
});

function picture(text: string, scale: number, pad: number, ecc: 'L' | 'M' | 'Q' | 'H' = 'M') {
  return qrToPixels(encodeQr(text, { ecc }), scale, { margin: pad });
}

/** Paints the code onto a bigger canvas turned by an angle, with a plain background. */
function rotated(text: string, angle: number, scale = 6) {
  const source = picture(text, scale, 4);
  const side = Math.ceil(source.width * 1.6);
  const data = new Uint8ClampedArray(side * side * 4).fill(255);
  const centre = side / 2;
  const half = source.width / 2;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const u = (x - centre) * cos + (y - centre) * sin + half;
      const v = -(x - centre) * sin + (y - centre) * cos + half;
      if (u >= 0 && v >= 0 && u < source.width && v < source.height) {
        const from = (Math.floor(v) * source.width + Math.floor(u)) * 4;
        const to = (y * side + x) * 4;
        data[to] = source.data[from] ?? 255;
        data[to + 1] = source.data[from + 1] ?? 255;
        data[to + 2] = source.data[from + 2] ?? 255;
      }
    }
  }
  return { width: side, height: side, data };
}

describe('decodeQrImage', () => {
  it('reads a clean picture at several sizes', () => {
    for (const scale of [1, 2, 3, 5, 10]) {
      for (const text of ['hello', 'https://example.com/some/longer/path?with=query&and=more']) {
        expect(decodeQrImage(picture(text, scale, 4))?.text, `${scale}x ${text}`).toBe(text);
      }
    }
  });

  it('reads a code with a thin quiet zone and big versions', () => {
    const text = 'q'.repeat(400);
    expect(decodeQrImage(picture(text, 3, 1, 'L'))?.text).toBe(text);
    expect(decodeQrImage(picture('x'.repeat(1200), 2, 4, 'L'))?.text).toBe('x'.repeat(1200));
  });

  it('reads colours other than black on white, and light on dark', () => {
    const code = encodeQr('colours');
    const blue = qrToPixels(code, 4, { dark: '#003366', light: '#ffffcc' });
    expect(decodeQrImage(blue)?.text).toBe('colours');
    const inverted = qrToPixels(code, 4, { dark: '#ffffff', light: '#000000' });
    expect(decodeQrImage(inverted)?.text).toBe('colours');
  });

  it('reads a code on a transparent background as if on white', () => {
    const picture1 = qrToPixels(encodeQr('transparent'), 4, { dark: '#000000', light: '#ffffff' });
    for (let i = 0; i < picture1.data.length; i += 4) {
      if (picture1.data[i] === 255) {
        picture1.data[i + 3] = 0;
      }
    }
    expect(decodeQrImage(picture1)?.text).toBe('transparent');
  });

  it('reads a turned code, version 1 and bigger', () => {
    for (const angle of [0.1, 0.4, Math.PI / 2, Math.PI, -0.7, 1.2]) {
      expect(decodeQrImage(rotated('turned', angle))?.text, `angle ${angle}`).toBe('turned');
    }
    const long = 'a longer text to need an alignment pattern '.repeat(3);
    for (const angle of [0.15, -0.3]) {
      expect(decodeQrImage(rotated(long, angle, 5))?.text, `long ${angle}`).toBe(long);
    }
  });

  it('reads a code seen at an angle (perspective), where the alignment pattern pins the grid', () => {
    for (const [length, strength] of [
      [47, 0.0008],
      [94, 0.0004],
    ] as const) {
      const text = 'x'.repeat(length);
      const source = picture(text, 5, 4, 'Q');
      const side = 520;
      const data = new Uint8ClampedArray(side * side * 4).fill(255);
      for (let y = 0; y < side; y++) {
        for (let x = 0; x < side; x++) {
          const w = 1 + strength * (x - 60) + strength * 0.4 * (y - 30);
          const u = (0.8 * (x - 60) + 0.12 * (y - 30)) / w;
          const v = (0.85 * (y - 30) - 0.06 * (x - 60)) / w;
          if (u >= 0 && v >= 0 && u < source.width && v < source.height) {
            const from = (Math.floor(v) * source.width + Math.floor(u)) * 4;
            const to = (y * side + x) * 4;
            data[to] = data[to + 1] = data[to + 2] = source.data[from] ?? 255;
          }
        }
      }
      expect(decodeQrImage({ width: side, height: side, data })?.text, `${length}`).toBe(text);
    }
  });

  it('reads a code with noise on the picture', () => {
    const image = picture('noisy picture', 6, 4, 'Q');
    let seed = 7;
    const random = (): number => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    for (let i = 0; i < image.data.length; i += 4) {
      const wobble = Math.round((random() - 0.5) * 70);
      for (let c = 0; c < 3; c++) {
        image.data[i + c] = Math.max(0, Math.min(255, (image.data[i + c] ?? 0) + wobble));
      }
    }
    expect(decodeQrImage(image)?.text).toBe('noisy picture');
  });

  it('reads a code that sits in a corner of a bigger picture with other things in it', () => {
    const code = picture('in a crowd', 4, 2);
    const width = code.width * 3;
    const height = code.height * 2;
    const data = new Uint8ClampedArray(width * height * 4).fill(255);
    // a black bar and a dark square near it
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < width; x++) {
        data.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 3);
      }
    }
    for (let y = 0; y < code.height; y++) {
      for (let x = 0; x < code.width; x++) {
        const from = (y * code.width + x) * 4;
        const to = ((y + 20) * width + x + code.width * 2 - 10) * 4;
        data.set(code.data.slice(from, from + 4), to);
      }
    }
    expect(decodeQrImage({ width, height, data })?.text).toBe('in a crowd');
  });

  it('says nothing for pictures without a code', () => {
    expect(
      decodeQrImage({
        width: 100,
        height: 100,
        data: new Uint8ClampedArray(100 * 100 * 4).fill(255),
      }),
    ).toBeUndefined();
    expect(
      decodeQrImage({ width: 10, height: 10, data: new Uint8ClampedArray(400) }),
    ).toBeUndefined();
    expect(
      decodeQrImage({ width: 100, height: 100, data: new Uint8ClampedArray(10) }),
    ).toBeUndefined();
    const noise = new Uint8ClampedArray(120 * 120 * 4);
    let seed = 3;
    for (let i = 0; i < noise.length; i++) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      noise[i] = i % 4 === 3 ? 255 : seed % 256;
    }
    expect(decodeQrImage({ width: 120, height: 120, data: noise })).toBeUndefined();
  });
});

describe('QR pictures', () => {
  it('draws an SVG with the code and the colours', () => {
    const svg = qrToSvg(encodeQr('svg'), { margin: 2, dark: '#102030', light: '#fff' });
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 25 25"')).toBe(
      true,
    );
    expect(svg).toContain('fill="#102030"');
    expect(svg).toContain('fill="#fff"');
    expect(svg).toContain('<path d="M2 2h7');
  });

  it('ignores a colour that is not a hex colour', () => {
    const svg = qrToSvg(encodeQr('svg'), { dark: '"><script>', light: 'red' });
    expect(svg).not.toContain('script');
    expect(svg).toContain('fill="#000000"');
    expect(svg).toContain('fill="#ffffff"');
  });

  it('draws pixels at whole numbers of pixels a module', () => {
    const code = encodeQr('px');
    const image = qrToPixels(code, 3, { margin: 1 });
    expect(image.width).toBe((code.size + 2) * 3);
    expect(image.data).toHaveLength(image.width * image.height * 4);
    expect(image.data[0]).toBe(255);
    // the first module of the top-left finder is dark
    const at = (3 * image.width + 3) * 4;
    expect(image.data[at]).toBe(0);
    expect(qrToPixels(code, 0).width).toBe(code.size + 8);
  });
});

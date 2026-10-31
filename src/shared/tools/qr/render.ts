// A QR code as pictures: an SVG for files and for the page, RGBA pixels for a PNG.

import type { QrCode } from './encode';

export interface QrStyle {
  /** Modules of quiet zone around the code; the standard asks for 4. */
  readonly margin?: number;
  /** `#rgb` or `#rrggbb`. */
  readonly dark?: string;
  readonly light?: string;
}

export const DEFAULT_DARK = '#000000';
export const DEFAULT_LIGHT = '#ffffff';

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/iu;

export function isHexColor(text: string): boolean {
  return HEX.test(text);
}

function hexOr(text: string | undefined, fallback: string): string {
  return text !== undefined && isHexColor(text) ? text : fallback;
}

export function parseHex(
  text: string,
  fallback: readonly [number, number, number],
): [number, number, number] {
  if (!HEX.test(text)) {
    return [...fallback];
  }
  const digits = text.slice(1);
  const full =
    digits.length === 3
      ? digits
          .split('')
          .map((d) => d + d)
          .join('')
      : digits;
  return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16)) as [
    number,
    number,
    number,
  ];
}

function margin(style: QrStyle): number {
  return Math.max(0, Math.min(20, Math.floor(style.margin ?? 4)));
}

/** The width of the picture in modules, quiet zone included. */
export function qrSide(code: QrCode, style: QrStyle = {}): number {
  return code.size + margin(style) * 2;
}

export function qrToSvg(code: QrCode, style: QrStyle = {}): string {
  const pad = margin(style);
  const dark = hexOr(style.dark, DEFAULT_DARK);
  const light = hexOr(style.light, DEFAULT_LIGHT);
  const side = code.size + pad * 2;
  let path = '';
  code.modules.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (row[x] === true) {
        let end = x + 1;
        while (row[end] === true) {
          end++;
        }
        path += `M${x + pad} ${y + pad}h${end - x}v1h-${end - x}z`;
        x = end;
      }
    }
  });
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" shape-rendering="crispEdges">` +
    `<rect width="${side}" height="${side}" fill="${light}"/>` +
    `<path d="${path}" fill="${dark}"/></svg>`
  );
}

/** RGBA pixels at a whole number of pixels a module. */
export function qrToPixels(
  code: QrCode,
  scale: number,
  style: QrStyle = {},
): { width: number; height: number; data: Uint8ClampedArray } {
  const pad = margin(style);
  const step = Math.max(1, Math.min(64, Math.floor(scale)));
  const side = (code.size + pad * 2) * step;
  const dark = parseHex(style.dark ?? DEFAULT_DARK, [0, 0, 0]);
  const light = parseHex(style.light ?? DEFAULT_LIGHT, [255, 255, 255]);
  const data = new Uint8ClampedArray(side * side * 4);
  for (let y = 0; y < side; y++) {
    const row = code.modules[Math.floor(y / step) - pad];
    for (let x = 0; x < side; x++) {
      const on = row?.[Math.floor(x / step) - pad] === true;
      const [r, g, b] = on ? dark : light;
      const at = (y * side + x) * 4;
      data[at] = r;
      data[at + 1] = g;
      data[at + 2] = b;
      data[at + 3] = 255;
    }
  }
  return { width: side, height: side, data };
}

/** WCAG contrast ratio of two `#rgb` / `#rrggbb` colours, 1–21. */
export function contrastRatio(a: string, b: string): number {
  const luminance = (hex: string): number => {
    const [r, g, bl] = parseHex(hex, [0, 0, 0]).map((value) => {
      const c = value / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// Pure helpers of the Tools page's Image tab: data URLs, sizes and SVG text.

export const MAX_IMAGE_SIDE = 16_384;

export interface DataUrlParts {
  readonly mime: string;
  readonly base64: string;
}

export function parseDataUrl(text: string): DataUrlParts | undefined {
  const match = /^data:([\w.+-]+\/[\w.+-]+)(?:;[\w=.-]+)*;base64,([A-Za-z0-9+/=]+)$/u.exec(
    text.trim(),
  );
  const [, mime, base64] = match ?? [];
  return mime === undefined || base64 === undefined ? undefined : { mime, base64 };
}

/** `url("data:…")` for a CSS background. */
export function cssUrl(dataUrl: string): string {
  return `url("${dataUrl.replaceAll('"', '%22')}")`;
}

export function htmlImg(dataUrl: string, width?: number, height?: number): string {
  const size =
    width !== undefined && height !== undefined ? ` width="${width}" height="${height}"` : '';
  return `<img src="${dataUrl.replaceAll('"', '&quot;')}"${size} alt="">`;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

const clampSide = (value: number): number =>
  Math.min(MAX_IMAGE_SIDE, Math.max(1, Math.round(value)));

/**
 * The size after one side is edited. With `keepRatio` the other side follows the original
 * proportions; sides are whole pixels from 1 to `MAX_IMAGE_SIDE`.
 */
export function resizeTo(
  original: Size,
  edited: 'width' | 'height',
  value: number,
  keepRatio: boolean,
): Size {
  if (!Number.isFinite(value) || original.width < 1 || original.height < 1) {
    return original;
  }
  const side = clampSide(value);
  if (!keepRatio) {
    return edited === 'width'
      ? { width: side, height: original.height }
      : { width: original.width, height: side };
  }
  const ratio = original.width / original.height;
  return edited === 'width'
    ? { width: side, height: clampSide(side / ratio) }
    : { width: clampSide(side * ratio), height: side };
}

export type OutputFormat = 'png' | 'jpeg' | 'webp';
export const OUTPUT_FORMATS: readonly OutputFormat[] = ['png', 'jpeg', 'webp'];

export function mimeOf(format: OutputFormat): string {
  return `image/${format}`;
}

export function extensionOfFormat(format: OutputFormat): string {
  return format === 'jpeg' ? 'jpg' : format;
}

/** True for text whose root element is `<svg>` (an XML prolog and comments may come first). */
export function isSvg(text: string): boolean {
  return /^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>]*>\s*)?<svg[\s>]/iu.test(
    text,
  );
}

/** A data URL the preview `<img>` can show; scripts in an image never run. */
export function svgToDataUrl(svg: string): string {
  const bytes = new TextEncoder().encode(svg);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

/** Re-indents SVG/XML text by its tags, two spaces a level. Text inside elements is kept. */
export function formatSvg(svg: string): string | undefined {
  if (!isSvg(svg)) {
    return undefined;
  }
  const tokens =
    svg.trim().match(/<!--[\s\S]*?-->|<![^>]*>|<\?[\s\S]*?\?>|<\/?[^>]+>|[^<]+/gu) ?? [];
  const lines: string[] = [];
  let depth = 0;
  for (const token of tokens) {
    if (!token.startsWith('<')) {
      const text = token.trim();
      if (text !== '') {
        const last = lines.length - 1;
        // Text stays on the line of its opening tag when it is short and the tag is still open.
        lines[last] = `${lines[last] ?? ''}${text}`;
      }
      continue;
    }
    if (token.startsWith('</')) {
      depth = Math.max(0, depth - 1);
      const last = lines.at(-1) ?? '';
      if (/^\s*<[^/!?][^>]*>[^<]+$/u.test(last)) {
        lines[lines.length - 1] = `${last}${token}`;
        continue;
      }
    }
    lines.push(`${'  '.repeat(depth)}${token}`);
    if (/^<[a-z]/iu.test(token) && !token.endsWith('/>')) {
      depth += 1;
    }
  }
  return lines.join('\n');
}

/** Sets `fill` on the root `<svg>` element only; undefined for text that is not an SVG. */
export function setRootFill(svg: string, color: string): string | undefined {
  if (!isSvg(svg) || !/^#[0-9a-f]{3,8}$|^[a-z]+$/iu.test(color)) {
    return undefined;
  }
  return svg.replace(/<svg\b([^>]*)>/iu, (_match, attrs: string) => {
    const without = attrs.replace(/\sfill\s*=\s*("[^"]*"|'[^']*')/iu, '');
    return `<svg${without} fill="${color}">`;
  });
}

/** Most pixels a resized image may have; a canvas of more would exhaust memory. */
export const MAX_IMAGE_PIXELS = 50_000_000;

export function withinPixelLimit(size: Size): boolean {
  return size.width * size.height <= MAX_IMAGE_PIXELS;
}

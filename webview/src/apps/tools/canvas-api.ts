// The browser's canvas behind one small interface, for the tools that need pixels (reading
// a QR code, cropping, shrinking). The tabs are tested with a fake; only this file touches
// a real canvas.

import { base64ToBytes } from '../../../../src/shared/tools/bytes';
import {
  type OutputFormat,
  mimeOf,
  parseDataUrl,
  withinPixelLimit,
} from '../../../../src/shared/tools/image-data';
import type { Rect } from '../../../../src/shared/tools/crop';

export interface Pixels {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

export interface CropOptions {
  readonly format: OutputFormat;
  /** 0–1; JPEG and WebP. */
  readonly quality: number;
  /** A CSS colour painted under the picture (JPEG has no transparency). */
  readonly background?: string | undefined;
}

export interface CanvasApi {
  /**
   * The picture's pixels, scaled down so neither side is longer than `maxSide`. A picture with
   * transparency is put on white unless `keepAlpha`.
   */
  pixels: (dataUrl: string, maxSide: number, keepAlpha?: boolean) => Promise<Pixels | undefined>;
  /** A part of the picture as a data URL; undefined when the format cannot be written. */
  crop: (dataUrl: string, rect: Rect, options: CropOptions) => Promise<string | undefined>;
  /** Pixels as a data URL. */
  fromPixels: (pixels: Pixels, options: CropOptions) => Promise<string | undefined>;
  /** zlib-wrapped deflate, as PNG wants. */
  deflate: (bytes: Uint8Array) => Promise<Uint8Array>;
  /** Puts a picture on the clipboard; false when the editor does not let the page. */
  copyImage: (dataUrl: string) => Promise<boolean>;
}

function decode(dataUrl: string): Promise<HTMLImageElement | undefined> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      resolve(image);
    };
    image.onerror = () => {
      resolve(undefined);
    };
    image.src = dataUrl;
  });
}

function canvasOf(
  width: number,
  height: number,
): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D } | undefined {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  return context === null ? undefined : { canvas, context };
}

function written(canvas: HTMLCanvasElement, options: CropOptions): string | undefined {
  const mime = mimeOf(options.format);
  const out = canvas.toDataURL(mime, options.quality);
  // A browser that cannot write the format answers with a PNG instead.
  return out.startsWith(`data:${mime}`) ? out : undefined;
}

export const browserCanvasApi: CanvasApi = {
  pixels: async (dataUrl, maxSide, keepAlpha = false) => {
    const image = await decode(dataUrl);
    if (image === undefined || image.naturalWidth === 0 || image.naturalHeight === 0) {
      return undefined;
    }
    const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const surface = canvasOf(width, height);
    if (surface === undefined) {
      return undefined;
    }
    if (!keepAlpha) {
      surface.context.fillStyle = '#ffffff';
      surface.context.fillRect(0, 0, width, height);
    }
    surface.context.drawImage(image, 0, 0, width, height);
    const { data } = surface.context.getImageData(0, 0, width, height);
    return { width, height, data };
  },
  crop: async (dataUrl, rect, options) => {
    if (!withinPixelLimit({ width: rect.w, height: rect.h })) {
      return undefined;
    }
    const image = await decode(dataUrl);
    const surface = canvasOf(rect.w, rect.h);
    if (image === undefined || surface === undefined) {
      return undefined;
    }
    if (options.background !== undefined) {
      surface.context.fillStyle = options.background;
      surface.context.fillRect(0, 0, rect.w, rect.h);
    }
    surface.context.drawImage(image, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
    return written(surface.canvas, options);
  },
  fromPixels: (pixels, options) => {
    const surface = canvasOf(pixels.width, pixels.height);
    if (surface === undefined) {
      return Promise.resolve(undefined);
    }
    surface.context.putImageData(
      new ImageData(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height),
      0,
      0,
    );
    return Promise.resolve(written(surface.canvas, options));
  },
  deflate: async (bytes) => {
    const stream = new Blob([bytes as BlobPart])
      .stream()
      .pipeThrough(new CompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  },
  copyImage: async (dataUrl) => {
    try {
      // Not `fetch(dataUrl)`: the page's policy allows no fetch at all.
      const parts = parseDataUrl(dataUrl);
      if (parts === undefined) {
        return false;
      }
      const blob = new Blob([base64ToBytes(parts.base64) as BlobPart], { type: parts.mime });
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      return true;
    } catch {
      return false;
    }
  },
};

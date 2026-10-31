// The browser's image machinery behind one small interface, so the Image tab is tested
// with a fake and only this file needs a real canvas.

import {
  type OutputFormat,
  mimeOf,
  withinPixelLimit,
} from '../../../../src/shared/tools/image-data';

export interface LoadedImage {
  readonly dataUrl: string;
  readonly width: number;
  readonly height: number;
  readonly name: string;
  /** Size of the file that was read. */
  readonly bytes: number;
  readonly mime: string;
}

export interface RenderOptions {
  readonly width: number;
  readonly height: number;
  readonly format: OutputFormat;
  /** 0–1; used by JPEG and WebP. */
  readonly quality: number;
  /** A CSS colour painted under the image; transparent when absent. */
  readonly background?: string | undefined;
}

export interface ImageApi {
  /** Reads a picked, dropped or pasted file; undefined when it is not an image the page can show. */
  load: (file: Blob, name: string) => Promise<LoadedImage | undefined>;
  /** Draws the image at the size and returns a data URL; undefined when the format is unsupported or too big. */
  render: (dataUrl: string, options: RenderOptions) => Promise<string | undefined>;
}

function readAsDataUrl(file: Blob): Promise<string | undefined> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(typeof reader.result === 'string' ? reader.result : undefined);
    };
    reader.onerror = () => {
      resolve(undefined);
    };
    reader.readAsDataURL(file);
  });
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

/** An SVG without a size reports none; a sensible square keeps the tools usable. */
const FALLBACK_SIDE = 512;

export const browserImageApi: ImageApi = {
  load: async (file, name) => {
    const dataUrl = await readAsDataUrl(file);
    if (dataUrl === undefined || !file.type.startsWith('image/')) {
      return undefined;
    }
    const image = await decode(dataUrl);
    if (image === undefined) {
      return undefined;
    }
    return {
      dataUrl,
      width: image.naturalWidth > 0 ? image.naturalWidth : FALLBACK_SIDE,
      height: image.naturalHeight > 0 ? image.naturalHeight : FALLBACK_SIDE,
      name,
      bytes: file.size,
      mime: file.type,
    };
  },
  render: async (dataUrl, options) => {
    if (!withinPixelLimit(options)) {
      return undefined;
    }
    const image = await decode(dataUrl);
    const canvas = document.createElement('canvas');
    canvas.width = options.width;
    canvas.height = options.height;
    const context = canvas.getContext('2d');
    if (image === undefined || context === null) {
      return undefined;
    }
    if (options.background !== undefined) {
      context.fillStyle = options.background;
      context.fillRect(0, 0, options.width, options.height);
    }
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, options.width, options.height);
    const mime = mimeOf(options.format);
    const out = canvas.toDataURL(mime, options.quality);
    // A browser that cannot write the format answers with a PNG instead.
    return out.startsWith(`data:${mime}`) ? out : undefined;
  },
};

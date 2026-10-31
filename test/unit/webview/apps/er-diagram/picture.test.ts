import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canvasMeasure,
  cssColor,
  pngScale,
} from '../../../../../webview/src/apps/er-diagram/picture';

describe('pngScale', () => {
  it('draws ordinary diagrams at twice the size', () => {
    expect(pngScale(1200, 800)).toBe(2);
    expect(pngScale(100, 100, 1)).toBe(1);
  });

  it('shrinks so the long side fits a canvas', () => {
    expect(pngScale(32_000, 1000)).toBeCloseTo(0.5);
  });

  it('shrinks so the area fits a canvas', () => {
    const scale = pngScale(12_000, 12_000);
    expect(12_000 * scale * 12_000 * scale).toBeLessThanOrEqual(120_000_000 + 1);
  });

  it('keeps the wanted scale for an empty picture', () => {
    expect(pngScale(0, 0)).toBe(2);
  });
});

describe('canvasMeasure', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('measures with the canvas in the given font and remembers the answers', () => {
    const fonts: string[] = [];
    const context = {
      font: '',
      measureText: vi.fn((text: string) => ({ width: text.length * 10 })),
    };
    Object.defineProperty(context, 'font', {
      set: (value: string) => fonts.push(value),
      get: () => fonts.at(-1) ?? '',
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      context as unknown as CanvasRenderingContext2D,
    );
    const measure = canvasMeasure('Inter');
    expect(measure('orders')).toBe(60);
    expect(measure('orders')).toBe(60);
    expect(measure('orders', true)).toBe(60);
    expect(context.measureText).toHaveBeenCalledTimes(2);
    expect(fonts).toEqual(['12px Inter', 'bold 12px Inter']);
  });

  it('counts characters where the canvas cannot measure', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const measure = canvasMeasure('sans-serif');
    expect(measure('orders')).toBeCloseTo(6 * 7.2);
    expect(measure('orders', true)).toBeGreaterThan(measure('orders'));
  });
});

describe('cssColor', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const paint = (pixel: number[]) => {
    const context = {
      fillStyle: '',
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      getImageData: vi.fn(() => ({ data: Uint8ClampedArray.from(pixel) })),
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      context as unknown as CanvasRenderingContext2D,
    );
    return context;
  };

  it('paints the colour the browser computes and reads it back as rgb()', () => {
    const context = paint([30, 60, 90, 255]);
    expect(cssColor('rgb(30, 60, 90)', '#fff')).toBe('rgb(30, 60, 90)');
    expect(context.fillStyle).toBe('rgb(30, 60, 90)');
    expect(document.body.querySelector('span')).toBeNull();
  });

  it('keeps the transparency of a see-through colour', () => {
    paint([0, 0, 0, 51]);
    expect(cssColor('rgba(0, 0, 0, 0.2)', '#fff')).toBe('rgba(0, 0, 0, 0.2)');
  });

  it('resolves inside the given element, which may define the variables', () => {
    paint([1, 2, 3, 255]);
    const host = document.createElement('div');
    document.body.append(host);
    const append = vi.spyOn(host, 'append');
    cssColor('blue', '#fff', host);
    expect(append).toHaveBeenCalledTimes(1);
    expect(host.children).toHaveLength(0);
    host.remove();
  });

  it('gives the computed colour where nothing can paint', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    expect(cssColor('rgb(1, 2, 3)', '#fff')).toBe('rgb(1, 2, 3)');
  });

  it('falls back where the colour is not one', () => {
    paint([9, 9, 9, 255]);
    expect(cssColor('not a colour', '#abcdef')).toBe('#abcdef');
  });
});

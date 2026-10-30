import { afterEach, describe, expect, it, vi } from 'vitest';
import { canvasMeasure, pngScale } from '../../../../../webview/src/apps/er-diagram/picture';

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

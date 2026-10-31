import { describe, expect, it } from 'vitest';
import {
  clampRect,
  fitRatio,
  moveRect,
  parseRatio,
  presetRatio,
  resizeRect,
  setSize,
} from '../../../../src/shared/tools/crop';

const bounds = { width: 200, height: 100 };

describe('clampRect and moveRect', () => {
  it('keeps the box inside the image, in whole pixels, at least one pixel', () => {
    expect(clampRect({ x: -5, y: -5, w: 50, h: 50 }, bounds)).toEqual({ x: 0, y: 0, w: 50, h: 50 });
    expect(clampRect({ x: 190, y: 90, w: 50, h: 50 }, bounds)).toEqual({
      x: 150,
      y: 50,
      w: 50,
      h: 50,
    });
    expect(clampRect({ x: 1.4, y: 2.6, w: 0, h: -3 }, bounds)).toEqual({ x: 1, y: 3, w: 1, h: 1 });
    expect(clampRect({ x: 0, y: 0, w: 900, h: 900 }, bounds)).toEqual({
      x: 0,
      y: 0,
      w: 200,
      h: 100,
    });
  });

  it('moves and stops at the edges', () => {
    const box = { x: 10, y: 10, w: 40, h: 40 };
    expect(moveRect(box, 5, -3, bounds)).toEqual({ x: 15, y: 7, w: 40, h: 40 });
    expect(moveRect(box, -100, 500, bounds)).toEqual({ x: 0, y: 60, w: 40, h: 40 });
  });
});

describe('ratios', () => {
  it('parses colon, slash, x and plain numbers', () => {
    expect(parseRatio('16:9')).toBeCloseTo(16 / 9);
    expect(parseRatio('4/3')).toBeCloseTo(4 / 3);
    expect(parseRatio(' 3 x 2 ')).toBeCloseTo(1.5);
    expect(parseRatio('1.5')).toBe(1.5);
    expect(parseRatio('0:5')).toBeUndefined();
    expect(parseRatio('5:0')).toBeUndefined();
    expect(parseRatio('wide')).toBeUndefined();
    expect(parseRatio('')).toBeUndefined();
  });

  it('maps presets', () => {
    expect(presetRatio('free', '')).toBeUndefined();
    expect(presetRatio('1:1', '')).toBe(1);
    expect(presetRatio('custom', '2:1')).toBe(2);
    expect(presetRatio('custom', 'x')).toBeUndefined();
  });

  it('fits the largest box of the ratio around the same centre', () => {
    const box = fitRatio({ x: 0, y: 0, w: 100, h: 100 }, 2, bounds);
    expect(box).toEqual({ x: 0, y: 25, w: 100, h: 50 });
    expect(fitRatio({ x: 0, y: 0, w: 200, h: 100 }, 1, bounds)).toEqual({
      x: 50,
      y: 0,
      w: 100,
      h: 100,
    });
    // a ratio wider than the image shrinks to the image
    const wide = fitRatio({ x: 0, y: 0, w: 200, h: 100 }, 4, bounds);
    expect(wide.w / wide.h).toBeCloseTo(4, 0);
    expect(wide.w).toBeLessThanOrEqual(200);
  });
});

describe('resizeRect', () => {
  const box = { x: 50, y: 20, w: 100, h: 50 };

  it('moves the dragged side and keeps the opposite one', () => {
    expect(resizeRect(box, 'e', 20, 0, bounds)).toEqual({ x: 50, y: 20, w: 120, h: 50 });
    expect(resizeRect(box, 'w', -20, 0, bounds)).toEqual({ x: 30, y: 20, w: 120, h: 50 });
    expect(resizeRect(box, 'n', 0, -10, bounds)).toEqual({ x: 50, y: 10, w: 100, h: 60 });
    expect(resizeRect(box, 's', 0, 10, bounds)).toEqual({ x: 50, y: 20, w: 100, h: 60 });
    expect(resizeRect(box, 'se', 10, 10, bounds)).toEqual({ x: 50, y: 20, w: 110, h: 60 });
    expect(resizeRect(box, 'nw', -10, -10, bounds)).toEqual({ x: 40, y: 10, w: 110, h: 60 });
  });

  it('stops at the image and never turns inside out', () => {
    expect(resizeRect(box, 'e', 999, 0, bounds).w).toBe(150);
    expect(resizeRect(box, 'w', -999, 0, bounds).x).toBe(0);
    expect(resizeRect(box, 'e', -999, 0, bounds)).toEqual({ x: 50, y: 20, w: 1, h: 50 });
    expect(resizeRect(box, 'n', 0, 999, bounds)).toEqual({ x: 50, y: 69, w: 100, h: 1 });
  });

  it('keeps a ratio from the dragged corner', () => {
    const next = resizeRect(box, 'se', 40, 0, bounds, 2);
    expect(next.x).toBe(50);
    expect(next.y).toBe(20);
    expect(next.w / next.h).toBeCloseTo(2, 0);
    const up = resizeRect(box, 'nw', -20, -20, bounds, 2);
    expect(up.x + up.w).toBe(150);
    expect(up.y + up.h).toBe(70);
    expect(up.w / up.h).toBeCloseTo(2, 0);
  });

  it('keeps a ratio on a side handle around the middle of the other axis', () => {
    const next = resizeRect(box, 'e', 40, 0, bounds, 2);
    expect(next.w).toBe(140);
    expect(next.h).toBe(70);
    expect(next.y).toBe(10);
    const tall = resizeRect(box, 's', 0, 20, bounds, 1);
    expect(tall.h).toBe(70);
    expect(tall.w).toBe(70);
    expect(tall.x).toBe(65);
  });

  it('shrinks a ratio box that would leave the image', () => {
    const next = resizeRect(box, 'se', 500, 500, bounds, 2);
    expect(next.x + next.w).toBeLessThanOrEqual(200);
    expect(next.y + next.h).toBeLessThanOrEqual(100);
    expect(next.w / next.h).toBeCloseTo(2, 0);
  });
});

describe('setSize', () => {
  const box = { x: 10, y: 10, w: 40, h: 40 };
  it('sets one side', () => {
    expect(setSize(box, 'w', 80, bounds)).toEqual({ x: 10, y: 10, w: 80, h: 40 });
    expect(setSize(box, 'h', 500, bounds)).toEqual({ x: 10, y: 0, w: 40, h: 100 });
  });
  it('drags the other side along under a ratio', () => {
    expect(setSize(box, 'w', 80, bounds, 2)).toEqual({ x: 10, y: 10, w: 80, h: 40 });
    expect(setSize(box, 'h', 20, bounds, 2)).toEqual({ x: 10, y: 10, w: 40, h: 20 });
  });
});

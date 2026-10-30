import { describe, expect, it } from 'vitest';
import {
  clampZoom,
  fitView,
  ZOOM_LIMITS,
  zoomAt,
} from '../../../../../webview/src/apps/er-diagram/view-math';

describe('zoomAt', () => {
  it('keeps the point under the cursor in place', () => {
    const view = { x: 30, y: -40, zoom: 0.8 };
    const next = zoomAt(view, 1.6, 200, 150);
    const before = { x: (200 - view.x) / view.zoom, y: (150 - view.y) / view.zoom };
    const after = { x: (200 - next.x) / next.zoom, y: (150 - next.y) / next.zoom };
    expect(next.zoom).toBe(1.6);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it('stops at the zoom limits', () => {
    expect(zoomAt({ x: 0, y: 0, zoom: 1 }, 100, 0, 0).zoom).toBe(ZOOM_LIMITS.max);
    expect(zoomAt({ x: 0, y: 0, zoom: 1 }, 0, 0, 0).zoom).toBe(ZOOM_LIMITS.min);
    expect(clampZoom({ x: 1, y: 2, zoom: 0.5 })).toEqual({ x: 1, y: 2, zoom: 0.5 });
  });
});

describe('fitView', () => {
  it('shrinks a big picture to the screen and centres it', () => {
    const view = fitView({ x: 0, y: 0, width: 2000, height: 1000 }, 1040, 1040);
    expect(view.zoom).toBeCloseTo(0.5);
    expect(view.x).toBeCloseTo(20);
    // 1000 × 0.5 = 500 of 1040: centred vertically.
    expect(view.y).toBeCloseTo(270);
  });

  it('never enlarges a small picture', () => {
    const view = fitView({ x: 0, y: 0, width: 100, height: 50 }, 800, 600);
    expect(view.zoom).toBe(1);
    expect(view.x).toBe(350);
  });

  it('takes the picture origin into account', () => {
    const view = fitView({ x: 500, y: 300, width: 100, height: 100 }, 800, 600);
    expect(500 * view.zoom + view.x).toBeCloseTo(350);
  });

  it('falls back to life size while the screen has no size yet', () => {
    expect(fitView({ x: 10, y: 5, width: 300, height: 300 }, 0, 0)).toEqual({
      x: 10,
      y: 15,
      zoom: 1,
    });
    expect(fitView({ x: 0, y: 0, width: 0, height: 0 }, 800, 600).zoom).toBe(1);
  });

  it('does not go below the smallest zoom for a huge picture', () => {
    expect(fitView({ x: 0, y: 0, width: 1e6, height: 1e6 }, 800, 600).zoom).toBe(ZOOM_LIMITS.min);
  });
});

import { describe, expect, it } from 'vitest';
import { placePopover } from '../../../../webview/src/lib/anchor';

const viewport = { width: 800, height: 600 };

describe('placePopover', () => {
  it('right-aligns the popover with its anchor when there is room', () => {
    const spot = placePopover({ left: 600, right: 700, bottom: 100 }, 300, viewport);
    expect(spot).toMatchObject({ left: 400, top: 106 });
  });

  it('keeps a wide popover inside the left edge instead of cutting it off', () => {
    const spot = placePopover({ left: 60, right: 120, bottom: 100 }, 460, viewport);
    expect(spot.left).toBe(8);
  });

  it('keeps it inside the right edge when the anchor sits at the very end', () => {
    const spot = placePopover({ left: 780, right: 900, bottom: 50 }, 200, viewport);
    expect(spot.left).toBe(592);
  });

  it('shrinks to the viewport when the popover is wider than the page', () => {
    const spot = placePopover({ left: 100, right: 200, bottom: 10 }, 2000, {
      width: 400,
      height: 300,
    });
    expect(spot.left).toBe(8);
  });

  it('limits the height to the room below, never under 120 px', () => {
    expect(placePopover({ left: 0, right: 100, bottom: 100 }, 100, viewport).maxHeight).toBe(486);
    expect(placePopover({ left: 0, right: 100, bottom: 590 }, 100, viewport).maxHeight).toBe(120);
  });
});

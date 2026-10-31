// The arithmetic of the crop box: where it may go, how a handle resizes it and how an aspect
// ratio is kept. All in whole pixels of the source image.

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface Bounds {
  readonly width: number;
  readonly height: number;
}

export type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
export const HANDLES: readonly Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export type RatioPreset = 'free' | '1:1' | '4:3' | '16:9' | '3:2' | 'custom';
export const RATIO_PRESETS: readonly RatioPreset[] = [
  'free',
  '1:1',
  '4:3',
  '16:9',
  '3:2',
  'custom',
];

const clamp = (value: number, low: number, high: number): number =>
  Math.max(low, Math.min(high, value));

/** The box brought inside the image, whole pixels, at least one pixel each way. */
export function clampRect(rect: Rect, bounds: Bounds): Rect {
  const w = clamp(Math.round(rect.w), 1, bounds.width);
  const h = clamp(Math.round(rect.h), 1, bounds.height);
  return {
    x: clamp(Math.round(rect.x), 0, bounds.width - w),
    y: clamp(Math.round(rect.y), 0, bounds.height - h),
    w,
    h,
  };
}

export function moveRect(rect: Rect, dx: number, dy: number, bounds: Bounds): Rect {
  return clampRect({ ...rect, x: rect.x + dx, y: rect.y + dy }, bounds);
}

/** `16:9`, `4/3` or `1.5` as width ÷ height; undefined for anything else or for zero. */
export function parseRatio(text: string): number | undefined {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(?:[:/x×]\s*(\d+(?:\.\d+)?))?\s*$/u.exec(text);
  if (match === null) {
    return undefined;
  }
  const a = Number(match[1]);
  const b = match[2] === undefined ? 1 : Number(match[2]);
  const ratio = a / b;
  return Number.isFinite(ratio) && ratio > 0 && ratio < 1000 ? ratio : undefined;
}

export function presetRatio(preset: RatioPreset, custom: string): number | undefined {
  return preset === 'free'
    ? undefined
    : preset === 'custom'
      ? parseRatio(custom)
      : parseRatio(preset);
}

/** The largest box of this ratio around the same centre that still fits the image. */
export function fitRatio(rect: Rect, ratio: number, bounds: Bounds): Rect {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  let w = rect.w;
  let h = w / ratio;
  if (h > rect.h) {
    h = rect.h;
    w = h * ratio;
  }
  if (w > bounds.width) {
    w = bounds.width;
    h = w / ratio;
  }
  if (h > bounds.height) {
    h = bounds.height;
    w = h * ratio;
  }
  return clampRect({ x: cx - w / 2, y: cy - h / 2, w: Math.max(1, w), h: Math.max(1, h) }, bounds);
}

/**
 * A handle dragged by (dx, dy): the opposite side stays where it is. With a ratio the box
 * keeps it, growing from the dragged corner or, on a side handle, around the middle of the
 * other axis.
 */
export function resizeRect(
  rect: Rect,
  handle: Handle,
  dx: number,
  dy: number,
  bounds: Bounds,
  ratio?: number,
): Rect {
  let left = rect.x;
  let top = rect.y;
  let right = rect.x + rect.w;
  let bottom = rect.y + rect.h;
  if (handle.includes('w')) {
    left = clamp(left + dx, 0, right - 1);
  }
  if (handle.includes('e')) {
    right = clamp(right + dx, left + 1, bounds.width);
  }
  if (handle.includes('n')) {
    top = clamp(top + dy, 0, bottom - 1);
  }
  if (handle.includes('s')) {
    bottom = clamp(bottom + dy, top + 1, bounds.height);
  }
  if (ratio === undefined) {
    return clampRect({ x: left, y: top, w: right - left, h: bottom - top }, bounds);
  }
  const fromRight = handle.includes('w');
  const fromBottom = handle.includes('n');
  const horizontalOnly = handle === 'e' || handle === 'w';
  const verticalOnly = handle === 'n' || handle === 's';
  let w = right - left;
  let h = bottom - top;
  if (verticalOnly) {
    w = h * ratio;
  } else if (horizontalOnly) {
    h = w / ratio;
  } else if (w / h > ratio) {
    w = h * ratio;
  } else {
    h = w / ratio;
  }
  // The anchored side's room limits the size.
  const room = {
    w: verticalOnly ? bounds.width : fromRight ? right : bounds.width - left,
    h: horizontalOnly ? bounds.height : fromBottom ? bottom : bounds.height - top,
  };
  if (w > room.w) {
    w = room.w;
    h = w / ratio;
  }
  if (h > room.h) {
    h = room.h;
    w = h * ratio;
  }
  w = Math.max(1, w);
  h = Math.max(1, h);
  const x = verticalOnly ? (left + right) / 2 - w / 2 : fromRight ? right - w : left;
  const y = horizontalOnly ? (top + bottom) / 2 - h / 2 : fromBottom ? bottom - h : top;
  return clampRect({ x, y, w, h }, bounds);
}

/** The box as the page shows it: a size that is not what the field says snaps to the ratio. */
export function setSize(
  rect: Rect,
  side: 'w' | 'h',
  value: number,
  bounds: Bounds,
  ratio?: number,
): Rect {
  const next = side === 'w' ? { ...rect, w: value } : { ...rect, h: value };
  if (ratio !== undefined) {
    return clampRect(
      side === 'w' ? { ...next, h: value / ratio } : { ...next, w: value * ratio },
      bounds,
    );
  }
  return clampRect(next, bounds);
}

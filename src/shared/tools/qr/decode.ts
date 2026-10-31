// Reading a QR code out of a picture: black-and-white the pixels, find the three finder
// patterns by their 1:1:3:1:1 runs, fit a perspective grid (the alignment pattern near the
// fourth corner pins it down), sample the modules and hand the matrix to `decode-modules`.

import { decodeModules, type Matrix, type QrDecoded, transpose } from './decode-modules';

export interface PixelImage {
  readonly width: number;
  readonly height: number;
  /** RGBA, four bytes a pixel. */
  readonly data: ArrayLike<number>;
}

export type { QrDecoded } from './decode-modules';

interface Point {
  readonly x: number;
  readonly y: number;
}

interface Finder extends Point {
  /** Pixels a module takes here. */
  readonly size: number;
  readonly count: number;
}

interface Bitmap {
  readonly width: number;
  readonly height: number;
  /** 1 = dark. */
  readonly dark: Uint8Array;
}

// ---- Black and white

function grayOf(image: PixelImage): Uint8Array {
  const gray = new Uint8Array(image.width * image.height);
  for (let i = 0; i < gray.length; i++) {
    const alpha = (image.data[i * 4 + 3] ?? 255) / 255;
    // A transparent pixel is the page behind the picture: white.
    const channel = (offset: number): number =>
      255 - alpha * (255 - (image.data[i * 4 + offset] ?? 0));
    gray[i] = Math.round(channel(0) * 0.299 + channel(1) * 0.587 + channel(2) * 0.114);
  }
  return gray;
}

function otsu(gray: Uint8Array): number {
  const histogram = new Array<number>(256).fill(0);
  for (const value of gray) {
    histogram[value] = (histogram[value] ?? 0) + 1;
  }
  let total = 0;
  histogram.forEach((count, level) => {
    total += count * level;
  });
  let below = 0;
  let weightBelow = 0;
  let best = 0;
  let bestSpread = -1;
  for (let level = 0; level < 256; level++) {
    weightBelow += histogram[level] ?? 0;
    if (weightBelow === 0) {
      continue;
    }
    const weightAbove = gray.length - weightBelow;
    if (weightAbove === 0) {
      break;
    }
    below += (histogram[level] ?? 0) * level;
    const meanBelow = below / weightBelow;
    const meanAbove = (total - below) / weightAbove;
    const spread = weightBelow * weightAbove * (meanBelow - meanAbove) ** 2;
    if (spread > bestSpread) {
      bestSpread = spread;
      best = level;
    }
  }
  return best;
}

function globalBitmap(gray: Uint8Array, width: number, height: number, invert: boolean): Bitmap {
  const threshold = otsu(gray);
  const dark = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) {
    dark[i] = (gray[i] ?? 0) <= threshold !== invert ? 1 : 0;
  }
  return { width, height, dark };
}

/** Compares each pixel with the mean of its neighbourhood: copes with shadows and gradients. */
function localBitmap(gray: Uint8Array, width: number, height: number, invert: boolean): Bitmap {
  const stride = width + 1;
  const sums = new Float64Array(stride * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      row += gray[y * width + x] ?? 0;
      sums[(y + 1) * stride + x + 1] = (sums[y * stride + x + 1] ?? 0) + row;
    }
  }
  const radius = Math.max(8, Math.floor(Math.min(width, height) / 10));
  const dark = new Uint8Array(gray.length);
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height, y + radius + 1);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width, x + radius + 1);
      const area = (x1 - x0) * (y1 - y0);
      const sum =
        (sums[y1 * stride + x1] ?? 0) -
        (sums[y0 * stride + x1] ?? 0) -
        (sums[y1 * stride + x0] ?? 0) +
        (sums[y0 * stride + x0] ?? 0);
      dark[y * width + x] = (gray[y * width + x] ?? 0) * area < sum * 0.92 !== invert ? 1 : 0;
    }
  }
  return { width, height, dark };
}

// ---- Finder patterns

function isDark(map: Bitmap, x: number, y: number): boolean | undefined {
  return x < 0 || y < 0 || x >= map.width || y >= map.height
    ? undefined
    : map.dark[y * map.width + x] === 1;
}

/** True when five run lengths are in the 1:1:3:1:1 proportion of a finder pattern. */
function finderRuns(counts: readonly number[]): boolean {
  const total = counts.reduce((a, b) => a + b, 0);
  if (counts.some((count) => count === 0) || total < 7) {
    return false;
  }
  const module = total / 7;
  const slack = module * 0.6;
  return (
    Math.abs((counts[0] ?? 0) - module) < slack &&
    Math.abs((counts[1] ?? 0) - module) < slack &&
    Math.abs((counts[2] ?? 0) - 3 * module) < 3 * slack &&
    Math.abs((counts[3] ?? 0) - module) < slack &&
    Math.abs((counts[4] ?? 0) - module) < slack
  );
}

/** Walks out from a dark pixel along a line; the centre and length of a finder pattern there. */
function crossCheck(
  map: Bitmap,
  x: number,
  y: number,
  dx: number,
  dy: number,
  expected: number,
): { centre: number; total: number } | undefined {
  const at = (k: number): boolean | undefined => isDark(map, x + dx * k, y + dy * k);
  const counts = [0, 0, 0, 0, 0];
  const bump = (index: number): void => {
    counts[index] = (counts[index] ?? 0) + 1;
  };
  // Backwards from the pixel: the centre run, the light run, the outer dark run.
  let k = 0;
  let start = 0;
  for (const [index, colour] of [
    [2, true],
    [1, false],
    [0, true],
  ] as const) {
    while (at(k) === colour) {
      bump(index);
      k--;
    }
    if (at(k) === undefined) {
      return undefined;
    }
    if (index === 2) {
      start = k;
    }
  }
  // Forwards from the next pixel: the rest of the centre run, then light and dark.
  k = 1;
  let end = k;
  for (const [index, colour] of [
    [2, true],
    [3, false],
    [4, true],
  ] as const) {
    while (at(k) === colour) {
      bump(index);
      k++;
    }
    if (at(k) === undefined) {
      return undefined;
    }
    if (index === 2) {
      end = k;
    }
  }
  const total = counts.reduce((a, b) => a + b, 0);
  if (Math.abs(total - expected) * 5 >= expected * 2 || !finderRuns(counts)) {
    return undefined;
  }
  return { centre: (start + end) / 2, total };
}

function findFinders(map: Bitmap): Finder[] {
  const found: { x: number; y: number; size: number; count: number }[] = [];
  const { width, height } = map;
  for (let y = 0; y < height; y++) {
    const starts: number[] = [];
    const lengths: number[] = [];
    const colours: boolean[] = [];
    let begin = 0;
    for (let x = 1; x <= width; x++) {
      if (x === width || map.dark[y * width + x] !== map.dark[y * width + x - 1]) {
        starts.push(begin);
        lengths.push(x - begin);
        colours.push(map.dark[y * width + begin] === 1);
        begin = x;
      }
    }
    for (let i = 0; i + 4 < lengths.length; i++) {
      if (colours[i] !== true) {
        continue;
      }
      const counts = lengths.slice(i, i + 5);
      if (!finderRuns(counts)) {
        continue;
      }
      const total = counts.reduce((a, b) => a + b, 0);
      const cx = (starts[i + 2] ?? 0) + (lengths[i + 2] ?? 0) / 2 - 0.5;
      const vertical = crossCheck(map, Math.round(cx), y, 0, 1, total);
      if (vertical === undefined) {
        continue;
      }
      const cy = y + vertical.centre;
      const horizontal = crossCheck(map, Math.round(cx), Math.round(cy), 1, 0, total);
      if (horizontal === undefined) {
        continue;
      }
      const x = Math.round(cx) + horizontal.centre;
      const size = (total + vertical.total + horizontal.total) / 21;
      const same = found.find(
        (finder) =>
          Math.abs(finder.x - x) <= finder.size * 1.5 &&
          Math.abs(finder.y - cy) <= finder.size * 1.5 &&
          Math.abs(finder.size - size) <= finder.size * 0.6,
      );
      if (same === undefined) {
        found.push({ x, y: cy, size, count: 1 });
      } else {
        const n = same.count;
        same.x = (same.x * n + x) / (n + 1);
        same.y = (same.y * n + cy) / (n + 1);
        same.size = (same.size * n + size) / (n + 1);
        same.count = n + 1;
      }
    }
  }
  const solid = found.filter((finder) => finder.count >= 2);
  return (solid.length >= 3 ? solid : found).sort((a, b) => b.count - a.count);
}

interface Corners {
  readonly topLeft: Finder;
  readonly topRight: Finder;
  readonly bottomLeft: Finder;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** The three finders that can be the corners of one code, with their roles told apart. */
function corners(finders: readonly Finder[]): Corners[] {
  const top = finders.slice(0, 9);
  const candidates: { corners: Corners; error: number }[] = [];
  for (let i = 0; i < top.length; i++) {
    for (let j = i + 1; j < top.length; j++) {
      for (let k = j + 1; k < top.length; k++) {
        const first = top[i];
        const second = top[j];
        const third = top[k];
        if (first === undefined || second === undefined || third === undefined) {
          continue;
        }
        const sizes = [first.size, second.size, third.size];
        if (Math.max(...sizes) > Math.min(...sizes) * 1.8) {
          continue;
        }
        // The corner opposite the longest side is the top left one.
        const sides = [distance(second, third), distance(first, third), distance(first, second)];
        const hypotenuse = Math.max(...sides);
        const longest = sides.indexOf(hypotenuse);
        const [corner, one, two] =
          longest === 0
            ? [first, second, third]
            : longest === 1
              ? [second, first, third]
              : [third, first, second];
        const a = distance(corner, one);
        const b = distance(corner, two);
        const error =
          Math.abs(hypotenuse ** 2 - (a ** 2 + b ** 2)) / hypotenuse ** 2 +
          Math.abs(a - b) / Math.max(a, b);
        if (error > 0.6) {
          continue;
        }
        const cross =
          (one.x - corner.x) * (two.y - corner.y) - (one.y - corner.y) * (two.x - corner.x);
        candidates.push({
          corners:
            cross > 0
              ? { topLeft: corner, topRight: one, bottomLeft: two }
              : { topLeft: corner, topRight: two, bottomLeft: one },
          error,
        });
      }
    }
  }
  return candidates
    .sort((a, b) => a.error - b.error)
    .slice(0, 3)
    .map((entry) => entry.corners);
}

// ---- Fitting the grid

type Transform = (u: number, v: number) => Point;

/** The perspective transform that sends four module-space points to four picture points. */
function homography(from: readonly Point[], to: readonly Point[]): Transform | undefined {
  const rows: number[][] = [];
  for (const [i, source] of from.entries()) {
    const target = to[i];
    if (target === undefined) {
      return undefined;
    }
    rows.push([
      source.x,
      source.y,
      1,
      0,
      0,
      0,
      -target.x * source.x,
      -target.x * source.y,
      target.x,
    ]);
    rows.push([
      0,
      0,
      0,
      source.x,
      source.y,
      1,
      -target.y * source.x,
      -target.y * source.y,
      target.y,
    ]);
  }
  for (let column = 0; column < 8; column++) {
    let pivot = column;
    for (let row = column + 1; row < 8; row++) {
      if (Math.abs(rows[row]?.[column] ?? 0) > Math.abs(rows[pivot]?.[column] ?? 0)) {
        pivot = row;
      }
    }
    const chosen = rows[pivot];
    const current = rows[column];
    if (chosen === undefined || current === undefined || Math.abs(chosen[column] ?? 0) < 1e-12) {
      return undefined;
    }
    rows[pivot] = current;
    rows[column] = chosen;
    const lead = chosen[column] ?? 1;
    for (let c = column; c < 9; c++) {
      chosen[c] = (chosen[c] ?? 0) / lead;
    }
    for (let row = 0; row < 8; row++) {
      const other = rows[row];
      if (row !== column && other !== undefined) {
        const factor = other[column] ?? 0;
        for (let c = column; c < 9; c++) {
          other[c] = (other[c] ?? 0) - factor * (chosen[c] ?? 0);
        }
      }
    }
  }
  const h = rows.map((row) => row[8] ?? 0);
  return (u, v) => {
    const w = (h[6] ?? 0) * u + (h[7] ?? 0) * v + 1;
    return {
      x: ((h[0] ?? 0) * u + (h[1] ?? 0) * v + (h[2] ?? 0)) / w,
      y: ((h[3] ?? 0) * u + (h[4] ?? 0) * v + (h[5] ?? 0)) / w,
    };
  };
}

/** Looks near where the fourth corner's alignment pattern should be and returns its centre. */
function alignmentCentre(map: Bitmap, guess: Point, module: Point, down: Point): Point | undefined {
  const score = (at: Point): number => {
    let hits = 0;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const x = Math.round(at.x + module.x * dx + down.x * dy);
        const y = Math.round(at.y + module.y * dx + down.y * dy);
        const expected = Math.max(Math.abs(dx), Math.abs(dy)) !== 1;
        hits += isDark(map, x, y) === expected ? 1 : 0;
      }
    }
    return hits;
  };
  const unit = Math.hypot(module.x, module.y);
  let best = { at: guess, score: -1 };
  for (const [reach, step] of [
    [4, 0.5],
    [0.7, 0.125],
  ] as const) {
    const centre = best.score < 0 ? guess : best.at;
    // Every position that matches as well as the best one is equally likely; take their middle.
    let top = -1;
    let sumX = 0;
    let sumY = 0;
    let n = 0;
    for (let sy = -reach; sy <= reach; sy += step) {
      for (let sx = -reach; sx <= reach; sx += step) {
        const at = { x: centre.x + sx * unit, y: centre.y + sy * unit };
        const value = score(at);
        if (value > top) {
          top = value;
          sumX = 0;
          sumY = 0;
          n = 0;
        }
        if (value === top) {
          sumX += at.x;
          sumY += at.y;
          n++;
        }
      }
    }
    best = { at: { x: sumX / n, y: sumY / n }, score: top };
  }
  return best.score >= 21 ? best.at : undefined;
}

function sample(map: Bitmap, transform: Transform, size: number): boolean[][] {
  const offsets = [
    [0, 0],
    [0.22, 0],
    [-0.22, 0],
    [0, 0.22],
    [0, -0.22],
  ] as const;
  return Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, column) => {
      let dark = 0;
      for (const [du, dv] of offsets) {
        const point = transform(column + 0.5 + du, row + 0.5 + dv);
        dark += isDark(map, Math.round(point.x), Math.round(point.y)) === true ? 1 : 0;
      }
      return dark >= 3;
    }),
  );
}

function readAt(
  map: Bitmap,
  found: Corners,
  dimension: number,
  align: boolean,
): QrDecoded | undefined {
  const { topLeft, topRight, bottomLeft } = found;
  const far = dimension - 3.5;
  const guess: Point = {
    x: topRight.x + bottomLeft.x - topLeft.x,
    y: topRight.y + bottomLeft.y - topLeft.y,
  };
  let fourth: { module: Point; point: Point } = { module: { x: far, y: far }, point: guess };
  if (align && dimension >= 25) {
    const perModule = (a: Point, b: Point): Point => ({
      x: (b.x - a.x) / (dimension - 7),
      y: (b.y - a.y) / (dimension - 7),
    });
    const across = perModule(topLeft, topRight);
    const down = perModule(topLeft, bottomLeft);
    const where: Point = {
      x: topLeft.x + across.x * (dimension - 10) + down.x * (dimension - 10),
      y: topLeft.y + across.y * (dimension - 10) + down.y * (dimension - 10),
    };
    const centre = alignmentCentre(map, where, across, down);
    if (centre !== undefined) {
      fourth = { module: { x: dimension - 6.5, y: dimension - 6.5 }, point: centre };
    }
  }
  const transform = homography(
    [{ x: 3.5, y: 3.5 }, { x: far, y: 3.5 }, { x: 3.5, y: far }, fourth.module],
    [topLeft, topRight, bottomLeft, fourth.point],
  );
  if (transform === undefined) {
    return undefined;
  }
  const matrix: Matrix = sample(map, transform, dimension);
  return decodeModules(matrix) ?? decodeModules(transpose(matrix));
}

function decodeBitmap(map: Bitmap): QrDecoded | undefined {
  for (const found of corners(findFinders(map))) {
    const module = (found.topLeft.size + found.topRight.size + found.bottomLeft.size) / 3;
    const across = distance(found.topLeft, found.topRight);
    const down = distance(found.topLeft, found.bottomLeft);
    // A code is 17 + 4n modules wide; the nearest such width, then its neighbours.
    const nearest = 17 + 4 * Math.round(((across + down) / 2 / module + 7 - 17) / 4);
    for (const dimension of [nearest, nearest - 4, nearest + 4]) {
      if (dimension >= 21 && dimension <= 177) {
        const result = readAt(map, found, dimension, true) ?? readAt(map, found, dimension, false);
        if (result !== undefined) {
          return result;
        }
      }
    }
  }
  return undefined;
}

/** Reads the first QR code found in a picture; undefined when there is none or it cannot be read. */
export function decodeQrImage(image: PixelImage): QrDecoded | undefined {
  if (image.width < 21 || image.height < 21 || image.data.length < image.width * image.height * 4) {
    return undefined;
  }
  const gray = grayOf(image);
  for (const make of [globalBitmap, localBitmap]) {
    for (const invert of [false, true]) {
      const result = decodeBitmap(make(gray, image.width, image.height, invert));
      if (result !== undefined) {
        return result;
      }
    }
  }
  return undefined;
}

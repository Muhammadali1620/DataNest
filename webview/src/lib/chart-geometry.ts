// The numbers behind a line chart (V11.14): a tidy scale, a smooth curve that never dips
// below its data, where a time falls on the axis and which sample the pointer is nearest.
// Pure, so the page only draws what these return.

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Scale {
  /** The top of the axis: the first tidy number at or above the highest value. */
  readonly max: number;
  /** From 0 up to `max`, evenly spaced, as many as were asked for plus one. */
  readonly ticks: readonly number[];
}

/** 1, 2, 2.5, 5 or 10 times a power of ten: the step a person would draw. */
function niceStep(raw: number): number {
  const power = 10 ** Math.floor(Math.log10(raw));
  const fraction = raw / power;
  const nice =
    fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  return nice * power;
}

/** An axis from zero that holds `highest`, in `count` steps (a flat zero still gets a range). */
export function niceScale(highest: number, count = 4): Scale {
  const top = Number.isFinite(highest) && highest > 0 ? highest : 1;
  const step = niceStep(top / count);
  const steps = Math.max(1, Math.ceil(top / step - 1e-9));
  const ticks = Array.from({ length: steps + 1 }, (_, index) => roundTo(index * step, step));
  return { max: ticks.at(-1) ?? step, ticks };
}

/** Removes the noise of floating point (0.30000000000000004) next to a step. */
function roundTo(value: number, step: number): number {
  const digits = Math.max(0, 2 - Math.floor(Math.log10(step)));
  return Number(value.toFixed(Math.min(digits, 8)));
}

/**
 * A curve through the points that follows them smoothly but never overshoots (monotone
 * cubic Hermite), so a quiet line does not swing below zero after a spike.
 */
export function smoothPath(points: readonly Point[]): string {
  const first = points[0];
  if (first === undefined) {
    return '';
  }
  if (points.length === 1) {
    return `M${n(first.x)},${n(first.y)}`;
  }
  const count = points.length;
  const slopes: number[] = [];
  for (let index = 0; index < count - 1; index += 1) {
    const a = points[index];
    const b = points[index + 1];
    slopes.push(a === undefined || b === undefined || b.x === a.x ? 0 : (b.y - a.y) / (b.x - a.x));
  }
  const tangents: number[] = [slopes[0] ?? 0];
  for (let index = 1; index < count - 1; index += 1) {
    const before = slopes[index - 1] ?? 0;
    const after = slopes[index] ?? 0;
    tangents.push(before * after <= 0 ? 0 : (before + after) / 2);
  }
  tangents.push(slopes[count - 2] ?? 0);
  // Fritsch–Carlson: a tangent may not be more than three times the slope beside it.
  for (let index = 0; index < count - 1; index += 1) {
    const slope = slopes[index] ?? 0;
    if (slope === 0) {
      tangents[index] = 0;
      tangents[index + 1] = 0;
      continue;
    }
    const alpha = (tangents[index] ?? 0) / slope;
    const beta = (tangents[index + 1] ?? 0) / slope;
    const length = Math.hypot(alpha, beta);
    if (length > 3) {
      const scale = 3 / length;
      tangents[index] = scale * alpha * slope;
      tangents[index + 1] = scale * beta * slope;
    }
  }
  let path = `M${n(first.x)},${n(first.y)}`;
  for (let index = 0; index < count - 1; index += 1) {
    const a = points[index];
    const b = points[index + 1];
    if (a === undefined || b === undefined) {
      continue;
    }
    const reach = (b.x - a.x) / 3;
    path +=
      `C${n(a.x + reach)},${n(a.y + reach * (tangents[index] ?? 0))}` +
      ` ${n(b.x - reach)},${n(b.y - reach * (tangents[index + 1] ?? 0))}` +
      ` ${n(b.x)},${n(b.y)}`;
  }
  return path;
}

/** The curve closed down to the baseline, to be filled softly. */
export function areaPath(points: readonly Point[], baseline: number): string {
  const first = points[0];
  const last = points.at(-1);
  if (first === undefined || last === undefined) {
    return '';
  }
  return `${smoothPath(points)}L${n(last.x)},${n(baseline)}L${n(first.x)},${n(baseline)}Z`;
}

function n(value: number): string {
  return (Math.round(value * 100) / 100).toString();
}

/** Where a time falls between `left` and `right` for a window that ends at `end`. */
export function timeX(
  time: number,
  end: number,
  windowMs: number,
  left: number,
  right: number,
): number {
  const share = windowMs <= 0 ? 1 : Math.min(1, Math.max(0, (time - (end - windowMs)) / windowMs));
  return left + share * (right - left);
}

/** `20:57:39`: the time of day as the axis writes it. */
export function clockLabel(time: number, locale?: string): string {
  return new Date(time).toLocaleTimeString(locale, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

/** Times for the labels under the axis: evenly spread over the window, `count` of them. */
export function axisTimes(end: number, windowMs: number, count: number): number[] {
  if (count <= 1) {
    return [end];
  }
  return Array.from(
    { length: count },
    (_, index) => end - windowMs + (index * windowMs) / (count - 1),
  );
}

/** The index of the sample closest to `x`, undefined for no samples. */
export function nearestIndex(xs: readonly number[], x: number): number | undefined {
  let best: number | undefined;
  let distance = Infinity;
  xs.forEach((candidate, index) => {
    const away = Math.abs(candidate - x);
    if (away < distance) {
      distance = away;
      best = index;
    }
  });
  return best;
}

/**
 * How much time the axis spans: what the readings cover, but never less than `least`
 * (so the first readings do not stretch over the whole width) nor more than `most`.
 */
export function windowFor(times: readonly number[], least: number, most: number): number {
  const first = times[0];
  const last = times.at(-1);
  if (first === undefined || last === undefined) {
    return least;
  }
  return Math.min(most, Math.max(least, last - first));
}

/** The unit a byte axis counts in: the largest one the highest value reaches. */
export function byteUnit(highest: number): { divisor: number; suffix: string } {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let divisor = 1;
  let index = 0;
  while (highest >= divisor * 1024 && index < units.length - 1) {
    divisor *= 1024;
    index += 1;
  }
  return { divisor, suffix: units[index] ?? 'B' };
}

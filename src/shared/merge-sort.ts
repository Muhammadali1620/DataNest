// A stable sort that can stop between steps. Array.prototype.sort cannot be paused,
// so sorting a million rows with it holds the extension host for the whole time; this
// one yields every few thousand comparisons and lets its driver decide when to wait.

/** Comparisons (or items visited) between two yields. */
const STEP = 4096;

/** Runs shorter than this are sorted by insertion before merging. */
const RUN = 32;

/**
 * Sorts `items` in place, stably, and returns them. The generator yields now and then;
 * a caller that never waits simply runs it to the end (see `runSteps`).
 */
export function* mergeSortSteps<T>(
  items: T[],
  compare: (left: T, right: T) => number,
): Generator<void, T[], void> {
  const length = items.length;
  let work = 0;
  for (let start = 0; start < length; start += RUN) {
    const end = Math.min(start + RUN, length);
    // Binary insertion: comparisons are the dear part (a collator), moves are cheap.
    for (let index = start + 1; index < end; index++) {
      const item = items[index] as T;
      let low = start;
      let high = index;
      while (low < high) {
        const middle = (low + high) >>> 1;
        // Past every equal item, so equal items keep their order.
        if (compare(items[middle] as T, item) <= 0) {
          low = middle + 1;
        } else {
          high = middle;
        }
        work++;
      }
      for (let position = index; position > low; position--) {
        items[position] = items[position - 1] as T;
      }
      items[low] = item;
    }
    if (work >= STEP) {
      work = 0;
      yield;
    }
  }
  let source = items;
  let target: T[] = new Array<T>(length);
  for (let width = RUN; width < length; width *= 2) {
    for (let start = 0; start < length; start += 2 * width) {
      const middle = Math.min(start + width, length);
      const end = Math.min(start + 2 * width, length);
      let left = start;
      let right = middle;
      let out = start;
      while (left < middle && right < end) {
        // `<=` keeps equal items in their original order.
        if (compare(source[left] as T, source[right] as T) <= 0) {
          target[out++] = source[left++] as T;
        } else {
          target[out++] = source[right++] as T;
        }
        if (++work >= STEP) {
          work = 0;
          yield;
        }
      }
      while (left < middle) {
        target[out++] = source[left++] as T;
      }
      while (right < end) {
        target[out++] = source[right++] as T;
      }
    }
    [source, target] = [target, source];
  }
  if (source !== items) {
    for (let index = 0; index < length; index++) {
      items[index] = source[index] as T;
    }
  }
  return items;
}

/** Runs a stepped computation to its end without waiting. */
export function runSteps<R>(steps: Generator<void, R, void>): R {
  for (;;) {
    const next = steps.next();
    if (next.done === true) {
      return next.value;
    }
  }
}

export interface PauseOptions {
  /** Waits for the event loop to breathe; a zero-delay timer by default. */
  readonly pause?: () => Promise<void>;
  /** The longest stretch of work between two pauses, in milliseconds. */
  readonly sliceMs?: number;
  /** The clock; `performance.now` by default. */
  readonly now?: () => number;
}

/**
 * Runs a stepped computation, pausing whenever it has worked for longer than a slice,
 * so the thread keeps answering everything else while a long sort goes on.
 */
export async function runStepsPaused<R>(
  steps: Generator<void, R, void>,
  options: PauseOptions = {},
): Promise<R> {
  const pause = options.pause ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  const sliceMs = options.sliceMs ?? 20;
  const now = options.now ?? (() => performance.now());
  let sliceStart = now();
  for (;;) {
    const next = steps.next();
    if (next.done === true) {
      return next.value;
    }
    if (now() - sliceStart >= sliceMs) {
      await pause();
      sliceStart = now();
    }
  }
}

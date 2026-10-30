// Line by line differences of two texts (V8.3: definitions side by side), as an
// edit script from the longest common subsequence. Big texts fall back to a plain
// "all removed, all added", which is still correct and keeps the page fast.

export interface DiffLine {
  readonly op: 'same' | 'add' | 'remove';
  readonly text: string;
}

/** Above this many cells (lines × lines) the full comparison is not worth its time. */
const MAX_CELLS = 4_000_000;

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  // Common lines at both ends need no table.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start += 1;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const head = a.slice(0, start).map((text): DiffLine => ({ op: 'same', text }));
  const tail = a.slice(endA).map((text): DiffLine => ({ op: 'same', text }));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  return [...head, ...middle(midA, midB), ...tail];
}

function middle(a: readonly string[], b: readonly string[]): DiffLine[] {
  if (a.length * b.length > MAX_CELLS) {
    return [
      ...a.map((text): DiffLine => ({ op: 'remove', text })),
      ...b.map((text): DiffLine => ({ op: 'add', text })),
    ];
  }
  const width = b.length + 1;
  // lengths[i * width + j]: longest common subsequence of a[i..] and b[j..].
  const lengths = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lengths[i * width + j] =
        a[i] === b[j]
          ? (lengths[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(lengths[(i + 1) * width + j] ?? 0, lengths[i * width + j + 1] ?? 0);
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ op: 'same', text: a[i] ?? '' });
      i += 1;
      j += 1;
    } else if ((lengths[(i + 1) * width + j] ?? 0) >= (lengths[i * width + j + 1] ?? 0)) {
      lines.push({ op: 'remove', text: a[i] ?? '' });
      i += 1;
    } else {
      lines.push({ op: 'add', text: b[j] ?? '' });
      j += 1;
    }
  }
  for (; i < a.length; i += 1) {
    lines.push({ op: 'remove', text: a[i] ?? '' });
  }
  for (; j < b.length; j += 1) {
    lines.push({ op: 'add', text: b[j] ?? '' });
  }
  return lines;
}

function splitLines(text: string): string[] {
  return text === '' ? [] : text.replace(/\r\n?/gu, '\n').split('\n');
}

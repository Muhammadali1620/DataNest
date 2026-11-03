// A small seeded generator for the property tests: the same seed always gives the same
// inputs, so a failure can be replayed from the seed in its message.

export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    // mulberry32
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)] as T;
}

/** A string made of pieces drawn from `alphabet`, up to `maxPieces` of them. */
export function pieces(
  random: () => number,
  alphabet: readonly string[],
  maxPieces: number,
): string {
  const count = Math.floor(random() * (maxPieces + 1));
  let text = '';
  for (let index = 0; index < count; index += 1) {
    text += pick(random, alphabet);
  }
  return text;
}

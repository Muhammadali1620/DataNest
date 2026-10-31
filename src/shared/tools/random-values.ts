// Random values of the Tools page. The source of randomness is a parameter, so tests are
// exact; the default one is the platform's cryptographic generator.

export interface RandomSource {
  /** Fills the array with random bytes. */
  fill(bytes: Uint8Array): Uint8Array;
}

export const cryptoSource: RandomSource = {
  fill: (bytes) => {
    // Typed arrays here are plain ArrayBuffer views; the DOM and Node typings differ on that.
    crypto.getRandomValues(bytes as Uint8Array<ArrayBuffer>);
    return bytes;
  },
};

/** An unbiased integer in [0, max), by rejecting the top of the byte range that would skew it. */
export function randomInt(max: number, source: RandomSource = cryptoSource): number {
  if (!Number.isInteger(max) || max < 1 || max > 0x1_0000_0000) {
    throw new RangeError('max must be an integer from 1 to 2^32');
  }
  if (max === 1) {
    return 0;
  }
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  for (;;) {
    const view = new DataView(source.fill(new Uint8Array(4)).buffer);
    const value = view.getUint32(0);
    if (value < limit) {
      return value % max;
    }
  }
}

export function pick<T>(items: readonly T[], source: RandomSource = cryptoSource): T {
  const item = items[randomInt(items.length, source)];
  if (item === undefined) {
    throw new RangeError('nothing to pick from');
  }
  return item;
}

/** A version 4 UUID (RFC 4122). */
export function uuidV4(source: RandomSource = cryptoSource): string {
  const bytes = source.fill(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface PasswordOptions {
  readonly length: number;
  readonly lower: boolean;
  readonly upper: boolean;
  readonly digits: boolean;
  readonly symbols: boolean;
}

export const DEFAULT_PASSWORD: PasswordOptions = {
  length: 16,
  lower: true,
  upper: true,
  digits: true,
  symbols: true,
};

export const MIN_PASSWORD_LENGTH = 4;
export const MAX_PASSWORD_LENGTH = 128;

const SETS = {
  lower: 'abcdefghijkmnopqrstuvwxyz',
  upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ',
  digits: '23456789',
  symbols: '!@#$%^&*()-_=+[]{};:,.?',
} as const;

/**
 * A password with at least one character of every chosen kind. Look-alike characters
 * (l, 1, I, O, 0) are left out, so it can be read aloud or typed from a screen.
 * Returns undefined when no kind is chosen.
 */
export function password(
  options: PasswordOptions,
  source: RandomSource = cryptoSource,
): string | undefined {
  const kinds = (['lower', 'upper', 'digits', 'symbols'] as const).filter((kind) => options[kind]);
  if (kinds.length === 0) {
    return undefined;
  }
  const length = Math.min(
    MAX_PASSWORD_LENGTH,
    Math.max(MIN_PASSWORD_LENGTH, Math.trunc(options.length)),
  );
  const all = kinds.map((kind) => SETS[kind]).join('');
  const chars = kinds.map((kind) => pick(Array.from(SETS[kind]), source));
  while (chars.length < length) {
    chars.push(pick(Array.from(all), source));
  }
  // Fisher–Yates, so the guaranteed characters are not always first.
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1, source);
    [chars[i], chars[j]] = [chars[j] ?? '', chars[i] ?? ''];
  }
  return chars.join('');
}

const FIRST_NAMES = [
  'Alex',
  'Maria',
  'Jordan',
  'Sofia',
  'Daniel',
  'Elena',
  'Marcus',
  'Anna',
  'Viktor',
  'Laura',
  'Samir',
  'Nina',
  'Oliver',
  'Katya',
  'Rafael',
  'Mila',
  'Theo',
  'Irina',
  'Kenji',
  'Leila',
];
const LAST_NAMES = [
  'Carter',
  'Ivanova',
  'Nguyen',
  'Silva',
  'Petrov',
  'Kowalski',
  'Moreau',
  'Haddad',
  'Larsen',
  'Tanaka',
  'Costa',
  'Novak',
  'Brown',
  'Rossi',
  'Okafor',
  'Schmidt',
  'Popov',
  'Garcia',
  'Lindqvist',
  'Aliyev',
];

/** An invented "First Last" name, for test data. */
export function personName(source: RandomSource = cryptoSource): string {
  return `${pick(FIRST_NAMES, source)} ${pick(LAST_NAMES, source)}`;
}

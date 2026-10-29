// Values for test data (V5.5): a generator per kind of column, driven by a seeded
// random source, so the same seed gives the same rows. Every value is text a column
// of the right type accepts (the import rules turn it into the stored value), or null.

/** What a column gets filled with. */
export const GENERATOR_KINDS = [
  'default',
  'null',
  'sequence',
  'integer',
  'decimal',
  'boolean',
  'date',
  'datetime',
  'time',
  'uuid',
  'text',
  'words',
  'sentence',
  'firstName',
  'lastName',
  'fullName',
  'username',
  'email',
  'phone',
  'company',
  'city',
  'country',
  'countryCode',
  'address',
  'postalCode',
  'url',
  'ip',
  'latitude',
  'longitude',
  'price',
  'color',
  'currency',
  'status',
  'enum',
  'json',
  'binary',
  'reference',
] as const;

export type GeneratorKind = (typeof GENERATOR_KINDS)[number];

export function isGeneratorKind(value: unknown): value is GeneratorKind {
  return GENERATOR_KINDS.some((kind) => kind === value);
}

/** A seeded source of numbers in [0, 1): mulberry32, small and good enough for test data. */
export class Random {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** A whole number in [min, max]. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)] as T;
  }
}

const FIRST = [
  'Anna',
  'Bob',
  'Carla',
  'David',
  'Elena',
  'Farid',
  'Grace',
  'Hiro',
  'Ivan',
  'Julia',
  'Kemal',
  'Lina',
  'Marco',
  'Nadia',
  'Omar',
  'Petra',
  'Quinn',
  'Rosa',
  'Sven',
  'Tara',
  'Umar',
  'Vera',
  'Wei',
  'Xenia',
  'Yusuf',
  'Zoe',
  'Aziz',
  'Dilnoza',
  'Olga',
  'Timur',
];
const LAST = [
  'Smith',
  'Johnson',
  'Garcia',
  'Müller',
  'Rossi',
  'Tanaka',
  'Ivanova',
  'Karimov',
  'Silva',
  'Nowak',
  'Dubois',
  'Kim',
  'Novak',
  'Haddad',
  'Olsen',
  'Costa',
  'Yilmaz',
  'Petrov',
  'Lee',
  'Brown',
  'Wilson',
  'Martin',
  'Lopez',
  'Schmidt',
  'Rahimov',
  "O'Brien",
];
const WORDS = (
  'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut ' +
  'labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris ' +
  'nisi aliquip ex ea commodo consequat duis aute irure in reprehenderit voluptate velit esse ' +
  'cillum fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt culpa qui ' +
  'officia deserunt mollit anim id est laborum'
).split(' ');
const COMPANIES = ['Acme', 'Globex', 'Initech', 'Umbrella', 'Stark', 'Wayne', 'Hooli', 'Vandelay'];
const COMPANY_KINDS = ['Inc', 'LLC', 'Group', 'Labs', 'Systems', 'Trading'];
const CITIES = [
  'Berlin',
  'Tashkent',
  'Lisbon',
  'Osaka',
  'Toronto',
  'Nairobi',
  'Lima',
  'Oslo',
  'Seoul',
  'Madrid',
  'Austin',
  'Samarkand',
  'Prague',
  'Kraków',
  'Dublin',
  'Riga',
  'Almaty',
  'Porto',
];
const COUNTRIES: readonly (readonly [string, string])[] = [
  ['DE', 'Germany'],
  ['UZ', 'Uzbekistan'],
  ['PT', 'Portugal'],
  ['JP', 'Japan'],
  ['CA', 'Canada'],
  ['KE', 'Kenya'],
  ['PE', 'Peru'],
  ['NO', 'Norway'],
  ['KR', 'South Korea'],
  ['ES', 'Spain'],
  ['US', 'United States'],
  ['CZ', 'Czechia'],
  ['PL', 'Poland'],
  ['IE', 'Ireland'],
  ['LV', 'Latvia'],
];
const STREETS = ['Main St', 'Oak Ave', 'Pine Rd', 'Lake Dr', 'Hill St', 'Park Ln', 'River Rd'];
const COLORS = ['red', 'green', 'blue', 'orange', 'purple', 'teal', 'black', 'white', 'gray'];
const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'UZS', 'CHF', 'CAD'];
const STATUSES = ['active', 'pending', 'inactive', 'archived'];

/** Everything a generator may know about its column. */
export interface GeneratorSettings {
  readonly kind: GeneratorKind;
  /** Longest text the column takes, from `varchar(n)` / `char(n)`. */
  readonly maxLength?: number;
  /** Fixed-length text (`char(n)`): pad to exactly this. */
  readonly fixedLength?: boolean;
  /** Integer range from the type. */
  readonly min?: number;
  readonly max?: number;
  /** Digits after the point, from `decimal(p,s)`. */
  readonly scale?: number;
  /** Values to choose from: enum options, or existing keys of a referenced table. */
  readonly choices?: readonly string[];
  /** First value of a sequence. */
  readonly start?: number;
  /** Values must not repeat: text gets the row number. */
  readonly unique?: boolean;
}

const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

function words(random: Random, from: number, to: number): string {
  return Array.from({ length: random.int(from, to) }, () => random.pick(WORDS)).join(' ');
}

function capitalize(text: string): string {
  return text.length === 0 ? text : `${text[0]?.toUpperCase() ?? ''}${text.slice(1)}`;
}

/** A moment in the last two years, as `YYYY-MM-DD HH:MM:SS`. */
function moment(random: Random): { date: string; time: string } {
  const now = Date.UTC(2026, 0, 1);
  const at = new Date(now - random.int(0, 2 * 365 * 24 * 3600) * 1000);
  return {
    date: `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`,
    time: `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}:${pad(at.getUTCSeconds())}`,
  };
}

function hex(random: Random, bytes: number): string {
  return Array.from({ length: bytes }, () => random.int(0, 255).toString(16).padStart(2, '0')).join(
    '',
  );
}

function uuid(random: Random): string {
  const digits = hex(random, 16).split('');
  digits[12] = '4';
  digits[16] = (8 + random.int(0, 3)).toString(16);
  const text = digits.join('');
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}

/** One value for row `row` (from 0); null means NULL. */
export function generateValue(
  settings: GeneratorSettings,
  random: Random,
  row: number,
): string | null {
  const value = raw(settings, random, row);
  return value === null ? null : fit(value, settings, row);
}

function raw(settings: GeneratorSettings, random: Random, row: number): string | null {
  const first = (): string => random.pick(FIRST);
  const last = (): string => random.pick(LAST);
  switch (settings.kind) {
    case 'default':
    case 'null':
      return null;
    case 'sequence':
      return String((settings.start ?? 1) + row);
    case 'integer':
      return String(random.int(settings.min ?? 1, settings.max ?? 1000));
    case 'decimal':
    case 'price': {
      const scale = settings.scale ?? 2;
      const top = Math.min(settings.max ?? 10_000, 1_000_000);
      const whole = random.int(settings.kind === 'price' ? 1 : (settings.min ?? 0), top);
      return scale === 0
        ? String(whole)
        : `${whole}.${String(random.int(0, 10 ** Math.min(scale, 6) - 1)).padStart(Math.min(scale, 6), '0')}`;
    }
    case 'boolean':
      return random.next() < 0.5 ? 'true' : 'false';
    case 'date':
      return moment(random).date;
    case 'datetime': {
      const at = moment(random);
      return `${at.date} ${at.time}`;
    }
    case 'time':
      return moment(random).time;
    case 'uuid':
      return uuid(random);
    case 'text':
    case 'words':
      return words(random, 1, 4);
    case 'sentence':
      return `${capitalize(words(random, 6, 14))}.`;
    case 'firstName':
      return first();
    case 'lastName':
      return last();
    case 'fullName':
      return `${first()} ${last()}`;
    case 'username':
      return `${first().toLowerCase()}.${last()
        .toLowerCase()
        .replace(/[^a-z]/gu, '')}${row + 1}`;
    case 'email':
      return `${first().toLowerCase()}.${last()
        .toLowerCase()
        .replace(/[^a-z]/gu, '')}${row + 1}@example.com`;
    case 'phone':
      return `+1-555-${pad(random.int(100, 999), 3)}-${pad(random.int(0, 9999), 4)}`;
    case 'company':
      return `${random.pick(COMPANIES)} ${random.pick(COMPANY_KINDS)}`;
    case 'city':
      return random.pick(CITIES);
    case 'country':
      return random.pick(COUNTRIES)[1];
    case 'countryCode':
      return random.pick(COUNTRIES)[0];
    case 'address':
      return `${random.int(1, 999)} ${random.pick(STREETS)}`;
    case 'postalCode':
      return pad(random.int(0, 99_999), 5);
    case 'url':
      return `https://example.com/${random.pick(WORDS)}/${row + 1}`;
    case 'ip':
      return `${random.int(1, 223)}.${random.int(0, 255)}.${random.int(0, 255)}.${random.int(1, 254)}`;
    case 'latitude':
      return (random.next() * 180 - 90).toFixed(6);
    case 'longitude':
      return (random.next() * 360 - 180).toFixed(6);
    case 'color':
      return random.pick(COLORS);
    case 'currency':
      return random.pick(CURRENCIES);
    case 'status':
      return random.pick(settings.choices?.length ? settings.choices : STATUSES);
    case 'enum':
    case 'reference':
      return settings.choices === undefined || settings.choices.length === 0
        ? null
        : random.pick(settings.choices);
    case 'json':
      return JSON.stringify({ id: row + 1, tag: random.pick(WORDS), score: random.int(0, 100) });
    case 'binary':
      return `0x${hex(random, random.int(4, 16))}`;
  }
}

/** Unique text gets the row number; text never outgrows its column. */
/** Kinds whose values are not free text: they are never cut or numbered. */
const EXACT_KINDS: ReadonlySet<GeneratorKind> = new Set([
  'sequence',
  'integer',
  'decimal',
  'price',
  'boolean',
  'date',
  'datetime',
  'time',
  'uuid',
  'enum',
  'reference',
  'json',
  'binary',
  'latitude',
  'longitude',
  'ip',
]);

function fit(value: string, settings: GeneratorSettings, row: number): string {
  const textual = !EXACT_KINDS.has(settings.kind);
  let text = value;
  if (settings.unique === true && textual && !text.includes(String(row + 1))) {
    text = `${text} ${row + 1}`;
  }
  if (settings.maxLength !== undefined && textual) {
    if (settings.unique === true && text.length > settings.maxLength) {
      // Keep the row number, which is what makes the value unique.
      const tail = String(row + 1);
      text = `${text.slice(0, Math.max(0, settings.maxLength - tail.length))}${tail}`;
    }
    text = text.slice(0, settings.maxLength);
    if (settings.fixedLength === true) {
      text = text.padEnd(settings.maxLength, 'x');
    }
  }
  return text;
}

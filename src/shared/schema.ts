// Tiny runtime schemas for messages from the webview, which is an untrusted side
// (ARCHITECTURE.md §5). Types are inferred from schemas, so each shape is written once.

/** Thrown when a value does not match a schema; `path` points to the offending field. */
export class SchemaError extends Error {
  override readonly name = 'SchemaError';

  constructor(
    readonly path: string,
    readonly problem: string,
  ) {
    super(`${path === '' ? 'value' : path}: ${problem}`);
  }
}

export interface Schema<T> {
  /** Returns a clean copy of `value` or throws SchemaError. */
  parse(value: unknown, path?: string): T;
}

export type Infer<S> = S extends Schema<infer T> ? T : never;

interface OptionalSchema<T> extends Schema<T | undefined> {
  readonly optional: true;
}

type Shape = Readonly<Record<string, Schema<unknown>>>;

type OptionalKeys<S extends Shape> = {
  [K in keyof S]: S[K] extends OptionalSchema<unknown> ? K : never;
}[keyof S];

type Simplify<T> = { [K in keyof T]: T[K] } & {};

export type InferObject<S extends Shape> = Simplify<
  { [K in Exclude<keyof S, OptionalKeys<S>>]: Infer<S[K]> } & {
    [K in OptionalKeys<S>]?: Infer<S[K]>;
  }
>;

/** Strings longer than this are rejected unless a schema allows more. */
export const DEFAULT_MAX_STRING_LENGTH = 1_000_000;

/** Arrays longer than this are rejected unless a schema allows more. */
export const DEFAULT_MAX_ARRAY_LENGTH = 100_000;

function describe(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}

function join(path: string, key: string | number): string {
  if (typeof key === 'number') {
    return `${path}[${key}]`;
  }
  return path === '' ? key : `${path}.${key}`;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

export function string(options: { minLength?: number; maxLength?: number } = {}): Schema<string> {
  const { minLength = 0, maxLength = DEFAULT_MAX_STRING_LENGTH } = options;
  return {
    parse(value, path = '') {
      if (typeof value !== 'string') {
        throw new SchemaError(path, `expected string, got ${describe(value)}`);
      }
      if (value.length < minLength) {
        throw new SchemaError(path, `expected at least ${minLength} characters`);
      }
      if (value.length > maxLength) {
        throw new SchemaError(path, `expected at most ${maxLength} characters`);
      }
      return value;
    },
  };
}

export function number(
  options: { integer?: boolean; min?: number; max?: number } = {},
): Schema<number> {
  const { integer = false, min = -Infinity, max = Infinity } = options;
  return {
    parse(value, path = '') {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new SchemaError(path, `expected finite number, got ${describe(value)}`);
      }
      if (integer && !Number.isInteger(value)) {
        throw new SchemaError(path, 'expected integer');
      }
      if (value < min || value > max) {
        throw new SchemaError(path, `expected number in ${min}..${max}`);
      }
      return value;
    },
  };
}

export function boolean(): Schema<boolean> {
  return {
    parse(value, path = '') {
      if (typeof value !== 'boolean') {
        throw new SchemaError(path, `expected boolean, got ${describe(value)}`);
      }
      return value;
    },
  };
}

/** One of the given primitive values, e.g. `literal('asc', 'desc')`. */
export function literal<const T extends readonly (string | number | boolean | null)[]>(
  ...values: T
): Schema<T[number]> {
  return {
    parse(value, path = '') {
      if (!values.includes(value as T[number])) {
        throw new SchemaError(
          path,
          `expected one of ${values.map((v) => JSON.stringify(v)).join(', ')}`,
        );
      }
      return value as T[number];
    },
  };
}

/** Accepts anything; for opaque payloads that are checked elsewhere. */
export function unknown(): Schema<unknown> {
  return { parse: (value) => value };
}

/** Allows `undefined`; inside `object()` the key may also be missing. */
export function optional<T>(schema: Schema<T>): OptionalSchema<T> {
  return {
    optional: true,
    parse(value, path = '') {
      return value === undefined ? undefined : schema.parse(value, path);
    },
  };
}

export function nullable<T>(schema: Schema<T>): Schema<T | null> {
  return {
    parse(value, path = '') {
      return value === null ? null : schema.parse(value, path);
    },
  };
}

type InferAny<T extends readonly Schema<unknown>[]> = { [K in keyof T]: Infer<T[K]> }[number];

/**
 * The first member that accepts the value wins. Members are tried in order, so
 * put the cheap and the common ones first.
 */
export function union<const T extends readonly Schema<unknown>[]>(
  ...members: T
): Schema<InferAny<T>> {
  if (members.length === 0) {
    throw new Error('A union needs at least one member');
  }
  return {
    parse(value, path = '') {
      for (const member of members) {
        try {
          return member.parse(value, path) as InferAny<T>;
        } catch (error) {
          if (!(error instanceof SchemaError)) {
            throw error;
          }
          // Try the next member; the combined failure is reported below.
        }
      }
      throw new SchemaError(path, `does not match any allowed shape (got ${describe(value)})`);
    },
  };
}

export function array<T>(item: Schema<T>, options: { maxLength?: number } = {}): Schema<T[]> {
  const { maxLength = DEFAULT_MAX_ARRAY_LENGTH } = options;
  return {
    parse(value, path = '') {
      if (!Array.isArray(value)) {
        throw new SchemaError(path, `expected array, got ${describe(value)}`);
      }
      if (value.length > maxLength) {
        throw new SchemaError(path, `expected at most ${maxLength} items`);
      }
      return value.map((element: unknown, index) => item.parse(element, join(path, index)));
    },
  };
}

/**
 * A plain object with exactly the given keys. Unknown keys are rejected, so a
 * typo or an injected field never passes silently.
 */
export function object<S extends Shape>(shape: S): Schema<InferObject<S>> {
  const fields: [string, Schema<unknown>][] = Object.entries(shape);
  return {
    parse(value, path = '') {
      if (!isPlainObject(value)) {
        throw new SchemaError(path, `expected object, got ${describe(value)}`);
      }
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(shape, key)) {
          throw new SchemaError(join(path, key), 'unexpected field');
        }
      }
      const result: Record<string, unknown> = {};
      for (const [key, field] of fields) {
        const parsed = field.parse(
          Object.hasOwn(value, key) ? value[key] : undefined,
          join(path, key),
        );
        if (parsed !== undefined) {
          result[key] = parsed;
        }
      }
      return result as InferObject<S>;
    },
  };
}

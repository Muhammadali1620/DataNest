/** Error categories every driver maps its native errors to. */
export type DbErrorCode =
  | 'connection-failed'
  | 'auth-failed'
  | 'timeout'
  | 'cancelled'
  /** Something else is already using the resource, e.g. a query is still running. */
  | 'busy'
  | 'syntax'
  | 'constraint'
  | 'permission-denied'
  | 'not-found'
  | 'unsupported'
  | 'internal';

export interface DbErrorOptions {
  /** Extra information for the log or an expandable details section. */
  readonly detail?: string;
  /** 0-based character offset of the error in the executed SQL. */
  readonly position?: number;
  /** SQLSTATE reported by the server, e.g. `23505`. */
  readonly sqlState?: string;
  /** The driver's own error code, e.g. `ER_DUP_ENTRY` or `1062`. */
  readonly driverCode?: string | number;
  readonly cause?: unknown;
}

/**
 * Marks a DbError of any copy of this module. Every driver is a bundle of its own with
 * its own copy of the class (§7), so plain `instanceof` would not know a driver's
 * error in the extension: the brand lives in the global symbol registry instead (D82).
 */
const BRAND = Symbol.for('datanest.DbError');

/** The only error type that crosses layer boundaries (ARCHITECTURE.md §9). */
export class DbError extends Error {
  static override [Symbol.hasInstance](value: unknown): boolean {
    return (
      typeof value === 'object' &&
      value !== null &&
      (value as { readonly [BRAND]?: unknown })[BRAND] === true
    );
  }

  override readonly name = 'DbError';
  readonly [BRAND] = true;
  readonly code: DbErrorCode;
  readonly detail: string | undefined;
  readonly position: number | undefined;
  readonly sqlState: string | undefined;
  readonly driverCode: string | number | undefined;

  constructor(code: DbErrorCode, message: string, options: DbErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    if (
      options.position !== undefined &&
      (!Number.isInteger(options.position) || options.position < 0)
    ) {
      throw new RangeError(`DbError position must be a non-negative integer: ${options.position}`);
    }
    this.code = code;
    this.detail = options.detail;
    this.position = options.position;
    this.sqlState = options.sqlState;
    this.driverCode = options.driverCode;
  }
}

export function isDbError(value: unknown): value is DbError {
  return value instanceof DbError;
}

/** Wraps anything thrown into a DbError, keeping the original as `cause`. */
export function toDbError(value: unknown, fallbackCode: DbErrorCode = 'internal'): DbError {
  if (value instanceof DbError) {
    return value;
  }
  return new DbError(fallbackCode, errorMessage(value), { cause: value });
}

/** A short message that is safe to show to the user. */
export function errorMessage(value: unknown): string {
  if (value instanceof Error) {
    return value.message.trim() === '' ? value.name : value.message;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    return value;
  }
  return 'Unexpected error';
}

const MAX_CAUSE_DEPTH = 10;

/** Full description with fields, stack and the cause chain, for the log. */
export function describeError(value: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = value;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== undefined; depth++) {
    if (seen.has(current)) {
      parts.push('[circular cause]');
      break;
    }
    seen.add(current);
    parts.push((depth === 0 ? '' : 'Caused by: ') + describeOne(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join('\n');
}

function describeOne(value: unknown): string {
  if (!(value instanceof Error)) {
    return typeof value === 'string' ? value : safeStringify(value);
  }
  const head =
    value instanceof DbError ? `DbError [${value.code}]: ${value.message}` : headOf(value);
  const lines = [head];
  if (value instanceof DbError) {
    const fields: [string, string | number | undefined][] = [
      ['sqlState', value.sqlState],
      ['driverCode', value.driverCode],
      ['position', value.position],
      ['detail', value.detail],
    ];
    for (const [name, field] of fields) {
      if (field !== undefined) {
        lines.push(`  ${name}: ${String(field)}`);
      }
    }
  }
  const frames = value.stack?.split('\n').filter((line) => /^\s+at /.test(line)) ?? [];
  lines.push(...frames.map((frame) => `  ${frame.trim()}`));
  return lines.join('\n');
}

function headOf(error: Error): string {
  return error.message === '' ? error.name : `${error.name}: ${error.message}`;
}

function safeStringify(value: unknown): string {
  try {
    // JSON.stringify returns undefined for functions and symbols despite its declared type.
    const json = JSON.stringify(value) as string | undefined;
    return json ?? String(value);
  } catch (_error) {
    // Circular or BigInt values cannot be serialized; the type is still useful.
    return Object.prototype.toString.call(value);
  }
}

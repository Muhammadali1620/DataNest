import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  array,
  boolean,
  DEFAULT_MAX_ARRAY_LENGTH,
  DEFAULT_MAX_STRING_LENGTH,
  type Infer,
  isPlainObject,
  literal,
  nullable,
  number,
  object,
  optional,
  SchemaError,
  string,
  union,
  unknown,
} from '../../../src/shared/schema';

function problem(fn: () => unknown): { path: string; message: string } {
  try {
    fn();
  } catch (error) {
    if (error instanceof SchemaError) {
      return { path: error.path, message: error.message };
    }
    throw error;
  }
  throw new Error('Expected a SchemaError');
}

describe('string', () => {
  it('accepts strings, including empty and Unicode', () => {
    expect(string().parse('')).toBe('');
    expect(string().parse('Ольга 🚀')).toBe('Ольга 🚀');
  });

  it.each([[1], [null], [undefined], [{}], [[]], [true]])('rejects %j', (value) => {
    expect(() => string().parse(value)).toThrow(SchemaError);
  });

  it('describes the received type', () => {
    expect(problem(() => string().parse(null)).message).toBe('value: expected string, got null');
    expect(problem(() => string().parse([])).message).toBe('value: expected string, got array');
  });

  it('checks length limits', () => {
    const s = string({ minLength: 2, maxLength: 3 });
    expect(s.parse('ab')).toBe('ab');
    expect(s.parse('abc')).toBe('abc');
    expect(() => s.parse('a')).toThrow('expected at least 2 characters');
    expect(() => s.parse('abcd')).toThrow('expected at most 3 characters');
  });

  it('limits length by default', () => {
    expect(string().parse('x'.repeat(DEFAULT_MAX_STRING_LENGTH))).toHaveLength(
      DEFAULT_MAX_STRING_LENGTH,
    );
    expect(() => string().parse('x'.repeat(DEFAULT_MAX_STRING_LENGTH + 1))).toThrow(SchemaError);
  });
});

describe('number', () => {
  it('accepts finite numbers', () => {
    expect(number().parse(0)).toBe(0);
    expect(number().parse(-1.5)).toBe(-1.5);
  });

  it.each([[Number.NaN], [Infinity], [-Infinity], ['1'], [null], [1n]])('rejects %s', (value) => {
    expect(() => number().parse(value)).toThrow('expected finite number');
  });

  it('checks integers and ranges', () => {
    const n = number({ integer: true, min: 1, max: 10 });
    expect(n.parse(1)).toBe(1);
    expect(n.parse(10)).toBe(10);
    expect(() => n.parse(1.5)).toThrow('expected integer');
    expect(() => n.parse(0)).toThrow('expected number in 1..10');
    expect(() => n.parse(11)).toThrow('expected number in 1..10');
  });
});

describe('boolean', () => {
  it('accepts only booleans', () => {
    expect(boolean().parse(true)).toBe(true);
    expect(boolean().parse(false)).toBe(false);
    expect(() => boolean().parse(0)).toThrow('expected boolean, got number');
    expect(() => boolean().parse('true')).toThrow(SchemaError);
  });
});

describe('literal', () => {
  it('accepts only the listed values', () => {
    const order = literal('asc', 'desc');
    expect(order.parse('asc')).toBe('asc');
    expect(() => order.parse('ASC')).toThrow('expected one of "asc", "desc"');
    expectTypeOf(order.parse('asc')).toEqualTypeOf<'asc' | 'desc'>();
  });

  it('supports numbers, booleans and null', () => {
    const value = literal(1, true, null);
    expect(value.parse(1)).toBe(1);
    expect(value.parse(true)).toBe(true);
    expect(value.parse(null)).toBeNull();
    expect(() => value.parse('1')).toThrow(SchemaError);
  });
});

describe('unknown, optional, nullable', () => {
  it('unknown passes anything through', () => {
    const value = { a: [1] };
    expect(unknown().parse(value)).toBe(value);
  });

  it('optional allows undefined only', () => {
    const s = optional(string());
    expect(s.parse(undefined)).toBeUndefined();
    expect(s.parse('x')).toBe('x');
    expect(() => s.parse(null)).toThrow(SchemaError);
  });

  it('nullable allows null only', () => {
    const s = nullable(number());
    expect(s.parse(null)).toBeNull();
    expect(s.parse(2)).toBe(2);
    expect(() => s.parse(undefined)).toThrow(SchemaError);
  });
});

describe('array', () => {
  it('parses every item and reports its index', () => {
    expect(array(number()).parse([1, 2])).toEqual([1, 2]);
    expect(problem(() => array(number()).parse([1, 'x']))).toEqual({
      path: '[1]',
      message: '[1]: expected finite number, got string',
    });
  });

  it('rejects non-arrays and array-likes', () => {
    expect(() => array(number()).parse({ length: 0 })).toThrow('expected array, got object');
    expect(() => array(number()).parse('abc')).toThrow(SchemaError);
  });

  it('checks the length', () => {
    expect(() => array(number(), { maxLength: 2 }).parse([1, 2, 3])).toThrow(
      'expected at most 2 items',
    );
    expect(() => array(number()).parse(new Array(DEFAULT_MAX_ARRAY_LENGTH + 1).fill(0))).toThrow(
      SchemaError,
    );
  });

  it('returns a new array', () => {
    const input = [1];
    expect(array(number()).parse(input)).not.toBe(input);
  });
});

describe('object', () => {
  const user = object({
    name: string(),
    age: optional(number({ integer: true })),
    tags: array(string()),
  });

  it('parses a valid object into a clean copy', () => {
    const input = { name: 'Ann', age: 30, tags: ['a'] };
    const parsed = user.parse(input);
    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
  });

  it('omits missing and undefined optional fields', () => {
    expect(user.parse({ name: 'Ann', tags: [] })).toEqual({ name: 'Ann', tags: [] });
    expect(Object.keys(user.parse({ name: 'Ann', age: undefined, tags: [] }))).toEqual([
      'name',
      'tags',
    ]);
  });

  it('rejects missing required fields', () => {
    expect(problem(() => user.parse({ tags: [] }))).toEqual({
      path: 'name',
      message: 'name: expected string, got undefined',
    });
  });

  it('rejects unknown fields', () => {
    expect(problem(() => user.parse({ name: 'A', tags: [], admin: true }))).toEqual({
      path: 'admin',
      message: 'admin: unexpected field',
    });
  });

  it('rejects prototype pollution attempts', () => {
    const payload = JSON.parse('{"name":"A","tags":[],"__proto__":{"admin":true}}') as unknown;
    expect(() => user.parse(payload)).toThrow('__proto__: unexpected field');
    expect(() => object({}).parse({ constructor: 1 })).toThrow('constructor: unexpected field');
  });

  it('does not treat inherited properties as fields', () => {
    expect(() => object({ toString: optional(string()) }).parse({})).not.toThrow();
    expect(object({ toString: optional(string()) }).parse({})).toEqual({});
  });

  it.each([[null], [[]], ['x'], [new Date()], [new Map()]])(
    'rejects the non-plain object %s',
    (value) => {
      expect(() => user.parse(value)).toThrow(SchemaError);
    },
  );

  it('accepts objects without a prototype', () => {
    const value = Object.assign(Object.create(null) as object, { name: 'A', tags: [] });
    expect(user.parse(value)).toEqual({ name: 'A', tags: [] });
  });

  it('reports nested paths', () => {
    const schema = object({ list: array(object({ id: number() })) });
    expect(problem(() => schema.parse({ list: [{ id: 1 }, { id: 'x' }] })).path).toBe('list[1].id');
    expect(problem(() => schema.parse({ list: [{}] }, 'params')).path).toBe('params.list[0].id');
  });

  it('infers optional keys in the type', () => {
    type User = Infer<typeof user>;
    expectTypeOf<User>().toEqualTypeOf<{
      name: string;
      tags: string[];
      age?: number | undefined;
    }>();
  });
});

describe('isPlainObject', () => {
  it('accepts only plain objects', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject(new Date())).toBe(false);
    expect(isPlainObject(new URL('https://x.test'))).toBe(false);
  });
});

describe('SchemaError', () => {
  it('keeps the path and the problem', () => {
    const error = new SchemaError('a.b', 'bad');
    expect(error.name).toBe('SchemaError');
    expect(error.path).toBe('a.b');
    expect(error.problem).toBe('bad');
    expect(error.message).toBe('a.b: bad');
    expect(new SchemaError('', 'bad').message).toBe('value: bad');
  });
});

describe('union', () => {
  const value = union(string(), number(), object({ a: boolean() }));

  it('accepts a value matching any member', () => {
    expect(value.parse('text')).toBe('text');
    expect(value.parse(42)).toBe(42);
    expect(value.parse({ a: true })).toEqual({ a: true });
  });

  it('returns the first member that matches', () => {
    const either = union(literal('a'), string());
    expect(either.parse('a')).toBe('a');
    expect(either.parse('b')).toBe('b');
  });

  it('rejects a value no member accepts, naming the path', () => {
    expect(() => value.parse(true)).toThrow('does not match any allowed shape');
    expect(() => object({ x: value }).parse({ x: true })).toThrow('x');
  });

  it('mentions the type it was given', () => {
    expect(() => value.parse(null)).toThrow('null');
    expect(() => value.parse([])).toThrow('array');
  });

  it('still rejects unknown fields inside an object member', () => {
    expect(() => value.parse({ a: true, b: 1 })).toThrow('does not match any allowed shape');
  });

  it('needs at least one member', () => {
    expect(() => union()).toThrow('at least one member');
  });
});

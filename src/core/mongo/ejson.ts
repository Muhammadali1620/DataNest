// MongoDB Extended JSON v2 (V10.2.7): documents written so that every BSON type comes
// back as it was — canonical mode, `{"$numberLong": "…"}` and the like — and read in
// either mode, so files of `mongoexport` (relaxed by default) load too. Built on the
// lossless JSON tree: numbers stay their text, fields keep their order.

import { type JsonMember, type JsonValue, jsonString } from '../json/json-tree';
import { msg } from '../user-message';
import type { MongoDocument, MongoValue } from './value';

/** A value that is Extended JSON in name only: the reason, for the line of the file. */
export class EjsonError extends Error {
  override readonly name = 'EjsonError';
}

const text = (value: string): JsonValue => ({ type: 'string', value });
const number = (value: string | number): JsonValue => ({ type: 'number', text: String(value) });
const object = (...members: JsonMember[]): JsonValue => ({ type: 'object', members });

/** Canonical Extended JSON of a value: nothing is lost on the way back. */
export function toEjson(value: MongoValue): JsonValue {
  switch (value.type) {
    case 'document':
      return { type: 'object', members: value.fields.map(([name, item]) => [name, toEjson(item)]) };
    case 'array':
      return { type: 'array', items: value.items.map(toEjson) };
    case 'null':
      return { type: 'null' };
    case 'undefined':
      return object(['$undefined', { type: 'bool', value: true }]);
    case 'bool':
      return { type: 'bool', value: value.value };
    case 'int32':
      return object(['$numberInt', text(String(value.value))]);
    case 'int64':
      return object(['$numberLong', text(value.value)]);
    case 'double':
      // NaN, Infinity and -Infinity are spelled the way the type keeps them already.
      return object(['$numberDouble', text(value.value)]);
    case 'decimal':
      return object(['$numberDecimal', text(value.value)]);
    case 'string':
      return text(value.value);
    case 'objectId':
      return object(['$oid', text(value.value)]);
    case 'date':
      return object(['$date', object(['$numberLong', text(value.value)])]);
    case 'binary':
      return object([
        '$binary',
        object(
          ['base64', text(value.value)],
          ['subType', text(value.subtype.toString(16).padStart(2, '0'))],
        ),
      ]);
    case 'regex':
      return object([
        '$regularExpression',
        object(['pattern', text(value.pattern)], ['options', text(value.flags)]),
      ]);
    case 'timestamp':
      return object(['$timestamp', object(['t', number(value.t)], ['i', number(value.i)])]);
    case 'minKey':
      return object(['$minKey', number(1)]);
    case 'maxKey':
      return object(['$maxKey', number(1)]);
    case 'code':
      return value.scope === undefined
        ? object(['$code', text(value.value)])
        : object(['$code', text(value.value)], ['$scope', toEjson(value.scope)]);
    case 'symbol':
      return object(['$symbol', text(value.value)]);
    case 'dbPointer':
      return object([
        '$dbPointer',
        object(['$ref', text(value.ns)], ['$id', object(['$oid', text(value.id)])]),
      ]);
  }
}

const INT32 = /^-?\d+$/u;
const OBJECT_ID = /^[0-9a-f]{24}$/iu;

function fail(reason: string): never {
  throw new EjsonError(reason);
}

function onlyString(value: JsonValue | undefined, what: string): string {
  const result = jsonString(value);
  return result ?? fail(msg('{0} must be text', what));
}

/** A relaxed number: an integer as int32 or int64 when it fits, anything else a double. */
function relaxedNumber(textValue: string): MongoValue {
  if (INT32.test(textValue)) {
    const big = BigInt(textValue);
    if (big >= -2_147_483_648n && big <= 2_147_483_647n) {
      return { type: 'int32', value: Number(big) };
    }
    if (big >= -(2n ** 63n) && big < 2n ** 63n) {
      return { type: 'int64', value: big.toString() };
    }
  }
  const parsed = Number(textValue);
  return { type: 'double', value: Object.is(parsed, -0) ? '-0' : String(parsed) };
}

function integerText(value: JsonValue | undefined, what: string): string {
  const result =
    value?.type === 'number' ? value.text : value?.type === 'string' ? value.value : undefined;
  if (result === undefined || !INT32.test(result)) {
    fail(msg('{0} must be a whole number', what));
  }
  return result;
}

function dateValue(value: JsonValue | undefined): MongoValue {
  if (value?.type === 'object') {
    const [name, inner] = value.members[0] ?? [];
    if (name === '$numberLong' && value.members.length === 1) {
      return { type: 'date', value: integerText(inner, '$date') };
    }
  }
  if (value?.type === 'number') {
    return { type: 'date', value: integerText(value, '$date') };
  }
  if (value?.type === 'string') {
    const ms = Date.parse(value.value);
    if (Number.isNaN(ms)) {
      fail(msg('{0} is not a date', value.value));
    }
    return { type: 'date', value: String(ms) };
  }
  return fail(msg('{0} must be a date', '$date'));
}

/** A wrapper object such as `{"$oid": "…"}`, or undefined for an ordinary document. */
function wrapper(members: readonly JsonMember[]): MongoValue | undefined {
  const [first] = members;
  if (first?.[0].startsWith('$') !== true) {
    return undefined;
  }
  const get = (name: string): JsonValue | undefined =>
    members.find(([member]) => member === name)?.[1];
  const single = members.length === 1;
  switch (first[0]) {
    case '$oid': {
      const id = onlyString(first[1], '$oid');
      return single && OBJECT_ID.test(id)
        ? { type: 'objectId', value: id.toLowerCase() }
        : fail(msg('{0} is not an ObjectId', id));
    }
    case '$numberInt': {
      const value = Number(integerText(first[1], '$numberInt'));
      return value >= -2_147_483_648 && value <= 2_147_483_647
        ? { type: 'int32', value }
        : fail(msg('{0} does not fit a 32-bit integer', String(value)));
    }
    case '$numberLong':
      return { type: 'int64', value: integerText(first[1], '$numberLong') };
    case '$numberDouble': {
      const value = onlyString(first[1], '$numberDouble');
      if (Number.isNaN(Number(value)) && value !== 'NaN') {
        fail(msg('{0} is not a number', value));
      }
      return { type: 'double', value };
    }
    case '$numberDecimal':
      return { type: 'decimal', value: onlyString(first[1], '$numberDecimal') };
    case '$date':
      return single ? dateValue(first[1]) : undefined;
    case '$binary': {
      // v2: {"$binary": {"base64": …, "subType": "hex"}}; v1: {"$binary": …, "$type": "hex"}.
      const inner = first[1];
      const base64 =
        inner.type === 'object'
          ? onlyString(member(inner, 'base64'), 'base64')
          : onlyString(inner, '$binary');
      const subType =
        inner.type === 'object'
          ? onlyString(member(inner, 'subType'), 'subType')
          : onlyString(get('$type'), '$type');
      const subtype = Number.parseInt(subType, 16);
      return Number.isNaN(subtype)
        ? fail(msg('{0} is not a binary subtype', subType))
        : { type: 'binary', subtype, value: base64 };
    }
    case '$regularExpression': {
      const inner = first[1];
      return {
        type: 'regex',
        pattern: onlyString(member(inner, 'pattern'), 'pattern'),
        flags: onlyString(member(inner, 'options'), 'options'),
      };
    }
    case '$regex':
      return {
        type: 'regex',
        pattern: onlyString(first[1], '$regex'),
        flags: jsonString(get('$options')) ?? '',
      };
    case '$timestamp': {
      const inner = first[1];
      return {
        type: 'timestamp',
        t: Number(integerText(member(inner, 't'), 't')),
        i: Number(integerText(member(inner, 'i'), 'i')),
      };
    }
    case '$minKey':
      return single ? { type: 'minKey' } : undefined;
    case '$maxKey':
      return single ? { type: 'maxKey' } : undefined;
    case '$undefined':
      return single ? { type: 'undefined' } : undefined;
    case '$code': {
      const scope = get('$scope');
      if (scope !== undefined && scope.type !== 'object') {
        fail(msg('{0} must be a document', '$scope'));
      }
      return {
        type: 'code',
        value: onlyString(first[1], '$code'),
        ...(scope === undefined ? {} : { scope: fromEjsonDocument(scope) }),
      };
    }
    case '$symbol':
      return { type: 'symbol', value: onlyString(first[1], '$symbol') };
    case '$dbPointer': {
      const inner = first[1];
      const id = fromEjson(member(inner, '$id') ?? { type: 'null' });
      return id.type === 'objectId'
        ? { type: 'dbPointer', ns: onlyString(member(inner, '$ref'), '$ref'), id: id.value }
        : fail(msg('{0} needs an ObjectId', '$dbPointer'));
    }
    default:
      // A field that merely starts with $ (an operator in a stored pipeline): a document.
      return undefined;
  }
}

function member(value: JsonValue, name: string): JsonValue | undefined {
  return value.type === 'object' ? value.members.find(([key]) => key === name)?.[1] : undefined;
}

/** A value read from Extended JSON, canonical or relaxed. */
export function fromEjson(value: JsonValue): MongoValue {
  switch (value.type) {
    case 'object':
      return (
        wrapper(value.members) ?? {
          type: 'document',
          fields: value.members.map(([name, item]) => [name, fromEjson(item)]),
        }
      );
    case 'array':
      return { type: 'array', items: value.items.map(fromEjson) };
    case 'string':
      return { type: 'string', value: value.value };
    case 'number':
      return relaxedNumber(value.text);
    case 'bool':
      return { type: 'bool', value: value.value };
    case 'null':
      return { type: 'null' };
  }
}

/** A document read from Extended JSON; anything else in its place is refused. */
export function fromEjsonDocument(value: JsonValue): MongoDocument {
  const read = fromEjson(value);
  return read.type === 'document'
    ? read
    : fail(msg('A line must hold a document, not {0}', read.type));
}

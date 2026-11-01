import { describe, expect, it } from 'vitest';
import { fromTyped, jsonText, typeName } from '../../../../src/drivers/neo4j/values';

const typed = (type: string, value: unknown) => ({ $type: type, _value: value });

describe('fromTyped', () => {
  it('reads the scalars', () => {
    expect(fromTyped(typed('Null', null))).toBeNull();
    expect(fromTyped(undefined)).toBeNull();
    expect(fromTyped(null)).toBeNull();
    expect(fromTyped(typed('Boolean', true))).toBe(true);
    expect(fromTyped(typed('Boolean', false))).toBe(false);
    expect(fromTyped(typed('String', 'é'))).toBe('é');
    expect(fromTyped(typed('String', 5))).toBeNull();
  });

  it('keeps integers beyond 2^53 exact', () => {
    expect(fromTyped(typed('Integer', '42'))).toBe(42);
    expect(fromTyped(typed('Integer', '-7'))).toBe(-7);
    expect(fromTyped(typed('Integer', '9007199254740993'))).toEqual({
      kind: 'bigint',
      text: '9007199254740993',
    });
    expect(fromTyped(typed('Integer', 'not a number'))).toBe('not a number');
  });

  it('reads floats, including the ones JSON cannot write', () => {
    expect(fromTyped(typed('Float', '0.1'))).toBe(0.1);
    expect(fromTyped(typed('Float', 2.5))).toBe(2.5);
    expect(fromTyped(typed('Float', 'NaN'))).toBeNaN();
    expect(fromTyped(typed('Float', 'Infinity'))).toBe(Number.POSITIVE_INFINITY);
    expect(fromTyped(typed('Float', '-Infinity'))).toBe(Number.NEGATIVE_INFINITY);
    expect(fromTyped(typed('Float', 'abc'))).toBe('abc');
    expect(fromTyped(typed('Float', { weird: true }))).toBe('{"weird":true}');
  });

  it('keeps dates as the server printed them', () => {
    for (const type of [
      'Date',
      'Time',
      'LocalTime',
      'LocalDateTime',
      'OffsetDateTime',
      'ZonedDateTime',
      'DateTime',
    ]) {
      expect(fromTyped(typed(type, '2020-01-01T10:00:00Z'))).toEqual({
        kind: 'datetime',
        text: '2020-01-01T10:00:00Z',
      });
    }
  });

  it('prints durations, points and types it does not know', () => {
    expect(fromTyped(typed('Duration', 'P1D'))).toBe('P1D');
    expect(fromTyped(typed('Point', 'SRID=7203;POINT (1.0 2.0)'))).toBe(
      'SRID=7203;POINT (1.0 2.0)',
    );
    expect(fromTyped(typed('Vector', 5))).toBe('5');
    expect(fromTyped(typed('Vector', null))).toBe('null');
  });

  it('reads bytes', () => {
    expect(fromTyped(typed('Base64', 'AP8Q'))).toMatchObject({
      kind: 'binary',
      size: 3,
      preview: '00ff10',
    });
    expect(fromTyped(typed('Base64', 5))).toBeNull();
  });

  it('shows lists, maps and entities as JSON', () => {
    expect(
      fromTyped(typed('List', [typed('Integer', '1'), typed('Float', '2.5'), typed('Null', null)])),
    ).toEqual({
      kind: 'json',
      text: '[1,2.5,null]',
    });
    expect(fromTyped(typed('Map', { k: typed('String', 'v') }))).toEqual({
      kind: 'json',
      text: '{"k":"v"}',
    });
    const node = typed('Node', {
      _element_id: '4:x:0',
      _labels: ['Person'],
      _properties: { name: typed('String', 'Ann'), big: typed('Integer', '9007199254740993') },
    });
    expect(fromTyped(node)).toEqual({
      kind: 'json',
      text: '{"elementId":"4:x:0","labels":["Person"],"properties":{"name":"Ann","big":9007199254740993}}',
    });
    const rel = typed('Relationship', {
      _element_id: '5:x:0',
      _start_node_element_id: '4:x:0',
      _end_node_element_id: '4:x:1',
      _type: 'KNOWS',
      _properties: { since: typed('Integer', '2020') },
    });
    expect(fromTyped(rel)).toEqual({
      kind: 'json',
      text: '{"elementId":"5:x:0","type":"KNOWS","from":"4:x:0","to":"4:x:1","properties":{"since":2020}}',
    });
    expect(
      JSON.parse((fromTyped(typed('Path', [node, rel, node])) as { text: string }).text),
    ).toHaveLength(3);
  });
});

describe('jsonText', () => {
  it('writes every kind of value as JSON', () => {
    expect(jsonText(typed('Boolean', true))).toBe('true');
    expect(jsonText(typed('Boolean', false))).toBe('false');
    expect(jsonText(typed('Null', null))).toBe('null');
    expect(jsonText(undefined)).toBe('null');
    expect(jsonText(typed('String', 'a"b'))).toBe('"a\\"b"');
    expect(jsonText(typed('Integer', '9007199254740993'))).toBe('9007199254740993');
    expect(jsonText(typed('Integer', 'x'))).toBe('"x"');
    expect(jsonText(typed('Float', '0.5'))).toBe('0.5');
    expect(jsonText(typed('Float', 'NaN'))).toBe('"NaN"');
    expect(jsonText(typed('Date', '2020-01-01'))).toBe('"2020-01-01"');
    expect(jsonText(typed('List', 'oops'))).toBe('[]');
    expect(jsonText(typed('Map', 'oops'))).toBe('{}');
    expect(jsonText(typed('Node', 'oops'))).toBe('{"elementId":null,"labels":[],"properties":{}}');
    expect(jsonText(typed('Relationship', null))).toBe(
      '{"elementId":null,"type":null,"from":null,"to":null,"properties":{}}',
    );
    expect(jsonText(typed('Path', null))).toBe('[]');
  });
});

describe('typeName', () => {
  it('names the type of a value, when it has one', () => {
    expect(typeName(typed('Integer', '1'))).toBe('integer');
    expect(typeName(typed('OffsetDateTime', 'x'))).toBe('offsetdatetime');
    expect(typeName(typed('Null', null))).toBeUndefined();
    expect(typeName(undefined)).toBeUndefined();
  });
});

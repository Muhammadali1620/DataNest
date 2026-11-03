import { describe, expect, it } from 'vitest';
import { SchemaRegistry, type RegistryFetch } from '../../../../src/drivers/kafka/registry';
import { framed, pbBytes, pbVarint } from '../../../helpers/wire-encoders';

interface Entry {
  schema: string;
  schemaType?: string;
  references?: { name: unknown; subject: string; version: number }[];
}

/** A registry that knows ids and also subjects with versions, like a Confluent one. */
function referencingRegistry(
  ids: Record<number, Entry>,
  subjects: Record<string, Entry>,
): { fetcher: RegistryFetch; urls: string[] } {
  const urls: string[] = [];
  const fetcher: RegistryFetch = (url) => {
    urls.push(url);
    const bySubject = /\/subjects\/([^/]+)\/versions\/(\d+)$/u.exec(url);
    const found =
      bySubject === null
        ? ids[Number(url.split('/').pop())]
        : subjects[`${decodeURIComponent(bySubject[1] ?? '')}/${bySubject[2] ?? ''}`];
    return Promise.resolve(
      found === undefined
        ? { ok: false, status: 404, json: () => Promise.resolve({}) }
        : { ok: true, status: 200, json: () => Promise.resolve(found) },
    );
  };
  return { fetcher, urls };
}

const textOf = (bytes: Uint8Array | undefined): unknown =>
  bytes === undefined ? undefined : JSON.parse(Buffer.from(bytes).toString('utf8'));

const MONEY =
  'syntax = "proto3"; package common; message Money { string cur = 1; int64 units = 2; }';
const ORDER = [
  'syntax = "proto3"; package shop;',
  'import "common.proto"; import "google/protobuf/timestamp.proto";',
  'message Order { common.Money price = 1; google.protobuf.Timestamp at = 2; string note = 3; }',
].join('\n');
const ZERO = Buffer.from([0]);

describe('Protobuf references (V13.39)', () => {
  it('decodes a field of an imported type that the registry lists as a reference', async () => {
    const { fetcher, urls } = referencingRegistry(
      {
        5: {
          schema: ORDER,
          schemaType: 'PROTOBUF',
          references: [{ name: 'common.proto', subject: 'common', version: 1 }],
        },
      },
      { 'common/1': { schema: MONEY, schemaType: 'PROTOBUF' } },
    );
    const registry = new SchemaRegistry('http://r', fetcher);
    const price = Buffer.concat([pbBytes(1, 'EUR'), pbVarint(2, 12)]);
    const at = pbVarint(1, 1700000000);
    const out = await registry.decode(
      framed(5, ZERO, pbBytes(1, price), pbBytes(2, at), pbBytes(3, 'hi')),
    );
    expect(textOf(out?.bytes)).toEqual({
      price: { cur: 'EUR', units: 12 },
      at: { seconds: 1700000000 },
      note: 'hi',
    });
    expect(urls).toContain('http://r/subjects/common/versions/1');
  });

  it('knows the well-known types without asking the registry for them', async () => {
    const name = 'google/protobuf/duration.proto';
    const { fetcher, urls } = referencingRegistry(
      {
        6: {
          schema:
            'syntax = "proto3"; import "google/protobuf/duration.proto"; message T { google.protobuf.Duration d = 1; }',
          schemaType: 'PROTOBUF',
          references: [{ name, subject: name, version: 1 }],
        },
      },
      {},
    );
    const registry = new SchemaRegistry('http://r', fetcher);
    const out = await registry.decode(
      framed(6, ZERO, pbBytes(1, Buffer.concat([pbVarint(1, 3), pbVarint(2, 500)]))),
    );
    expect(textOf(out?.bytes)).toEqual({ d: { seconds: 3, nanos: 500 } });
    expect(urls).toEqual(['http://r/schemas/ids/6']);
  });

  it('follows references of references and survives a loop', async () => {
    const { fetcher } = referencingRegistry(
      {
        7: {
          schema: 'syntax = "proto3"; import "a.proto"; message T { a.A a = 1; }',
          schemaType: 'PROTOBUF',
          references: [{ name: 'a.proto', subject: 'a', version: 1 }],
        },
      },
      {
        'a/1': {
          schema: 'syntax = "proto3"; package a; import "b.proto"; message A { b.B b = 1; }',
          schemaType: 'PROTOBUF',
          references: [
            { name: 'b.proto', subject: 'b', version: 1 },
            { name: 'a.proto', subject: 'a', version: 1 },
          ],
        },
        'b/1': {
          schema: 'syntax = "proto3"; package b; message B { string s = 1; }',
          schemaType: 'PROTOBUF',
          references: [{ name: 'a.proto', subject: 'a', version: 1 }],
        },
      },
    );
    const registry = new SchemaRegistry('http://r', fetcher);
    const inner = pbBytes(1, pbBytes(1, 'deep'));
    const out = await registry.decode(framed(7, ZERO, pbBytes(1, inner)));
    expect(textOf(out?.bytes)).toEqual({ a: { b: { s: 'deep' } } });
  });

  it('decodes the rest when a reference cannot be read', async () => {
    const { fetcher } = referencingRegistry(
      {
        8: {
          schema: ORDER,
          schemaType: 'PROTOBUF',
          references: [{ name: 'common.proto', subject: 'gone', version: 3 }],
        },
      },
      {},
    );
    const registry = new SchemaRegistry('http://r', fetcher);
    const out = await registry.decode(
      framed(8, ZERO, pbBytes(1, pbBytes(1, 'EUR')), pbBytes(3, 'hi')),
    );
    const parsed = textOf(out?.bytes) as Record<string, unknown>;
    expect(parsed.note).toBe('hi');
    expect(parsed.price).toBeDefined();
  });

  it('keeps the own type of the schema when an import has a type of the same name', async () => {
    const { fetcher } = referencingRegistry(
      {
        9: {
          schema:
            'syntax = "proto3"; package p; import "x.proto"; message M { p.K k = 1; } message K { string own = 1; }',
          schemaType: 'PROTOBUF',
          references: [{ name: 'x.proto', subject: 'x', version: 1 }],
        },
      },
      {
        'x/1': {
          schema: 'syntax = "proto3"; package p; message K { string other = 1; }',
          schemaType: 'PROTOBUF',
        },
      },
    );
    const registry = new SchemaRegistry('http://r', fetcher);
    const out = await registry.decode(framed(9, ZERO, pbBytes(1, pbBytes(1, 'v'))));
    expect(textOf(out?.bytes)).toEqual({ k: { own: 'v' } });
  });

  it('ignores a reference that is not well formed and one that is not Protobuf', async () => {
    const { fetcher } = referencingRegistry(
      {
        10: {
          schema: 'syntax = "proto3"; message M { string s = 1; }',
          schemaType: 'PROTOBUF',
          references: [
            { name: 1, subject: 's', version: 1 },
            { name: 'avro', subject: 'av', version: 1 },
          ],
        },
      },
      { 'av/1': { schema: '{"type":"string"}' } },
    );
    const registry = new SchemaRegistry('http://r', fetcher);
    const out = await registry.decode(framed(10, ZERO, pbBytes(1, 'ok')));
    expect(textOf(out?.bytes)).toEqual({ s: 'ok' });
  });
});

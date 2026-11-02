import { describe, expect, it } from 'vitest';
import {
  etcdKeyProtocol,
  etcdKeyStateSchema,
  leaseSchema,
} from '../../../../src/shared/protocols/etcd-key';

const state = {
  key: { text: '/a' },
  connectionName: 'c',
  readOnly: false,
  exists: true,
  value: { text: 'v' },
  size: 1,
  modRevision: '5',
  createRevision: '4',
  version: 2,
  lease: null,
};

describe('the etcd key page state', () => {
  it('accepts a key with and without a lease', () => {
    expect(etcdKeyStateSchema.parse(state)).toMatchObject({ exists: true });
    expect(
      etcdKeyStateSchema.parse({
        ...state,
        lease: { id: '7587862219395031808', ttl: 5, grantedTtl: 10 },
        conflict: true,
      }),
    ).toMatchObject({ conflict: true });
    expect(etcdKeyStateSchema.parse({ ...state, exists: false, value: undefined })).toBeDefined();
  });

  it('refuses a state that is not whole', () => {
    expect(() => etcdKeyStateSchema.parse({ ...state, modRevision: 5 })).toThrow();
    expect(() => etcdKeyStateSchema.parse({ ...state, size: -1 })).toThrow();
    expect(() => etcdKeyStateSchema.parse({ ...state, lease: undefined })).toThrow();
    expect(() => etcdKeyStateSchema.parse({ ...state, version: 1.5 })).toThrow();
  });

  it('keeps a lease id as text of at most 24 characters', () => {
    expect(() => leaseSchema.parse({ id: 1, ttl: 1, grantedTtl: 1 })).toThrow();
    expect(() => leaseSchema.parse({ id: '1'.repeat(25), ttl: 1, grantedTtl: 1 })).toThrow();
    expect(leaseSchema.parse({ id: '1'.repeat(24), ttl: -1, grantedTtl: 0 })).toBeDefined();
  });
});

describe('the etcd key page requests', () => {
  const { requests } = etcdKeyProtocol.host;

  it('takes a save with the revision the page read and, on purpose, overwrite', () => {
    expect(requests.save.params.parse({ value: { text: 'x' }, modRevision: '5' })).toBeDefined();
    expect(
      requests.save.params.parse({ value: { text: 'x' }, modRevision: '0', overwrite: true }),
    ).toMatchObject({ overwrite: true });
    expect(() => requests.save.params.parse({ value: { text: 'x' } })).toThrow();
    expect(() => requests.save.params.parse({ modRevision: '5' })).toThrow();
  });

  it('takes a lease by seconds or by id, and refuses seconds below one', () => {
    expect(requests.attachLease.params.parse({ ttl: 30 })).toEqual({ ttl: 30 });
    expect(requests.attachLease.params.parse({ id: '42' })).toEqual({ id: '42' });
    expect(() => requests.attachLease.params.parse({ ttl: 0 })).toThrow();
    expect(() => requests.attachLease.params.parse({ ttl: 1.5 })).toThrow();
  });

  it('answers what was done', () => {
    expect(requests.save.result.parse({ saved: false })).toEqual({ saved: false });
    expect(requests.revokeLease.result.parse({ revoked: true })).toEqual({ revoked: true });
    expect(requests.deleteKey.result.parse({ deleted: true })).toEqual({ deleted: true });
    expect(() => requests.save.result.parse({})).toThrow();
  });

  it('sends the state to the page', () => {
    expect(etcdKeyProtocol.webview.events.state.parse(state)).toBeDefined();
    expect(etcdKeyProtocol.host.events.ready.parse({})).toEqual({});
  });
});

describe('the etcd key page: watching', () => {
  const event = {
    at: 1_700_000_000_000,
    type: 'put',
    key: '/a',
    revision: '7',
    size: 3,
    preview: 'abc',
  };

  it('takes a state that is watching, with the changes it saw and a notice', () => {
    expect(
      etcdKeyStateSchema.parse({
        ...state,
        watching: true,
        watchPrefix: true,
        events: [event, { ...event, type: 'delete', size: 0, preview: '' }],
        watchNotice: 'Watching stopped: gone',
      }),
    ).toMatchObject({ watching: true, events: [{ type: 'put' }, { type: 'delete' }] });
  });

  it('refuses a change that is not whole, of another kind, or too long', () => {
    for (const bad of [
      { ...event, type: 'update' },
      { ...event, revision: 7 },
      { ...event, size: -1 },
      { ...event, at: 1.5 },
      { ...event, preview: 'x'.repeat(301) },
      { ...event, key: undefined },
    ]) {
      expect(() => etcdKeyStateSchema.parse({ ...state, events: [bad] })).toThrow();
    }
    expect(() =>
      etcdKeyStateSchema.parse({ ...state, events: Array.from({ length: 201 }, () => event) }),
    ).toThrow();
  });

  it('takes the request to watch, with or without the keys below, and to clear', () => {
    const { requests } = etcdKeyProtocol.host;
    expect(requests.watch.params.parse({ on: true })).toEqual({ on: true });
    expect(requests.watch.params.parse({ on: false, prefix: true })).toEqual({
      on: false,
      prefix: true,
    });
    expect(() => requests.watch.params.parse({})).toThrow();
    expect(() => requests.watch.params.parse({ on: 'yes' })).toThrow();
    expect(requests.clearEvents.params.parse({})).toBeDefined();
  });
});

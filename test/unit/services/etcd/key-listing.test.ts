import { beforeEach, describe, expect, it } from 'vitest';
import {
  listPage,
  findKeys,
  joinKey,
  type ListEntry,
} from '../../../../src/services/etcd/key-listing';
import { grantLease } from '../../../../src/services/etcd/etcd-client';
import { redisKeyBytes } from '../../../../src/shared/redis-key';
import { FakeEtcd } from '../../../helpers/fake-etcd';

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

let etcd: FakeEtcd;

beforeEach(() => {
  etcd = new FakeEtcd();
});

/** `app/ 4`, `readme`: a folder with its count, or a key. */
function outline(entries: readonly ListEntry[]): string[] {
  return entries.map((entry) =>
    entry.kind === 'folder' ? `${entry.label}/ ${entry.count ?? '?'}` : entry.label,
  );
}

function reads(): number {
  return etcd.calls.filter((path) => path === 'kv/range').length;
}

describe('listPage', () => {
  beforeEach(() => {
    for (const name of [
      '/t/readme',
      '/t/app/one',
      '/t/app/two',
      '/t/app/deep/a',
      '/t/app/deep/b',
      '/t/db/host',
      '/t/zeta',
      '/other/x',
    ]) {
      etcd.seed(name);
    }
  });

  it('folds the keys of one level into folders and keys, in key order', async () => {
    const page = await listPage(etcd, text('/t/'), undefined, 50);
    expect(outline(page.entries)).toEqual(['app/ 4', 'db/ 1', 'readme', 'zeta']);
    expect(page.next).toBeUndefined();
  });

  it('goes one level down', async () => {
    const page = await listPage(etcd, text('/t/app/'), undefined, 50);
    expect(outline(page.entries)).toEqual(['deep/ 2', 'one', 'two']);
  });

  it('gives each folder the prefix its keys start with', async () => {
    const page = await listPage(etcd, text('/t/'), undefined, 50);
    const app = page.entries[0];
    expect(app?.kind === 'folder' ? app.prefix.text : undefined).toBe('/t/app/');
    expect(app?.kind === 'folder' ? redisKeyBytes(app.prefix) : undefined).toEqual(text('/t/app/'));
  });

  it('gives each key its whole name and the name inside the folder', async () => {
    const page = await listPage(etcd, text('/t/'), undefined, 50);
    const readme = page.entries.find((entry) => entry.kind === 'key' && entry.label === 'readme');
    expect(readme?.kind === 'key' ? readme.key.text : undefined).toBe('/t/readme');
  });

  it('lists the top of the key space: a name with a leading slash is in the folder "/"', async () => {
    const page = await listPage(etcd, new Uint8Array(), undefined, 50);
    expect(outline(page.entries)).toEqual(['/ 8']);
    const slash = page.entries[0];
    expect(slash?.kind === 'folder' ? slash.prefix.text : undefined).toBe('/');
  });

  it('lists names without a slash as keys at the top', async () => {
    etcd.seed('plain');
    etcd.seed('also/folder');
    const page = await listPage(etcd, new Uint8Array(), undefined, 50);
    expect(outline(page.entries)).toEqual(['/ 8', 'also/ 1', 'plain']);
  });

  it('shows a key that is also the name of a folder next to it', async () => {
    etcd.seed('/t/app');
    const page = await listPage(etcd, text('/t/'), undefined, 50);
    // In key order: "/t/app" comes before everything that starts with "/t/app/".
    expect(outline(page.entries)).toEqual(['app', 'app/ 4', 'db/ 1', 'readme', 'zeta']);
  });

  it('shows the key that is the folder itself by its whole name', async () => {
    etcd.seed('/t/app/');
    const page = await listPage(etcd, text('/t/app/'), undefined, 50);
    expect(page.entries[0]).toMatchObject({ kind: 'key', label: '/t/app/' });
  });

  it('is empty for a folder with nothing in it', async () => {
    const page = await listPage(etcd, text('/nothing/'), undefined, 50);
    expect(page.entries).toEqual([]);
    expect(page.next).toBeUndefined();
  });

  it('marks a key that dies with a lease', async () => {
    const lease = await grantLease(etcd, 60);
    await etcd.call('kv/put', {
      key: Buffer.from('/t/leased').toString('base64'),
      lease: lease.id,
    });
    const page = await listPage(etcd, text('/t/'), undefined, 50);
    const leased = page.entries.find((entry) => entry.kind === 'key' && entry.label === 'leased');
    expect(leased?.kind === 'key' ? leased.leased : undefined).toBe(true);
    const plain = page.entries.find((entry) => entry.kind === 'key' && entry.label === 'readme');
    expect(plain?.kind === 'key' ? plain.leased : undefined).toBe(false);
  });

  it('names a key that is not text with escapes and finds it again by its bytes', async () => {
    const name = Uint8Array.from([...text('/t/b/'), 0xff, 0x41]);
    await etcd.call('kv/put', { key: Buffer.from(name).toString('base64') });
    const page = await listPage(etcd, text('/t/b/'), undefined, 50);
    const key = page.entries[0];
    expect(key?.kind === 'key' ? key.label : undefined).toBe('\\xffA');
    expect(key?.kind === 'key' ? Array.from(redisKeyBytes(key.key)) : []).toEqual(Array.from(name));
  });

  it('does not count folders beyond the first sixty', async () => {
    for (let index = 0; index < 70; index += 1) {
      etcd.seed(`/many/f${String(index).padStart(2, '0')}/k`);
    }
    const page = await listPage(etcd, text('/many/'), undefined, 500);
    const counted = page.entries.filter((entry) => entry.kind === 'folder' && entry.count === 1);
    expect(page.entries).toHaveLength(70);
    expect(counted).toHaveLength(60);
  });

  it('leaves a folder without its number when counting fails, and lists it still', async () => {
    const original = etcd.call;
    etcd.call = (path, body, options) => {
      if (body.count_only === true) {
        return Promise.reject(new Error('count failed'));
      }
      return original(path, body, options);
    };
    const page = await listPage(etcd, text('/t/'), undefined, 50);
    expect(outline(page.entries)).toEqual(['app/ ?', 'db/ ?', 'readme', 'zeta']);
  });
});

describe('listPage on a big store', () => {
  function seedMany(prefix: string, count: number): void {
    for (let index = 0; index < count; index += 1) {
      etcd.seed(`${prefix}${String(index).padStart(5, '0')}`);
    }
  }

  it('jumps over the rest of a folder that is bigger than one read', async () => {
    etcd.seed('/b/first');
    seedMany('/b/pile/k', 2600);
    etcd.seed('/b/zz');
    const page = await listPage(etcd, text('/b/'), undefined, 50);
    expect(outline(page.entries)).toEqual(['first', 'pile/ 2600', 'zz']);
    // One read brings the first key and the first 999 of the pile; a jump past the pile
    // brings the last key; and one count asks the pile's size. Not 2600 keys' worth.
    expect(reads()).toBe(2 + 1);
  });

  it('stops after a page and goes on from where it stopped', async () => {
    seedMany('/p/', 3500);
    const first = await listPage(etcd, text('/p/'), undefined, 1000);
    expect(first.entries).toHaveLength(1000);
    expect(first.next).toBeDefined();
    const second = await listPage(etcd, text('/p/'), first.next, 1000);
    expect(second.entries.length).toBeGreaterThan(0);
    const names = [...first.entries, ...second.entries].map((entry) => entry.label);
    expect(new Set(names).size).toBe(names.length);
    expect(names[1000]).toBe('01000');
    // Pages follow each other without a gap or a repeat, to the end.
    let all = [...first.entries, ...second.entries];
    let next = second.next;
    while (next !== undefined) {
      const page = await listPage(etcd, text('/p/'), next, 1000);
      all = [...all, ...page.entries];
      next = page.next;
    }
    expect(all.map((entry) => entry.label)).toEqual(
      Array.from({ length: 3500 }, (_, index) => String(index).padStart(5, '0')),
    );
  });

  it('continues after a folder it stopped inside, without showing it twice', async () => {
    seedMany('/q/dir/k', 2500);
    etcd.seed('/q/zz');
    const first = await listPage(etcd, text('/q/'), undefined, 1);
    expect(outline(first.entries)).toEqual(['dir/ 2500']);
    expect(first.next).toBeDefined();
    const second = await listPage(etcd, text('/q/'), first.next, 1);
    expect(outline(second.entries)).toEqual(['zz']);
    expect(second.next).toBeUndefined();
  });

  it('ends a page of nothing but big folders instead of reading for ever', async () => {
    for (let folder = 0; folder < 30; folder += 1) {
      seedMany(`/g/f${String(folder).padStart(2, '0')}/k`, 1001);
    }
    const page = await listPage(etcd, text('/g/'), undefined, 1_000_000);
    // Twenty reads at most, each past one more folder; the rest is the next page.
    expect(page.entries.length).toBeLessThanOrEqual(21);
    expect(page.next).toBeDefined();
    expect(reads()).toBeLessThanOrEqual(20 + 21);
  });
});

describe('findKeys and joinKey', () => {
  it('lists the keys that start with a prefix, names only', async () => {
    for (const name of ['/f/a', '/f/b', '/g/c']) {
      etcd.seed(name, 'value');
    }
    const found = await findKeys(etcd, text('/f/'), 10);
    expect(found.keys.map((key) => key.text)).toEqual(['/f/a', '/f/b']);
    expect(found.more).toBe(false);
    expect(etcd.bodies.at(-1)).toMatchObject({ keys_only: true });
  });

  it('says when there are more than it was asked for', async () => {
    for (let index = 0; index < 5; index += 1) {
      etcd.seed(`/h/${index}`);
    }
    const found = await findKeys(etcd, text('/h/'), 3);
    expect(found.keys).toHaveLength(3);
    expect(found.more).toBe(true);
  });

  it('finds everything from an empty prefix', async () => {
    etcd.seed('a');
    etcd.seed('b');
    expect((await findKeys(etcd, new Uint8Array(), 10)).keys).toHaveLength(2);
  });

  it('joins a folder and a name', () => {
    expect(joinKey(text('/f/'), text('name'))).toEqual(text('/f/name'));
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import { addRole, addUser, grantRole } from '../../../../src/services/etcd/etcd-auth';
import { prefixEnd } from '../../../../src/services/etcd/etcd-codec';
import type { ConnectionConfig } from '../../../../src/shared/connection';
import {
  type AccessPickItem,
  etcdAccessHandler,
  type EtcdAccessUi,
} from '../../../../src/vscode/etcd/etcd-access-commands';
import type { TreeNode } from '../../../../src/vscode/tree/nodes';
import { FakeEtcd } from '../../../helpers/fake-etcd';

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

const etcdConfig = (id: string, extra: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
  id,
  name: `etcd ${id}`,
  driver: 'etcd',
  host: 'h',
  ...extra,
});

interface Shown {
  title: string;
  placeHolder: string | undefined;
  labels: string[];
}

let etcd: FakeEtcd;
let configs: ConnectionConfig[];
/** The answers the user gives, in the order the dialogs ask; a function picks by label. */
let picks: (string | undefined | ((items: readonly AccessPickItem<unknown>[]) => unknown))[];
let inputs: (string | undefined)[];
let confirmAnswers: boolean[];
let shown: Shown[];
let infos: string[];
let confirms: { message: string; detail: string | undefined }[];
let inputOptions: {
  prompt: string;
  password?: boolean;
  validate?: (v: string) => string | undefined;
}[];
let pickedConnection: string | undefined;

function handler() {
  const ui: EtcdAccessUi = {
    input: (options) => {
      inputOptions.push({
        prompt: options.prompt,
        ...(options.password === true ? { password: true } : {}),
        ...(options.validate === undefined ? {} : { validate: options.validate }),
      });
      return Promise.resolve(inputs.shift());
    },
    pickKey: () => Promise.resolve(undefined),
    confirm: (message, detail) => {
      confirms.push({ message, detail });
      return Promise.resolve(confirmAnswers.shift() ?? false);
    },
    pickConnection: () => Promise.resolve(pickedConnection),
    info: (message) => {
      infos.push(message);
    },
    pick: <T>(options: {
      title: string;
      placeHolder?: string;
      items: readonly AccessPickItem<T>[];
    }): Promise<T | undefined> => {
      shown.push({
        title: options.title,
        placeHolder: options.placeHolder,
        labels: options.items.map((item) => item.label),
      });
      const answer = picks.shift();
      if (typeof answer === 'function') {
        return Promise.resolve(answer(options.items) as T | undefined);
      }
      const item = options.items.find((one) => one.label === answer);
      if (answer !== undefined && item === undefined) {
        throw new Error(
          `No item "${answer}" among ${options.items.map((i) => i.label).join(', ')}`,
        );
      }
      return Promise.resolve(item?.value);
    },
  };
  return etcdAccessHandler({
    store: {
      get: (id) => configs.find((config) => config.id === id),
      list: () => configs,
    },
    session: () => Promise.resolve(etcd),
    ui,
    texts: { noEtcd: 'No etcd', readOnly: 'Read-only' },
  });
}

const node = (connectionId: string): TreeNode => ({ kind: 'connection', connectionId });

beforeEach(() => {
  etcd = new FakeEtcd();
  configs = [etcdConfig('c1')];
  picks = [];
  inputs = [];
  confirmAnswers = [];
  shown = [];
  infos = [];
  confirms = [];
  inputOptions = [];
  pickedConnection = undefined;
});

describe('Users and Roles: the main list', () => {
  it('shows the users and roles with the two ways to add, and ends when the user backs out', async () => {
    await addUser(etcd, 'amy', 'pw');
    await addRole(etcd, 'admins');
    picks = [undefined];
    await handler()(node('c1'));
    expect(shown).toHaveLength(1);
    expect(shown[0]?.title).toBe('Users and Roles');
    expect(shown[0]?.placeHolder).toBe('1 users, 1 roles');
    expect(shown[0]?.labels).toEqual(['Add a User…', 'Add a Role…', 'amy', 'admins']);
  });

  it('is shown for an empty cluster as well', async () => {
    picks = [undefined];
    await handler()(node('c1'));
    expect(shown[0]?.labels).toEqual(['Add a User…', 'Add a Role…']);
  });

  it('picks the only etcd connection when it is run from the palette', async () => {
    configs = [etcdConfig('c1'), { id: 'p', name: 'pg', driver: 'postgres', host: 'h' }];
    picks = [undefined];
    await handler()(undefined);
    expect(shown).toHaveLength(1);
  });

  it('asks which connection when there are several, and stops when none is picked', async () => {
    configs = [etcdConfig('c1'), etcdConfig('c2')];
    await handler()(undefined);
    expect(shown).toHaveLength(0);
    pickedConnection = 'c2';
    picks = [undefined];
    await handler()(undefined);
    expect(shown).toHaveLength(1);
  });

  it('refuses a connection that is not etcd, and says so when there is none', async () => {
    configs = [{ id: 'p', name: 'pg', driver: 'postgres', host: 'h' }];
    await expect(handler()(node('p'))).rejects.toMatchObject({ code: 'unsupported' });
    await expect(handler()(undefined)).rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('Users and Roles: adding', () => {
  it('adds a user with a password, hiding what is typed for it', async () => {
    inputs = ['amy', 'secret'];
    picks = ['Add a User…', undefined];
    await handler()(node('c1'));
    expect(etcd.accountBook.get('amy')?.password).toBe('secret');
    expect(infos).toEqual(['The user "amy" was added']);
    expect(inputOptions.map((option) => option.password === true)).toEqual([false, true]);
    // The list is read again and shows the new user.
    expect(shown[1]?.labels).toContain('amy');
  });

  it('checks a name and a password as they are typed', async () => {
    inputs = ['amy', 'pw'];
    picks = ['Add a User…', undefined];
    await handler()(node('c1'));
    const [name, password] = inputOptions;
    expect(name?.validate?.('')).toBe('A name is needed');
    expect(name?.validate?.('x'.repeat(257))).toBe('A name has up to 256 characters');
    expect(name?.validate?.('amy')).toBeUndefined();
    expect(password?.validate?.('')).toBe('A password is needed');
    expect(password?.validate?.('x')).toBeUndefined();
  });

  it('adds nothing when the user backs out of the name or the password', async () => {
    inputs = [undefined];
    picks = ['Add a User…', 'Add a User…', undefined];
    await handler()(node('c1'));
    inputs = ['amy', undefined];
    await handler()(node('c1'));
    expect(etcd.accountBook.size).toBe(0);
  });

  it('adds a role', async () => {
    inputs = ['admins'];
    picks = ['Add a Role…', undefined];
    await handler()(node('c1'));
    expect([...etcd.roleBook.keys()]).toEqual(['admins']);
    expect(infos).toEqual(['The role "admins" was added']);
  });

  it('adds no role when the user backs out, and shows what the cluster refuses', async () => {
    inputs = [undefined];
    picks = ['Add a Role…', undefined];
    await handler()(node('c1'));
    expect(etcd.roleBook.size).toBe(0);
    await addRole(etcd, 'r');
    inputs = ['r'];
    picks = ['Add a Role…'];
    await expect(handler()(node('c1'))).rejects.toMatchObject({ code: 'constraint' });
  });
});

describe('Users and Roles: a user', () => {
  beforeEach(async () => {
    await addUser(etcd, 'amy', 'pw');
    await addRole(etcd, 'writers');
    await addRole(etcd, 'admins');
  });

  it('grants a role that is not granted yet, and offers a revoke once there is one', async () => {
    picks = ['amy', 'Grant a Role…', 'writers', undefined, undefined];
    await handler()(node('c1'));
    expect(etcd.accountBook.get('amy')?.roles).toEqual(new Set(['writers']));
    const roleLists = shown.filter((one) => one.title === 'Grant a role to "amy"');
    expect(roleLists[0]?.labels).toEqual(['admins', 'writers']);
    const menus = shown.filter((one) => one.title === 'User "amy"');
    expect(menus[0]?.labels).not.toContain('Revoke a Role…');
    expect(menus[0]?.placeHolder).toBe('No roles');
    expect(menus[1]?.labels).toContain('Revoke a Role…');
    expect(menus[1]?.placeHolder).toBe('Roles: writers');
  });

  it('says every role is granted when there is none left to grant', async () => {
    await grantRole(etcd, 'amy', 'writers');
    await grantRole(etcd, 'amy', 'admins');
    picks = ['amy', 'Grant a Role…', undefined, undefined, undefined];
    await handler()(node('c1'));
    const list = shown.find((one) => one.title === 'Grant a role to "amy"');
    expect(list?.placeHolder).toBe('Every role is granted already');
    expect(list?.labels).toEqual([]);
  });

  it('revokes a role', async () => {
    await grantRole(etcd, 'amy', 'writers');
    picks = ['amy', 'Revoke a Role…', 'writers', undefined, undefined];
    await handler()(node('c1'));
    expect(etcd.accountBook.get('amy')?.roles.size).toBe(0);
  });

  it('changes the password', async () => {
    inputs = ['newpass'];
    picks = ['amy', 'Change the Password…', undefined, undefined];
    await handler()(node('c1'));
    expect(etcd.accountBook.get('amy')?.password).toBe('newpass');
    expect(infos).toEqual(['The password of "amy" was changed']);
    expect(inputOptions[0]).toMatchObject({ password: true });
  });

  it('keeps the password when the user backs out', async () => {
    inputs = [undefined];
    picks = ['amy', 'Change the Password…', undefined, undefined];
    await handler()(node('c1'));
    expect(etcd.accountBook.get('amy')?.password).toBe('pw');
    expect(infos).toEqual([]);
  });

  it('deletes the user only after the question is answered yes, and leaves the menu', async () => {
    confirmAnswers = [false, true];
    picks = ['amy', 'Delete the User', 'Delete the User', undefined];
    await handler()(node('c1'));
    expect(confirms).toHaveLength(2);
    expect(confirms[0]?.message).toBe('Delete the user "amy"?');
    expect(etcd.accountBook.size).toBe(0);
    // The menu of the user closed itself: the next list is the main one again.
    expect(shown.at(-1)?.title).toBe('Users and Roles');
  });

  it('warns that a user with the root role may be the only way in', async () => {
    await addRole(etcd, 'root');
    await grantRole(etcd, 'amy', 'root');
    confirmAnswers = [false];
    picks = ['amy', 'Delete the User', undefined, undefined];
    await handler()(node('c1'));
    expect(confirms[0]?.detail).toContain('root role');
  });
});

describe('Users and Roles: a role', () => {
  beforeEach(async () => {
    await addRole(etcd, 'r');
  });

  it('grants a read permission on a prefix', async () => {
    inputs = ['/app/'];
    picks = ['r', 'Grant a Permission…', 'Read', 'Keys that start with…', undefined, undefined];
    await handler()(node('c1'));
    expect(etcd.roleBook.get('r')).toEqual([
      {
        key: Buffer.from('/app/').toString('base64'),
        range_end: Buffer.from(prefixEnd(text('/app/'))).toString('base64'),
      },
    ]);
    // The role page lists what it has now, in words.
    expect(shown.filter((one) => one.title === 'Role "r"').at(-1)?.labels).toContain(
      'read: /app/*',
    );
  });

  it('grants write on one key, read and write on a range, and everything on all keys', async () => {
    inputs = ['/one', '/a', '/m'];
    picks = [
      'r',
      'Grant a Permission…',
      'Write',
      'One key',
      'Grant a Permission…',
      'Read and write',
      'A range of keys…',
      'Grant a Permission…',
      'Read',
      'All keys',
      undefined,
      undefined,
    ];
    await handler()(node('c1'));
    const labels = shown.filter((one) => one.title === 'Role "r"').at(-1)?.labels;
    expect(labels).toEqual(
      expect.arrayContaining(['write: /one', 'readwrite: /a … /m', 'read: *']),
    );
  });

  it('grants nothing when the user backs out at any step', async () => {
    picks = [
      'r',
      'Grant a Permission…',
      undefined,
      'Grant a Permission…',
      'Read',
      undefined,
      'Grant a Permission…',
      'Read',
      'One key',
      'Grant a Permission…',
      'Read',
      'A range of keys…',
      undefined,
    ];
    inputs = [undefined, '/a', undefined];
    await handler()(node('c1'));
    expect(etcd.roleBook.get('r')).toEqual([]);
  });

  it('asks for a key that is not empty, for the beginning, the range and its end', async () => {
    inputs = ['/a', '/b'];
    picks = ['r', 'Grant a Permission…', 'Read', 'A range of keys…', undefined, undefined];
    await handler()(node('c1'));
    expect(inputOptions.map((option) => option.prompt)).toEqual([
      'The first key of the range',
      'The key after the last one of the range (it is not included)',
    ]);
    expect(inputOptions[0]?.validate?.('')).toBe('A key is needed');
    expect(inputOptions[1]?.validate?.('x')).toBeUndefined();
  });

  it('revokes a permission picked from the list, and offers no revoke without one', async () => {
    await etcd.call('auth/role/grant', {
      name: 'r',
      perm: { permType: 'WRITE', key: Buffer.from('/a').toString('base64') },
    });
    picks = ['r', 'Revoke a Permission…', (items) => items[0]?.value, undefined, undefined];
    await handler()(node('c1'));
    expect(etcd.roleBook.get('r')).toEqual([]);
    const pages = shown.filter((one) => one.title === 'Role "r"');
    expect(pages[0]?.labels).toContain('Revoke a Permission…');
    expect(pages[1]?.labels).not.toContain('Revoke a Permission…');
    expect(pages[1]?.placeHolder).toBe('No permissions');
  });

  it('deletes the role after the question, with a warning for root', async () => {
    await addRole(etcd, 'root');
    confirmAnswers = [true];
    picks = ['root', 'Delete the Role', undefined];
    await handler()(node('c1'));
    expect(confirms[0]?.detail).toContain('root role');
    expect([...etcd.roleBook.keys()]).toEqual(['r']);
    confirmAnswers = [false];
    picks = ['r', 'Delete the Role', undefined, undefined];
    await handler()(node('c1'));
    expect([...etcd.roleBook.keys()]).toEqual(['r']);
    expect(confirms[1]?.detail).toBe('Every user that has the role loses it.');
  });
});

describe('Users and Roles: read-only and production', () => {
  it('lets a read-only connection look, and refuses every change', async () => {
    configs = [etcdConfig('c1', { readOnly: true })];
    await addUser(etcd, 'amy', 'pw');
    await addRole(etcd, 'r');
    inputs = ['bob', 'pw'];
    picks = ['Add a User…'];
    await expect(handler()(node('c1'))).rejects.toMatchObject({ code: 'permission-denied' });
    picks = ['amy', undefined, undefined];
    await handler()(node('c1'));
    expect(etcd.accountBook.size).toBe(1);
    inputs = ['x'];
    picks = ['Add a Role…'];
    await expect(handler()(node('c1'))).rejects.toBeInstanceOf(DbError);
    expect(etcd.roleBook.size).toBe(1);
  });

  it('asks before a change on a production connection, and changes nothing on no', async () => {
    configs = [etcdConfig('c1', { production: true })];
    confirmAnswers = [false];
    inputs = ['admins'];
    picks = ['Add a Role…', undefined];
    await handler()(node('c1'));
    expect(confirms[0]?.message).toBe('Change access on the production connection "etcd c1"?');
    expect(etcd.roleBook.size).toBe(0);
    confirmAnswers = [true];
    inputs = ['admins'];
    picks = ['Add a Role…', undefined];
    await handler()(node('c1'));
    expect([...etcd.roleBook.keys()]).toEqual(['admins']);
  });
});

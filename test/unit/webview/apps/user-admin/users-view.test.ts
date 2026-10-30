import { describe, expect, it } from 'vitest';
import type { AdminGrant, AdminUser } from '../../../../../src/shared/protocols/user-admin';
import {
  type Features,
  filterUsers,
  type GrantForm,
  grantChange,
  grantReady,
  privilegesOf,
  revokeChange,
  sortGrants,
  targetFields,
  targetLabel,
  userKey,
  userLabel,
} from '../../../../../webview/src/apps/user-admin/users-view';

const mysql: Features = {
  hosts: true,
  tablesIn: 'database',
  passwordOptional: false,
  createOptions: [],
  lock: true,
  levels: [
    { level: 'server', privileges: ['SELECT', 'PROCESS'] },
    { level: 'table', privileges: ['SELECT'] },
    { level: 'role', privileges: [] },
  ],
};
const postgres: Features = { ...mysql, hosts: false, tablesIn: 'schema', levels: [] };

const form: GrantForm = {
  level: 'table',
  database: ' shop ',
  schema: 'ignored',
  name: 'orders',
  role: '',
  host: '%',
  privileges: ['SELECT'],
  grantable: true,
};

describe('names of accounts', () => {
  it('keys and labels accounts with and without hosts', () => {
    expect(userKey({ name: 'app', host: '%' })).not.toBe(
      userKey({ name: 'app', host: 'localhost' }),
    );
    expect(userLabel({ name: 'app', host: '%' })).toBe('app@%');
    expect(userLabel({ name: 'app' })).toBe('app');
  });

  it('filters by name, host, flags and roles', () => {
    const users: AdminUser[] = [
      { name: 'app', host: '%', login: true, flags: [], memberOf: ['readers'] },
      { name: 'old', host: 'localhost', login: true, flags: ['locked'], memberOf: [] },
    ];
    expect(filterUsers(users, 'LOCAL').map((user) => user.name)).toEqual(['old']);
    expect(filterUsers(users, 'readers').map((user) => user.name)).toEqual(['app']);
    expect(filterUsers(users, 'locked').map((user) => user.name)).toEqual(['old']);
    expect(filterUsers(users, ' ')).toHaveLength(2);
  });
});

describe('grants', () => {
  it('labels targets as people write them', () => {
    const base = { privilege: 'X', grantable: false };
    expect(targetLabel({ ...base, level: 'server' })).toBe('*');
    expect(targetLabel({ ...base, level: 'database', database: 'shop' })).toBe('shop');
    expect(targetLabel({ ...base, level: 'allTables', schema: 'public' })).toBe('public.*');
    expect(targetLabel({ ...base, level: 'table', database: 'shop', name: 'orders' })).toBe(
      'shop.orders',
    );
    expect(
      targetLabel({ ...base, level: 'table', database: 'shop', schema: 'dbo', name: 't' }),
    ).toBe('dbo.t');
    expect(targetLabel({ ...base, level: 'role', name: 'reader', host: '%' })).toBe('reader@%');
    expect(targetLabel({ ...base, level: 'role', name: 'reader' })).toBe('reader');
  });

  it('sorts by level, object and privilege', () => {
    const grants: AdminGrant[] = [
      { level: 'role', name: 'r', privilege: 'ROLE', grantable: false },
      { level: 'table', database: 'b', name: 't', privilege: 'SELECT', grantable: false },
      { level: 'server', privilege: 'PROCESS', grantable: false },
      { level: 'table', database: 'a', name: 't', privilege: 'UPDATE', grantable: false },
      { level: 'table', database: 'a', name: 't', privilege: 'INSERT', grantable: false },
    ];
    expect(
      sortGrants(grants).map((grant) => `${grant.level}:${targetLabel(grant)}:${grant.privilege}`),
    ).toEqual([
      'server:*:PROCESS',
      'table:a.t:INSERT',
      'table:a.t:UPDATE',
      'table:b.t:SELECT',
      'role:r:ROLE',
    ]);
  });

  it('asks for the fields a level needs, by where the server keeps tables', () => {
    expect(targetFields('server', mysql)).toEqual([]);
    expect(targetFields('table', mysql)).toEqual(['database', 'name']);
    expect(targetFields('table', postgres)).toEqual(['schema', 'name']);
    expect(targetFields('allTables', postgres)).toEqual(['schema']);
    expect(targetFields('role', mysql)).toEqual(['role', 'host']);
    expect(targetFields('role', postgres)).toEqual(['role']);
  });

  it('builds a grant with only the fields of its level, trimmed', () => {
    expect(grantChange({ name: 'app', host: '%' }, form, mysql)).toEqual({
      kind: 'grant',
      user: { name: 'app', host: '%' },
      target: { level: 'table', database: 'shop', name: 'orders' },
      privileges: ['SELECT'],
      grantable: true,
    });
    expect(
      grantChange(
        { name: 'app' },
        { ...form, level: 'role', role: ' readers ', host: '' },
        postgres,
      ),
    ).toEqual({
      kind: 'grant',
      user: { name: 'app' },
      target: { level: 'role', name: 'readers' },
      privileges: [],
      grantable: true,
    });
  });

  it('takes back exactly one listed grant', () => {
    expect(
      revokeChange(
        { name: 'app', host: '%' },
        {
          level: 'table',
          database: 'shop',
          name: 'orders',
          privilege: 'UPDATE',
          grantable: true,
        },
      ),
    ).toEqual({
      kind: 'revoke',
      user: { name: 'app', host: '%' },
      target: { level: 'table', database: 'shop', name: 'orders' },
      privileges: ['UPDATE'],
      grantable: true,
    });
    expect(
      revokeChange(
        { name: 'app' },
        { level: 'role', name: 'r', host: '%', privilege: 'ROLE', grantable: false },
      ).privileges,
    ).toEqual([]);
  });

  it('knows when the form is complete', () => {
    expect(grantReady(form, mysql)).toBe(true);
    expect(grantReady({ ...form, name: ' ' }, mysql)).toBe(false);
    expect(grantReady({ ...form, privileges: [] }, mysql)).toBe(false);
    expect(grantReady({ ...form, level: 'role', role: 'r', host: '' }, mysql)).toBe(true);
    expect(grantReady({ ...form, level: 'server', privileges: ['PROCESS'] }, mysql)).toBe(true);
    expect(privilegesOf(mysql, 'server')).toEqual(['SELECT', 'PROCESS']);
    expect(privilegesOf(mysql, 'schema')).toEqual([]);
  });
});

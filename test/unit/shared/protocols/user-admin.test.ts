import { describe, expect, it } from 'vitest';
import { userAdminProtocol } from '../../../../src/shared/protocols/user-admin';

describe('userAdminProtocol', () => {
  it('accepts the state, users and grants the host sends', () => {
    const state = {
      connectionName: 'Local',
      server: 'MySQL',
      features: {
        hosts: true,
        tablesIn: 'database',
        passwordOptional: false,
        createOptions: [],
        lock: true,
        levels: [{ level: 'server', privileges: ['SELECT'] }],
      },
      readOnly: false,
    };
    expect(userAdminProtocol.webview.events.state.parse(state)).toEqual(state);
    const users = {
      rows: [{ name: 'app', host: '%', login: true, flags: ['locked'], memberOf: ['r'] }],
    };
    expect(userAdminProtocol.host.requests.users.result.parse(users)).toEqual(users);
    const grants = {
      rows: [
        {
          level: 'table',
          database: 'shop',
          name: 'orders',
          privilege: 'SELECT',
          grantable: true,
          fixed: true,
        },
      ],
    };
    expect(userAdminProtocol.host.requests.grants.result.parse(grants)).toEqual(grants);
  });

  it('accepts the changes the page builds and refuses others', () => {
    const { params } = userAdminProtocol.host.requests.run;
    const grant = {
      change: {
        kind: 'grant',
        user: { name: 'app', host: '%' },
        target: { level: 'table', database: 'shop', name: 'orders' },
        privileges: ['SELECT'],
        grantable: false,
      },
    };
    expect(params.parse(grant)).toEqual(grant);
    expect(() => params.parse({ change: { kind: 'execute', user: { name: 'a' } } })).toThrow();
    expect(() =>
      params.parse({
        change: { kind: 'grant', user: { name: 'a' }, target: { level: 'cluster' } },
      }),
    ).toThrow();
    expect(() =>
      params.parse({ change: { kind: 'drop', user: { name: 'a', extra: 1 } } }),
    ).toThrow();
    expect(() =>
      params.parse({
        change: { kind: 'password', user: { name: 'a' }, password: 'x'.repeat(1001) },
      }),
    ).toThrow();
  });

  it('limits what names the page may ask for', () => {
    const { params } = userAdminProtocol.host.requests.objects;
    expect(params.parse({ kind: 'table', database: 'shop' })).toBeDefined();
    expect(() => params.parse({ kind: 'function' })).toThrow();
  });
});

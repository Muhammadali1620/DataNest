import { describe, expect, it } from 'vitest';
import {
  checkPrivilege,
  checkText,
  PASSWORD_MASK,
  privilegeList,
  required,
  type UserAdminFeatures,
  withPassword,
} from '../../../../src/services/users/user-admin';

const features: UserAdminFeatures = {
  hosts: false,
  tablesIn: 'schema',
  passwordOptional: false,
  createOptions: [],
  lock: false,
  privileges: { table: ['SELECT', 'INSERT'], role: [] },
};

describe('withPassword', () => {
  it('builds the statements to run and the same with the password hidden', () => {
    expect(withPassword('s3cret', (password) => [`SET ${password}`, 'NEXT'])).toEqual({
      statements: ['SET s3cret', 'NEXT'],
      preview: [`SET ${PASSWORD_MASK}`, 'NEXT'],
    });
  });
});

describe('checkText and required', () => {
  it('refuses empty texts, line breaks and NUL characters', () => {
    expect(() => {
      checkText('  ', 'name');
    }).toThrow('The name is empty');
    expect(() => {
      checkText('a\nb', 'name');
    }).toThrow('line break');
    expect(() => {
      checkText('a\rb', 'name');
    }).toThrow('line break');
    expect(() => {
      checkText('a\u0000b', 'password');
    }).toThrow('NUL');
    expect(() => {
      checkText('o\'neil "x" ✓', 'name');
    }).not.toThrow();
  });

  it('requires a value to be there', () => {
    expect(required('shop', 'database')).toBe('shop');
    expect(() => required(undefined, 'database')).toThrow('The database is missing');
    expect(() => required('', 'database')).toThrow('empty');
  });
});

describe('checkPrivilege', () => {
  it('takes privilege words as servers print them, nothing else', () => {
    for (const privilege of ['SELECT', 'CREATE TEMPORARY TABLES', 'AUDIT_ADMIN', 'dictGet']) {
      expect(() => {
        checkPrivilege(privilege);
      }).not.toThrow();
    }
    for (const privilege of ['', '1SELECT', 'SELECT;', "X' OR '1", 'A'.repeat(65)]) {
      expect(() => {
        checkPrivilege(privilege);
      }, privilege).toThrow('not a privilege');
    }
  });
});

describe('privilegeList', () => {
  it('joins privileges of the level, refusing others and none', () => {
    expect(
      privilegeList(features, {
        level: 'table',
        privileges: ['SELECT', 'INSERT'],
        grantable: false,
      }),
    ).toBe('SELECT, INSERT');
    expect(() =>
      privilegeList(features, { level: 'table', privileges: ['DELETE'], grantable: false }),
    ).toThrow('"DELETE" is not a privilege of this level');
    expect(() =>
      privilegeList(features, { level: 'table', privileges: [], grantable: false }),
    ).toThrow('at least one');
    expect(() =>
      privilegeList(features, { level: 'server', privileges: ['SELECT'], grantable: false }),
    ).toThrow('cannot be granted at the level "server"');
  });
});

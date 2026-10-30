import { describe, expect, it } from 'vitest';
import { readGrantLine } from '../../../../src/services/users/mysql-grants';

describe('readGrantLine', () => {
  it('reads privileges on a database, one per privilege, and the grant option apart', () => {
    expect(
      readGrantLine(
        'GRANT SELECT, INSERT, CREATE TEMPORARY TABLES ON `shop`.* TO `app`@`%` WITH GRANT OPTION',
      ),
    ).toEqual([
      { level: 'database', database: 'shop', privilege: 'SELECT', grantable: false },
      { level: 'database', database: 'shop', privilege: 'INSERT', grantable: false },
      {
        level: 'database',
        database: 'shop',
        privilege: 'CREATE TEMPORARY TABLES',
        grantable: false,
      },
      { level: 'database', database: 'shop', privilege: 'GRANT OPTION', grantable: false },
    ]);
  });

  it('skips USAGE, which grants nothing', () => {
    expect(readGrantLine("GRANT USAGE ON *.* TO 'root'@'%'")).toEqual([]);
  });

  it('reads server privileges, dynamic ones without spaces too', () => {
    expect(
      readGrantLine('GRANT APPLICATION_PASSWORD_ADMIN,AUDIT_ADMIN ON *.* TO `root`@`localhost`'),
    ).toEqual([
      { level: 'server', privilege: 'APPLICATION_PASSWORD_ADMIN', grantable: false },
      { level: 'server', privilege: 'AUDIT_ADMIN', grantable: false },
    ]);
  });

  it('reads tables with quoted names that hold quotes and dots', () => {
    expect(readGrantLine('GRANT UPDATE ON `my``db`.`a.b` TO `app`@`%`')).toEqual([
      { level: 'table', database: 'my`db', name: 'a.b', privilege: 'UPDATE', grantable: false },
    ]);
    expect(readGrantLine('GRANT DELETE ON TABLE `shop`.`orders` TO `app`@`%`')[0]).toMatchObject({
      level: 'table',
      name: 'orders',
    });
  });

  it('keeps column privileges and routines, which a revoke from here does not rebuild', () => {
    expect(
      readGrantLine('GRANT SELECT (`id`, `email`), UPDATE (`email`) ON `shop`.`c` TO `app`@`%`'),
    ).toEqual([
      {
        level: 'table',
        database: 'shop',
        name: 'c',
        privilege: 'SELECT (id, email)',
        grantable: false,
        fixed: true,
      },
      {
        level: 'table',
        database: 'shop',
        name: 'c',
        privilege: 'UPDATE (email)',
        grantable: false,
        fixed: true,
      },
    ]);
    expect(readGrantLine('GRANT EXECUTE ON PROCEDURE `shop`.`p` TO `app`@`%`')).toEqual([
      {
        level: 'routine',
        database: 'shop',
        name: 'p',
        privilege: 'EXECUTE',
        grantable: false,
        fixed: true,
      },
    ]);
    expect(readGrantLine("GRANT PROXY ON ''@'' TO 'root'@'localhost' WITH GRANT OPTION")).toEqual([
      { level: 'server', privilege: 'PROXY', grantable: false, fixed: true },
      { level: 'server', privilege: 'GRANT OPTION', grantable: false, fixed: true },
    ]);
  });

  it('never keeps what MariaDB prints after the account, like the password hash', () => {
    const grants = readGrantLine(
      "GRANT ALL PRIVILEGES ON *.* TO `root`@`localhost` IDENTIFIED VIA mysql_native_password USING '*81F5E21E35407D884A6CD4A731AEBFB6AF209E1B' OR unix_socket WITH GRANT OPTION",
    );
    expect(grants.map((grant) => grant.privilege)).toEqual(['ALL PRIVILEGES', 'GRANT OPTION']);
    expect(JSON.stringify(grants)).not.toContain('81F5');
  });

  it('reads roles granted to an account, with and without hosts', () => {
    expect(readGrantLine('GRANT `reader`@`%`,`writer`@`10.0.%` TO `app`@`%`')).toEqual([
      { level: 'role', name: 'reader', host: '%', privilege: 'ROLE', grantable: false },
      { level: 'role', name: 'writer', host: '10.0.%', privilege: 'ROLE', grantable: false },
    ]);
    expect(readGrantLine('GRANT `auditor` TO `app`@`%` WITH ADMIN OPTION')).toEqual([
      { level: 'role', name: 'auditor', privilege: 'ROLE', grantable: true },
    ]);
  });

  it('gives nothing for lines it does not know', () => {
    expect(readGrantLine('')).toEqual([]);
    expect(readGrantLine('REVOKE SELECT ON *.* FROM x')).toEqual([]);
    expect(readGrantLine('GRANT SELECT ON')).toEqual([]);
    expect(readGrantLine('GRANT SELECT ON `unclosed TO `x`')).toEqual([]);
  });
});

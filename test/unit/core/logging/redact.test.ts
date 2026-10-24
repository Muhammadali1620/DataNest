import { describe, expect, it } from 'vitest';
import { redactSecrets } from '../../../../src/core/logging/redact';

describe('redactSecrets', () => {
  describe('connection URLs', () => {
    it.each([
      ['mysql://root:s3cret@localhost:3306/db', 'mysql://root:***@localhost:3306/db'],
      ['postgres://u:p%40ss@db.example.com/app', 'postgres://u:***@db.example.com/app'],
      ['postgresql://user:@host/db', 'postgresql://user:***@host/db'],
      ['mongodb+srv://admin:pw@cluster0.x.net', 'mongodb+srv://admin:***@cluster0.x.net'],
      ['redis://:onlypass@127.0.0.1:6379', 'redis://:***@127.0.0.1:6379'],
    ])('masks the password in %s', (input, expected) => {
      expect(redactSecrets(input)).toBe(expected);
    });

    it('keeps URLs without a password', () => {
      expect(redactSecrets('mysql://root@localhost/db')).toBe('mysql://root@localhost/db');
      expect(redactSecrets('https://example.com/a:b')).toBe('https://example.com/a:b');
    });

    it('masks several URLs in one line', () => {
      expect(redactSecrets('from mysql://a:1@h1 to postgres://b:2@h2')).toBe(
        'from mysql://a:***@h1 to postgres://b:***@h2',
      );
    });
  });

  describe('key/value pairs', () => {
    it.each([
      ['password=hunter2', 'password=***'],
      ['Password = hunter2', 'Password = ***'],
      ['host=db;pwd=abc;user=x', 'host=db;pwd=***;user=x'],
      ['passwd: abc def', 'passwd: *** def'],
      ['OPEN_VSX_TOKEN=abcdef123', 'OPEN_VSX_TOKEN=***'],
      ['authToken=xyz&next=1', 'authToken=***&next=1'],
      ['api_key=K1 apiKey=K2 api-key=K3', 'api_key=*** apiKey=*** api-key=***'],
      ['sshPassphrase=phrase', 'sshPassphrase=***'],
      ['client_secret=s', 'client_secret=***'],
    ])('masks %s', (input, expected) => {
      expect(redactSecrets(input)).toBe(expected);
    });

    it('masks quoted values and keeps the quotes', () => {
      expect(redactSecrets(`password='with space'`)).toBe(`password='***'`);
      expect(redactSecrets('password="a \\" b" next')).toBe('password="***" next');
    });

    it('masks JSON properties', () => {
      const json = JSON.stringify({ host: 'h', user: 'u', password: 'p@ss', port: 1 });
      expect(redactSecrets(json)).toBe('{"host":"h","user":"u","password":"***","port":1}');
      expect(redactSecrets(`{ 'token': 'abc' }`)).toBe(`{ 'token': '***' }`);
    });

    it('masks unquoted values inside objects', () => {
      expect(redactSecrets('{ password: secret }')).toBe('{ password: *** }');
    });

    it('does not touch words that only contain a keyword', () => {
      const text = 'tokenizer=sql passwordless=true secretary: Ann';
      expect(redactSecrets(text)).toBe(text);
    });

    it('does not touch the keyword without a value', () => {
      const text = 'Wrong password for user "root"';
      expect(redactSecrets(text)).toBe(text);
    });
  });

  describe('SQL', () => {
    it.each([
      ["CREATE USER 'bob'@'%' IDENTIFIED BY 'pa''ss'", "CREATE USER 'bob'@'%' IDENTIFIED BY '***'"],
      ["ALTER ROLE app WITH PASSWORD 'x1'", "ALTER ROLE app WITH PASSWORD '***'"],
      ["alter user u identified   by 'q'", "alter user u identified   by '***'"],
      ['CREATE ROLE r PASSWORD "dq"', "CREATE ROLE r PASSWORD '***'"],
    ])('masks %s', (input, expected) => {
      expect(redactSecrets(input)).toBe(expected);
    });

    it('keeps ordinary SQL unchanged', () => {
      const sql = "SELECT id, password_hash FROM users WHERE email = 'a@b.c'";
      expect(redactSecrets(sql)).toBe(sql);
    });
  });

  it('keeps text without secrets unchanged', () => {
    const text = 'Connected to 127.0.0.1:7306 in 12 ms';
    expect(redactSecrets(text)).toBe(text);
    expect(redactSecrets('')).toBe('');
  });

  it('masks secrets on every line of a multi-line message', () => {
    expect(redactSecrets('a\npassword=1\nb\ntoken=2')).toBe('a\npassword=***\nb\ntoken=***');
  });
});

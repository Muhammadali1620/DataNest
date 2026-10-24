import { describe, expect, it } from 'vitest';
import {
  fieldsFrom,
  type FormFields,
  parsePort,
  passwordChange,
  PROBLEM_MESSAGES,
  problemMessage,
  problemsOf,
  toDraft,
  toInput,
} from '../../../../../webview/src/apps/connection-form/form-model';
import { en } from '../../../../../webview/src/l10n/en';

function fields(overrides: Partial<FormFields> = {}): FormFields {
  return {
    name: 'Local',
    driver: 'mysql',
    host: '127.0.0.1',
    port: '7306',
    user: 'root',
    database: 'app',
    file: '',
    password: '',
    passwordTouched: false,
    erasePassword: false,
    ...overrides,
  };
}

describe('fieldsFrom', () => {
  it('fills the form from the host state and never pre-fills a password', () => {
    const result = fieldsFrom({
      connectionId: 'c1',
      input: {
        name: 'Local',
        driver: 'postgres',
        host: 'db',
        port: 7432,
        user: 'u',
        database: 'd',
      },
      hasStoredPassword: true,
      drivers: [],
    });
    expect(result).toEqual({
      name: 'Local',
      driver: 'postgres',
      host: 'db',
      port: '7432',
      user: 'u',
      database: 'd',
      file: '',
      password: '',
      passwordTouched: false,
      erasePassword: false,
    });
  });

  it('leaves missing fields empty, with no port text', () => {
    const result = fieldsFrom({
      input: { name: '', driver: 'sqlite', file: '/tmp/a.db' },
      hasStoredPassword: false,
      drivers: [],
    });
    expect(result.port).toBe('');
    expect(result.host).toBe('');
    expect(result.file).toBe('/tmp/a.db');
  });
});

describe('parsePort', () => {
  it('accepts plain digits and trims spaces', () => {
    expect(parsePort('7306')).toBe(7306);
    expect(parsePort('  7306 ')).toBe(7306);
  });

  it('rejects anything that is not a plain number', () => {
    for (const text of ['', ' ', 'abc', '70a', '-1', '1.5', '0x10', '1e3']) {
      expect(parsePort(text)).toBeUndefined();
    }
  });
});

describe('toInput', () => {
  it('trims text and keeps the network fields', () => {
    expect(toInput(fields({ name: '  Local  ', host: ' db ', user: ' root ' }))).toEqual({
      name: 'Local',
      driver: 'mysql',
      host: 'db',
      port: 7306,
      user: 'root',
      database: 'app',
    });
  });

  it('drops blank optional fields', () => {
    expect(toInput(fields({ user: '  ', database: '', port: '' }))).toEqual({
      name: 'Local',
      driver: 'mysql',
      host: '127.0.0.1',
    });
  });

  it('keeps only the file for a file driver, ignoring network fields', () => {
    expect(toInput(fields({ driver: 'sqlite', file: ' /tmp/a.db ' }))).toEqual({
      name: 'Local',
      driver: 'sqlite',
      file: '/tmp/a.db',
    });
  });

  it('omits an empty file so the problem is reported', () => {
    expect(toInput(fields({ driver: 'sqlite', file: '   ' }))).toEqual({
      name: 'Local',
      driver: 'sqlite',
    });
  });

  it('omits a port that is not a plain number', () => {
    expect(toInput(fields({ port: 'abc' }))).not.toHaveProperty('port');
  });
});

describe('passwordChange', () => {
  it('keeps the stored password while the box is untouched', () => {
    expect(passwordChange(fields())).toEqual({ kind: 'keep' });
  });

  it('sets what the user typed', () => {
    expect(passwordChange(fields({ password: 'pw', passwordTouched: true }))).toEqual({
      kind: 'set',
      value: 'pw',
    });
  });

  it('clears when the user empties a touched box', () => {
    expect(passwordChange(fields({ password: '', passwordTouched: true }))).toEqual({
      kind: 'clear',
    });
  });

  it('clears when the erase box is ticked, whatever was typed', () => {
    expect(
      passwordChange(fields({ password: 'pw', passwordTouched: true, erasePassword: true })),
    ).toEqual({ kind: 'clear' });
  });
});

describe('toDraft', () => {
  it('bundles the input and the password decision', () => {
    expect(toDraft(fields({ password: 'pw', passwordTouched: true }))).toEqual({
      input: {
        name: 'Local',
        driver: 'mysql',
        host: '127.0.0.1',
        port: 7306,
        user: 'root',
        database: 'app',
      },
      password: { kind: 'set', value: 'pw' },
    });
  });
});

describe('problemsOf', () => {
  it('is empty for a valid network form', () => {
    expect(problemsOf(fields())).toEqual([]);
  });

  it('is empty for a valid file form', () => {
    expect(problemsOf(fields({ driver: 'sqlite', file: '/tmp/a.db' }))).toEqual([]);
  });

  it('reports a missing name, host and file', () => {
    expect(problemsOf(fields({ name: ' ' }))).toContain('name-empty');
    expect(problemsOf(fields({ host: '' }))).toContain('host-empty');
    expect(problemsOf(fields({ driver: 'sqlite', file: '' }))).toContain('file-empty');
  });

  it('reports a port that is not a number, without duplicates', () => {
    expect(problemsOf(fields({ port: 'abc' }))).toEqual(['port-invalid']);
    expect(problemsOf(fields({ port: '70000' }))).toEqual(['port-invalid']);
  });

  it('accepts an empty port, which means the driver default', () => {
    expect(problemsOf(fields({ port: '' }))).toEqual([]);
  });

  it('ignores port text for a file driver', () => {
    expect(problemsOf(fields({ driver: 'sqlite', file: '/db', port: 'nonsense' }))).toEqual([]);
  });
});

describe('problem messages', () => {
  it('has a translated message for every problem', () => {
    for (const key of Object.values(PROBLEM_MESSAGES)) {
      expect(en[key]).toBeTypeOf('string');
    }
  });

  it('returns a key only for problems that are present', () => {
    const problems = problemsOf(fields({ name: '' }));
    expect(problemMessage(problems, 'name-empty')).toBe('form.error.nameEmpty');
    expect(problemMessage(problems, 'host-empty')).toBeUndefined();
  });
});

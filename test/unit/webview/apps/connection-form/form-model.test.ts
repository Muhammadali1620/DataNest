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
  newHopFields,
  hopFieldsFrom,
  hopProblemsOf,
  hopSecretChanges,
  secretChange,
  toHop,
  moveJump,
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
    useSsh: false,
    ssh: newHopFields('hop1'),
    jumps: [],
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
      storedSsh: [],
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
      useSsh: false,
      ssh: expect.objectContaining({ host: '', auth: 'password' }) as unknown,
      jumps: [],
    });
  });

  it('leaves missing fields empty, with no port text', () => {
    const result = fieldsFrom({
      input: { name: '', driver: 'sqlite', file: '/tmp/a.db' },
      hasStoredPassword: false,
      storedSsh: [],
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

describe('SSH fields', () => {
  it('starts a hop empty with a password login and a fresh id', () => {
    const a = newHopFields();
    const b = newHopFields();
    expect(a).toMatchObject({ host: '', port: '', user: '', auth: 'password' });
    expect(a.id).not.toBe(b.id);
  });

  it('round-trips a saved hop without secrets', () => {
    const hop = {
      id: 'main',
      host: 'b',
      port: 2222,
      user: 'u',
      auth: 'key' as const,
      keyFile: '/k',
    };
    const fields = hopFieldsFrom(hop);
    expect(fields.port).toBe('2222');
    expect(fields.password).toEqual({ value: '', touched: false, erase: false });
    expect(toHop(fields)).toEqual(hop);
  });

  it('sends only the fields of the chosen method, trimmed', () => {
    const hop = {
      ...newHopFields('h'),
      host: ' b ',
      user: ' u ',
      port: ' ',
      keyFile: ' /k ',
      agentSocket: '/s',
    };
    expect(toHop({ ...hop, auth: 'key' })).toEqual({
      id: 'h',
      host: 'b',
      user: 'u',
      auth: 'key',
      keyFile: '/k',
    });
    expect(toHop({ ...hop, auth: 'agent' })).toEqual({
      id: 'h',
      host: 'b',
      user: 'u',
      auth: 'agent',
      agentSocket: '/s',
    });
    expect(toHop({ ...hop, auth: 'password' })).not.toHaveProperty('keyFile');
  });

  it('turns a secret box into keep, set or clear', () => {
    expect(secretChange({ value: '', touched: false, erase: false })).toEqual({ kind: 'keep' });
    expect(secretChange({ value: 'x', touched: true, erase: false })).toEqual({
      kind: 'set',
      value: 'x',
    });
    expect(secretChange({ value: '', touched: true, erase: false })).toEqual({ kind: 'clear' });
    expect(secretChange({ value: 'x', touched: true, erase: true })).toEqual({ kind: 'clear' });
  });

  it('erases the secret the chosen method does not use', () => {
    const hop = {
      ...newHopFields('h'),
      password: { value: 'p', touched: true, erase: false },
      passphrase: { value: 'q', touched: true, erase: false },
    };
    expect(hopSecretChanges({ ...hop, auth: 'password' })).toEqual({
      hopId: 'h',
      password: { kind: 'set', value: 'p' },
      passphrase: { kind: 'clear' },
    });
    expect(hopSecretChanges({ ...hop, auth: 'key' }).password).toEqual({ kind: 'clear' });
    expect(hopSecretChanges({ ...hop, auth: 'agent' })).toMatchObject({
      password: { kind: 'clear' },
      passphrase: { kind: 'clear' },
    });
  });

  it('flags a port that is not a plain number', () => {
    const hop = { ...newHopFields('h'), host: 'b', user: 'u' };
    expect(hopProblemsOf(hop)).toEqual([]);
    expect(hopProblemsOf({ ...hop, port: '22a' })).toEqual(['ssh-port-invalid']);
    expect(hopProblemsOf({ ...hop, port: '0' })).toEqual(['ssh-port-invalid']);
  });

  it('puts the hop into the input and draft only while SSH is on', () => {
    const ssh = { ...newHopFields('h'), host: 'b', user: 'u' };
    expect(toInput(fields({ ssh })).ssh).toBeUndefined();
    expect(toDraft(fields({ ssh })).ssh).toBeUndefined();
    expect(toInput(fields({ ssh, useSsh: true })).ssh).toMatchObject({ host: 'b' });
    expect(toDraft(fields({ ssh, useSsh: true })).ssh).toHaveLength(1);
    expect(
      toInput(fields({ ssh, useSsh: true, driver: 'sqlite', file: '/f' })).ssh,
    ).toBeUndefined();
  });

  it('blocks saving on SSH problems only while SSH is on', () => {
    const ssh = newHopFields('h');
    expect(problemsOf(fields({ ssh }))).toEqual([]);
    expect(problemsOf(fields({ ssh, useSsh: true }))).toEqual(['ssh-host-empty', 'ssh-user-empty']);
  });

  it('has a message for every SSH problem', () => {
    for (const problem of [
      'ssh-host-empty',
      'ssh-port-invalid',
      'ssh-user-empty',
      'ssh-key-empty',
    ] as const) {
      expect(en[PROBLEM_MESSAGES[problem]]).toBeTruthy();
    }
  });
});

describe('jump hosts', () => {
  const server = { ...newHopFields('main'), host: 'inner', user: 'deploy' };
  const jump = (id: string) => ({ ...newHopFields(id), host: `${id}.example`, user: 'j' });

  it('reads the jumps of a saved tunnel in order', () => {
    const result = fieldsFrom({
      input: {
        name: 'p',
        driver: 'mysql',
        host: 'db',
        ssh: {
          id: 'main',
          host: 'inner',
          user: 'u',
          auth: 'agent',
          jumps: [
            { id: 'a', host: 'a.example', user: 'j', auth: 'password' },
            { id: 'b', host: 'b.example', port: 2200, user: 'j', auth: 'key', keyFile: '/k' },
          ],
        },
      },
      hasStoredPassword: false,
      storedSsh: [],
      drivers: [],
    });
    expect(result.jumps.map((hop) => [hop.id, hop.host, hop.port])).toEqual([
      ['a', 'a.example', ''],
      ['b', 'b.example', '2200'],
    ]);
  });

  it('sends the jumps inside the tunnel, and none when the list is empty', () => {
    const withJumps = toInput(fields({ useSsh: true, ssh: server, jumps: [jump('a'), jump('b')] }));
    expect(withJumps.ssh?.jumps?.map((hop) => hop.id)).toEqual(['a', 'b']);
    expect(toInput(fields({ useSsh: true, ssh: server })).ssh).not.toHaveProperty('jumps');
  });

  it('sends secret decisions for every hop, jumps first', () => {
    const draft = toDraft(fields({ useSsh: true, ssh: server, jumps: [jump('a'), jump('b')] }));
    expect(draft.ssh?.map((change) => change.hopId)).toEqual(['a', 'b', 'main']);
  });

  it('blocks saving while a jump is incomplete', () => {
    const broken = { ...jump('a'), user: '' };
    expect(problemsOf(fields({ useSsh: true, ssh: server, jumps: [broken] }))).toEqual([
      'ssh-user-empty',
    ]);
  });

  it('moves a jump up and down within the list only', () => {
    const list = [jump('a'), jump('b'), jump('c')];
    moveJump(list, 0, 1);
    expect(list.map((hop) => hop.id)).toEqual(['b', 'a', 'c']);
    moveJump(list, 2, -1);
    expect(list.map((hop) => hop.id)).toEqual(['b', 'c', 'a']);
    moveJump(list, 0, -1);
    moveJump(list, 2, 1);
    expect(list.map((hop) => hop.id)).toEqual(['b', 'c', 'a']);
  });
});

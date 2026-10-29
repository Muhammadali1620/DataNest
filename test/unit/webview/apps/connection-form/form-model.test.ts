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
  toSsl,
  applyUrl,
  URL_PROBLEM_MESSAGES,
  toOptions,
  toFilter,
  applyPreset,
  changeRedisMode,
  emptySecret,
  nodeText,
  parseNodes,
  sshAllowed,
  toRedis,
  toMongo,
  changeMongoMode,
} from '../../../../../webview/src/apps/connection-form/form-model';
import { serverPreset } from '../../../../../src/shared/server-presets';
import { parseConnectionUrl } from '../../../../../src/shared/connection-url';
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
    sslMode: 'off',
    sslCa: '',
    sslCert: '',
    sslKey: '',
    folder: '',
    color: '',
    production: false,
    readOnly: false,
    project: '',
    connectTimeout: '',
    queryTimeout: '',
    keepAlive: '',
    timeZone: '',
    charset: '',
    initSql: '',
    filterDatabases: '',
    filterSchemas: '',
    redisMode: 'standalone',
    masterName: '',
    redisNodes: '',
    sentinelUser: '',
    sentinelPassword: emptySecret(),
    mongoMode: 'direct',
    replicaSet: '',
    mongoNodes: '',
    authSource: '',
    authMechanism: '',
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
      sslMode: 'off',
      sslCa: '',
      sslCert: '',
      sslKey: '',
      folder: '',
      color: '',
      production: false,
      readOnly: false,
      project: '',
      connectTimeout: '',
      queryTimeout: '',
      keepAlive: '',
      timeZone: '',
      charset: '',
      initSql: '',
      filterDatabases: '',
      filterSchemas: '',
      redisMode: 'standalone',
      masterName: '',
      redisNodes: '',
      sentinelUser: '',
      sentinelPassword: { value: '', touched: false, erase: false },
      mongoMode: 'direct',
      replicaSet: '',
      mongoNodes: '',
      authSource: '',
      authMechanism: '',
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

describe('SSL fields', () => {
  it('reads saved TLS settings, off when there are none', () => {
    const state = {
      hasStoredPassword: false,
      storedSsh: [],
      drivers: [],
    };
    expect(
      fieldsFrom({ ...state, input: { name: 'a', driver: 'postgres', host: 'h' } }).sslMode,
    ).toBe('off');
    const result = fieldsFrom({
      ...state,
      input: {
        name: 'a',
        driver: 'postgres',
        host: 'h',
        ssl: { mode: 'verify-ca', ca: '/ca', cert: '/c', key: '/k' },
      },
    });
    expect([result.sslMode, result.sslCa, result.sslCert, result.sslKey]).toEqual([
      'verify-ca',
      '/ca',
      '/c',
      '/k',
    ]);
  });

  it('sends TLS only when it is on, with trimmed files', () => {
    expect(toSsl(fields({ sslCa: '/ca' }))).toBeUndefined();
    expect(toInput(fields())).not.toHaveProperty('ssl');
    expect(toSsl(fields({ sslMode: 'require', sslCa: ' /ca ', sslCert: ' ' }))).toEqual({
      mode: 'require',
      ca: '/ca',
    });
    expect(toInput(fields({ sslMode: 'verify-full' })).ssl).toEqual({ mode: 'verify-full' });
    expect(
      toInput(fields({ driver: 'sqlite', file: '/f', sslMode: 'require' })),
    ).not.toHaveProperty('ssl');
  });

  it('blocks saving with half a client certificate', () => {
    expect(problemsOf(fields({ sslMode: 'require', sslCert: '/c' }))).toEqual([
      'ssl-cert-without-key',
    ]);
    expect(en[PROBLEM_MESSAGES['ssl-cert-without-key']]).toBeTruthy();
    expect(en[PROBLEM_MESSAGES['ssl-key-without-cert']]).toBeTruthy();
  });
});

describe('TLS for Oracle (V6.4)', () => {
  const oracle = { driver: 'oracle', port: '1521', database: 'FREEPDB1' } as const;

  it('sends no TLS settings for Oracle, even when a mode is still set', () => {
    expect(toSsl(fields({ ...oracle, sslMode: 'require', sslCa: '/ca' }))).toBeUndefined();
    expect(toInput(fields({ ...oracle, sslMode: 'verify-full' }))).not.toHaveProperty('ssl');
  });

  it('still sends them for the drivers that use TLS', () => {
    expect(toSsl(fields({ driver: 'mssql', sslMode: 'require' }))).toEqual({ mode: 'require' });
    expect(toSsl(fields({ driver: 'clickhouse', sslMode: 'require' }))).toEqual({
      mode: 'require',
    });
  });

  it('sends schema patterns only, as the service is the one database', () => {
    expect(
      toInput(fields({ ...oracle, filterDatabases: 'a*', filterSchemas: 'APP, HR_*' })).filter,
    ).toEqual({ schemas: ['APP', 'HR_*'] });
  });

  it('builds the rest of an Oracle connection as usual', () => {
    expect(toInput(fields({ ...oracle, name: 'Ora', host: 'db', user: 'app' }))).toMatchObject({
      name: 'Ora',
      driver: 'oracle',
      host: 'db',
      port: 1521,
      user: 'app',
      database: 'FREEPDB1',
    });
  });
});

describe('applyUrl', () => {
  it('fills the target, TLS and password, and names a nameless connection', () => {
    const form = fields({
      name: '',
      user: 'old',
      database: 'old',
      sslMode: 'require',
      sslCa: '/x',
    });
    applyUrl(form, {
      input: {
        name: 'shop',
        driver: 'postgres',
        host: 'db',
        port: 6543,
        database: 'shop',
        ssl: { mode: 'verify-ca', ca: '/ca' },
      },
      password: 'pw',
    });
    expect(form).toMatchObject({
      name: 'shop',
      driver: 'postgres',
      host: 'db',
      port: '6543',
      user: '',
      database: 'shop',
      sslMode: 'verify-ca',
      sslCa: '/ca',
      password: 'pw',
      passwordTouched: true,
    });
  });

  it('keeps a name the user gave, the password without one in the URL, and SSH', () => {
    const ssh = { ...newHopFields('h'), host: 'bastion' };
    const form = fields({
      name: 'Mine',
      password: 'typed',
      passwordTouched: true,
      useSsh: true,
      ssh,
    });
    applyUrl(form, { input: { name: 'x', driver: 'mysql', host: 'h2' } });
    expect(form).toMatchObject({
      name: 'Mine',
      host: 'h2',
      port: '',
      sslMode: 'off',
      password: 'typed',
      useSsh: true,
    });
    expect(form.ssh.host).toBe('bastion');
  });

  it('switches to a file database', () => {
    const form = fields();
    applyUrl(form, { input: { name: 'a.db', driver: 'sqlite', file: '/a.db' } });
    expect(form).toMatchObject({ driver: 'sqlite', file: '/a.db', host: '' });
  });

  it('has a message for every URL problem', () => {
    for (const key of Object.values(URL_PROBLEM_MESSAGES)) {
      expect(en[key]).toBeTruthy();
    }
  });
});

describe('folder and color', () => {
  it('reads them from the saved connection and sends them back, for every driver', () => {
    const read = fieldsFrom({
      input: { name: 'a', driver: 'sqlite', file: '/f', folder: 'Local', color: 'green' },
      hasStoredPassword: false,
      storedSsh: [],
      drivers: [],
    });
    expect([read.folder, read.color]).toEqual(['Local', 'green']);
    expect(toInput(read)).toMatchObject({ folder: 'Local', color: 'green' });
    expect(toInput(fields({ folder: ' Prod ', color: 'red' }))).toMatchObject({
      folder: 'Prod',
      color: 'red',
    });
  });

  it('leaves out an empty folder and no color', () => {
    const input = toInput(fields({ folder: '  ', color: '' }));
    expect(input).not.toHaveProperty('folder');
    expect(input).not.toHaveProperty('color');
  });
});

describe('production and read-only', () => {
  it('reads and sends the flags only when set, for every driver', () => {
    const read = fieldsFrom({
      input: { name: 'a', driver: 'sqlite', file: '/f', production: true, readOnly: true },
      hasStoredPassword: false,
      storedSsh: [],
      drivers: [],
    });
    expect([read.production, read.readOnly]).toEqual([true, true]);
    expect(toInput(read)).toMatchObject({ production: true, readOnly: true });
    const plain = toInput(fields());
    expect(plain).not.toHaveProperty('production');
    expect(plain).not.toHaveProperty('readOnly');
  });
});

describe('project connections (V4.7)', () => {
  it('starts on the project that holds the connection', () => {
    expect(
      fieldsFrom({
        connectionId: 'p-1',
        input: { name: 'Dev', driver: 'mysql', host: 'h' },
        hasStoredPassword: false,
        storedSsh: [],
        drivers: [],
        project: { key: 'file:///shop', name: 'shop' },
      }).project,
    ).toBe('file:///shop');
  });

  it('sends the chosen project with the draft and no folder', () => {
    const draft = toDraft(fields({ folder: 'Work', project: 'file:///shop' }));
    expect(draft.project).toBe('file:///shop');
    expect(draft.input).not.toHaveProperty('folder');
  });

  it('sends no project for the user list and keeps the folder', () => {
    const draft = toDraft(fields({ folder: 'Work' }));
    expect(draft).not.toHaveProperty('project');
    expect(draft.input.folder).toBe('Work');
  });
});

describe('session options (V4.9)', () => {
  it('fills the option fields from the host state', () => {
    const result = fieldsFrom({
      input: {
        name: 'n',
        driver: 'mysql',
        host: 'h',
        options: {
          connectTimeout: 20,
          queryTimeout: 0,
          keepAlive: 60,
          timeZone: 'UTC',
          charset: 'latin1',
          initSql: 'SET a = 1',
        },
      },
      hasStoredPassword: false,
      storedSsh: [],
      drivers: [],
    });
    expect(result).toMatchObject({
      connectTimeout: '20',
      queryTimeout: '0',
      keepAlive: '60',
      timeZone: 'UTC',
      charset: 'latin1',
      initSql: 'SET a = 1',
    });
  });

  it('sends the options the driver honours, numbers as numbers, blanks left out', () => {
    expect(
      toOptions(
        fields({
          connectTimeout: '20',
          queryTimeout: '0',
          keepAlive: '',
          timeZone: ' +03:00 ',
          charset: 'latin1',
          initSql: 'SET a = 1;\nSET b = 2;',
        }),
      ),
    ).toEqual({
      connectTimeout: 20,
      queryTimeout: 0,
      timeZone: '+03:00',
      charset: 'latin1',
      initSql: 'SET a = 1;\nSET b = 2;',
    });
    expect(toOptions(fields())).toBeUndefined();
    expect(toInput(fields())).not.toHaveProperty('options');
  });

  it('keeps only what PostgreSQL and SQLite use', () => {
    const all = {
      connectTimeout: '5',
      queryTimeout: '9',
      keepAlive: '30',
      timeZone: 'UTC',
      charset: 'latin1',
      initSql: 'SELECT 1',
    };
    expect(toOptions(fields({ ...all, driver: 'postgres' }))).toEqual({
      connectTimeout: 5,
      queryTimeout: 9,
      keepAlive: 30,
      timeZone: 'UTC',
      initSql: 'SELECT 1',
    });
    expect(toInput(fields({ ...all, driver: 'sqlite', file: '/a.db' })).options).toEqual({
      queryTimeout: 9,
      initSql: 'SELECT 1',
    });
  });

  it('flags seconds that are not whole numbers or out of range, and a bad charset', () => {
    expect(problemsOf(fields({ connectTimeout: 'ten' }))).toContain('connect-timeout-invalid');
    expect(problemsOf(fields({ connectTimeout: '0' }))).toContain('connect-timeout-invalid');
    expect(problemsOf(fields({ queryTimeout: '1.5' }))).toContain('query-timeout-invalid');
    expect(problemsOf(fields({ keepAlive: '99999' }))).toContain('keep-alive-invalid');
    expect(problemsOf(fields({ charset: 'utf-8' }))).toContain('charset-invalid');
    expect(problemsOf(fields({ connectTimeout: '30', keepAlive: '0' }))).toEqual([]);
  });

  it('has a message for every option problem', () => {
    for (const problem of [
      'connect-timeout-invalid',
      'query-timeout-invalid',
      'keep-alive-invalid',
      'time-zone-invalid',
      'charset-invalid',
      'init-sql-too-long',
    ] as const) {
      expect(en[PROBLEM_MESSAGES[problem]]).toBeTruthy();
    }
  });
});

describe('visibility filter (V4.10)', () => {
  it('shows the patterns as one line each', () => {
    expect(
      fieldsFrom({
        input: {
          name: 'n',
          driver: 'postgres',
          host: 'h',
          filter: { databases: ['a*', '!a_t'], schemas: ['public'] },
        },
        hasStoredPassword: false,
        storedSsh: [],
        drivers: [],
      }),
    ).toMatchObject({ filterDatabases: 'a*, !a_t', filterSchemas: 'public' });
  });

  it('sends the lists the driver has, split on commas and lines', () => {
    expect(
      toFilter(
        fields({
          driver: 'postgres',
          filterDatabases: 'app_*,\n!app_test',
          filterSchemas: ' public ',
        }),
      ),
    ).toEqual({ databases: ['app_*', '!app_test'], schemas: ['public'] });
    expect(toFilter(fields({ filterDatabases: 'shop', filterSchemas: 'public' }))).toEqual({
      databases: ['shop'],
    });
    expect(toFilter(fields({ driver: 'sqlite', filterDatabases: 'x' }))).toBeUndefined();
    expect(toInput(fields())).not.toHaveProperty('filter');
  });

  it('flags a filter that is too long', () => {
    const many = Array.from({ length: 101 }, (_, index) => `db${index}`).join(',');
    expect(problemsOf(fields({ filterDatabases: many }))).toContain('filter-too-long');
    expect(en[PROBLEM_MESSAGES['filter-too-long']]).toBeTruthy();
  });
});

describe('applyPreset (V6.5)', () => {
  const preset = (id: string) => {
    const found = serverPreset(id);
    if (found === undefined) {
      throw new Error(id);
    }
    return found;
  };

  it("sets the server's driver and port, and fills the account and database left blank", () => {
    const form = fields({ user: '', database: '', port: '7306' });
    applyPreset(form, preset('yugabytedb'));
    expect(form).toMatchObject({
      driver: 'postgres',
      port: '5433',
      user: 'yugabyte',
      database: 'yugabyte',
      sslMode: 'off',
    });
  });

  it('keeps an account and database the user typed, and TLS already chosen', () => {
    const form = fields({ user: 'me', database: 'shop', sslMode: 'verify-full', sslCa: 'rds.pem' });
    applyPreset(form, preset('aurora-postgres'));
    expect(form).toMatchObject({
      driver: 'postgres',
      port: '5432',
      user: 'me',
      database: 'shop',
      sslMode: 'verify-full',
    });
  });

  it('turns TLS on for a hosted server, and leaves blanks blank when the server has none', () => {
    const form = fields({ user: '', database: '' });
    applyPreset(form, preset('aurora-mysql'));
    expect(form).toMatchObject({ driver: 'mysql', port: '3306', user: '', sslMode: 'require' });
    expect(toInput(form).ssl).toEqual({ mode: 'require' });
  });
});

describe('Redis fields (V7.1)', () => {
  const redis = (overrides: Partial<FormFields> = {}): FormFields =>
    fields({ driver: 'redis', port: '6379', user: '', database: '', ...overrides });

  it('sends nothing Redis-specific for one server', () => {
    expect(toInput(redis()).redis).toBeUndefined();
    expect(toDraft(redis()).sentinelPassword).toBeUndefined();
  });

  it('sends the Sentinel settings, nodes and password change', () => {
    const form = redis({
      redisMode: 'sentinel',
      port: '26379',
      masterName: ' mymaster ',
      redisNodes: 's2:26380, s3',
      sentinelUser: ' watcher ',
      sentinelPassword: { value: 'pw', touched: true, erase: false },
    });
    expect(toInput(form).redis).toEqual({
      mode: 'sentinel',
      masterName: 'mymaster',
      nodes: [{ host: 's2', port: 26380 }, { host: 's3' }],
      sentinelUser: 'watcher',
    });
    expect(toDraft(form).sentinelPassword).toEqual({ kind: 'set', value: 'pw' });
    expect(problemsOf(form)).toEqual([]);
  });

  it('keeps a stored Sentinel password untouched, and erases it on request', () => {
    const form = redis({ redisMode: 'sentinel', masterName: 'm' });
    expect(toDraft(form).sentinelPassword).toEqual({ kind: 'keep' });
    form.sentinelPassword.erase = true;
    expect(toDraft(form).sentinelPassword).toEqual({ kind: 'clear' });
  });

  it('drops the master name and the Sentinel user for a cluster', () => {
    const form = redis({
      redisMode: 'cluster',
      masterName: 'm',
      sentinelUser: 'u',
      redisNodes: 'n2:7001',
    });
    expect(toRedis(form)).toEqual({ mode: 'cluster', nodes: [{ host: 'n2', port: 7001 }] });
    expect(toDraft(form).sentinelPassword).toBeUndefined();
  });

  it('sends no Redis settings for another driver, whatever is left in the fields', () => {
    expect(toRedis(fields({ redisMode: 'cluster' }))).toBeUndefined();
    expect(sshAllowed(fields({ redisMode: 'cluster' }))).toBe(true);
  });

  it('reads extra nodes with IPv6 brackets and flags bad ones', () => {
    expect(parseNodes('[::1]:7000; a  b:1')).toEqual({
      nodes: [{ host: '::1', port: 7000 }, { host: 'a' }, { host: 'b', port: 1 }],
      invalid: false,
    });
    expect(parseNodes('a:x, b:70000, :5, c')).toEqual({ nodes: [{ host: 'c' }], invalid: true });
    expect(parseNodes('')).toEqual({ nodes: [], invalid: false });
    expect(nodeText({ host: '::1', port: 7000 })).toBe('[::1]:7000');
    expect(nodeText({ host: 'a' })).toBe('a');
  });

  it('reports bad nodes, a missing master name and a bad database', () => {
    const form = redis({ redisMode: 'sentinel', redisNodes: 'a:x', database: 'one' });
    const problems = problemsOf(form);
    expect(problems).toContain('redis-node-invalid');
    expect(problems).toContain('redis-master-empty');
    expect(problems).toContain('redis-database-invalid');
    expect(problemsOf(redis({ redisMode: 'cluster', database: '3' }))).toContain(
      'redis-cluster-database',
    );
    // Bad nodes do not matter for one server: the box is hidden.
    expect(problemsOf(redis({ redisNodes: 'a:x' }))).toEqual([]);
  });

  it('has a message for every Redis problem', () => {
    for (const problem of [
      'redis-master-empty',
      'redis-node-invalid',
      'redis-too-many-nodes',
      'redis-database-invalid',
      'redis-cluster-database',
      'redis-ssh-topology',
    ] as const) {
      expect(en[PROBLEM_MESSAGES[problem]]).toBeTruthy();
    }
  });

  it('leaves SSH out for Sentinels and clusters, and does not check its hop', () => {
    const tunnel = { useSsh: true, ssh: { ...newHopFields('h1'), host: '' } };
    expect(toInput(redis({ redisMode: 'cluster', ...tunnel })).ssh).toBeUndefined();
    expect(problemsOf(redis({ redisMode: 'cluster', ...tunnel }))).toEqual([]);
    expect(sshAllowed(redis({ redisMode: 'sentinel' }))).toBe(false);
    expect(problemsOf(redis(tunnel))).toContain('ssh-host-empty');
  });

  it('moves a default port along with the mode, but keeps a typed one', () => {
    const form = redis();
    changeRedisMode(form, 'sentinel');
    expect(form.port).toBe('26379');
    changeRedisMode(form, 'cluster');
    expect(form.port).toBe('6379');
    form.port = '7000';
    changeRedisMode(form, 'sentinel');
    expect(form.port).toBe('7000');
    expect(form.redisMode).toBe('sentinel');
    form.port = '';
    changeRedisMode(form, 'sentinel');
    expect(form.port).toBe('26379');
  });

  it('fills the form from a saved Sentinel connection without its password', () => {
    const result = fieldsFrom({
      input: {
        name: 'r',
        driver: 'redis',
        host: 's1',
        redis: {
          mode: 'sentinel',
          masterName: 'm',
          nodes: [{ host: 's2', port: 1 }],
          sentinelUser: 'u',
        },
      },
      hasStoredPassword: false,
      hasStoredSentinelPassword: true,
      storedSsh: [],
      drivers: [],
    });
    expect(result).toMatchObject({
      redisMode: 'sentinel',
      masterName: 'm',
      redisNodes: 's2:1',
      sentinelUser: 'u',
      sentinelPassword: { value: '', touched: false, erase: false },
    });
  });

  it('turns a URL into one server', () => {
    const form = redis({ redisMode: 'cluster' });
    applyUrl(form, { input: { name: 'x', driver: 'redis', host: 'h' } });
    expect(form.redisMode).toBe('standalone');
  });
});

describe('MongoDB fields (V7.5)', () => {
  const mongo = (overrides: Partial<FormFields> = {}): FormFields =>
    fields({ driver: 'mongodb', port: '27017', ...overrides });

  it('reads the settings of a saved connection into the fields', () => {
    const state = fieldsFrom({
      input: {
        name: 'S',
        driver: 'mongodb',
        host: 'a',
        mongo: {
          mode: 'replicaSet',
          replicaSet: 'rs0',
          nodes: [{ host: 'b', port: 27_018 }, { host: '::1' }],
          authSource: 'admin',
          authMechanism: 'PLAIN',
        },
      },
      drivers: [],
      folders: [],
      projects: [],
      hasStoredPassword: false,
      storedSsh: [],
    } as never);
    expect(state).toMatchObject({
      mongoMode: 'replicaSet',
      replicaSet: 'rs0',
      mongoNodes: 'b:27018, [::1]',
      authSource: 'admin',
      authMechanism: 'PLAIN',
    });
  });

  it('sends nothing for a plain direct connection, and only what the mode uses', () => {
    expect(toMongo(mongo())).toBeUndefined();
    expect(toMongo(mongo({ replicaSet: 'rs0', mongoNodes: 'b' }))).toBeUndefined();
    expect(toMongo(mongo({ authSource: ' admin ' }))).toEqual({
      mode: 'direct',
      authSource: 'admin',
    });
    expect(
      toMongo(mongo({ mongoMode: 'replicaSet', replicaSet: ' rs0 ', mongoNodes: 'b:27018, c' })),
    ).toEqual({
      mode: 'replicaSet',
      replicaSet: 'rs0',
      nodes: [{ host: 'b', port: 27_018 }, { host: 'c' }],
    });
    expect(toMongo(mongo({ mongoMode: 'srv', authMechanism: 'MONGODB-X509' }))).toEqual({
      mode: 'srv',
      authMechanism: 'MONGODB-X509',
    });
    expect(toMongo(fields({ mongoMode: 'srv' }))).toBeUndefined();
    expect(toInput(mongo({ mongoMode: 'srv', port: '' })).mongo).toEqual({ mode: 'srv' });
  });

  it('clears the port and checks TLS for SRV, and puts the port back after', () => {
    const state = mongo({ sslMode: 'off' });
    changeMongoMode(state, 'srv');
    expect(state).toMatchObject({ mongoMode: 'srv', port: '', sslMode: 'verify-full' });
    changeMongoMode(state, 'direct');
    expect(state).toMatchObject({ mongoMode: 'direct', port: '27017', sslMode: 'verify-full' });
    const typed = mongo({ sslMode: 'require', port: '7017' });
    changeMongoMode(typed, 'replicaSet');
    expect(typed).toMatchObject({ port: '7017', sslMode: 'require' });
  });

  it('allows SSH only to one server', () => {
    expect(sshAllowed(mongo())).toBe(true);
    expect(sshAllowed(mongo({ mongoMode: 'replicaSet' }))).toBe(false);
    expect(sshAllowed(mongo({ mongoMode: 'srv' }))).toBe(false);
    expect(toInput(mongo({ mongoMode: 'srv', useSsh: true })).ssh).toBeUndefined();
  });

  it('blocks a member list that cannot be read, and an SRV with a port', () => {
    expect(problemsOf(mongo({ mongoMode: 'replicaSet', mongoNodes: 'b:x' }))).toContain(
      'mongo-node-invalid',
    );
    expect(problemsOf(mongo({ mongoMode: 'direct', mongoNodes: 'b:x' }))).toEqual([]);
    expect(problemsOf(mongo({ mongoMode: 'srv' }))).toContain('mongo-srv-port');
    for (const problem of [
      'mongo-node-invalid',
      'mongo-too-many-nodes',
      'mongo-srv-port',
      'mongo-name-invalid',
      'mongo-ssh-topology',
    ] as const) {
      expect(en[PROBLEM_MESSAGES[problem]]).toBeTruthy();
    }
  });

  it('fills the MongoDB fields from a URL, and resets them for another one', () => {
    const state = fields();
    const parsed = parseConnectionUrl('mongodb+srv://u:p@c.x.net/logs?authSource=admin');
    if (!parsed.ok) {
      throw new Error('URL');
    }
    applyUrl(state, parsed.value);
    expect(state).toMatchObject({
      driver: 'mongodb',
      host: 'c.x.net',
      port: '',
      mongoMode: 'srv',
      authSource: 'admin',
      sslMode: 'verify-full',
      password: 'p',
    });
    const plain = parseConnectionUrl('postgres://h/db');
    if (!plain.ok) {
      throw new Error('URL');
    }
    applyUrl(state, plain.value);
    expect(state).toMatchObject({ driver: 'postgres', mongoMode: 'direct', authSource: '' });
  });
});

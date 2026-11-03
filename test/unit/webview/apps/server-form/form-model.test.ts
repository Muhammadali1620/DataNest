import { describe, expect, it } from 'vitest';
import { serverFormProtocol } from '../../../../../src/shared/protocols/server-form';
import { serverProblems } from '../../../../../src/shared/ssh-server';
import { en } from '../../../../../webview/src/l10n/en';
import { ru } from '../../../../../webview/src/l10n/ru';
import {
  fieldsFrom,
  moveJump,
  newHopFields,
  newServerFields,
  problemsOf,
  SERVER_PROBLEM_MESSAGES,
  toDraft,
  toInput,
  toProxy,
} from '../../../../../webview/src/apps/server-form/form-model';

function filled() {
  const fields = newServerFields();
  fields.name = ' Web ';
  fields.ssh.host = ' web.example.com ';
  fields.ssh.user = 'deploy';
  return fields;
}

describe('a blank form', () => {
  it('starts with a password login and nothing else', () => {
    const fields = newServerFields();
    expect(fields).toMatchObject({
      name: '',
      color: '',
      startPath: '',
      readOnly: false,
      jumps: [],
      useProxy: false,
      proxyKind: 'socks5',
    });
    expect(fields.ssh).toMatchObject({ auth: 'password', host: '', port: '' });
    expect(fields.ssh.id).toMatch(/\S/u);
  });

  it('gives every blank form its own hop id, so two secrets never share a key', () => {
    expect(newServerFields().ssh.id).not.toBe(newServerFields().ssh.id);
  });

  it('is what a state without a server turns into', () => {
    const fields = fieldsFrom({ storedSsh: [] });
    expect(fields).toMatchObject({ name: '', jumps: [], useProxy: false });
  });

  it('cannot be saved yet, and says why', () => {
    expect(problemsOf(newServerFields())).toEqual(
      expect.arrayContaining(['name-empty', 'ssh-host-empty', 'ssh-user-empty']),
    );
  });

  it('can be saved once a name, a host and a user are given', () => {
    expect(problemsOf(filled())).toEqual([]);
  });
});

describe('the fields of a saved server', () => {
  const saved = {
    name: 'Staging',
    color: 'green' as const,
    startPath: '/var/www',
    readOnly: true,
    ssh: {
      id: 'main',
      host: 'stage.example.com',
      port: 2200,
      user: 'deploy',
      auth: 'key' as const,
      keyFile: '~/.ssh/id',
      algorithms: { cipher: '+aes128-cbc' },
      jumps: [{ id: 'j1', host: 'jump', user: 'hop', auth: 'agent' as const, agentSocket: '/s' }],
    },
    proxy: { kind: 'http' as const, host: 'px', port: 3128, user: 'me' },
  };

  it('fill the form without any secret', () => {
    const fields = fieldsFrom({ serverId: 'x', input: saved, storedSsh: [] });
    expect(fields).toMatchObject({
      name: 'Staging',
      color: 'green',
      startPath: '/var/www',
      readOnly: true,
      useProxy: true,
      proxyKind: 'http',
      proxyHost: 'px',
      proxyPort: '3128',
      proxyUser: 'me',
    });
    expect(fields.ssh).toMatchObject({
      id: 'main',
      host: 'stage.example.com',
      port: '2200',
      auth: 'key',
      keyFile: '~/.ssh/id',
      algorithms: { cipher: '+aes128-cbc', kex: '' },
    });
    expect(fields.jumps).toHaveLength(1);
    expect(fields.jumps[0]).toMatchObject({ id: 'j1', auth: 'agent', agentSocket: '/s' });
    expect(fields.ssh.password).toEqual({ value: '', touched: false, erase: false });
    expect(fields.proxyPassword).toEqual({ value: '', touched: false, erase: false });
  });

  it('go back to the same server when nothing is changed', () => {
    const fields = fieldsFrom({ serverId: 'x', input: saved, storedSsh: [] });
    expect(toInput(fields)).toEqual(saved);
  });
});

describe('what is sent', () => {
  it('drops blank optional fields and trims the rest', () => {
    expect(toInput(filled())).toEqual({
      name: 'Web',
      ssh: {
        id: expect.any(String) as string,
        host: 'web.example.com',
        user: 'deploy',
        auth: 'password',
      },
    });
  });

  it('sends a port only when it is written in digits', () => {
    const fields = filled();
    fields.ssh.port = '2222';
    expect(toInput(fields).ssh.port).toBe(2222);
    fields.ssh.port = '22x';
    expect(toInput(fields).ssh.port).toBeUndefined();
    expect(problemsOf(fields)).toContain('ssh-port-invalid');
  });

  it('keeps only the login details of the chosen method', () => {
    const fields = filled();
    fields.ssh.keyFile = '~/.ssh/id';
    fields.ssh.agentSocket = '/s';
    expect(toInput(fields).ssh).not.toHaveProperty('keyFile');
    expect(toInput(fields).ssh).not.toHaveProperty('agentSocket');
    fields.ssh.auth = 'key';
    expect(toInput(fields).ssh).toMatchObject({ keyFile: '~/.ssh/id' });
    fields.ssh.auth = 'agent';
    expect(toInput(fields).ssh).toMatchObject({ agentSocket: '/s' });
  });

  it('wants a key file for a key login', () => {
    const fields = filled();
    fields.ssh.auth = 'key';
    expect(problemsOf(fields)).toContain('ssh-key-empty');
    fields.ssh.keyFile = '~/.ssh/id';
    expect(problemsOf(fields)).toEqual([]);
  });

  it('sends the start folder, read-only and the colour when they are set', () => {
    const fields = filled();
    fields.startPath = ' /srv ';
    fields.readOnly = true;
    fields.color = 'purple';
    expect(toInput(fields)).toMatchObject({ startPath: '/srv', readOnly: true, color: 'purple' });
  });

  it('sends the jump hosts in the order they are shown', () => {
    const fields = filled();
    const first = newHopFields('j1');
    const second = newHopFields('j2');
    first.host = 'a';
    second.host = 'b';
    fields.jumps.push(first, second);
    expect(toInput(fields).ssh.jumps?.map((hop) => hop.host)).toEqual(['a', 'b']);
    moveJump(fields.jumps, 1, -1);
    expect(toInput(fields).ssh.jumps?.map((hop) => hop.host)).toEqual(['b', 'a']);
    moveJump(fields.jumps, 0, -1);
    expect(toInput(fields).ssh.jumps?.map((hop) => hop.host)).toEqual(['b', 'a']);
  });

  it('asks for the problems of a jump host too', () => {
    const fields = filled();
    fields.jumps.push(newHopFields('j1'));
    expect(problemsOf(fields)).toEqual(
      expect.arrayContaining(['ssh-host-empty', 'ssh-user-empty']),
    );
  });

  it('sends the proxy only when it is on', () => {
    const fields = filled();
    fields.proxyHost = 'px';
    expect(toProxy(fields)).toBeUndefined();
    expect(toInput(fields)).not.toHaveProperty('proxy');
    fields.useProxy = true;
    fields.proxyKind = 'http';
    fields.proxyPort = '3128';
    fields.proxyUser = ' me ';
    expect(toProxy(fields)).toEqual({ kind: 'http', host: 'px', port: 3128, user: 'me' });
    fields.proxyPort = '';
    fields.proxyUser = '';
    expect(toProxy(fields)).toEqual({ kind: 'http', host: 'px' });
  });

  it('wants a host and a real port for the proxy', () => {
    const fields = filled();
    fields.useProxy = true;
    expect(problemsOf(fields)).toContain('proxy-host-empty');
    fields.proxyHost = 'px';
    fields.proxyPort = 'abc';
    expect(problemsOf(fields)).toContain('proxy-port-invalid');
    fields.proxyPort = '70000';
    expect(problemsOf(fields)).toContain('proxy-port-invalid');
    fields.proxyPort = '1080';
    expect(problemsOf(fields)).toEqual([]);
  });

  it('wants a name that fits', () => {
    const fields = filled();
    fields.name = 'x'.repeat(201);
    expect(problemsOf(fields)).toContain('too-long');
  });

  it('agrees with the store about what cannot be saved', () => {
    const fields = filled();
    fields.useProxy = true;
    expect(problemsOf(fields)).toEqual(expect.arrayContaining(serverProblems(toInput(fields))));
  });

  it('builds a draft the host accepts', () => {
    const fields = filled();
    fields.useProxy = true;
    fields.proxyHost = 'px';
    fields.ssh.password = { value: 'pw', touched: true, erase: false };
    fields.proxyPassword = { value: 'ppw', touched: true, erase: false };
    const draft = toDraft(fields);
    expect(() => serverFormProtocol.host.requests.save.params.parse(draft)).not.toThrow();
    expect(draft.ssh).toEqual([
      {
        hopId: fields.ssh.id,
        password: { kind: 'set', value: 'pw' },
        passphrase: { kind: 'clear' },
      },
    ]);
    expect(draft.proxyPassword).toEqual({ kind: 'set', value: 'ppw' });
  });

  it('keeps the secrets that were not touched, jump hosts first', () => {
    const fields = filled();
    fields.jumps.push(newHopFields('j1'));
    const draft = toDraft(fields);
    expect(draft.ssh.map((change) => change.hopId)).toEqual(['j1', fields.ssh.id]);
    expect(draft.ssh[1]?.password).toEqual({ kind: 'keep' });
  });

  it('erases the password the chosen method does not use, and the proxy password when asked', () => {
    const fields = filled();
    fields.ssh.auth = 'agent';
    fields.ssh.password = { value: 'old', touched: true, erase: false };
    expect(toDraft(fields).ssh[0]).toMatchObject({
      password: { kind: 'clear' },
      passphrase: { kind: 'clear' },
    });
    fields.useProxy = true;
    fields.proxyHost = 'px';
    fields.proxyPassword = { value: '', touched: false, erase: true };
    expect(toDraft(fields).proxyPassword).toEqual({ kind: 'clear' });
  });

  it('sends no proxy password without a proxy', () => {
    const fields = filled();
    fields.proxyPassword = { value: 'ppw', touched: true, erase: false };
    expect(toDraft(fields)).not.toHaveProperty('proxyPassword');
  });
});

describe('the lines under the fields', () => {
  it('has a translated line for every problem', () => {
    for (const key of Object.values(SERVER_PROBLEM_MESSAGES)) {
      expect(en[key]).toBeTruthy();
      expect(ru[key]).toBeTruthy();
    }
  });
});

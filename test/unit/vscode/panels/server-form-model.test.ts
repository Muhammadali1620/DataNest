// The server form without its page (V13.37): the state it starts with, what "Test connection"
// logs in with and how a save turns the page's secrets into the store's — on a real SSH
// server with an SFTP file system, through the same code the extension uses.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  newSecrets,
  proxyChangeOf,
  proxyPasswordForTest,
  ServerFormModel,
} from '../../../../src/vscode/panels/server-form-model';
import { serverFormProtocol, type ServerDraft } from '../../../../src/shared/protocols/server-form';
import { MemorySftpFs } from '../../../helpers/memory-sftp';
import { startSocksProxy, type TestProxy } from '../../../helpers/proxy-servers';
import { type ServerWorld, startServerWorld } from '../../../helpers/sftp-fixture';

let world: ServerWorld;

beforeEach(async () => {
  world = await startServerWorld(new MemorySftpFs().folder('/home/deploy'));
});

afterEach(async () => {
  await world.shutdown();
});

const keep = { kind: 'keep' } as const;

/** The draft of the saved server as the page would send it back: secrets untouched. */
function draftOf(overrides: Partial<ServerDraft['input']> = {}, ssh: ServerDraft['ssh'] = []) {
  return {
    input: {
      name: 'Web',
      ssh: {
        id: 'main',
        host: '127.0.0.1',
        port: world.server.port,
        user: 'deploy',
        auth: 'password' as const,
      },
      ...overrides,
    },
    ssh: ssh.length === 0 ? [{ hopId: 'main', password: keep, passphrase: keep }] : ssh,
  } satisfies ServerDraft;
}

const typed = (value: string): ServerDraft['ssh'] => [
  { hopId: 'main', password: { kind: 'set', value }, passphrase: { kind: 'clear' } },
];

function model(id?: string): ServerFormModel {
  return new ServerFormModel({ store: world.store, hub: world.hub }, id);
}

describe('the state of the form', () => {
  it('has nothing to show for a new server, and the page accepts that', async () => {
    const state = await model().state();
    expect(state).toEqual({ storedSsh: [] });
    expect(() => serverFormProtocol.webview.events.state.parse(state)).not.toThrow();
  });

  it('describes a saved server without its secrets, only with flags', async () => {
    const state = await model(world.serverId).state();
    expect(state.serverId).toBe(world.serverId);
    expect(state.input).toMatchObject({ name: 'Web', ssh: { id: 'main', user: 'deploy' } });
    expect(state.input).not.toHaveProperty('id');
    expect(state.storedSsh).toEqual([{ hopId: 'main', password: true, passphrase: false }]);
    expect(state.hasStoredProxyPassword).toBeUndefined();
    expect(JSON.stringify(state)).not.toContain('"pw"');
    expect(() => serverFormProtocol.webview.events.state.parse(state)).not.toThrow();
  });

  it('leaves out the fields a server was saved without', async () => {
    const { input } = await model(world.serverId).state();
    expect(Object.values(input ?? {})).not.toContain(undefined);
    expect(input).not.toHaveProperty('startPath');
    expect(input).not.toHaveProperty('readOnly');
  });

  it('says a proxy password is saved', async () => {
    const added = await world.store.add(
      {
        name: 'Through proxy',
        ssh: { id: 'h', host: 'x', user: 'u', auth: 'agent' },
        proxy: { kind: 'socks5', host: 'p', user: 'me' },
      },
      {},
      'proxy-secret',
    );
    const state = await model(added.id).state();
    expect(state.hasStoredProxyPassword).toBe(true);
    expect(state.input?.proxy).toEqual({ kind: 'socks5', host: 'p', user: 'me' });
  });

  it('knows its name, empty until the server is saved', () => {
    expect(model().name).toBe('');
    expect(model(world.serverId).name).toBe('Web');
    expect(model('gone').name).toBe('');
    expect(model().id).toBeUndefined();
  });
});

describe('testing the connection', () => {
  it('logs in with the typed password and answers with the login folder', async () => {
    const result = await model().test(draftOf({}, typed('pw')));
    expect(result).toEqual({ home: '/home/deploy', hops: 1 });
    expect(world.server.logins).toContain('deploy');
  });

  it('is refused with a wrong password', async () => {
    await expect(model().test(draftOf({}, typed('nope')))).rejects.toMatchObject({
      code: 'auth-failed',
    });
  });

  it('uses the saved password while editing when none is typed', async () => {
    const result = await model(world.serverId).test(draftOf());
    expect(result.home).toBe('/home/deploy');
  });

  it('does not use the saved password after it was erased', async () => {
    const erased: ServerDraft['ssh'] = [
      { hopId: 'main', password: { kind: 'clear' }, passphrase: keep },
    ];
    await expect(model(world.serverId).test(draftOf({}, erased))).rejects.toMatchObject({
      code: 'auth-failed',
    });
  });

  it('has no saved password to fall back on for a new server', async () => {
    await expect(model().test(draftOf())).rejects.toMatchObject({ code: 'auth-failed' });
  });

  it('saves nothing and keeps no session open', async () => {
    const before = world.store.list().length;
    await model().test(draftOf({}, typed('pw')));
    expect(world.store.list()).toHaveLength(before);
    expect(world.hub.isOpen(world.serverId)).toBe(false);
  });

  it('counts the jump hosts of the way', async () => {
    const jump = {
      id: 'jump',
      host: '127.0.0.1',
      port: world.server.port,
      user: 'deploy',
      auth: 'password' as const,
    };
    const base = draftOf();
    const draft: ServerDraft = {
      ...base,
      input: { ...base.input, ssh: { ...base.input.ssh, jumps: [jump] } },
      ssh: [
        { hopId: 'jump', password: { kind: 'set', value: 'pw' }, passphrase: { kind: 'clear' } },
        { hopId: 'main', password: { kind: 'set', value: 'pw' }, passphrase: { kind: 'clear' } },
      ],
    };
    const result = await model().test(draft);
    expect(result.hops).toBe(2);
    expect(world.server.forwards).toContain(`127.0.0.1:${world.server.port}`);
  });

  describe('through a proxy', () => {
    let proxy: TestProxy;

    afterEach(async () => {
      await proxy.close();
    });

    const through = (port: number): Partial<ServerDraft['input']> => ({
      proxy: { kind: 'socks5', host: '127.0.0.1', port, user: 'me' },
    });

    it('logs in to the proxy with the typed password', async () => {
      proxy = await startSocksProxy({ user: 'me', password: 'proxy-pw' });
      const draft: ServerDraft = {
        ...draftOf(through(proxy.port), typed('pw')),
        proxyPassword: { kind: 'set', value: 'proxy-pw' },
      };
      await model().test(draft);
      expect(proxy.requests).toEqual([`127.0.0.1:${world.server.port}`]);
    });

    it('is refused by the proxy with a wrong password', async () => {
      proxy = await startSocksProxy({ user: 'me', password: 'proxy-pw' });
      const draft: ServerDraft = {
        ...draftOf(through(proxy.port), typed('pw')),
        proxyPassword: { kind: 'set', value: 'wrong' },
      };
      await expect(model().test(draft)).rejects.toMatchObject({ code: 'auth-failed' });
    });

    it('uses the saved proxy password while editing', async () => {
      proxy = await startSocksProxy({ user: 'me', password: 'proxy-pw' });
      const saved = await world.store.add(
        {
          name: 'Behind a proxy',
          ssh: {
            id: 'main',
            host: '127.0.0.1',
            port: world.server.port,
            user: 'deploy',
            auth: 'password',
          },
          proxy: { kind: 'socks5', host: '127.0.0.1', port: proxy.port, user: 'me' },
        },
        { main: { password: 'pw' } },
        'proxy-pw',
      );
      const result = await model(saved.id).test(draftOf(through(proxy.port)));
      expect(result.hops).toBe(1);
    });

    it('ignores a proxy password when the proxy is off', async () => {
      const draft: ServerDraft = {
        ...draftOf({}, typed('pw')),
        proxyPassword: { kind: 'set', value: 'unused' },
      };
      proxy = await startSocksProxy();
      await expect(model().test(draft)).resolves.toMatchObject({ hops: 1 });
      expect(proxy.requests).toEqual([]);
    });
  });
});

describe('saving', () => {
  it('adds a new server with its secrets in the store and remembers the id', async () => {
    const form = model();
    const id = await form.save({
      ...draftOf(
        { name: 'Staging', startPath: '/var/www', readOnly: true, color: 'green' },
        typed('s3'),
      ),
    });
    expect(form.id).toBe(id);
    expect(form.name).toBe('Staging');
    expect(world.store.get(id)).toMatchObject({
      name: 'Staging',
      startPath: '/var/www',
      readOnly: true,
      color: 'green',
    });
    expect(await world.store.getSshSecrets(id)).toEqual({ main: { password: 's3' } });
  });

  it('keeps a key passphrase and drops the password a key login does not use', async () => {
    const id = await model().save({
      input: {
        name: 'Keyed',
        ssh: { id: 'k', host: 'k.example.com', user: 'me', auth: 'key', keyFile: '~/.ssh/id' },
      },
      ssh: [
        {
          hopId: 'k',
          password: { kind: 'clear' },
          passphrase: { kind: 'set', value: 'phrase' },
        },
      ],
    });
    expect(await world.store.getSshSecrets(id)).toEqual({ k: { passphrase: 'phrase' } });
  });

  it('needs no secret for the agent', async () => {
    const id = await model().save({
      input: { name: 'Agent', ssh: { id: 'a', host: 'a.example.com', user: 'me', auth: 'agent' } },
      ssh: [{ hopId: 'a', password: { kind: 'clear' }, passphrase: { kind: 'clear' } }],
    });
    expect(await world.store.getSshSecrets(id)).toEqual({ a: {} });
  });

  it('saves the secrets of every jump host and of the proxy', async () => {
    const id = await model().save({
      input: {
        name: 'Far',
        ssh: {
          id: 'main',
          host: 'inner',
          user: 'me',
          auth: 'password',
          jumps: [{ id: 'j1', host: 'jump', user: 'hop', auth: 'password' }],
        },
        proxy: { kind: 'http', host: 'proxy', user: 'p' },
      },
      ssh: [
        { hopId: 'j1', password: { kind: 'set', value: 'hop-pw' }, passphrase: { kind: 'clear' } },
        { hopId: 'main', password: { kind: 'set', value: 'in-pw' }, passphrase: { kind: 'clear' } },
      ],
      proxyPassword: { kind: 'set', value: 'proxy-pw' },
    });
    expect(await world.store.getSshSecrets(id)).toEqual({
      j1: { password: 'hop-pw' },
      main: { password: 'in-pw' },
    });
    expect(await world.store.getProxyPassword(id)).toBe('proxy-pw');
  });

  it('updates the server it was opened for and keeps a password that was not retyped', async () => {
    const form = model(world.serverId);
    const id = await form.save(draftOf({ name: 'Web renamed', startPath: '/srv' }));
    expect(id).toBe(world.serverId);
    expect(world.store.get(id)).toMatchObject({ name: 'Web renamed', startPath: '/srv' });
    expect(await world.store.getSshSecrets(id)).toEqual({ main: { password: 'pw' } });
    expect(world.store.list()).toHaveLength(2);
  });

  it('replaces a password that was typed, and erases one that was cleared', async () => {
    const form = model(world.serverId);
    await form.save(draftOf({}, typed('new-pw')));
    expect(await world.store.getSshSecrets(world.serverId)).toEqual({
      main: { password: 'new-pw' },
    });
    await form.save(
      draftOf({}, [{ hopId: 'main', password: { kind: 'clear' }, passphrase: keep }]),
    );
    expect(await world.store.getSshSecrets(world.serverId)).toEqual({ main: {} });
  });

  it('closes the open session, so the next one uses the new settings', async () => {
    await world.hub.session(world.serverId);
    expect(world.hub.isOpen(world.serverId)).toBe(true);
    await model(world.serverId).save(draftOf());
    expect(world.hub.isOpen(world.serverId)).toBe(false);
  });

  it('turns a second save of a new server into an update, not a second server', async () => {
    const form = model();
    const first = await form.save(draftOf({ name: 'Once' }, typed('pw')));
    const before = world.store.list().length;
    const second = await form.save(draftOf({ name: 'Once, renamed' }));
    expect(second).toBe(first);
    expect(world.store.list()).toHaveLength(before);
    expect(world.store.get(first)?.name).toBe('Once, renamed');
    expect(await world.store.getSshSecrets(first)).toEqual({ main: { password: 'pw' } });
  });

  it('removes the secrets of a jump host that was taken out', async () => {
    const form = model();
    const id = await form.save({
      input: {
        name: 'Hops',
        ssh: {
          id: 'main',
          host: 'inner',
          user: 'me',
          auth: 'password',
          jumps: [{ id: 'j1', host: 'jump', user: 'hop', auth: 'password' }],
        },
      },
      ssh: [
        { hopId: 'j1', password: { kind: 'set', value: 'a' }, passphrase: { kind: 'clear' } },
        { hopId: 'main', password: { kind: 'set', value: 'b' }, passphrase: { kind: 'clear' } },
      ],
    });
    await form.save({
      input: { name: 'Hops', ssh: { id: 'main', host: 'inner', user: 'me', auth: 'password' } },
      ssh: [{ hopId: 'main', password: keep, passphrase: keep }],
    });
    expect(await world.store.getSshSecrets(id)).toEqual({ main: { password: 'b' } });
  });

  it('drops the proxy password with the proxy', async () => {
    const form = model();
    const id = await form.save({
      input: {
        name: 'P',
        ssh: { id: 'main', host: 'h', user: 'u', auth: 'agent' },
        proxy: { kind: 'socks5', host: 'p', user: 'x' },
      },
      ssh: [{ hopId: 'main', password: { kind: 'clear' }, passphrase: { kind: 'clear' } }],
      proxyPassword: { kind: 'set', value: 'proxy-pw' },
    });
    expect(await world.store.getProxyPassword(id)).toBe('proxy-pw');
    await form.save({
      input: { name: 'P', ssh: { id: 'main', host: 'h', user: 'u', auth: 'agent' } },
      ssh: [{ hopId: 'main', password: { kind: 'clear' }, passphrase: { kind: 'clear' } }],
    });
    expect(await world.store.getProxyPassword(id)).toBeUndefined();
  });

  it('refuses what the store cannot keep, and saves nothing', async () => {
    const before = world.store.list().length;
    await expect(
      model().save({
        input: { name: '  ', ssh: { id: 'main', host: 'h', user: 'u', auth: 'agent' } },
        ssh: [],
      }),
    ).rejects.toThrow();
    expect(world.store.list()).toHaveLength(before);
  });

  it('refuses to update a server that is gone', async () => {
    await expect(model('gone').save(draftOf())).rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('the secrets of a draft', () => {
  it('takes only what was typed for a new server', () => {
    const draft = draftOf({}, [
      { hopId: 'main', password: { kind: 'set', value: 'x' }, passphrase: keep },
    ]);
    expect(newSecrets(draft)).toEqual({ main: { password: 'x' } });
    expect(newSecrets(draftOf())).toEqual({ main: {} });
    expect(
      newSecrets(
        draftOf({}, [{ hopId: 'main', password: { kind: 'set', value: '' }, passphrase: keep }]),
      ),
    ).toEqual({ main: {} });
  });

  it('reads the proxy password change, and a page that says nothing keeps it', () => {
    expect(proxyChangeOf({})).toEqual({ kind: 'keep' });
    expect(proxyChangeOf({ proxyPassword: { kind: 'set', value: 'v' } })).toEqual({
      kind: 'set',
      value: 'v',
    });
    expect(proxyChangeOf({ proxyPassword: { kind: 'clear' } })).toEqual({ kind: 'clear' });
    expect(proxyChangeOf({ proxyPassword: { kind: 'set' } })).toEqual({ kind: 'set', value: '' });
  });

  it('logs in to the proxy with what was typed, else what is saved', () => {
    expect(proxyPasswordForTest({}, 'saved')).toBe('saved');
    expect(proxyPasswordForTest({ proxyPassword: keep }, 'saved')).toBe('saved');
    expect(proxyPasswordForTest({ proxyPassword: { kind: 'set', value: 'typed' } }, 'saved')).toBe(
      'typed',
    );
    expect(
      proxyPasswordForTest({ proxyPassword: { kind: 'set', value: '' } }, 'saved'),
    ).toBeUndefined();
    expect(proxyPasswordForTest({ proxyPassword: { kind: 'clear' } }, 'saved')).toBeUndefined();
    expect(proxyPasswordForTest({}, undefined)).toBeUndefined();
  });
});

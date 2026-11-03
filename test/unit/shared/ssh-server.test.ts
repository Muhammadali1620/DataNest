import { describe, expect, it } from 'vitest';
import {
  describeServer,
  SERVER_LIMITS,
  serverHops,
  serverProblems,
  sshServerInputSchema,
  sshServerSchema,
  type SshServerInput,
} from '../../../src/shared/ssh-server';

const input: SshServerInput = {
  name: 'Web',
  ssh: { id: 'main', host: 'web.example.com', user: 'deploy', auth: 'password' },
};

describe('describeServer', () => {
  it('shows user and host, and the port only when it is not 22', () => {
    expect(describeServer(input)).toBe('deploy@web.example.com');
    expect(describeServer({ ssh: { ...input.ssh, port: 22 } })).toBe('deploy@web.example.com');
    expect(describeServer({ ssh: { ...input.ssh, port: 2222 } })).toBe(
      'deploy@web.example.com:2222',
    );
  });
});

describe('serverHops', () => {
  it('lists jump hosts first, then the server', () => {
    const hops = serverHops({
      ssh: {
        ...input.ssh,
        jumps: [
          { id: 'j1', host: 'a', user: 'u', auth: 'agent' },
          { id: 'j2', host: 'b', user: 'u', auth: 'agent' },
        ],
      },
    });
    expect(hops.map((hop) => hop.id)).toEqual(['j1', 'j2', 'main']);
  });

  it('has just the server when there are no jumps', () => {
    expect(serverHops(input)).toHaveLength(1);
  });
});

describe('serverProblems', () => {
  it('finds none in a good server', () => {
    expect(serverProblems(input)).toEqual([]);
  });

  it('finds an empty name', () => {
    expect(serverProblems({ ...input, name: '   ' })).toContain('name-empty');
  });

  it('finds a name or a start folder that is too long', () => {
    expect(serverProblems({ ...input, name: 'x'.repeat(SERVER_LIMITS.name + 1) })).toContain(
      'too-long',
    );
    expect(serverProblems({ ...input, startPath: '/'.repeat(SERVER_LIMITS.path + 1) })).toContain(
      'too-long',
    );
  });

  it('finds a proxy without a host or with a port that is not one', () => {
    expect(serverProblems({ ...input, proxy: { kind: 'socks5', host: '  ' } })).toEqual([
      'proxy-host-empty',
    ]);
    expect(serverProblems({ ...input, proxy: { kind: 'http', host: 'p', port: 70_000 } })).toEqual([
      'proxy-port-invalid',
    ]);
    expect(serverProblems({ ...input, proxy: { kind: 'http', host: 'p', port: 0 } })).toEqual([
      'proxy-port-invalid',
    ]);
    expect(serverProblems({ ...input, proxy: { kind: 'socks5', host: 'p' } })).toEqual([]);
    expect(serverProblems({ ...input, proxy: { kind: 'socks5', host: 'p', port: 1080 } })).toEqual(
      [],
    );
  });

  it('finds the problems of every hop, each once', () => {
    const problems = serverProblems({
      ...input,
      ssh: {
        ...input.ssh,
        host: '',
        jumps: [{ id: 'j', host: '', user: '', auth: 'key' }],
      },
    });
    expect(problems.filter((problem) => problem === 'ssh-host-empty')).toHaveLength(1);
    expect(problems).toEqual(
      expect.arrayContaining(['ssh-host-empty', 'ssh-user-empty', 'ssh-key-empty']),
    );
  });
});

describe('schemas', () => {
  it('accepts a server and an input, and the id on top of an input', () => {
    expect(sshServerInputSchema.parse(input)).toEqual(input);
    expect(sshServerSchema.parse({ ...input, id: 'x' })).toEqual({ ...input, id: 'x' });
  });

  it('accepts the optional parts', () => {
    const full = {
      ...input,
      startPath: '/srv',
      readOnly: true,
      color: 'red',
      proxy: { kind: 'http', host: 'p', port: 3128 },
    };
    expect(sshServerInputSchema.parse(full)).toEqual(full);
  });

  it('refuses a missing name, a wrong colour and a server without a login', () => {
    expect(() => sshServerInputSchema.parse({ ssh: input.ssh })).toThrow();
    expect(() => sshServerInputSchema.parse({ ...input, color: 'pink' })).toThrow();
    expect(() => sshServerInputSchema.parse({ name: 'x' })).toThrow();
    expect(() => sshServerSchema.parse(input)).toThrow();
  });
});

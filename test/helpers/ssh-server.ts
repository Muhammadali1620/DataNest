// An SSH server inside the test process (ssh2's own server), so tunnels are tested
// for real — logins, forwarding, host keys — without Docker or the network.

import { timingSafeEqual } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createConnection, createServer, type Server as NetServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentProtocol, type ParsedKey, Server, utils } from 'ssh2';
import { describeHostKey } from '../../src/services/ssh/tunnel';

export interface TestSshUser {
  readonly name: string;
  readonly password?: string;
  /** OpenSSH public key line the user may log in with. */
  readonly publicKey?: string;
  /** Ask for the password through keyboard-interactive instead of `password`. */
  readonly keyboardOnly?: boolean;
}

export interface TestSshServer {
  readonly port: number;
  /** The fingerprint a client should see, as `describeHostKey` reports it. */
  readonly fingerprint: string;
  /** `host:port` of every forward request, in order. */
  readonly forwards: string[];
  /** Users that logged in, in order. */
  readonly logins: string[];
  /** Drops every client connection, as a server restart would. */
  kick(): void;
  close(): Promise<void>;
}

function parsed(key: string | Buffer, passphrase?: string): ParsedKey {
  const result = utils.parseKey(key, passphrase);
  if (result instanceof Error) {
    throw result;
  }
  return Array.isArray(result) ? (result[0] as ParsedKey) : result;
}

function same(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A host key generated once per test run; generating keys is the slow part. */
let hostKey: string | undefined;

export function testHostKey(): string {
  hostKey ??= utils.generateKeyPairSync('ed25519').private;
  return hostKey;
}

/** A user key pair; with a passphrase the private key is encrypted. */
export function testUserKey(passphrase?: string): { private: string; public: string } {
  return utils.generateKeyPairSync(
    'ed25519',
    passphrase === undefined ? {} : { passphrase, cipher: 'aes256-ctr', rounds: 4 },
  );
}

export async function startSshServer(options: {
  readonly users: readonly TestSshUser[];
  /** Destinations the server refuses to reach. */
  readonly refuse?: (host: string, port: number) => boolean;
}): Promise<TestSshServer> {
  const forwards: string[] = [];
  const logins: string[] = [];
  const clients = new Set<{ end(): void }>();
  const key = testHostKey();
  const server = new Server({ hostKeys: [key] }, (client) => {
    clients.add(client);
    client.on('close', () => clients.delete(client));
    client.on('error', () => undefined);
    client.on('authentication', (ctx) => {
      const user = options.users.find((candidate) => candidate.name === ctx.username);
      if (user === undefined) {
        ctx.reject();
        return;
      }
      if (ctx.method === 'password' && user.password !== undefined && !user.keyboardOnly) {
        if (ctx.password === user.password) {
          logins.push(user.name);
          ctx.accept();
        } else {
          ctx.reject();
        }
        return;
      }
      if (ctx.method === 'keyboard-interactive' && user.password !== undefined) {
        ctx.prompt([{ prompt: 'Password: ', echo: false }], (answers) => {
          if (answers[0] === user.password) {
            logins.push(user.name);
            ctx.accept();
          } else {
            ctx.reject();
          }
        });
        return;
      }
      if (ctx.method === 'publickey' && user.publicKey !== undefined) {
        const allowed = parsed(user.publicKey);
        if (ctx.key.algo !== allowed.type || !same(ctx.key.data, allowed.getPublicSSH())) {
          ctx.reject();
          return;
        }
        if (ctx.signature === undefined) {
          // The client asks whether this key would do before signing with it.
          ctx.accept();
          return;
        }
        if (allowed.verify(ctx.blob ?? Buffer.alloc(0), ctx.signature, ctx.hashAlgo)) {
          logins.push(user.name);
          ctx.accept();
        } else {
          ctx.reject();
        }
        return;
      }
      const methods: ('password' | 'publickey' | 'keyboard-interactive')[] = [];
      if (user.password !== undefined) {
        methods.push(user.keyboardOnly === true ? 'keyboard-interactive' : 'password');
      }
      if (user.publicKey !== undefined) {
        methods.push('publickey');
      }
      ctx.reject(methods);
    });
    client.on('ready', () => {
      client.on('tcpip', (accept, reject, info) => {
        forwards.push(`${info.destIP}:${info.destPort}`);
        if (options.refuse?.(info.destIP, info.destPort) === true) {
          reject();
          return;
        }
        const socket = createConnection(info.destPort, info.destIP);
        socket.once('error', () => {
          reject();
        });
        socket.once('connect', () => {
          const stream = accept();
          stream.on('error', () => socket.destroy());
          socket.on('error', () => stream.destroy());
          stream.pipe(socket).pipe(stream);
        });
      });
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as { port: number }).port;
  const publicKey = parsed(key).getPublicSSH();
  return {
    port,
    fingerprint: describeHostKey('127.0.0.1', port, publicKey).fingerprint,
    forwards,
    logins,
    kick: () => {
      for (const client of clients) {
        client.end();
      }
    },
    close: async () => {
      for (const client of clients) {
        client.end();
      }
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

/** A TCP server that answers every line with the same line: the "database". */
export async function startEchoServer(): Promise<{
  readonly port: number;
  readonly connections: () => number;
  close(): Promise<void>;
}> {
  const sockets = new Set<Socket>();
  let total = 0;
  const server: NetServer = createServer((socket) => {
    total += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    socket.pipe(socket);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    port: (server.address() as { port: number }).port,
    connections: () => total,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

/** Sends one message through a local port and returns what came back. */
export async function roundTrip(port: number, message: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const socket = createConnection(port, '127.0.0.1');
    let received = '';
    socket.on('error', reject);
    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString('utf8');
      if (received.length >= message.length) {
        socket.end();
        resolve(received);
      }
    });
    socket.on('close', () => {
      resolve(received);
    });
    socket.write(message);
  });
}

/**
 * An SSH agent on a local socket (a named pipe on Windows) that holds one key, so
 * agent logins are tested without the user's real agent.
 */
export async function startTestAgent(
  privateKey: string | Buffer,
  passphrase?: string,
): Promise<{
  readonly socket: string;
  close(): Promise<void>;
}> {
  const key = parsed(privateKey, passphrase);
  const dir = mkdtempSync(join(tmpdir(), 'datanest-agent-'));
  const socket =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\datanest-agent-${process.pid}-${Date.now()}`
      : join(dir, 'agent.sock');
  const server = createServer((connection) => {
    const protocol = new AgentProtocol(false);
    protocol.on('identities', (request) => {
      protocol.getIdentitiesReply(request, [key]);
    });
    protocol.on('sign', (request, _pubKey, data, options) => {
      const signature = key.sign(data, options.hash);
      if (signature instanceof Error) {
        protocol.failureReply(request);
      } else {
        protocol.signReply(request, signature);
      }
    });
    connection.on('error', () => undefined);
    connection.pipe(protocol).pipe(connection);
  });
  await new Promise<void>((resolve) => {
    server.listen(socket, resolve);
  });
  return {
    socket,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

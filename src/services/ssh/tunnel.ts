// The SSH tunnel itself: log in to each hop through the one before it, then
// forward every connection to a local port on to the database server. Only this
// file (and the bundle entry next to it) imports ssh2.

import { createHash } from 'node:crypto';
import { createServer, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { Client, type ConnectConfig } from 'ssh2';
import { DbError, errorMessage } from '../../core/errors';
import { expandHome, readUserFile } from '../../drivers/common/files';
import type { Logger } from '../../core/logging/logger';
import type { HostKeyInfo, Tunnel, TunnelHop, TunnelSpec } from '../tunnels';
import { msg } from '../../core/user-message';

const KEEPALIVE_INTERVAL_MS = 15_000;
const KEEPALIVE_COUNT_MAX = 3;

/** The OpenSSH agent of Windows listens on this pipe. */
export const WINDOWS_AGENT_PIPE = '\\\\.\\pipe\\openssh-ssh-agent';

/** Where the agent is when the user did not say: `SSH_AUTH_SOCK`, or the Windows pipe. */
export function defaultAgentSocket(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const socket = env.SSH_AUTH_SOCK;
  if (socket !== undefined && socket !== '') {
    return socket;
  }
  return platform === 'win32' ? WINDOWS_AGENT_PIPE : undefined;
}

/** OpenSSH-style fingerprint and the algorithm named inside the key blob. */
export function describeHostKey(host: string, port: number, key: Buffer): HostKeyInfo {
  const fingerprint = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
  const length = key.length >= 4 ? key.readUInt32BE(0) : 0;
  const algorithm =
    length > 0 && length + 4 <= key.length ? key.subarray(4, 4 + length).toString('latin1') : '?';
  return { host, port, algorithm, fingerprint };
}

function where(hop: TunnelHop): string {
  return `${hop.user}@${hop.host}:${hop.port}`;
}

/** The options ssh2 gets for one hop; only the chosen method's credentials are set. */
export async function connectConfig(
  hop: TunnelHop,
  timeoutMs: number,
  env: { platform: NodeJS.Platform; env: Readonly<Record<string, string | undefined>> } = {
    platform: process.platform,
    env: process.env,
  },
): Promise<ConnectConfig> {
  const base: ConnectConfig = {
    host: hop.host,
    port: hop.port,
    username: hop.user,
    readyTimeout: timeoutMs,
    keepaliveInterval: KEEPALIVE_INTERVAL_MS,
    keepaliveCountMax: KEEPALIVE_COUNT_MAX,
  };
  switch (hop.auth) {
    case 'password':
      // Many servers ask for the password through keyboard-interactive instead.
      return { ...base, password: hop.password ?? '', tryKeyboard: true };
    case 'key': {
      const privateKey = await readUserFile(hop.keyFile ?? '', msg('the SSH key file'));
      return {
        ...base,
        privateKey,
        ...(hop.passphrase === undefined || hop.passphrase === ''
          ? {}
          : { passphrase: hop.passphrase }),
      };
    }
    case 'agent': {
      const agent =
        hop.agentSocket === undefined || hop.agentSocket === ''
          ? defaultAgentSocket(env.platform, env.env)
          : expandHome(hop.agentSocket);
      if (agent === undefined) {
        throw new DbError(
          'auth-failed',
          msg('No SSH agent found: SSH_AUTH_SOCK is not set. Start an agent or give its socket.'),
        );
      }
      return { ...base, agent };
    }
  }
}

/** Turns what ssh2 reports into an error the user can act on. */
export function sshError(hop: TunnelHop, error: unknown, hostKeyRejected: boolean): DbError {
  const message = errorMessage(error);
  const level = (error as { level?: unknown } | null)?.level;
  if (hostKeyRejected) {
    return new DbError(
      'permission-denied',
      msg('The host key of {0}:{1} was not trusted', hop.host, hop.port),
      { cause: error },
    );
  }
  if (level === 'client-authentication') {
    return new DbError('auth-failed', msg('SSH login failed for {0}', where(hop)), {
      cause: error,
    });
  }
  if (level === 'client-timeout') {
    return new DbError(
      'timeout',
      msg('The SSH server {0}:{1} did not answer in time', hop.host, hop.port),
      {
        cause: error,
      },
    );
  }
  if (/no passphrase given|bad passphrase|integrity check failed/i.test(message)) {
    return new DbError(
      'auth-failed',
      hop.passphrase === undefined || hop.passphrase === ''
        ? msg('The SSH key of {0} is protected by a passphrase', where(hop))
        : msg('Wrong passphrase for the SSH key of {0}', where(hop)),
      { cause: error },
    );
  }
  if (/Cannot parse privateKey|Unsupported key format/i.test(message)) {
    return new DbError(
      'auth-failed',
      msg('The SSH key of {0} cannot be read: {1}', where(hop), message),
      {
        cause: error,
      },
    );
  }
  return new DbError(
    'connection-failed',
    msg('Cannot connect to the SSH server {0}:{1}: {2}', hop.host, hop.port, message),
    { cause: error },
  );
}

/** Logs in to one hop, over `sock` when it is reached through the previous hop. */
async function login(
  hop: TunnelHop,
  spec: TunnelSpec,
  sock: Duplex | undefined,
  logger: Logger,
): Promise<Client> {
  const config = await connectConfig(hop, spec.timeoutMs);
  const client = new Client();
  let hostKeyRejected = false;
  return await new Promise<Client>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      client.end();
      reject(sshError(hop, error, hostKeyRejected));
    };
    // The listener stays for good: ssh2 may report more errors after the first one
    // (e.g. the socket closing after a timeout), and an unheard 'error' event would
    // crash the extension host. After login they end the tunnel through 'close'.
    client.on('error', (error) => {
      if (settled) {
        logger.warn(`SSH ${hop.host}:${hop.port} failed`, error);
      } else {
        fail(error);
      }
    });
    client.once('ready', () => {
      settled = true;
      resolve(client);
    });
    client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
      finish(prompts.map(() => hop.password ?? ''));
    });
    try {
      client.connect({
        ...config,
        ...(sock === undefined ? {} : { sock }),
        hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => {
          void (async () => {
            let trusted = false;
            try {
              trusted = await spec.checkHostKey(describeHostKey(hop.host, hop.port, key));
            } catch (error) {
              logger.warn('Checking an SSH host key failed', error);
            }
            hostKeyRejected = !trusted;
            verify(trusted);
          })();
        },
      });
    } catch (error) {
      // Key parsing errors are thrown right away instead of emitted.
      fail(error);
    }
  });
}

async function forward(
  client: Client,
  host: string,
  port: number,
  source: { address: string; port: number },
): Promise<Duplex> {
  return await new Promise<Duplex>((resolve, reject) => {
    client.forwardOut(source.address, source.port, host, port, (error, stream) => {
      if (error) {
        reject(error);
      } else {
        resolve(stream);
      }
    });
  });
}

/** Opens the chain of hops and a local port in front of the target. */
export async function openSshTunnel(spec: TunnelSpec, logger: Logger): Promise<Tunnel> {
  if (spec.hops.length === 0) {
    throw new DbError('internal', msg('An SSH tunnel needs at least one server'));
  }
  const clients: Client[] = [];
  const closeClients = (): void => {
    for (const client of [...clients].reverse()) {
      client.end();
    }
  };
  try {
    for (const [index, hop] of spec.hops.entries()) {
      const previous = clients.at(-1);
      let sock: Duplex | undefined;
      if (previous !== undefined) {
        try {
          sock = await forward(previous, hop.host, hop.port, { address: '127.0.0.1', port: 0 });
        } catch (error) {
          const from = spec.hops[index - 1];
          throw new DbError(
            'connection-failed',
            msg(
              'The SSH server {0} cannot reach {1}:{2}: {3}',
              from?.host ?? '?',
              hop.host,
              hop.port,
              errorMessage(error),
            ),
            { cause: error },
          );
        }
      }
      clients.push(await login(hop, spec, sock, logger));
      logger.debug(`SSH logged in to ${hop.host}:${hop.port}`);
    }
  } catch (error) {
    closeClients();
    throw error;
  }
  const last = clients.at(-1);
  const lastHop = spec.hops.at(-1);
  if (last === undefined || lastHop === undefined) {
    throw new DbError('internal', msg('The SSH chain is empty'));
  }
  const server = createServer();
  const sockets = new Set<Socket>();
  let failure: DbError | undefined;
  let closing = false;
  let resolveClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const shutdown = (): void => {
    if (closing) {
      return;
    }
    closing = true;
    server.close();
    for (const socket of sockets) {
      socket.destroy();
    }
    closeClients();
    resolveClosed();
  };
  for (const [index, client] of clients.entries()) {
    client.on('close', () => {
      if (!closing) {
        logger.info(`SSH connection to ${spec.hops[index]?.host ?? '?'} closed`);
      }
      shutdown();
    });
  }

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    void (async () => {
      try {
        const stream = await forward(last, spec.target.host, spec.target.port, {
          address: socket.remoteAddress ?? '127.0.0.1',
          port: socket.remotePort ?? 0,
        });
        failure = undefined;
        stream.on('error', () => socket.destroy());
        stream.on('close', () => socket.destroy());
        socket.on('close', () => stream.destroy());
        socket.pipe(stream).pipe(socket);
      } catch (error) {
        failure = new DbError(
          'connection-failed',
          msg(
            'The SSH server {0} cannot reach {1}:{2}: {3}',
            lastHop.host,
            spec.target.host,
            spec.target.port,
            errorMessage(error),
          ),
          { cause: error },
        );
        logger.warn(failure.message);
        socket.destroy();
      }
    })();
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      // Only this machine may use the port: it leads past the server's firewall.
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  } catch (error) {
    shutdown();
    throw new DbError(
      'connection-failed',
      msg('Cannot open a local port: {0}', errorMessage(error)),
      {
        cause: error,
      },
    );
  }
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  logger.info(`SSH tunnel open on 127.0.0.1:${port} to ${spec.target.host}:${spec.target.port}`);

  return {
    port,
    closed,
    forwardError: () => failure,
    close: async () => {
      shutdown();
      await closed;
    },
  };
}

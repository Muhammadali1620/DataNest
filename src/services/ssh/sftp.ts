// Copying files from a server over SFTP (V12.8). It rides on the same chain of SSH hops as
// a tunnel — jump hosts, proxy, host-key check — and only this file and tunnel.ts import
// ssh2.

import { DbError, errorMessage } from '../../core/errors';
import type { Logger } from '../../core/logging/logger';
import { msg } from '../../core/user-message';
import type {
  DownloadLimits,
  DownloadReport,
  DownloadRequest,
  RemoteFileSpec,
} from '../remote-snapshots';
import { connectChain } from './tunnel';
import type { SFTPWrapper, Stats } from 'ssh2';

/** SFTP status codes the messages below tell apart. */
const NO_SUCH_FILE = 2;
const PERMISSION_DENIED = 3;

function codeOf(error: unknown): number | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? code : undefined;
}

function openSftp(client: {
  sftp(callback: (error: Error | undefined, sftp: SFTPWrapper) => void): unknown;
}): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => {
      if (error) {
        reject(
          new DbError(
            'connection-failed',
            msg('The SSH server does not offer file transfer (SFTP): {0}', errorMessage(error)),
            { cause: error },
          ),
        );
      } else {
        resolve(sftp);
      }
    });
  });
}

function statOf(sftp: SFTPWrapper, path: string): Promise<Stats | undefined> {
  return new Promise((resolve, reject) => {
    sftp.stat(path, (error, stats) => {
      if (!error) {
        resolve(stats);
      } else if (codeOf(error) === NO_SUCH_FILE) {
        resolve(undefined);
      } else if (codeOf(error) === PERMISSION_DENIED) {
        reject(
          new DbError('permission-denied', msg('No permission to read {0} on the server', path), {
            cause: error,
          }),
        );
      } else {
        reject(
          new DbError('connection-failed', msg('Cannot read {0}: {1}', path, errorMessage(error)), {
            cause: error,
          }),
        );
      }
    });
  });
}

function fastGet(sftp: SFTPWrapper, remote: string, local: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.fastGet(remote, local, { concurrency: 16, chunkSize: 32 * 1024 }, (error) => {
      if (error) {
        reject(
          codeOf(error) === PERMISSION_DENIED
            ? new DbError(
                'permission-denied',
                msg('No permission to read {0} on the server', remote),
                {
                  cause: error,
                },
              )
            : new DbError(
                'connection-failed',
                msg('Copying {0} failed: {1}', remote, errorMessage(error)),
                { cause: error },
              ),
        );
      } else {
        resolve();
      }
    });
  });
}

/** Copies the requested files; an optional one that is not there is skipped. */
export async function downloadFiles(
  spec: RemoteFileSpec,
  requests: readonly DownloadRequest[],
  limits: DownloadLimits,
  logger: Logger,
): Promise<DownloadReport> {
  const clients = await connectChain(spec, logger);
  try {
    const last = clients.at(-1);
    if (last === undefined) {
      throw new DbError('internal', msg('The SSH chain is empty'));
    }
    const sftp = await openSftp(last);
    const copied: { remote: string; bytes: number }[] = [];
    for (const request of requests) {
      const stats = await statOf(sftp, request.remote);
      if (stats === undefined) {
        if (request.optional === true) {
          continue;
        }
        throw new DbError(
          'not-found',
          msg('The file {0} does not exist on the server', request.remote),
        );
      }
      if (!stats.isFile()) {
        throw new DbError('unsupported', msg('{0} on the server is not a file', request.remote));
      }
      if (stats.size > limits.maxBytes) {
        throw new DbError(
          'unsupported',
          msg(
            '{0} is {1} MB, more than the {2} MB that are copied. Raise "datanest.sqlite.remoteMaxSizeMb" to open it.',
            request.remote,
            Math.ceil(stats.size / 1_048_576),
            Math.floor(limits.maxBytes / 1_048_576),
          ),
        );
      }
      await fastGet(sftp, request.remote, request.local);
      copied.push({ remote: request.remote, bytes: stats.size });
      logger.debug(`SFTP copied ${request.remote} (${stats.size} bytes)`);
    }
    sftp.end();
    return { copied };
  } finally {
    for (const client of [...clients].reverse()) {
      client.end();
    }
  }
}

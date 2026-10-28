// TLS options shared by the network drivers. The certificate is checked against the
// server's own name even when the connection goes to a local tunnel port
// (`tlsServerName`), so an SSH tunnel never weakens `verify-full`.

import { isIP } from 'node:net';
import { checkServerIdentity, type PeerCertificate } from 'node:tls';
import { DbError, errorMessage } from '../../core/errors';
import type { ResolvedConnectionConfig, SslMode } from '../../shared/connection';
import { readUserFile } from './files';

export interface TlsMaterial {
  readonly mode: SslMode;
  readonly ca?: Buffer;
  readonly cert?: Buffer;
  readonly key?: Buffer;
  /** The name the certificate must be issued for. */
  readonly serverName: string;
}

/** Reads the certificate files of a config; undefined when it does not use TLS. */
export async function tlsMaterial(
  config: ResolvedConnectionConfig,
): Promise<TlsMaterial | undefined> {
  const { ssl } = config;
  if (ssl === undefined) {
    return undefined;
  }
  const read = async (path: string | undefined, what: string): Promise<Buffer | undefined> =>
    path === undefined || path.trim() === '' ? undefined : await readUserFile(path, what);
  const ca = await read(ssl.ca, 'the CA certificate');
  const cert = await read(ssl.cert, 'the client certificate');
  const key = await read(ssl.key, 'the client key');
  return {
    mode: ssl.mode,
    ...(ca === undefined ? {} : { ca }),
    ...(cert === undefined ? {} : { cert }),
    ...(key === undefined ? {} : { key }),
    serverName: config.tlsServerName ?? config.host ?? 'localhost',
  };
}

/** SNI must be a host name; sending an IP address there is not allowed (RFC 6066). */
export function sniName(serverName: string): string | undefined {
  return isIP(serverName) === 0 ? serverName : undefined;
}

/**
 * The identity check for a mode: none below `verify-full`, otherwise Node's own
 * rules against the server's real name (not the host we happened to connect to).
 */
export function identityCheck(
  material: TlsMaterial,
): (host: string, cert: PeerCertificate) => Error | undefined {
  if (material.mode !== 'verify-full') {
    return () => undefined;
  }
  return (_host, cert) => checkServerIdentity(material.serverName, cert);
}

const UNTRUSTED = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_UNTRUSTED',
  'CERT_SIGNATURE_FAILURE',
]);

/** What went wrong with the server certificate, from Node's code or, failing that, its text. */
type CertProblem = 'name' | 'untrusted' | 'dates';

function certProblem(code: string, message: string): CertProblem | undefined {
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
    return 'name';
  }
  if (UNTRUSTED.has(code)) {
    return 'untrusted';
  }
  if (code === 'CERT_HAS_EXPIRED' || code === 'CERT_NOT_YET_VALID') {
    return 'dates';
  }
  // mysql2 replaces Node's code with its own and keeps only the text.
  if (code === 'HANDSHAKE_SSL_ERROR') {
    if (/does not match certificate/i.test(message)) {
      return 'name';
    }
    if (
      /self[- ]signed|unable to (verify|get)|certificate chain|signature failure/i.test(message)
    ) {
      return 'untrusted';
    }
    if (/certificate has expired|not yet valid/i.test(message)) {
      return 'dates';
    }
  }
  return undefined;
}

/**
 * A clear message for a certificate the client refused, or undefined when the error
 * is not about that. Node's own texts ("unable to verify the first certificate") do
 * not say what to do about it.
 */
export function tlsFailure(error: unknown, serverName: string): DbError | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== 'string') {
    return undefined;
  }
  const reason = errorMessage(error);
  const options = { cause: error, driverCode: code };
  switch (certProblem(code, reason)) {
    case 'name':
      return new DbError(
        'connection-failed',
        `The server certificate is not issued for "${serverName}": ${reason}`,
        options,
      );
    case 'untrusted':
      return new DbError(
        'connection-failed',
        `The server certificate is not trusted (${reason}). Choose the CA certificate that issued it, or only encrypt without checking.`,
        options,
      );
    case 'dates':
      return new DbError(
        'connection-failed',
        `The server certificate is not valid now: ${reason}`,
        options,
      );
    case undefined:
      return undefined;
  }
}

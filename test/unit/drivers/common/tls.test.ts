import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PeerCertificate } from 'node:tls';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  identityCheck,
  sniName,
  tlsFailure,
  type TlsMaterial,
  tlsMaterial,
} from '../../../../src/drivers/common/tls';
import type { ResolvedConnectionConfig } from '../../../../src/shared/connection';

const base: ResolvedConnectionConfig = {
  id: 'c',
  name: 'n',
  driver: 'postgres',
  host: 'db.example',
};

describe('tlsMaterial', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'datanest-tls-'));
    writeFileSync(join(dir, 'ca.crt'), 'CA');
    writeFileSync(join(dir, 'client.crt'), 'CERT');
    writeFileSync(join(dir, 'client.key'), 'KEY');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is undefined without TLS settings', async () => {
    expect(await tlsMaterial(base)).toBeUndefined();
  });

  it('reads every file it is given and names the server', async () => {
    const material = await tlsMaterial({
      ...base,
      ssl: {
        mode: 'verify-full',
        ca: join(dir, 'ca.crt'),
        cert: join(dir, 'client.crt'),
        key: join(dir, 'client.key'),
      },
    });
    expect(material?.mode).toBe('verify-full');
    expect(material?.ca?.toString()).toBe('CA');
    expect(material?.cert?.toString()).toBe('CERT');
    expect(material?.key?.toString()).toBe('KEY');
    expect(material?.serverName).toBe('db.example');
  });

  it('checks against the real server name behind a tunnel', async () => {
    const material = await tlsMaterial({
      ...base,
      host: '127.0.0.1',
      tlsServerName: 'db.internal',
      ssl: { mode: 'require' },
    });
    expect(material).toEqual({ mode: 'require', serverName: 'db.internal' });
  });

  it('skips blank paths and reports missing files', async () => {
    expect(await tlsMaterial({ ...base, ssl: { mode: 'verify-ca', ca: ' ' } })).not.toHaveProperty(
      'ca',
    );
    await expect(
      tlsMaterial({ ...base, ssl: { mode: 'verify-ca', cert: join(dir, 'missing') } }),
    ).rejects.toMatchObject({
      code: 'not-found',
      message: expect.stringContaining('the client certificate') as unknown,
    });
  });
});

describe('sniName', () => {
  it('sends host names but never IP addresses', () => {
    expect(sniName('db.example')).toBe('db.example');
    expect(sniName('127.0.0.1')).toBeUndefined();
    expect(sniName('::1')).toBeUndefined();
  });
});

describe('identityCheck', () => {
  const cert = {
    subject: { CN: 'db.example' },
    subjectaltname: 'DNS:db.example',
  } as unknown as PeerCertificate;
  const material = (mode: TlsMaterial['mode'], serverName: string): TlsMaterial => ({
    mode,
    serverName,
  });

  it('does not check names below verify-full', () => {
    expect(identityCheck(material('require', 'other'))('x', cert)).toBeUndefined();
    expect(identityCheck(material('verify-ca', 'other'))('x', cert)).toBeUndefined();
  });

  it('checks the real name, whatever host the socket went to', () => {
    expect(identityCheck(material('verify-full', 'db.example'))('127.0.0.1', cert)).toBeUndefined();
    expect(
      identityCheck(material('verify-full', 'evil.example'))('db.example', cert),
    ).toBeInstanceOf(Error);
  });
});

describe('tlsFailure', () => {
  const withCode = (code: string, message: string) => Object.assign(new Error(message), { code });

  it('explains a certificate for another name', () => {
    expect(
      tlsFailure(withCode('ERR_TLS_CERT_ALTNAME_INVALID', 'Hostname/IP does not match'), 'db'),
    ).toMatchObject({
      code: 'connection-failed',
      message: expect.stringContaining('not issued for "db"') as unknown,
      driverCode: 'ERR_TLS_CERT_ALTNAME_INVALID',
    });
  });

  it('suggests a CA for an untrusted certificate', () => {
    for (const code of ['SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']) {
      expect(tlsFailure(withCode(code, 'x'), 'db')?.message).toContain('Choose the CA certificate');
    }
  });

  it('reports dates', () => {
    expect(
      tlsFailure(withCode('CERT_HAS_EXPIRED', 'certificate has expired'), 'db')?.message,
    ).toContain('not valid now');
  });

  it("reads mysql2's wrapped errors by their text", () => {
    const wrapped = (message: string) => withCode('HANDSHAKE_SSL_ERROR', message);
    expect(
      tlsFailure(wrapped("Hostname/IP does not match certificate's altnames"), 'db')?.message,
    ).toContain('not issued for');
    expect(
      tlsFailure(wrapped('self-signed certificate in certificate chain'), 'db')?.message,
    ).toContain('not trusted');
    expect(tlsFailure(wrapped('certificate has expired'), 'db')?.message).toContain(
      'not valid now',
    );
    expect(tlsFailure(wrapped('wrong version number'), 'db')).toBeUndefined();
  });

  it('leaves other errors alone', () => {
    expect(tlsFailure(withCode('ECONNREFUSED', 'refused'), 'db')).toBeUndefined();
    expect(tlsFailure(new Error('no code'), 'db')).toBeUndefined();
    expect(tlsFailure('text', 'db')).toBeUndefined();
    expect(tlsFailure(null, 'db')).toBeUndefined();
  });
});

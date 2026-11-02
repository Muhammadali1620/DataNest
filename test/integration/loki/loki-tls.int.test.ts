// Grafana Loki over TLS for real (V13.32): the `loki-tls` service of the group `loki` in
// docker/compose.yml, the same server with HTTPS and the test certificate of docker/tls. The
// live view goes over `wss` here, and it has no time limit (`# tail: forever`).

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { request } from 'node:https';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExecuteEvent, Session } from '../../../src/drivers/driver';
import { driver } from '../../../src/drivers/loki';
import type { ResolvedConnectionConfig, SslSettings } from '../../../src/shared/connection';
import { TEST_LOKI } from '../../helpers/loki-servers';

const RUN = `tls${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const SECOND = 1_000_000_000n;

function config(
  ssl?: SslSettings,
  over: Partial<ResolvedConnectionConfig> = {},
): ResolvedConnectionConfig {
  return {
    id: 'loki-tls',
    name: 'Loki over TLS',
    driver: 'loki',
    host: TEST_LOKI.host,
    port: TEST_LOKI.tlsPort,
    ...(ssl === undefined ? {} : { ssl }),
    ...over,
  };
}

function stamp(secondsAgo: number): string {
  return (BigInt(Date.now()) * 1_000_000n - BigInt(secondsAgo) * SECOND).toString();
}

/** Pushes lines over HTTPS, trusting the test CA. */
async function push(app: string, lines: [string, string][]): Promise<void> {
  const ca = await readFile(TEST_LOKI.ca);
  const body = JSON.stringify({ streams: [{ stream: { app }, values: lines }] });
  const status = await new Promise<number>((resolve, reject) => {
    const req = request(
      {
        host: TEST_LOKI.host,
        port: TEST_LOKI.tlsPort,
        path: '/loki/api/v1/push',
        method: 'POST',
        ca,
        servername: 'localhost',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end(body);
  });
  if (status !== 204) {
    throw new Error(`push failed: ${status}`);
  }
}

async function run(session: Session, sql: string): Promise<ExecuteEvent[]> {
  const events: ExecuteEvent[] = [];
  for await (const event of session.execute(sql, {})) {
    events.push(event);
  }
  return events;
}

function linesOf(events: readonly ExecuteEvent[]): unknown[] {
  return events.flatMap((event) => (event.kind === 'rows' ? event.rows.map((row) => row[3]) : []));
}

/** Waits until the TLS server's ingester is ready: its health check only sees the port. */
async function untilReady(): Promise<void> {
  const ca = await readFile(TEST_LOKI.ca);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const ready = await new Promise<boolean>((resolve) => {
      const req = request(
        {
          host: TEST_LOKI.host,
          port: TEST_LOKI.tlsPort,
          path: '/ready',
          ca,
          servername: 'localhost',
        },
        (response) => {
          let text = '';
          response.on('data', (chunk: Buffer) => {
            text += chunk.toString();
          });
          response.on('end', () => {
            resolve(text.trim() === 'ready');
          });
        },
      );
      req.on('error', () => {
        resolve(false);
      });
      req.end();
    });
    if (ready) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('Loki over TLS did not become ready');
}

describe('Grafana Loki over TLS', () => {
  const app = `shop_${RUN}`;
  const sessions: Session[] = [];

  async function open(
    ssl?: SslSettings,
    over: Partial<ResolvedConnectionConfig> = {},
  ): Promise<Session> {
    const session = await driver.openSession(config(ssl, over));
    sessions.push(session);
    return session;
  }

  beforeAll(async () => {
    await untilReady();
    await push(app, [
      [stamp(20), 'order 1 created'],
      [stamp(10), 'order 2 created'],
    ]);
  }, 90_000);

  afterAll(async () => {
    for (const session of sessions) {
      await session.close();
    }
  });

  it('reads over HTTPS when the certificate is checked against the test CA', async () => {
    const session = await open({ mode: 'verify-full', ca: TEST_LOKI.ca });
    expect(linesOf(await run(session, `{app="${app}"}`)).sort()).toEqual([
      'order 1 created',
      'order 2 created',
    ]);
  });

  it('takes any certificate in "require", and "verify-full" also by the name localhost', async () => {
    const session = await open({ mode: 'require' });
    expect(linesOf(await run(session, `{app="${app}"}`))).toHaveLength(2);
    const byName = await open({ mode: 'verify-full', ca: TEST_LOKI.ca }, { host: 'localhost' });
    expect(linesOf(await run(byName, `{app="${app}"}`))).toHaveLength(2);
  });

  it('refuses a certificate the CA did not sign', async () => {
    await expect(open({ mode: 'verify-ca', ca: TEST_LOKI.otherCa })).rejects.toMatchObject({
      code: 'connection-failed',
      message: expect.stringContaining('not trusted') as unknown,
    });
  });

  it('refuses plain text on the HTTPS port', async () => {
    await expect(open(undefined)).rejects.toBeDefined();
  });

  it('follows a query over wss with no time limit, until the row limit', async () => {
    const live = `live_${RUN}`;
    const session = await open({ mode: 'verify-full', ca: TEST_LOKI.ca });
    const pending = run(session, `# tail: forever\n# limit: 2\n{app="${live}"}`);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await push(live, [[stamp(0), 'first live line']]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await push(live, [[stamp(0), 'second live line']]);
    const events = await pending;
    expect(linesOf(events)).toEqual(['first live line', 'second live line']);
    expect(events.at(-1)).toMatchObject({ kind: 'done' });
  }, 40_000);

  it('follows with no time limit until it is cancelled, keeping what it read', async () => {
    const live = `cancel_${RUN}`;
    const session = await open({ mode: 'require' });
    const seen: ExecuteEvent[] = [];
    const pending = (async () => {
      for await (const event of session.execute(`# tail: forever\n{app="${live}"}`, {})) {
        seen.push(event);
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await push(live, [[stamp(0), 'one line']]);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await session.cancel();
    await pending;
    expect(linesOf(seen)).toEqual(['one line']);
    expect(seen.at(-1)).toMatchObject({ kind: 'done' });
  }, 40_000);
});

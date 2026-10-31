// The two checks of the Tools page that talk to a public service, each only after the
// user's click and each to a named host: "what is my public address" (ipify.org) and
// DNS over HTTPS (Cloudflare or Google). `httpGet` is a parameter so the logic is tested
// without a network; `realHttpGet` is plain HTTPS, no redirects, a small body.

import { get } from 'node:https';
import type { NetworkErrorCode } from '../../shared/protocols/tools';
import {
  type DnsRecord,
  type DnsType,
  type DohProvider,
  dohUrl,
  parseDohResponse,
} from '../../shared/tools/doh';
import { checkHost, isIpv4, isIpv6 } from '../../shared/tools/validate';
import { networkErrorOf } from './network';

export interface HttpReply {
  readonly status: number;
  readonly body: string;
}

export type HttpGet = (
  url: string,
  headers: Readonly<Record<string, string>>,
  timeoutMs: number,
) => Promise<HttpReply>;

const MAX_BODY = 256 * 1024;

export const realHttpGet: HttpGet = (url, headers, timeoutMs) =>
  new Promise((resolve, reject) => {
    if (!url.startsWith('https://')) {
      reject(new Error('Only https is allowed'));
      return;
    }
    const request = get(url, { headers: { ...headers }, timeout: timeoutMs }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          request.destroy(new Error('The answer is too large'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
      });
      response.on('error', reject);
    });
    request.on('timeout', () => {
      request.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
    });
    request.on('error', reject);
  });

export const PUBLIC_IP_HOSTS = { v4: 'api.ipify.org', v6: 'api6.ipify.org' } as const;
const TIMEOUT_MS = 6000;

export interface PublicIpResult {
  ipv4?: string;
  ipv6?: string;
  error?: NetworkErrorCode;
}

export class OnlineTools {
  constructor(private readonly httpGet: HttpGet = realHttpGet) {}

  /** The address the internet sees, over IPv4 and, if the machine has it, IPv6. */
  async publicIp(): Promise<PublicIpResult> {
    type Answer = { ok: true; text: string } | { ok: false; error: NetworkErrorCode };
    const ask = async (host: string, valid: (text: string) => boolean): Promise<Answer> => {
      try {
        const reply = await this.httpGet(`https://${host}/`, { Accept: 'text/plain' }, TIMEOUT_MS);
        const text = reply.body.trim();
        return reply.status === 200 && valid(text)
          ? { ok: true, text }
          : { ok: false, error: 'failed' };
      } catch (error) {
        return { ok: false, error: networkErrorOf(error) };
      }
    };
    const [v4, v6] = await Promise.all([
      ask(PUBLIC_IP_HOSTS.v4, isIpv4),
      ask(PUBLIC_IP_HOSTS.v6, isIpv6),
    ]);
    const result: PublicIpResult = {};
    if (v4.ok) {
      result.ipv4 = v4.text;
    }
    if (v6.ok) {
      result.ipv6 = v6.text;
    }
    if (!v4.ok && !v6.ok) {
      // IPv6 is often missing; report the IPv4 failure, which is the one that matters.
      result.error = v4.error;
    }
    return result;
  }

  async dohLookup(
    host: string,
    type: DnsType,
    provider: DohProvider,
  ): Promise<{ records: DnsRecord[]; error?: NetworkErrorCode }> {
    const checked = checkHost(host);
    if (!checked.ok) {
      return { records: [], error: 'invalid-host' };
    }
    try {
      const reply = await this.httpGet(
        dohUrl(provider, checked.value, type),
        { Accept: 'application/dns-json' },
        TIMEOUT_MS,
      );
      if (reply.status !== 200) {
        return { records: [], error: 'failed' };
      }
      const outcome = parseDohResponse(reply.body);
      return outcome.ok ? { records: outcome.records } : { records: [], error: outcome.error };
    } catch (error) {
      return { records: [], error: networkErrorOf(error) };
    }
  }
}

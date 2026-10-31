import { describe, expect, it } from 'vitest';
import {
  DNS_TYPES,
  DOH_HOSTS,
  DOH_PROVIDERS,
  dohUrl,
  parseDohResponse,
} from '../../../../src/shared/tools/doh';

describe('dohUrl', () => {
  it('asks each provider at its own address and escapes the name', () => {
    expect(dohUrl('cloudflare', 'example.com', 'A')).toBe(
      'https://cloudflare-dns.com/dns-query?name=example.com&type=A',
    );
    expect(dohUrl('google', 'a b&c', 'MX')).toBe(
      'https://dns.google/resolve?name=a%20b%26c&type=MX',
    );
  });

  it('names the host that gets the question, for every provider', () => {
    for (const provider of DOH_PROVIDERS) {
      expect(dohUrl(provider, 'x.test', 'A')).toContain(DOH_HOSTS[provider]);
    }
    expect(DNS_TYPES).toEqual(['A', 'AAAA', 'MX', 'TXT', 'CNAME', 'NS']);
  });
});

describe('parseDohResponse', () => {
  const answer = (records: unknown[], status = 0) =>
    JSON.stringify({ Status: status, Answer: records });

  it('reads A, MX, CNAME and NS records, dropping the final dot', () => {
    const outcome = parseDohResponse(
      answer([
        { name: 'example.com.', type: 1, TTL: 300, data: '93.184.216.34' },
        { name: 'example.com.', type: 15, TTL: 60, data: '10 mail.example.com.' },
        { name: 'www.example.com.', type: 5, TTL: 10, data: 'example.com.' },
        { name: 'example.com.', type: 2, TTL: 10, data: 'ns1.example.com.' },
        { name: 'example.com.', type: 28, TTL: 1, data: '2606:2800::1' },
      ]),
    );
    expect(outcome).toEqual({
      ok: true,
      records: [
        { name: 'example.com', type: 'A', ttl: 300, data: '93.184.216.34' },
        { name: 'example.com', type: 'MX', ttl: 60, data: '10 mail.example.com' },
        { name: 'www.example.com', type: 'CNAME', ttl: 10, data: 'example.com' },
        { name: 'example.com', type: 'NS', ttl: 10, data: 'ns1.example.com' },
        { name: 'example.com', type: 'AAAA', ttl: 1, data: '2606:2800::1' },
      ],
    });
  });

  it('joins the quoted pieces of a TXT record and unescapes it', () => {
    const outcome = parseDohResponse(
      answer([{ name: 'x.', type: 16, TTL: 5, data: '"v=spf1 " "include:a.b \\"q\\" -all"' }]),
    );
    expect(outcome).toMatchObject({
      ok: true,
      records: [{ type: 'TXT', data: 'v=spf1 include:a.b "q" -all' }],
    });
  });

  it('keeps a TXT value that has no quotes as it is', () => {
    expect(parseDohResponse(answer([{ name: 'x.', type: 16, data: 'plain' }]))).toMatchObject({
      records: [{ data: 'plain', ttl: 0 }],
    });
  });

  it('says not-found for NXDOMAIN and for an empty answer', () => {
    expect(parseDohResponse(JSON.stringify({ Status: 3 }))).toEqual({
      ok: false,
      error: 'not-found',
    });
    expect(parseDohResponse(JSON.stringify({ Status: 0 }))).toEqual({
      ok: false,
      error: 'not-found',
    });
    expect(parseDohResponse(answer([]))).toEqual({ ok: false, error: 'not-found' });
  });

  it('skips records of kinds the page does not show and malformed ones', () => {
    const outcome = parseDohResponse(
      answer([
        { name: 'x.', type: 99, TTL: 1, data: 'skipped' },
        { name: 5, type: 1, data: '1.1.1.1' },
        null,
        { name: 'x.', type: 1, TTL: 2, data: '1.1.1.1' },
      ]),
    );
    expect(outcome).toMatchObject({ ok: true, records: [{ data: '1.1.1.1' }] });
    if (outcome.ok) {
      expect(outcome.records).toHaveLength(1);
    }
  });

  it('fails on a server error, on text that is no JSON and on a wrong shape', () => {
    expect(parseDohResponse(answer([], 2))).toEqual({ ok: false, error: 'failed' });
    expect(parseDohResponse('<html>')).toEqual({ ok: false, error: 'failed' });
    expect(parseDohResponse('42')).toEqual({ ok: false, error: 'failed' });
    expect(parseDohResponse('null')).toEqual({ ok: false, error: 'failed' });
  });
});

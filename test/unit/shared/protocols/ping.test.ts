import { describe, expect, it } from 'vitest';
import { PING_MAX_TEXT_LENGTH, pingProtocol } from '../../../../src/shared/protocols/ping';

const { host, webview } = pingProtocol;

describe('ping protocol', () => {
  it('lets the webview ping the host with bounded text', () => {
    expect(host.requests.ping.params.parse({ text: 'hi' })).toEqual({ text: 'hi' });
    expect(() =>
      host.requests.ping.params.parse({ text: 'x'.repeat(PING_MAX_TEXT_LENGTH + 1) }),
    ).toThrow();
    expect(() => host.requests.ping.params.parse({ text: 1 })).toThrow();
    expect(() => host.requests.ping.params.parse({})).toThrow();
  });

  it('answers pings with the reply and a positive counter', () => {
    expect(host.requests.ping.result.parse({ reply: 'hi', count: 1 })).toEqual({
      reply: 'hi',
      count: 1,
    });
    expect(() => host.requests.ping.result.parse({ reply: 'hi', count: 0 })).toThrow();
    expect(() => host.requests.ping.result.parse({ reply: 'hi', count: 1.5 })).toThrow();
  });

  it('has an empty ready event', () => {
    expect(host.events.ready.parse({})).toEqual({});
    expect(() => host.events.ready.parse({ extra: true })).toThrow();
  });

  it('lets the host ask the webview to echo text', () => {
    expect(webview.requests.echo.params.parse({ text: 'x' })).toEqual({ text: 'x' });
    expect(webview.requests.echo.result.parse({ text: 'x' })).toEqual({ text: 'x' });
    expect(() => webview.requests.echo.result.parse({ text: null })).toThrow();
  });

  it('sends notices with bounded text', () => {
    expect(webview.events.notice.parse({ text: 'Connected' })).toEqual({ text: 'Connected' });
    expect(() =>
      webview.events.notice.parse({ text: 'x'.repeat(PING_MAX_TEXT_LENGTH + 1) }),
    ).toThrow();
  });
});

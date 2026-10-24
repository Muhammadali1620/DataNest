import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  DEFAULT_RPC_TIMEOUT_MS,
  defineProtocol,
  parseRpcMessage,
  RpcError,
  RpcPeer,
} from '../../../src/shared/rpc';
import { array, number, object, optional, string } from '../../../src/shared/schema';
import { createLinkedTransports, FakeTransport, flush } from '../../helpers/rpc';

const protocol = defineProtocol({
  host: {
    requests: {
      add: { params: object({ a: number(), b: number() }), result: object({ sum: number() }) },
      fail: { params: object({}), result: object({}) },
      slow: { params: object({ ms: number() }), result: object({ done: number() }) },
    },
    events: { ready: object({}), log: object({ line: string(), level: optional(string()) }) },
  },
  webview: {
    requests: { echo: { params: object({ text: string() }), result: object({ text: string() }) } },
    events: { rows: object({ ids: array(number()) }) },
  },
});

type P = typeof protocol;

function setup(options: { timeoutMs?: number } = {}) {
  const transports = createLinkedTransports();
  const hostProblems: string[] = [];
  const webviewProblems: string[] = [];
  const host = new RpcPeer<P['host'], P['webview']>({
    local: protocol.host,
    remote: protocol.webview,
    transport: transports.host,
    onProtocolError: (p) => hostProblems.push(p),
    ...options,
  });
  const webview = new RpcPeer<P['webview'], P['host']>({
    local: protocol.webview,
    remote: protocol.host,
    transport: transports.webview,
    onProtocolError: (p) => webviewProblems.push(p),
    ...options,
  });
  return { host, webview, transports, hostProblems, webviewProblems };
}

async function rejection(promise: Promise<unknown>): Promise<RpcError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RpcError) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected the promise to reject');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('parseRpcMessage', () => {
  it.each([
    [{ kind: 'request', id: 1, method: 'add', params: { a: 1 } }],
    [{ kind: 'request', id: 2, method: 'm', params: undefined }],
    [{ kind: 'response', id: 1, ok: true, result: null }],
    [{ kind: 'response', id: 1, ok: false, error: { code: 'internal', message: 'x' } }],
    [{ kind: 'event', name: 'ready', payload: {} }],
  ])('accepts %j', (message) => {
    expect(parseRpcMessage(message)).toEqual(message);
  });

  it.each([
    ['not an object', 'hello'],
    ['null', null],
    ['an array', [{ kind: 'event' }]],
    ['an unknown kind', { kind: 'command', id: 1 }],
    ['no kind', { id: 1, method: 'x', params: {} }],
    ['id 0', { kind: 'request', id: 0, method: 'x', params: {} }],
    ['a negative id', { kind: 'request', id: -1, method: 'x', params: {} }],
    ['a fractional id', { kind: 'request', id: 1.5, method: 'x', params: {} }],
    ['a string id', { kind: 'request', id: '1', method: 'x', params: {} }],
    ['an empty method', { kind: 'request', id: 1, method: '', params: {} }],
    ['a huge method name', { kind: 'request', id: 1, method: 'm'.repeat(101), params: {} }],
    ['an extra field', { kind: 'request', id: 1, method: 'x', params: {}, extra: 1 }],
    ['a non-boolean ok', { kind: 'response', id: 1, ok: 'yes', result: 1 }],
    ['an error without code', { kind: 'response', id: 1, ok: false, error: { message: 'x' } }],
    ['an error as string', { kind: 'response', id: 1, ok: false, error: 'boom' }],
    ['an event without name', { kind: 'event', payload: {} }],
  ])('rejects %s', (_name, message) => {
    expect(parseRpcMessage(message)).toBeUndefined();
  });

  it('drops a message whose fields throw when read', () => {
    const hostile = {
      kind: 'request',
      get id(): number {
        throw new TypeError('boom');
      },
      method: 'add',
      params: {},
    };
    expect(parseRpcMessage(hostile)).toBeUndefined();
  });
});

describe('RpcPeer requests', () => {
  it('calls the other side and returns a typed result', async () => {
    const { host, webview } = setup();
    host.handle('add', ({ a, b }) => ({ sum: a + b }));
    const result = await webview.request('add', { a: 2, b: 3 });
    expect(result).toEqual({ sum: 5 });
    expectTypeOf(result).toEqualTypeOf<{ sum: number }>();
  });

  it('works in both directions', async () => {
    const { host, webview } = setup();
    webview.handle('echo', ({ text }) => ({ text: text.toUpperCase() }));
    await expect(host.request('echo', { text: 'hi' })).resolves.toEqual({ text: 'HI' });
  });

  it('supports async handlers', async () => {
    const { host, webview } = setup();
    host.handle('add', async ({ a, b }) => {
      await flush(2);
      return { sum: a + b };
    });
    await expect(webview.request('add', { a: 1, b: 1 })).resolves.toEqual({ sum: 2 });
  });

  it('keeps concurrent requests apart, even when answered out of order', async () => {
    const { host, webview } = setup();
    const gates: (() => void)[] = [];
    host.handle(
      'slow',
      ({ ms }) =>
        new Promise((resolve) =>
          gates.push(() => {
            resolve({ done: ms });
          }),
        ),
    );
    const first = webview.request('slow', { ms: 1 });
    const second = webview.request('slow', { ms: 2 });
    await flush();
    gates[1]?.();
    gates[0]?.();
    await expect(Promise.all([first, second])).resolves.toEqual([{ done: 1 }, { done: 2 }]);
  });

  it('uses increasing ids', async () => {
    const { host, webview, transports } = setup();
    host.handle('add', ({ a, b }) => ({ sum: a + b }));
    await webview.request('add', { a: 1, b: 1 });
    await webview.request('add', { a: 1, b: 1 });
    expect(transports.webview.posted.map((m) => (m as { id: number }).id)).toEqual([1, 2]);
  });

  it('validates params before sending', async () => {
    const { webview, transports } = setup();
    // @ts-expect-error -- wrong param type on purpose
    const error = await rejection(webview.request('add', { a: 1, b: 'x' }));
    expect(error.code).toBe('invalid-params');
    expect(error.message).toBe('b: expected finite number, got string');
    expect(transports.webview.posted).toEqual([]);
  });

  it('rejects methods that are not in the protocol', async () => {
    const { webview } = setup();
    for (const method of ['nope', '__proto__', 'constructor', 'toString']) {
      // @ts-expect-error -- unknown method on purpose
      const error = await rejection(webview.request(method, {}));
      expect(error.code).toBe('unknown-method');
    }
  });

  it('answers unknown-method when the other side has no handler', async () => {
    const { webview } = setup();
    const error = await rejection(webview.request('add', { a: 1, b: 2 }));
    expect(error).toMatchObject({ code: 'unknown-method', message: 'Unknown method "add"' });
  });

  it('answers unknown-method for methods outside its protocol', async () => {
    // The host peer from setup() answers, though no handler can exist for this name.
    const { transports } = setup();
    transports.host.deliver({ kind: 'request', id: 7, method: '__proto__', params: {} });
    await flush();
    expect(transports.host.posted).toEqual([
      {
        kind: 'response',
        id: 7,
        ok: false,
        error: { code: 'unknown-method', message: 'Unknown method "__proto__"' },
      },
    ]);
  });

  it('rejects invalid params from the other side without calling the handler', async () => {
    const { host, transports } = setup();
    const handler = vi.fn(() => ({ sum: 0 }));
    host.handle('add', handler);
    transports.host.deliver({ kind: 'request', id: 1, method: 'add', params: { a: 1 } });
    transports.host.deliver({
      kind: 'request',
      id: 2,
      method: 'add',
      params: { a: 1, b: 2, evil: true },
    });
    await flush();
    expect(handler).not.toHaveBeenCalled();
    expect(transports.host.posted).toEqual([
      {
        kind: 'response',
        id: 1,
        ok: false,
        error: {
          code: 'invalid-params',
          message: 'params.b: expected finite number, got undefined',
        },
      },
      {
        kind: 'response',
        id: 2,
        ok: false,
        error: { code: 'invalid-params', message: 'params.evil: unexpected field' },
      },
    ]);
  });

  it('passes the validated copy of params to the handler', async () => {
    const { host, webview } = setup();
    const handler = vi.fn(({ a, b }: { a: number; b: number }) => ({ sum: a + b }));
    host.handle('add', handler);
    await webview.request('add', { a: 1, b: 2 });
    expect(handler).toHaveBeenCalledWith({ a: 1, b: 2 });
  });

  it('forwards handler errors with their code and message only', async () => {
    const { host, webview, transports } = setup();
    host.handle('fail', () => {
      const error = new Error('Connection refused') as Error & { code: string };
      error.code = 'connection-failed';
      throw error;
    });
    const error = await rejection(webview.request('fail', {}));
    expect(error).toBeInstanceOf(RpcError);
    expect(error).toMatchObject({ code: 'connection-failed', message: 'Connection refused' });
    // No stack traces leak to the other side.
    expect(JSON.stringify(transports.host.posted)).not.toContain('at ');
  });

  it.each([
    ['a plain Error', () => new Error('boom'), 'internal', 'boom'],
    ['a string', () => 'bad thing', 'internal', 'bad thing'],
    ['an empty Error', () => new Error(''), 'internal', 'Unexpected error'],
    ['a weird value', () => 42, 'internal', 'Unexpected error'],
    [
      'a code with odd characters',
      () => Object.assign(new Error('x'), { code: 'A B' }),
      'internal',
      'x',
    ],
    ['a numeric code', () => Object.assign(new Error('x'), { code: 1062 }), 'internal', 'x'],
  ])('maps %s thrown by a handler', async (_name, make, code, message) => {
    const { host, webview } = setup();
    host.handle('fail', () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- non-Error throws on purpose
      throw make();
    });
    await expect(rejection(webview.request('fail', {}))).resolves.toMatchObject({ code, message });
  });

  it('refuses to send an invalid result and reports it', async () => {
    const { host, webview, hostProblems } = setup();
    // @ts-expect-error -- wrong result type on purpose
    host.handle('add', () => ({ total: 1 }));
    const error = await rejection(webview.request('add', { a: 1, b: 1 }));
    expect(error).toMatchObject({
      code: 'internal',
      message: 'Method "add" returned an invalid result',
    });
    expect(hostProblems).toEqual([
      'Handler of "add" returned an invalid result: result.total: unexpected field',
    ]);
  });

  it('rejects an invalid result coming from the other side', async () => {
    const { webview, transports } = setup();
    const pending = webview.request('add', { a: 1, b: 1 });
    transports.webview.deliver({ kind: 'response', id: 1, ok: true, result: { sum: 'two' } });
    await expect(rejection(pending)).resolves.toMatchObject({ code: 'invalid-result' });
  });

  it('times out and drops a late response', async () => {
    vi.useFakeTimers();
    const { webview, transports, webviewProblems } = setup({ timeoutMs: 1000 });
    transports.webview.peer = undefined; // nobody answers
    const pending = rejection(webview.request('add', { a: 1, b: 1 }));
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toMatchObject({
      code: 'timeout',
      message: 'Request "add" timed out after 1000 ms',
    });
    transports.webview.deliver({ kind: 'response', id: 1, ok: true, result: { sum: 2 } });
    expect(webviewProblems).toEqual(['Dropped a response to unknown request 1']);
  });

  it('waits 30 seconds by default', async () => {
    vi.useFakeTimers();
    const { webview, transports } = setup();
    transports.webview.peer = undefined; // nobody answers
    let settled = false;
    const pending = webview.request('add', { a: 1, b: 1 }).catch(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(DEFAULT_RPC_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(settled).toBe(true);
  });

  it('clears the timer when the answer arrives', async () => {
    vi.useFakeTimers();
    const { host, webview } = setup();
    host.handle('add', ({ a, b }) => ({ sum: a + b }));
    await webview.request('add', { a: 1, b: 1 });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('RpcPeer handlers', () => {
  it('allows one handler per method', () => {
    const { host } = setup();
    host.handle('add', () => ({ sum: 0 }));
    expect(() => host.handle('add', () => ({ sum: 1 }))).toThrow(
      'Method "add" already has a handler',
    );
  });

  it('rejects handlers for methods outside its protocol', () => {
    const { host } = setup();
    // @ts-expect-error -- unknown method on purpose
    expect(() => host.handle('echo', () => ({ text: '' }))).toThrow(
      'Method "echo" is not in the protocol',
    );
  });

  it('removes a handler on dispose, so it can be registered again', async () => {
    const { host, webview } = setup();
    host.handle('add', () => ({ sum: 1 })).dispose();
    await expect(rejection(webview.request('add', { a: 0, b: 0 }))).resolves.toMatchObject({
      code: 'unknown-method',
    });
    host.handle('add', () => ({ sum: 2 }));
    await expect(webview.request('add', { a: 0, b: 0 })).resolves.toEqual({ sum: 2 });
  });

  it('does not remove a newer handler when an old subscription is disposed twice', async () => {
    const { host, webview } = setup();
    const old = host.handle('add', () => ({ sum: 1 }));
    old.dispose();
    host.handle('add', () => ({ sum: 2 }));
    old.dispose();
    await expect(webview.request('add', { a: 0, b: 0 })).resolves.toEqual({ sum: 2 });
  });
});

describe('RpcPeer events', () => {
  it('delivers validated events to every listener', async () => {
    const { host, webview } = setup();
    const a = vi.fn();
    const b = vi.fn();
    host.on('log', a);
    host.on('log', b);
    webview.emit('log', { line: 'hello' });
    await flush();
    expect(a).toHaveBeenCalledWith({ line: 'hello' });
    expect(b).toHaveBeenCalledWith({ line: 'hello' });
  });

  it('accepts valid events nobody listens to', () => {
    const { transports, hostProblems } = setup();
    transports.host.deliver({ kind: 'event', name: 'ready', payload: {} });
    expect(hostProblems).toEqual([]);
  });

  it('stops delivering after the listener is disposed', async () => {
    const { host, webview } = setup();
    const listener = vi.fn();
    host.on('ready', listener).dispose();
    webview.emit('ready', {});
    await flush();
    expect(listener).not.toHaveBeenCalled();
  });

  it('validates outgoing payloads', () => {
    const { host, transports } = setup();
    expect(() => {
      // @ts-expect-error -- wrong payload on purpose
      host.emit('rows', { ids: ['1'] });
    }).toThrow('ids[0]: expected finite number, got string');
    expect(transports.host.posted).toEqual([]);
  });

  it('refuses to emit events outside the protocol', () => {
    const { host } = setup();
    expect(() => {
      // @ts-expect-error -- unknown event on purpose
      host.emit('ready', {});
    }).toThrow('Event "ready" is not in the protocol');
  });

  it('rejects listeners for events outside its protocol', () => {
    const { host } = setup();
    // @ts-expect-error -- unknown event on purpose
    expect(() => host.on('rows', () => undefined)).toThrow('Event "rows" is not in the protocol');
  });

  it('drops unknown and invalid events and reports them', () => {
    const { host, transports, hostProblems } = setup();
    const listener = vi.fn();
    host.on('log', listener);
    transports.host.deliver({ kind: 'event', name: 'rows', payload: { ids: [] } });
    transports.host.deliver({ kind: 'event', name: 'log', payload: { line: 1 } });
    transports.host.deliver({ kind: 'event', name: 'hasOwnProperty', payload: {} });
    expect(listener).not.toHaveBeenCalled();
    expect(hostProblems).toEqual([
      'Dropped unknown event "rows"',
      'Dropped event "log": payload.line: expected string, got number',
      'Dropped unknown event "hasOwnProperty"',
    ]);
  });

  it('keeps delivering when one listener throws', () => {
    const { host, transports, hostProblems } = setup();
    const after = vi.fn();
    host.on('ready', () => {
      throw new Error('listener bug');
    });
    host.on('ready', after);
    transports.host.deliver({ kind: 'event', name: 'ready', payload: {} });
    expect(after).toHaveBeenCalledOnce();
    expect(hostProblems).toEqual(['Listener of "ready" failed: listener bug']);
  });

  it('lets a listener unsubscribe itself while being called', () => {
    const { host, transports } = setup();
    const calls: string[] = [];
    const sub = host.on('ready', () => {
      calls.push('first');
      sub.dispose();
    });
    host.on('ready', () => calls.push('second'));
    transports.host.deliver({ kind: 'event', name: 'ready', payload: {} });
    transports.host.deliver({ kind: 'event', name: 'ready', payload: {} });
    expect(calls).toEqual(['first', 'second', 'second']);
  });
});

describe('RpcPeer protocol errors', () => {
  it('reports malformed messages and keeps working', async () => {
    const { host, webview, transports, hostProblems } = setup();
    host.handle('add', ({ a, b }) => ({ sum: a + b }));
    for (const junk of ['text', 42, null, { kind: 'request' }, { kind: 'response', id: 1 }]) {
      transports.host.deliver(junk);
    }
    expect(hostProblems).toHaveLength(5);
    expect(new Set(hostProblems)).toEqual(new Set(['Dropped a malformed message']));
    await expect(webview.request('add', { a: 1, b: 2 })).resolves.toEqual({ sum: 3 });
  });

  it('ignores protocol errors when no reporter is given', () => {
    const transport = new FakeTransport();
    const peer = new RpcPeer({ local: protocol.host, remote: protocol.webview, transport });
    expect(() => {
      transport.deliver('junk');
    }).not.toThrow();
    peer.dispose();
  });
});

describe('RpcPeer dispose', () => {
  it('rejects pending requests and stops listening', async () => {
    const { webview, transports } = setup();
    const pending = rejection(webview.request('add', { a: 1, b: 1 }));
    expect(transports.webview.listenerCount).toBe(1);
    webview.dispose();
    await expect(pending).resolves.toMatchObject({
      code: 'disposed',
      message: 'Request "add" was cancelled',
    });
    expect(webview.isDisposed).toBe(true);
    expect(transports.webview.listenerCount).toBe(0);
  });

  it('refuses new requests and ignores emits after dispose', async () => {
    const { host, transports } = setup();
    host.dispose();
    await expect(rejection(host.request('echo', { text: 'x' }))).resolves.toMatchObject({
      code: 'disposed',
    });
    host.emit('rows', { ids: [] });
    expect(transports.host.posted).toEqual([]);
  });

  it('does not answer a request whose handler finished after dispose', async () => {
    const { host, transports } = setup();
    let finish: (() => void) | undefined;
    host.handle(
      'slow',
      () =>
        new Promise(
          (resolve) =>
            (finish = () => {
              resolve({ done: 1 });
            }),
        ),
    );
    transports.host.deliver({ kind: 'request', id: 1, method: 'slow', params: { ms: 1 } });
    await flush();
    host.dispose();
    finish?.();
    await flush();
    expect(transports.host.posted).toEqual([]);
  });

  it('ignores messages that arrive after dispose and can be disposed twice', () => {
    const { host, transports, hostProblems } = setup();
    host.dispose();
    host.dispose();
    transports.host.deliver('junk');
    expect(hostProblems).toEqual([]);
  });

  it('ignores input even if the transport keeps calling after unsubscribe', () => {
    const listeners: ((message: unknown) => void)[] = [];
    const leaky = {
      post: vi.fn(),
      subscribe: (listener: (message: unknown) => void) => {
        listeners.push(listener);
        return { dispose: () => undefined };
      },
    };
    const problems: string[] = [];
    const peer = new RpcPeer({
      local: protocol.host,
      remote: protocol.webview,
      transport: leaky,
      onProtocolError: (p) => problems.push(p),
    });
    const handler = vi.fn(() => ({ sum: 0 }));
    peer.handle('add', handler);
    peer.dispose();
    listeners[0]?.({ kind: 'request', id: 1, method: 'add', params: { a: 1, b: 1 } });
    listeners[0]?.('junk');
    expect(handler).not.toHaveBeenCalled();
    expect(leaky.post).not.toHaveBeenCalled();
    expect(problems).toEqual([]);
  });

  it('clears timers of pending requests', async () => {
    vi.useFakeTimers();
    const { webview } = setup();
    const pending = rejection(webview.request('add', { a: 1, b: 1 }));
    webview.dispose();
    await pending;
    expect(vi.getTimerCount()).toBe(0);
  });
});

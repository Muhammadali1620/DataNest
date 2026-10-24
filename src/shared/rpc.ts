// Typed RPC between the extension host and a webview (ARCHITECTURE.md §5).
// Both sides use the same RpcPeer; a protocol describes what each side handles,
// and every incoming message is validated against it before anything runs.

import { type Infer, isPlainObject, number, object, type Schema, string, unknown } from './schema';

export interface RequestSpec<P, R> {
  readonly params: Schema<P>;
  readonly result: Schema<R>;
}

/** What one side handles: requests it answers and events it receives. */
export interface SideSpec {
  readonly requests: Readonly<Record<string, RequestSpec<unknown, unknown>>>;
  readonly events: Readonly<Record<string, Schema<unknown>>>;
}

export interface ProtocolSpec {
  readonly host: SideSpec;
  readonly webview: SideSpec;
}

/** Keeps literal keys of a protocol while checking its shape. */
export function defineProtocol<const P extends ProtocolSpec>(protocol: P): P {
  return protocol;
}

type RequestName<S extends SideSpec> = keyof S['requests'] & string;
type EventName<S extends SideSpec> = keyof S['events'] & string;
export type ParamsOf<S extends SideSpec, M extends RequestName<S>> = Infer<
  S['requests'][M]['params']
>;
export type ResultOf<S extends SideSpec, M extends RequestName<S>> = Infer<
  S['requests'][M]['result']
>;
export type PayloadOf<S extends SideSpec, E extends EventName<S>> = Infer<S['events'][E]>;

export interface RpcSubscription {
  dispose(): void;
}

/** `webview.postMessage` / `onDidReceiveMessage` on the host, `vscode.postMessage` / `message` events in the webview. */
export interface RpcTransport {
  post(message: unknown): void;
  subscribe(listener: (message: unknown) => void): RpcSubscription;
}

/** Codes produced by the RPC layer itself; handlers may also reject with their own codes. */
export type RpcErrorCode =
  'unknown-method' | 'invalid-params' | 'invalid-result' | 'timeout' | 'disposed' | 'internal';

export class RpcError extends Error {
  override readonly name = 'RpcError';

  constructor(
    readonly code: RpcErrorCode | (string & {}),
    message: string,
  ) {
    super(message);
  }
}

export type RpcMessage =
  | {
      readonly kind: 'request';
      readonly id: number;
      readonly method: string;
      readonly params: unknown;
    }
  | { readonly kind: 'response'; readonly id: number; readonly ok: true; readonly result: unknown }
  | {
      readonly kind: 'response';
      readonly id: number;
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    }
  | { readonly kind: 'event'; readonly name: string; readonly payload: unknown };

const MAX_NAME_LENGTH = 100;
const id = number({ integer: true, min: 1, max: Number.MAX_SAFE_INTEGER });
const name = string({ minLength: 1, maxLength: MAX_NAME_LENGTH });
const ENVELOPES = {
  request: object({ kind: string(), id, method: name, params: unknown() }),
  okResponse: object({ kind: string(), id, ok: unknown(), result: unknown() }),
  errorResponse: object({
    kind: string(),
    id,
    ok: unknown(),
    error: object({ code: name, message: string({ maxLength: 10_000 }) }),
  }),
  event: object({ kind: string(), name, payload: unknown() }),
};

/** Checks the envelope of an incoming message; returns undefined for anything it cannot read. */
export function parseRpcMessage(value: unknown): RpcMessage | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  try {
    switch (value.kind) {
      case 'request':
        return { ...ENVELOPES.request.parse(value), kind: 'request' };
      case 'response':
        if (value.ok === true) {
          return { ...ENVELOPES.okResponse.parse(value), kind: 'response', ok: true };
        }
        if (value.ok === false) {
          return { ...ENVELOPES.errorResponse.parse(value), kind: 'response', ok: false };
        }
        return undefined;
      case 'event':
        return { ...ENVELOPES.event.parse(value), kind: 'event' };
      default:
        return undefined;
    }
  } catch (_error) {
    // Input from the other side is hostile until proven otherwise: a schema mismatch
    // or even a throwing getter just means the message is dropped.
    return undefined;
  }
}

export interface RpcPeerOptions<Local extends SideSpec, Remote extends SideSpec> {
  /** What this side handles. */
  readonly local: Local;
  /** What the other side handles. */
  readonly remote: Remote;
  readonly transport: RpcTransport;
  /** How long `request` waits for an answer. */
  readonly timeoutMs?: number;
  /** Malformed or unexpected input from the other side; it is dropped after reporting. */
  readonly onProtocolError?: (problem: string) => void;
}

interface Pending {
  readonly method: string;
  readonly result: Schema<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: RpcError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

type Handler = (params: unknown) => unknown;
type Listener = (payload: unknown) => void;

export const DEFAULT_RPC_TIMEOUT_MS = 30_000;

export class RpcPeer<Local extends SideSpec, Remote extends SideSpec> {
  private readonly local: Local;
  private readonly remote: Remote;
  private readonly transport: RpcTransport;
  private readonly timeoutMs: number;
  private readonly onProtocolError: (problem: string) => void;
  private readonly subscription: RpcSubscription;
  private readonly handlers = new Map<string, Handler>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private disposed = false;

  constructor(options: RpcPeerOptions<Local, Remote>) {
    this.local = options.local;
    this.remote = options.remote;
    this.transport = options.transport;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    this.onProtocolError = options.onProtocolError ?? (() => undefined);
    this.subscription = this.transport.subscribe((message) => {
      this.receive(message);
    });
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Answers requests of the other side. One handler per method. */
  handle<M extends RequestName<Local>>(
    method: M,
    handler: (params: ParamsOf<Local, M>) => ResultOf<Local, M> | Promise<ResultOf<Local, M>>,
  ): RpcSubscription {
    if (!Object.hasOwn(this.local.requests, method)) {
      throw new Error(`Method "${method}" is not in the protocol`);
    }
    if (this.handlers.has(method)) {
      throw new Error(`Method "${method}" already has a handler`);
    }
    this.handlers.set(method, handler as Handler);
    return {
      dispose: () => {
        if (this.handlers.get(method) === handler) {
          this.handlers.delete(method);
        }
      },
    };
  }

  /** Listens to events from the other side. */
  on<E extends EventName<Local>>(
    event: E,
    listener: (payload: PayloadOf<Local, E>) => void,
  ): RpcSubscription {
    if (!Object.hasOwn(this.local.events, event)) {
      throw new Error(`Event "${event}" is not in the protocol`);
    }
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    const entry = listener as Listener;
    set.add(entry);
    return {
      dispose: () => {
        this.listeners.get(event)?.delete(entry);
      },
    };
  }

  /** Calls a method of the other side and waits for its validated result. */
  async request<M extends RequestName<Remote>>(
    method: M,
    params: ParamsOf<Remote, M>,
  ): Promise<ResultOf<Remote, M>> {
    if (this.disposed) {
      throw new RpcError('disposed', 'RPC peer is disposed');
    }
    const spec = this.remote.requests[method];
    if (!spec || !Object.hasOwn(this.remote.requests, method)) {
      throw new RpcError('unknown-method', `Method "${method}" is not in the protocol`);
    }
    const cleanParams = this.validate(spec.params, params, 'invalid-params');
    const id = this.nextId++;
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError('timeout', `Request "${method}" timed out after ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      this.pending.set(id, { method, result: spec.result, resolve, reject, timer });
    });
    this.send({ kind: 'request', id, method, params: cleanParams });
    return (await result) as ResultOf<Remote, M>;
  }

  /** Sends an event to the other side. */
  emit<E extends EventName<Remote>>(event: E, payload: PayloadOf<Remote, E>): void {
    if (this.disposed) {
      return;
    }
    const schema = this.remote.events[event];
    if (!schema || !Object.hasOwn(this.remote.events, event)) {
      throw new RpcError('unknown-method', `Event "${event}" is not in the protocol`);
    }
    this.send({
      kind: 'event',
      name: event,
      payload: this.validate(schema, payload, 'invalid-params'),
    });
  }

  /** Stops listening and rejects all pending requests. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.subscription.dispose();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new RpcError('disposed', `Request "${pending.method}" was cancelled`));
    }
    this.pending.clear();
    this.handlers.clear();
    this.listeners.clear();
  }

  private receive(raw: unknown): void {
    if (this.disposed) {
      return;
    }
    const message = parseRpcMessage(raw);
    if (!message) {
      this.onProtocolError('Dropped a malformed message');
      return;
    }
    switch (message.kind) {
      case 'request':
        void this.answer(message.id, message.method, message.params);
        return;
      case 'response':
        this.settle(message);
        return;
      case 'event':
        this.dispatch(message.name, message.payload);
        return;
    }
  }

  private async answer(id: number, method: string, rawParams: unknown): Promise<void> {
    const spec = Object.hasOwn(this.local.requests, method)
      ? this.local.requests[method]
      : undefined;
    const handler = this.handlers.get(method);
    if (!spec || !handler) {
      this.reply(id, new RpcError('unknown-method', `Unknown method "${method}"`));
      return;
    }
    let params: unknown;
    try {
      params = spec.params.parse(rawParams, 'params');
    } catch (error) {
      this.reply(id, new RpcError('invalid-params', messageOf(error)));
      return;
    }
    let result: unknown;
    try {
      result = await handler(params);
    } catch (error) {
      this.reply(id, new RpcError(codeOf(error), messageOf(error)));
      return;
    }
    try {
      result = spec.result.parse(result, 'result');
    } catch (error) {
      this.onProtocolError(
        `Handler of "${method}" returned an invalid result: ${messageOf(error)}`,
      );
      this.reply(id, new RpcError('internal', `Method "${method}" returned an invalid result`));
      return;
    }
    this.reply(id, undefined, result);
  }

  private reply(id: number, error: RpcError | undefined, result?: unknown): void {
    if (this.disposed) {
      return;
    }
    this.send(
      error
        ? { kind: 'response', id, ok: false, error: { code: error.code, message: error.message } }
        : { kind: 'response', id, ok: true, result },
    );
  }

  private settle(message: Extract<RpcMessage, { kind: 'response' }>): void {
    const pending = this.pending.get(message.id);
    if (!pending) {
      this.onProtocolError(`Dropped a response to unknown request ${message.id}`);
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (!message.ok) {
      pending.reject(new RpcError(message.error.code, message.error.message));
      return;
    }
    try {
      pending.resolve(pending.result.parse(message.result, 'result'));
    } catch (error) {
      pending.reject(new RpcError('invalid-result', messageOf(error)));
    }
  }

  private dispatch(event: string, rawPayload: unknown): void {
    const schema = Object.hasOwn(this.local.events, event) ? this.local.events[event] : undefined;
    if (!schema) {
      this.onProtocolError(`Dropped unknown event "${event}"`);
      return;
    }
    let payload: unknown;
    try {
      payload = schema.parse(rawPayload, 'payload');
    } catch (error) {
      this.onProtocolError(`Dropped event "${event}": ${messageOf(error)}`);
      return;
    }
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      try {
        listener(payload);
      } catch (error) {
        this.onProtocolError(`Listener of "${event}" failed: ${messageOf(error)}`);
      }
    }
  }

  private validate(schema: Schema<unknown>, value: unknown, code: RpcErrorCode): unknown {
    try {
      return schema.parse(value);
    } catch (error) {
      throw new RpcError(code, messageOf(error));
    }
  }

  private send(message: RpcMessage): void {
    this.transport.post(message);
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message !== '') {
    return error.message;
  }
  return typeof error === 'string' && error !== '' ? error : 'Unexpected error';
}

/** Keeps codes like DbError's `connection-failed`; anything else becomes `internal`. */
function codeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const { code } = error;
    if (typeof code === 'string' && /^[a-z][a-z-]{0,63}$/.test(code)) {
      return code;
    }
  }
  return 'internal';
}

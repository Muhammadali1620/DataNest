// What the Kafka topic page (V13.23) shows and does, free of `vscode`: it lists the
// partitions, reads the messages of one of them and sends a message. Nothing here commits
// an offset or joins a group of the user's (D153): reading goes through the session's
// `readMessages`, which uses a throw-away group and never commits.

import { DbError } from '../../core/errors';
import { msg } from '../../core/user-message';
import type { KafkaMessage, KafkaSession } from '../../drivers/kafka-driver';
import {
  DEFAULT_KAFKA_COUNT,
  type KafkaMessageView,
  type KafkaReadMode,
  type KafkaTopicState,
  MAX_KAFKA_COUNT,
} from '../../shared/protocols/kafka-topic';
import { redisValueBytes, type RedisValue, redisValueOf } from '../../shared/redis-value';

/** Bytes of one key, value or header the page shows; the rest is cut and says so. */
export const MAX_SHOWN_BYTES = 256 * 1024;

/** Bytes a read brings at most, all messages together. */
export const MAX_READ_BYTES = 8 * 1024 * 1024;

export interface KafkaTopicModelDeps {
  readonly topic: string;
  readonly internal: boolean;
  readonly connectionName: string;
  readonly readOnly: boolean;
  /** The session of the topic's connection. */
  readonly session: () => Promise<KafkaSession>;
  /** Milliseconds live messages are gathered before the page hears of them. */
  readonly tailFlushMs?: number;
}

/** How long live messages are gathered before the page is told. */
export const DEFAULT_TAIL_FLUSH_MS = 250;

export interface KafkaReadParams {
  readonly partition: number;
  readonly mode: KafkaReadMode;
  readonly count: number;
  readonly offset?: string | undefined;
  readonly time?: string | undefined;
}

export interface KafkaProduceParams {
  readonly partition?: number | undefined;
  readonly key?: RedisValue | undefined;
  readonly value: RedisValue | null;
  readonly headers: readonly { readonly name: string; readonly value: string }[];
}

/** A moment typed by the user: milliseconds, or any date and time `Date.parse` reads. */
export function parseMoment(text: string): number {
  const trimmed = text.trim();
  const ms = /^\d{9,}$/u.test(trimmed) ? Number(trimmed) : Date.parse(trimmed);
  if (!Number.isFinite(ms) || ms < 0) {
    throw new DbError('syntax', msg('"{0}" is not a date and time', text));
  }
  return ms;
}

function shown(bytes: Uint8Array | null): RedisValue | null {
  return bytes === null ? null : redisValueOf(bytes, MAX_SHOWN_BYTES, bytes.length);
}

export function viewOf(message: KafkaMessage): KafkaMessageView {
  return {
    partition: message.partition,
    offset: message.offset,
    timestamp: message.timestamp,
    key: shown(message.key),
    value: shown(message.value),
    headers: message.headers.map((header) => ({
      name: header.name,
      value: redisValueOf(header.value, MAX_SHOWN_BYTES, header.value.length),
    })),
  };
}

export class KafkaTopicModel {
  private partitions: KafkaTopicState['partitions'] = [];
  private messages: KafkaMessageView[] = [];
  private asked: KafkaReadParams = { partition: 0, mode: 'last', count: DEFAULT_KAFKA_COUNT };
  private read = false;
  private notice: string | undefined;
  private tail: AbortController | undefined;
  private tailPending: KafkaMessageView[] = [];
  private tailTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly deps: KafkaTopicModelDeps) {}

  get topic(): string {
    return this.deps.topic;
  }

  /** True while the topic is followed live. */
  get tailing(): boolean {
    return this.tail !== undefined;
  }

  /** What the page renders. */
  state(): KafkaTopicState {
    return {
      topic: this.deps.topic,
      internal: this.deps.internal,
      connectionName: this.deps.connectionName,
      readOnly: this.deps.readOnly,
      partitions: this.partitions,
      partition: this.asked.partition,
      mode: this.asked.mode,
      count: this.asked.count,
      messages: this.messages,
      read: this.read,
      ...(this.notice === undefined ? {} : { notice: this.notice }),
      ...(this.tail === undefined ? {} : { tailing: true }),
    };
  }

  /** Lists the partitions again. */
  async refresh(): Promise<KafkaTopicState> {
    const session = await this.deps.session();
    const details = await session.describeTopic(this.deps.topic);
    this.partitions = details.partitions.map((one) => ({ ...one }));
    // A first look opens the partition that holds messages, not an empty zero.
    if (!this.read && this.partitions.length > 0) {
      const first =
        this.partitions.find((one) => BigInt(one.high) > BigInt(one.low)) ?? this.partitions[0];
      this.asked = { ...this.asked, partition: first?.partition ?? 0 };
    }
    return this.state();
  }

  /** Reads messages of one partition as asked. */
  async readMessages(params: KafkaReadParams, signal?: AbortSignal): Promise<KafkaTopicState> {
    this.stopTail();
    const session = await this.deps.session();
    const count = Math.min(Math.max(1, Math.trunc(params.count)), MAX_KAFKA_COUNT);
    let fromOffset: string | undefined;
    let notice: string | undefined;
    if (params.mode === 'offset') {
      if (params.offset === undefined || !/^\d+$/u.test(params.offset.trim())) {
        throw new DbError('syntax', msg('The offset must be a whole number'));
      }
      fromOffset = params.offset.trim();
    } else if (params.mode === 'time') {
      const moment = parseMoment(params.time ?? '');
      const found = await session.offsetsForTime(this.deps.topic, moment);
      const offset = found.get(params.partition);
      if (offset === undefined || offset === '-1') {
        // The moment is after the last message: there is nothing at or after it.
        this.messages = [];
        this.asked = { ...params, count };
        this.read = true;
        this.notice = msg('There is no message at or after that moment');
        return this.state();
      }
      fromOffset = offset;
    }
    const messages = await session.readMessages({
      topic: this.deps.topic,
      partition: params.partition,
      ...(fromOffset === undefined ? {} : { fromOffset }),
      count,
      maxBytes: MAX_READ_BYTES,
      ...(signal === undefined ? {} : { signal }),
    });
    this.messages = messages.map(viewOf);
    this.asked = { ...params, count };
    this.read = true;
    if (messages.length === 0) {
      // A moment after the last message starts at the end: nothing is at or after it.
      notice =
        params.mode === 'time'
          ? msg('There is no message at or after that moment')
          : msg('The partition holds no messages');
    } else if (messages.length < count && params.mode !== 'last') {
      notice = msg('Only {0} messages were there to read', messages.length);
    }
    this.notice = notice;
    return this.state();
  }

  /**
   * Follows a partition: the messages that arrive from now on are added to the ones shown
   * (kept up to what a read brings, the oldest go first) and `onChange` is called, at most
   * once per flush interval, so the page can show them. A failure ends the tail and says so.
   */
  async startTail(partition: number, onChange: () => void): Promise<KafkaTopicState> {
    this.stopTail();
    const session = await this.deps.session();
    if (this.asked.partition !== partition || !this.read) {
      this.messages = [];
    }
    this.asked = { ...this.asked, partition };
    this.read = true;
    this.notice = undefined;
    const abort = new AbortController();
    this.tail = abort;
    const flushMs = this.deps.tailFlushMs ?? DEFAULT_TAIL_FLUSH_MS;
    const flush = (): void => {
      this.tailTimer = undefined;
      this.takePending();
      onChange();
    };
    void session
      .watchMessages({ topic: this.deps.topic, partition, signal: abort.signal }, (arrived) => {
        if (this.tail !== abort) {
          return;
        }
        this.tailPending.push(...arrived.map(viewOf));
        this.tailTimer ??= setTimeout(flush, flushMs);
      })
      .catch((error: unknown) => {
        if (this.tail !== abort) {
          return;
        }
        this.stopTail();
        this.notice = msg(
          'Live reading stopped: {0}',
          error instanceof Error ? error.message : String(error),
        );
        onChange();
      });
    return this.state();
  }

  /** Stops following the partition; what arrived is kept. */
  stopTail(): KafkaTopicState {
    const running = this.tail;
    this.tail = undefined;
    running?.abort();
    if (this.tailTimer !== undefined) {
      clearTimeout(this.tailTimer);
      this.tailTimer = undefined;
    }
    this.takePending();
    return this.state();
  }

  private takePending(): void {
    if (this.tailPending.length === 0) {
      return;
    }
    this.messages = [...this.messages, ...this.tailPending].slice(-MAX_KAFKA_COUNT);
    this.tailPending = [];
  }

  /** Sends one message and reads the partitions again. */
  async produce(params: KafkaProduceParams): Promise<{
    readonly state: KafkaTopicState;
    readonly partition: number;
    readonly offset: string;
  }> {
    this.requireWritable();
    const session = await this.deps.session();
    const key = params.key === undefined ? undefined : this.bytes(params.key);
    const value = params.value === null ? null : this.bytes(params.value);
    const headers = params.headers
      .filter((header) => header.name.trim() !== '')
      .map((header) => ({
        name: header.name.trim(),
        value: new TextEncoder().encode(header.value),
      }));
    const produced = await session.produce({
      topic: this.deps.topic,
      ...(params.partition === undefined ? {} : { partition: params.partition }),
      ...(key === undefined || key.length === 0 ? {} : { key }),
      value,
      headers,
    });
    await this.refresh();
    return { state: this.state(), partition: produced.partition, offset: produced.offset };
  }

  async deleteTopic(): Promise<void> {
    this.requireWritable();
    this.stopTail();
    await (await this.deps.session()).deleteTopic(this.deps.topic);
  }

  private bytes(value: RedisValue): Uint8Array {
    const bytes = redisValueBytes(value);
    if (bytes === undefined) {
      throw new DbError('syntax', msg('The hexadecimal text is not valid'));
    }
    return bytes;
  }

  private requireWritable(): void {
    if (this.deps.readOnly) {
      throw new DbError(
        'permission-denied',
        msg('The connection is read-only: nothing may change'),
      );
    }
  }
}

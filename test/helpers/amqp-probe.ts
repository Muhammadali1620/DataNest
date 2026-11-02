// A just-enough AMQP 0-9-1 client for the RabbitMQ integration tests (V13.28): it signs in,
// opens one channel, sets a prefetch and starts a consumer, so the broker has a connection and
// a consumer to list. It never acknowledges, publishes or reads a message. Written from the
// protocol's public specification; the extension itself speaks only the management API.

import { connect, type Socket } from 'node:net';

const FRAME_END = 0xce;

function shortstr(text: string): Buffer {
  const bytes = Buffer.from(text, 'utf8');
  return Buffer.concat([Buffer.from([bytes.length]), bytes]);
}

function longstr(bytes: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

/** A table of string values: the client properties of the connection. */
function table(entries: Readonly<Record<string, string>>): Buffer {
  const parts = Object.entries(entries).map(([name, value]) =>
    Buffer.concat([shortstr(name), Buffer.from('S'), longstr(Buffer.from(value, 'utf8'))]),
  );
  return longstr(Buffer.concat(parts));
}

function method(channel: number, cls: number, id: number, args: Buffer): Buffer {
  const payload = Buffer.alloc(4);
  payload.writeUInt16BE(cls, 0);
  payload.writeUInt16BE(id, 2);
  const body = Buffer.concat([payload, args]);
  const head = Buffer.alloc(7);
  head.writeUInt8(1, 0);
  head.writeUInt16BE(channel, 1);
  head.writeUInt32BE(body.length, 3);
  return Buffer.concat([head, body, Buffer.from([FRAME_END])]);
}

const u16 = (value: number): Buffer => {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16BE(value);
  return bytes;
};
const u32 = (value: number): Buffer => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
};

export interface AmqpProbeOptions {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly vhost: string;
  /** The name the connection gives itself (a client property). */
  readonly connectionName: string;
  readonly queue: string;
  readonly consumerTag: string;
  readonly prefetch: number;
}

export class AmqpProbe {
  private socket: Socket | undefined;
  private buffer = Buffer.alloc(0);
  private waiting:
    ((frame: { type: number; channel: number; payload: Buffer }) => void) | undefined;
  private readonly queued: { type: number; channel: number; payload: Buffer }[] = [];
  closedByBroker = false;

  constructor(private readonly options: AmqpProbeOptions) {}

  /** Connects, signs in and starts the consumer; resolves once the broker said so. */
  async open(): Promise<void> {
    const socket = connect({ host: this.options.host, port: this.options.port });
    this.socket = socket;
    socket.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
    socket.on('close', () => {
      this.closedByBroker = true;
    });
    socket.on('error', () => undefined);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    socket.write(Buffer.from('AMQP\u0000\u0000\u0009\u0001', 'latin1'));
    await this.expect(0, 10, 10); // connection.start
    const response = Buffer.from(
      `\u0000${this.options.user}\u0000${this.options.password}`,
      'utf8',
    );
    socket.write(
      method(
        0,
        10,
        11,
        Buffer.concat([
          table({ connection_name: this.options.connectionName, product: 'datanest-test' }),
          shortstr('PLAIN'),
          longstr(response),
          shortstr('en_US'),
        ]),
      ),
    );
    await this.expect(0, 10, 30); // connection.tune
    socket.write(method(0, 10, 31, Buffer.concat([u16(2047), u32(131_072), u16(0)])));
    socket.write(
      method(
        0,
        10,
        40,
        Buffer.concat([shortstr(this.options.vhost), shortstr(''), Buffer.from([0])]),
      ),
    );
    await this.expect(0, 10, 41); // connection.open-ok
    socket.write(method(1, 20, 10, shortstr('')));
    await this.expect(1, 20, 11); // channel.open-ok
    socket.write(
      method(1, 60, 10, Buffer.concat([u32(0), u16(this.options.prefetch), Buffer.from([0])])),
    );
    await this.expect(1, 60, 11); // basic.qos-ok
    socket.write(
      method(
        1,
        60,
        20,
        Buffer.concat([
          u16(0),
          shortstr(this.options.queue),
          shortstr(this.options.consumerTag),
          Buffer.from([0]),
          table({}),
        ]),
      ),
    );
    await this.expect(1, 60, 21); // basic.consume-ok
  }

  close(): void {
    this.socket?.destroy();
  }

  private drain(): void {
    for (;;) {
      if (this.buffer.length < 7) {
        return;
      }
      const size = this.buffer.readUInt32BE(3);
      if (this.buffer.length < 7 + size + 1) {
        return;
      }
      const frame = {
        type: this.buffer.readUInt8(0),
        channel: this.buffer.readUInt16BE(1),
        payload: this.buffer.subarray(7, 7 + size),
      };
      this.buffer = this.buffer.subarray(7 + size + 1);
      // Heartbeats carry nothing.
      if (frame.type === 8) {
        continue;
      }
      const waiting = this.waiting;
      if (waiting === undefined) {
        this.queued.push(frame);
      } else {
        this.waiting = undefined;
        waiting(frame);
      }
    }
  }

  private next(): Promise<{ type: number; channel: number; payload: Buffer }> {
    const queued = this.queued.shift();
    if (queued !== undefined) {
      return Promise.resolve(queued);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting = undefined;
        reject(new Error('The broker did not answer the AMQP client'));
      }, 10_000);
      this.waiting = (frame) => {
        clearTimeout(timer);
        resolve(frame);
      };
    });
  }

  private async expect(channel: number, cls: number, id: number): Promise<void> {
    const frame = await this.next();
    const gotClass = frame.payload.readUInt16BE(0);
    const gotMethod = frame.payload.readUInt16BE(2);
    if (frame.channel !== channel || gotClass !== cls || gotMethod !== id) {
      throw new Error(
        `AMQP: expected ${cls}.${id} on channel ${channel}, got ${gotClass}.${gotMethod} on ${frame.channel}`,
      );
    }
  }
}

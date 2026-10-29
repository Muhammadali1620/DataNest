// New ObjectIds made on this side (V7.5), for `ObjectId()` in what the user types and for
// new documents: 4 bytes of seconds, 5 random bytes per run, a 3-byte counter — the
// layout the server and the drivers use, so ids still sort by creation time.

const RANDOM = new Uint8Array(5);
globalThis.crypto.getRandomValues(RANDOM);

const START = new Uint32Array(1);
globalThis.crypto.getRandomValues(START);
let counter = (START[0] ?? 0) & 0xff_ffff;

function hex(value: number, digits: number): string {
  return value.toString(16).padStart(digits, '0');
}

/** 24 lowercase hex digits; `now` is for tests. */
export function newObjectId(now: number = Date.now()): string {
  counter = (counter + 1) & 0xff_ffff;
  const seconds = Math.floor(now / 1000) >>> 0;
  const random = [...RANDOM].map((byte) => hex(byte, 2)).join('');
  return `${hex(seconds, 8)}${random}${hex(counter, 6)}`;
}

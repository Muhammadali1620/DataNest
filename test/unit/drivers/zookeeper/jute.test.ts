import { describe, expect, it } from 'vitest';
import { JuteReader, JuteWriter } from '../../../../src/drivers/zookeeper/jute';
import type { ZookeeperStat } from '../../../../src/drivers/zookeeper-driver';

const STAT: ZookeeperStat = {
  czxid: '4294967297',
  mzxid: '4294967298',
  pzxid: '4294967299',
  ctime: 1_700_000_000_123,
  mtime: 1_700_000_500_456,
  version: 3,
  cversion: 2,
  aversion: 1,
  ephemeralOwner: '0',
  dataLength: 5,
  numChildren: 7,
};

describe('JuteWriter and JuteReader', () => {
  it('write integers big-endian, longs in eight bytes and booleans in one', () => {
    const bytes = new JuteWriter().int(1).int(-2).long(-1n).bool(true).bool(false).toBuffer();
    expect([...bytes]).toEqual([
      0, 0, 0, 1, 255, 255, 255, 254, 255, 255, 255, 255, 255, 255, 255, 255, 1, 0,
    ]);
    const reader = new JuteReader(bytes);
    expect(reader.int()).toBe(1);
    expect(reader.int()).toBe(-2);
    expect(reader.long()).toBe(-1n);
    expect(reader.bool()).toBe(true);
    expect(reader.bool()).toBe(false);
    expect(reader.remaining).toBe(0);
  });

  it('carry strings and buffers with their length, and null as -1', () => {
    const bytes = new JuteWriter()
      .string('héllo')
      .bytes(null)
      .bytes(Buffer.from([1, 2]))
      .string('')
      .toBuffer();
    const reader = new JuteReader(bytes);
    expect(reader.string()).toBe('héllo');
    expect(reader.bytes()).toBeNull();
    expect([...(reader.bytes() ?? [])]).toEqual([1, 2]);
    expect(reader.string()).toBe('');
    // A null string reads as empty text.
    expect(new JuteReader(new JuteWriter().string(null).toBuffer()).string()).toBe('');
  });

  it('frame puts the length of the body in front', () => {
    const frame = new JuteWriter().int(7).frame();
    expect([...frame]).toEqual([0, 0, 0, 4, 0, 0, 0, 7]);
  });

  it('round-trip a stat in its 68 bytes, the owner as an unsigned number', () => {
    const bytes = new JuteWriter().stat(STAT).toBuffer();
    expect(bytes.length).toBe(68);
    expect(new JuteReader(bytes).stat()).toEqual(STAT);
    const container = { ...STAT, ephemeralOwner: (1n << 63n).toString() };
    expect(new JuteReader(new JuteWriter().stat(container).toBuffer()).stat()).toEqual(container);
  });

  it('round-trip lists of strings and ACL entries', () => {
    const writer = new JuteWriter()
      .int(2)
      .string('a')
      .string('b')
      .acl([
        { perms: 31, scheme: 'world', id: 'anyone' },
        { perms: 1, scheme: 'digest', id: 'u:hash' },
      ]);
    const reader = new JuteReader(writer.toBuffer());
    expect(reader.stringList()).toEqual(['a', 'b']);
    expect(reader.aclList()).toEqual([
      { perms: 31, scheme: 'world', id: 'anyone' },
      { perms: 1, scheme: 'digest', id: 'u:hash' },
    ]);
  });

  it('refuse to read past the end', () => {
    expect(() => new JuteReader(Buffer.from([0, 0])).int()).toThrow(RangeError);
    expect(() => new JuteReader(Buffer.from([0, 0, 0, 9, 1])).bytes()).toThrow(RangeError);
    expect(() => new JuteReader(Buffer.alloc(0)).bool()).toThrow(RangeError);
    expect(() => new JuteReader(Buffer.alloc(4)).long()).toThrow(RangeError);
  });
});

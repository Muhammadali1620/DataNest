import { describe, expect, it } from 'vitest';
import {
  hintOf,
  joinDefinition,
  POLICY_FIELDS,
  splitDefinition,
  visibleFields,
} from '../../../../../webview/src/apps/rabbitmq-object/policy-definition';

describe('splitDefinition', () => {
  it('puts the keys with a field in the fields and the rest in the box', () => {
    expect(
      splitDefinition(
        '{"message-ttl": 60000, "overflow": "drop-head", "dead-letter-exchange": "dlx", "queue-version": 2, "x": {"a": 1}}',
      ),
    ).toEqual({
      values: { 'message-ttl': '60000', overflow: 'drop-head', 'dead-letter-exchange': 'dlx' },
      extra: JSON.stringify({ 'queue-version': 2, x: { a: 1 } }, null, 2),
    });
  });

  it('leaves the rest empty when the fields cover everything', () => {
    expect(splitDefinition('{"max-length": 5}')).toEqual({
      values: { 'max-length': '5' },
      extra: '',
    });
    expect(splitDefinition('{}')).toEqual({ values: {}, extra: '' });
  });

  it('keeps a value that does not fit its field in the rest, so looking changes nothing', () => {
    const split = splitDefinition(
      '{"message-ttl": "soon", "max-length": 1.5, "overflow": "sideways", "dead-letter-exchange": 7}',
    );
    expect(split.values).toEqual({});
    expect(JSON.parse(split.extra)).toEqual({
      'message-ttl': 'soon',
      'max-length': 1.5,
      overflow: 'sideways',
      'dead-letter-exchange': 7,
    });
  });

  it('sends text that is not a JSON object whole to the rest', () => {
    expect(splitDefinition('  nonsense ')).toEqual({ values: {}, extra: 'nonsense' });
    expect(splitDefinition('[1, 2]')).toEqual({ values: {}, extra: '[1, 2]' });
    expect(splitDefinition('null')).toEqual({ values: {}, extra: 'null' });
    expect(splitDefinition('')).toEqual({ values: {}, extra: '' });
  });
});

describe('joinDefinition', () => {
  it('writes the fields that are filled and leaves out the blank ones', () => {
    const joined = joinDefinition(
      { 'message-ttl': ' 5000 ', 'max-length': '', overflow: 'reject-publish', expires: '  ' },
      '',
    );
    expect(joined.ok).toBe(true);
    expect(joined.ok && JSON.parse(joined.json)).toEqual({
      'message-ttl': 5000,
      overflow: 'reject-publish',
    });
  });

  it('adds the rest, and the fields win over the same key typed in the rest', () => {
    const joined = joinDefinition({ 'max-length': '10' }, '{"max-length": 99, "queue-version": 2}');
    expect(joined.ok && JSON.parse(joined.json)).toEqual({ 'max-length': 10, 'queue-version': 2 });
  });

  it('accepts 0 and refuses what is not a whole number from 0', () => {
    expect(joinDefinition({ 'max-length': '0' }, '')).toMatchObject({ ok: true });
    for (const bad of ['-1', '1.5', '1e3', 'ten', '12345678901234567']) {
      expect(joinDefinition({ 'message-ttl': bad }, '')).toEqual({
        ok: false,
        reason: 'number',
        key: 'message-ttl',
      });
    }
  });

  it('refuses a rest that is not a JSON object', () => {
    for (const bad of ['{', '[1]', '"text"', '7', 'null']) {
      expect(joinDefinition({}, bad)).toEqual({ ok: false, reason: 'extra' });
    }
  });

  it('gives an empty object for nothing at all, and round-trips a split', () => {
    expect(joinDefinition({}, '')).toEqual({ ok: true, json: '{}' });
    const original = { 'message-ttl': 1, 'dead-letter-routing-key': 'k', other: [1, 2] };
    const split = splitDefinition(JSON.stringify(original));
    const joined = joinDefinition(split.values, split.extra);
    expect(joined.ok && JSON.parse(joined.json)).toEqual(original);
  });
});

describe('visibleFields', () => {
  const keys = (target: Parameters<typeof visibleFields>[0], values = {}): string[] =>
    visibleFields(target, values).map((field) => field.key);

  it('shows every field for everything', () => {
    expect(keys('all')).toEqual(POLICY_FIELDS.map((field) => field.key));
  });

  it('shows the queue keys for queues of any kind, and the exchange key for exchanges', () => {
    for (const target of ['queues', 'classic_queues', 'quorum_queues', 'streams'] as const) {
      expect(keys(target)).not.toContain('alternate-exchange');
      expect(keys(target)).toContain('message-ttl');
    }
    expect(keys('exchanges')).toEqual(['alternate-exchange']);
  });

  it('keeps a field that holds a value in view whatever the target', () => {
    expect(keys('exchanges', { 'max-length': '5' })).toEqual(['max-length', 'alternate-exchange']);
    expect(keys('queues', { 'max-length': '   ' })).not.toContain('alternate-exchange');
  });
});

describe('hintOf', () => {
  it('has a hint for the keys that take free text or a number, and none for choices', () => {
    for (const field of POLICY_FIELDS) {
      expect(hintOf(field) === undefined).toBe(field.kind === 'select');
    }
  });
});

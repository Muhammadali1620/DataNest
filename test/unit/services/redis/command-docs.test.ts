import { describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import type { RedisReply } from '../../../../src/drivers/redis-driver';
import {
  loadCommandDocs,
  parseCommandDocs,
  parseCommandNames,
} from '../../../../src/services/redis/command-docs';
import { bulk, FakeRedisSession } from '../../../helpers/fake-redis';

/** A RESP2 map from pairs, values as the server sends them. */
function map(...pairs: [string, RedisReply][]): RedisReply {
  return pairs.flatMap(([key, value]) => [bulk(key), value]);
}

function arg(...pairs: [string, RedisReply][]): RedisReply {
  return map(...pairs);
}

const SET_DOCS = map(
  ['summary', bulk('Sets the string value of a key.')],
  ['since', bulk('1.0.0')],
  ['group', bulk('string')],
  [
    'arguments',
    [
      arg(['name', bulk('key')], ['type', bulk('key')], ['display_text', bulk('key')]),
      arg(['name', bulk('value')], ['type', bulk('string')], ['display_text', bulk('value')]),
      arg(
        ['name', bulk('condition')],
        ['type', bulk('oneof')],
        ['flags', [bulk('optional')]],
        [
          'arguments',
          [
            arg(['name', bulk('nx')], ['type', bulk('pure-token')], ['token', bulk('NX')]),
            arg(['name', bulk('xx')], ['type', bulk('pure-token')], ['token', bulk('XX')]),
          ],
        ],
      ),
      arg(
        ['name', bulk('seconds')],
        ['type', bulk('integer')],
        ['display_text', bulk('seconds')],
        ['token', bulk('EX')],
        ['flags', [bulk('optional')]],
      ),
    ],
  ],
);

const DEL_DOCS = map(
  ['summary', bulk('Deletes keys.')],
  [
    'arguments',
    [
      arg(
        ['name', bulk('key')],
        ['type', bulk('key')],
        ['display_text', bulk('key')],
        ['flags', [bulk('multiple')]],
      ),
    ],
  ],
);

const CONFIG_DOCS = map(
  ['summary', bulk('A container.')],
  [
    'subcommands',
    map([
      'config|get',
      map(
        ['summary', bulk('Returns parameters.')],
        [
          'arguments',
          [
            arg(
              ['name', bulk('parameter')],
              ['type', bulk('string')],
              ['display_text', bulk('parameter')],
              ['flags', [bulk('multiple')]],
            ),
          ],
        ],
      ),
    ]),
  ],
);

const MODE_DOCS = map([
  'arguments',
  [
    arg(
      ['name', bulk('mode')],
      ['type', bulk('oneof')],
      [
        'arguments',
        [
          arg(['name', bulk('a')], ['type', bulk('pure-token')], ['token', bulk('A')]),
          arg(
            ['name', bulk('b')],
            ['type', bulk('block')],
            [
              'arguments',
              [
                arg(['name', bulk('n')], ['type', bulk('integer')]),
                arg(['name', bulk('m')], ['type', bulk('integer')]),
              ],
            ],
          ),
        ],
      ],
    ),
  ],
]);

describe('parseCommandDocs', () => {
  const docs = parseCommandDocs(
    map(['set', SET_DOCS], ['del', DEL_DOCS], ['config', CONFIG_DOCS], ['mode', MODE_DOCS]),
  );
  const byName = new Map(docs.map((doc) => [doc.name, doc]));

  it('reads name, summary, group and version, and knows when a key comes first', () => {
    expect(byName.get('SET')).toEqual({
      name: 'SET',
      summary: 'Sets the string value of a key.',
      syntax: 'key value [NX | XX] [EX seconds]',
      group: 'string',
      since: '1.0.0',
      keyFirst: true,
    });
  });

  it('writes repeated, choice and block arguments', () => {
    expect(byName.get('DEL')?.syntax).toBe('key [key ...]');
    expect(byName.get('MODE')?.syntax).toBe('<A | n m>');
    expect(byName.get('MODE')?.keyFirst).toBe(false);
  });

  it('lists subcommands under their container, sorted', () => {
    expect(docs.map((doc) => doc.name)).toEqual(['CONFIG', 'CONFIG GET', 'DEL', 'MODE', 'SET']);
    expect(byName.get('CONFIG GET')?.syntax).toBe('parameter [parameter ...]');
    expect(byName.get('CONFIG')?.syntax).toBeUndefined();
  });
});

describe('parseCommandNames', () => {
  it('reads names and whether a key comes first from a plain COMMAND reply', () => {
    expect(
      parseCommandNames([
        [bulk('get'), '2', [bulk('readonly')], '1', '1', '1'],
        [bulk('ping'), '-1', [], '0', '0', '0'],
        null,
      ]),
    ).toEqual([
      { name: 'GET', keyFirst: true },
      { name: 'PING', keyFirst: false },
    ]);
  });
});

describe('loadCommandDocs', () => {
  it('uses COMMAND DOCS when the server has it', async () => {
    const session = new FakeRedisSession((words) =>
      words[1] === 'DOCS' ? map(['del', DEL_DOCS]) : null,
    );
    expect((await loadCommandDocs(session)).map((doc) => doc.name)).toEqual(['DEL']);
  });

  it('falls back to COMMAND on older servers, and to nothing when refused', async () => {
    const old = new FakeRedisSession((words) =>
      words[1] === 'DOCS'
        ? new DbError('syntax', 'ERR unknown subcommand')
        : [[bulk('get'), '2', [], '1', '1', '1']],
    );
    expect(await loadCommandDocs(old)).toEqual([{ name: 'GET', keyFirst: true }]);
    const refused = new FakeRedisSession(() => new DbError('permission-denied', 'NOPERM'));
    expect(await loadCommandDocs(refused)).toEqual([]);
  });
});

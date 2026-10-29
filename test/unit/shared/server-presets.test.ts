import { describe, expect, it } from 'vitest';
import { DEFAULT_PORTS } from '../../../src/shared/connection';
import {
  SERVER_PRESET_IDS,
  SERVER_PRESETS,
  serverPreset,
} from '../../../src/shared/server-presets';

describe('server presets (V6.5)', () => {
  it('has one preset per id, in that order', () => {
    expect(SERVER_PRESETS.map((preset) => preset.id)).toEqual([...SERVER_PRESET_IDS]);
  });

  it('starts each server on the driver whose protocol it speaks, at its own port', () => {
    expect(SERVER_PRESETS.map((preset) => [preset.id, preset.driver, preset.port])).toEqual([
      ['tidb', 'mysql', 4000],
      ['aurora-mysql', 'mysql', DEFAULT_PORTS.mysql],
      ['cockroachdb', 'postgres', 26257],
      ['yugabytedb', 'postgres', 5433],
      ['aurora-postgres', 'postgres', DEFAULT_PORTS.postgres],
    ]);
  });

  it('turns TLS on only for the hosted servers, without a check that needs their CA', () => {
    expect(SERVER_PRESETS.filter((preset) => preset.ssl !== undefined)).toEqual([
      expect.objectContaining({ id: 'aurora-mysql', ssl: 'require' }),
      expect.objectContaining({ id: 'aurora-postgres', ssl: 'require' }),
    ]);
  });

  it('finds a preset by id and nothing for an unknown one', () => {
    expect(serverPreset('yugabytedb')).toMatchObject({ user: 'yugabyte', database: 'yugabyte' });
    expect(serverPreset('redshift')).toBeUndefined();
    expect(serverPreset('')).toBeUndefined();
  });
});

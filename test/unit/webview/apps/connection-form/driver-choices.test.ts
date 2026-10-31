import { describe, expect, it } from 'vitest';
import { DRIVER_IDS } from '../../../../../src/shared/connection';
import { SERVER_PRESETS } from '../../../../../src/shared/server-presets';
import { driverChoices } from '../../../../../webview/src/apps/connection-form/driver-choices';

const choicesOf = (drivers: Parameters<typeof driverChoices>[0]) =>
  driverChoices(
    drivers,
    SERVER_PRESETS,
    (driver) => `driver ${driver}`,
    (preset) => `preset ${preset}`,
    (label) => `uses ${label}`,
  );

describe('driverChoices', () => {
  it('lists the offered drivers in their order, then the compatible servers', () => {
    const choices = choicesOf(['postgres', 'mysql']);
    expect(choices.map((choice) => choice.value)).toEqual([
      'postgres',
      'mysql',
      'preset:tidb',
      'preset:aurora-mysql',
      'preset:cockroachdb',
      'preset:yugabytedb',
      'preset:aurora-postgres',
    ]);
    expect(choices[0]).toEqual({
      value: 'postgres',
      label: 'driver postgres',
      mark: 'Pg',
      tone: 'blue',
      compatible: false,
      driver: 'postgres',
    });
    // A database has its own drawing; a compatible server keeps its letters.
    expect(choices.filter((choice) => choice.driver !== undefined).length).toBe(
      choices.filter((choice) => !choice.compatible).length,
    );
  });

  it('offers only the compatible servers whose driver is there', () => {
    const values = choicesOf(['postgres']).map((choice) => choice.value);
    expect(values).toContain('preset:cockroachdb');
    expect(values).not.toContain('preset:tidb');
    expect(choicesOf(['sqlite']).map((choice) => choice.value)).toEqual(['sqlite']);
  });

  it('gives a compatible server the tone of its driver and says which driver it uses', () => {
    const tidb = choicesOf(['mysql']).find((choice) => choice.value === 'preset:tidb');
    expect(tidb).toEqual({
      value: 'preset:tidb',
      label: 'preset tidb',
      mark: 'Ti',
      tone: 'orange',
      compatible: true,
      hint: 'uses driver mysql',
    });
  });

  it('has a two-letter mark and a tone for every driver', () => {
    for (const choice of choicesOf([...DRIVER_IDS])) {
      expect(choice.mark, choice.value).toMatch(/^[A-Za-z]{2}$/);
      expect(['blue', 'green', 'orange', 'red', 'yellow', 'purple']).toContain(choice.tone);
    }
  });

  it('has nothing to offer without drivers', () => {
    expect(choicesOf([])).toEqual([]);
  });
});

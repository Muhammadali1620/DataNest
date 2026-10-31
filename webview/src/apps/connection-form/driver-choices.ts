import type { DriverId } from '../../../../src/shared/connection';
import type { ServerPreset, ServerPresetId } from '../../../../src/shared/server-presets';

/** One card of the database picker. */
export interface DriverChoice {
  /** A driver id, or `preset:<id>` for a compatible server. */
  readonly value: string;
  readonly label: string;
  /** Two letters drawn on the card: our own mark, never a vendor's logo. */
  readonly mark: string;
  /** The theme chart colour of the mark. */
  readonly tone: Tone;
  readonly compatible: boolean;
  /** Tooltip of a compatible server: which driver it uses. */
  readonly hint?: string;
}

export type Tone = 'blue' | 'green' | 'orange' | 'red' | 'yellow' | 'purple';

const DRIVER_MARKS: Readonly<Record<DriverId, readonly [string, Tone]>> = {
  mysql: ['My', 'orange'],
  postgres: ['Pg', 'blue'],
  sqlite: ['Lt', 'green'],
  mssql: ['MS', 'red'],
  clickhouse: ['CH', 'yellow'],
  oracle: ['Or', 'red'],
  redis: ['Rd', 'red'],
  mongodb: ['Mg', 'green'],
  elasticsearch: ['Es', 'purple'],
};

const PRESET_MARKS: Readonly<Record<ServerPresetId, string>> = {
  tidb: 'Ti',
  'aurora-mysql': 'Au',
  cockroachdb: 'Cr',
  yugabytedb: 'Yb',
  'aurora-postgres': 'Au',
};

/**
 * The cards of the picker: the drivers the host offers, in its order, then the
 * compatible servers whose driver it offers. A compatible server's mark takes the tone
 * of its driver, so the two read as related.
 */
export function driverChoices(
  drivers: readonly DriverId[],
  presets: readonly ServerPreset[],
  label: (driver: DriverId) => string,
  presetLabel: (preset: ServerPresetId) => string,
  presetHint: (driverLabel: string) => string,
): DriverChoice[] {
  const offered = new Set(drivers);
  return [
    ...drivers.map((driver) => ({
      value: driver,
      label: label(driver),
      mark: DRIVER_MARKS[driver][0],
      tone: DRIVER_MARKS[driver][1],
      compatible: false,
    })),
    ...presets
      .filter((preset) => offered.has(preset.driver))
      .map((preset) => ({
        value: `preset:${preset.id}`,
        label: presetLabel(preset.id),
        mark: PRESET_MARKS[preset.id],
        tone: DRIVER_MARKS[preset.driver][1],
        compatible: true,
        hint: presetHint(label(preset.driver)),
      })),
  ];
}

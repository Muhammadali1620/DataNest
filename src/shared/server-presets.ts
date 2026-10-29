// Servers that speak MySQL's or PostgreSQL's protocol (V6.5). They need no driver of their
// own: the connection form offers them as starting points for the MySQL or PostgreSQL
// driver, with the port, account and TLS they come with. What is saved is a connection of
// that driver; the driver itself tells the servers apart where their catalogs differ.

import type { DriverId, SslMode } from './connection';

export const SERVER_PRESET_IDS = [
  'tidb',
  'aurora-mysql',
  'cockroachdb',
  'yugabytedb',
  'aurora-postgres',
] as const;

export type ServerPresetId = (typeof SERVER_PRESET_IDS)[number];

export interface ServerPreset {
  readonly id: ServerPresetId;
  readonly driver: Extract<DriverId, 'mysql' | 'postgres'>;
  readonly port: number;
  /** The account a new server has, where it has one. */
  readonly user?: string;
  /** The database a new server has, where the protocol needs one. */
  readonly database?: string;
  /** Hosted servers take only encrypted connections. */
  readonly ssl?: SslMode;
}

export const SERVER_PRESETS: readonly ServerPreset[] = [
  { id: 'tidb', driver: 'mysql', port: 4000, user: 'root' },
  // Aurora is MySQL and PostgreSQL themselves, behind TLS signed by Amazon's own CA: it is
  // checked once the RDS bundle is given as the CA, so the preset starts with `require`.
  { id: 'aurora-mysql', driver: 'mysql', port: 3306, ssl: 'require' },
  // A secure CockroachDB cluster takes TLS only; `cockroach start --insecure` takes none.
  { id: 'cockroachdb', driver: 'postgres', port: 26257, user: 'root', database: 'defaultdb' },
  { id: 'yugabytedb', driver: 'postgres', port: 5433, user: 'yugabyte', database: 'yugabyte' },
  { id: 'aurora-postgres', driver: 'postgres', port: 5432, database: 'postgres', ssl: 'require' },
];

export function serverPreset(id: string): ServerPreset | undefined {
  return SERVER_PRESETS.find((preset) => preset.id === id);
}

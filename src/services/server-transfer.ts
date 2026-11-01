// Saved servers in a file, without a single secret (V13.16), to move them to another machine
// or share the list: the passwords and passphrases are asked for again after the import.

import { DbError } from '../core/errors';
import { msg } from '../core/user-message';
import {
  serverProblems,
  type SshServerConfig,
  type SshServerInput,
  sshServerInputSchema,
} from '../shared/ssh-server';
import { normalizeProxy, normalizeTunnel } from './connection-store';

export const SERVER_FILE_VERSION = 1;

/** The most entries one file may hold. */
export const MAX_SERVERS = 1000;

/** The file text for these servers: only what is not secret. */
export function exportServers(servers: readonly SshServerConfig[]): string {
  // Field by field, so nothing else a config might ever carry can end up in the file.
  const items = servers.map(({ name, ssh, proxy, startPath, readOnly, color }): SshServerInput => ({
    name,
    ssh,
    ...(proxy === undefined ? {} : { proxy }),
    ...(startPath === undefined ? {} : { startPath }),
    ...(readOnly === true ? { readOnly } : {}),
    ...(color === undefined ? {} : { color }),
  }));
  return `${JSON.stringify({ version: SERVER_FILE_VERSION, servers: items }, undefined, 2)}\n`;
}

export interface ServerImportPlan {
  readonly servers: readonly SshServerInput[];
  /** Entries that could not be read, by position (from 1), with the reason. */
  readonly skipped: readonly { readonly position: number; readonly problem: string }[];
}

/** Reads a file written by `exportServers`; an entry that is not valid is skipped, not fatal. */
export function parseServerFile(text: string): ServerImportPlan {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new DbError('unsupported', msg('The file is not valid JSON'));
  }
  const file = (typeof raw === 'object' ? raw : undefined) as
    { version?: unknown; servers?: unknown } | null | undefined;
  if (
    file?.version !== SERVER_FILE_VERSION ||
    !Array.isArray(file.servers) ||
    file.servers.length > MAX_SERVERS
  ) {
    throw new DbError('unsupported', msg('This is not a DataNest servers file'));
  }
  const parsed = { servers: file.servers as unknown[] };
  const servers: SshServerInput[] = [];
  const skipped: { position: number; problem: string }[] = [];
  parsed.servers.forEach((entry, index) => {
    try {
      const input = sshServerInputSchema.parse(entry);
      const clean: SshServerInput = {
        ...input,
        name: input.name.trim(),
        ssh: normalizeTunnel(input.ssh),
        ...(input.proxy === undefined ? {} : { proxy: normalizeProxy(input.proxy) }),
      };
      const problems = serverProblems(clean);
      if (problems.length > 0) {
        skipped.push({ position: index + 1, problem: problems.join(', ') });
      } else {
        servers.push(clean);
      }
    } catch (error) {
      skipped.push({
        position: index + 1,
        problem: error instanceof Error ? error.message : String(error),
      });
    }
  });
  return { servers, skipped };
}

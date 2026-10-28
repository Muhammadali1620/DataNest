// What a connection lets through: everything, everything after a confirmation
// (production), or nothing that changes data (read-only). Pure, so the editor
// integration only shows the dialogs these rules ask for.

import { changingStatements } from '../core/sql/read-only';
import type { SqlStatement } from '../core/sql/split';
import { syntaxOf } from '../core/sql/tokenizer';
import type { ConnectionConfig } from '../shared/connection';

export interface WritePolicy {
  readonly name: string;
  readonly production: boolean;
  readonly readOnly: boolean;
}

export const NO_POLICY: WritePolicy = { name: '', production: false, readOnly: false };

export function policyOf(config: ConnectionConfig | undefined): WritePolicy {
  if (config === undefined) {
    return NO_POLICY;
  }
  return {
    name: config.name,
    production: config.production === true,
    readOnly: config.readOnly === true,
  };
}

/** What to do with a run: go ahead, ask first (and about what), or refuse (and why). */
export type RunVerdict =
  | { readonly kind: 'allow' }
  | { readonly kind: 'confirm'; readonly changes: readonly SqlStatement[] }
  | { readonly kind: 'refuse'; readonly changes: readonly SqlStatement[] };

export function runVerdict(
  policy: WritePolicy,
  statements: readonly SqlStatement[],
  driver: ConnectionConfig['driver'] | undefined,
): RunVerdict {
  if (!policy.production && !policy.readOnly) {
    return { kind: 'allow' };
  }
  const changes = changingStatements(statements, syntaxOf(driver));
  if (changes.length === 0) {
    return { kind: 'allow' };
  }
  return policy.readOnly ? { kind: 'refuse', changes } : { kind: 'confirm', changes };
}

/** For actions that always change something (DDL, saving edits): refuse, ask or go. */
export function changeVerdict(policy: WritePolicy): 'allow' | 'confirm' | 'refuse' {
  if (policy.readOnly) {
    return 'refuse';
  }
  return policy.production ? 'confirm' : 'allow';
}

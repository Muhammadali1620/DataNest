// Ending the transaction of a session on the user's word (V4.8): Commit and Rollback
// in the status bar, and before an editor switches connection or disconnects.

import { DbError } from '../core/errors';
import type { ConnectionManager } from './connection-manager';
import { msg } from '../core/user-message';

export type TransactionEnd = 'commit' | 'rollback';

/**
 * Commits or rolls back the open transaction of an owner's session. A transaction
 * that failed can only be rolled back: PostgreSQL would turn the COMMIT into a
 * ROLLBACK without saying so, which reads as "saved" when nothing was.
 */
export async function endTransaction(
  manager: Pick<ConnectionManager, 'sessionOf' | 'transactionState'>,
  owner: string,
  end: TransactionEnd,
): Promise<void> {
  const session = manager.sessionOf(owner);
  const state = manager.transactionState(owner);
  if (session === undefined || (state !== 'open' && state !== 'failed')) {
    throw new DbError('not-found', msg('There is no open transaction in this editor'));
  }
  if (end === 'commit' && state === 'failed') {
    throw new DbError(
      'unsupported',
      msg('The transaction failed, so nothing in it can be saved: roll it back'),
    );
  }
  for await (const _event of session.execute(end === 'commit' ? 'COMMIT' : 'ROLLBACK')) {
    // Nothing to collect: what matters is that the server accepted it.
  }
}

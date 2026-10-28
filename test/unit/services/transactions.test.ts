import { describe, expect, it } from 'vitest';
import type { TransactionState } from '../../../src/drivers/driver';
import { endTransaction } from '../../../src/services/transactions';
import { FakeSession } from '../../helpers/fake-driver';

function manager(session: FakeSession | undefined, state: TransactionState | undefined) {
  return {
    sessionOf: () => session,
    transactionState: () => state,
  };
}

describe('endTransaction', () => {
  const session = () => new FakeSession({ id: 'c', name: 'c', driver: 'postgres' });

  it('commits or rolls back an open transaction on the owner session', async () => {
    const one = session();
    await endTransaction(manager(one, 'open'), 'editor:a', 'commit');
    await endTransaction(manager(one, 'open'), 'editor:a', 'rollback');
    expect(one.executed).toEqual(['COMMIT', 'ROLLBACK']);
  });

  it('rolls back a failed transaction but refuses to pretend to commit it', async () => {
    const one = session();
    await expect(endTransaction(manager(one, 'failed'), 'editor:a', 'commit')).rejects.toThrow(
      'roll it back',
    );
    await endTransaction(manager(one, 'failed'), 'editor:a', 'rollback');
    expect(one.executed).toEqual(['ROLLBACK']);
  });

  it('says so when there is nothing to end', async () => {
    for (const state of ['idle', undefined] as const) {
      await expect(
        endTransaction(manager(session(), state), 'editor:a', 'commit'),
      ).rejects.toMatchObject({ code: 'not-found' });
    }
    await expect(
      endTransaction(manager(undefined, 'open'), 'editor:a', 'rollback'),
    ).rejects.toThrow('no open transaction');
  });

  it('lets a server error through', async () => {
    const one = session();
    one.failExecuteWhen = () => true;
    await expect(endTransaction(manager(one, 'open'), 'editor:a', 'commit')).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });
});

// EXPLAIN (V8.2) on Oracle: EXPLAIN PLAN into PLAN_TABLE, read back and removed.

import { expect, it } from 'vitest';
import { driver } from '../../../src/drivers/oracle';
import { explainSuite, serverConfig } from '../../helpers/explain-suite';
import { firstColumn, runAll } from '../../helpers/driver-run';

explainSuite({
  label: 'oracle',
  driver: () => driver,
  config: () => serverConfig('oracle', 'oracle'),
  server: 'oracle',
  sqlDriver: 'oracle',
  change: "UPDATE customers SET full_name = full_name WHERE country = 'XX'",
});

it('leaves no rows of its own in PLAN_TABLE', async () => {
  const session = await driver.openSession(serverConfig('oracle', 'oracle'));
  try {
    const left = firstColumn(
      await runAll(session, "SELECT COUNT(*) FROM plan_table WHERE statement_id LIKE 'DN%'"),
    );
    expect(
      Number(
        typeof left[0] === 'object' && left[0] !== null && 'text' in left[0]
          ? left[0].text
          : left[0],
      ),
    ).toBe(0);
  } finally {
    await session.close();
  }
});

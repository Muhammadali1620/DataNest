import { describe, expect, it } from 'vitest';
import { readOraclePlan } from '../../../../src/services/explain/oracle-plan';
import type { CellValue } from '../../../../src/shared/cell-value';
import { fixtureJson } from '../../../helpers/fixtures';
import { outline } from '../../../helpers/plan-outline';

describe('readOraclePlan', () => {
  it('hangs PLAN_TABLE rows from their parents with costs and predicates', () => {
    const { columns, rows } = fixtureJson('explain', 'oracle-plan.json') as {
      columns: string[];
      rows: CellValue[][];
    };
    const plan = readOraclePlan(columns, rows, 'raw');
    expect(outline(plan)).toEqual([
      'SELECT STATEMENT',
      '  SORT ORDER BY !sort',
      '    HASH GROUP BY',
      '      HASH JOIN',
      '        NESTED LOOPS',
      '          STATISTICS COLLECTOR',
      '            VIEW [VW_GBF_14]',
      '              HASH JOIN',
      '                TABLE ACCESS FULL [CUSTOMERS C] !full-scan',
      '                TABLE ACCESS FULL [ORDERS O] !full-scan',
      '          INDEX RANGE SCAN [SYS_C008742 I]',
      '        INDEX FAST FULL SCAN [SYS_C008742 I] !full-scan',
    ]);
    expect(plan.root).toMatchObject({ cost: 9, rows: 9 });
    const customers =
      plan.root.children[0]?.children[0]?.children[0]?.children[0]?.children[0]?.children[0]
        ?.children[0]?.children[0];
    expect(customers?.detail).toBe(`filter: "C"."COUNTRY"<>'XX'`);
    expect(customers?.properties).toContainEqual(['object_owner', 'DATANEST']);
  });

  it('accepts exact numbers and flags cartesian joins', () => {
    const columns = ['ID', 'PARENT_ID', 'OPERATION', 'OPTIONS', 'COST', 'CARDINALITY'];
    const plan = readOraclePlan(
      columns,
      [
        [0, null, 'SELECT STATEMENT', null, { kind: 'decimal', text: '12' }, 3],
        [1, 0, 'MERGE JOIN', 'CARTESIAN', 12, 3],
      ],
      '',
    );
    expect(plan.root.cost).toBe(12);
    expect(plan.root.children[0]?.warnings).toEqual(['no-join-predicate']);
  });
});

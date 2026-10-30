import { describe, expect, it } from 'vitest';
import { readMssqlPlan } from '../../../../src/services/explain/mssql-plan';
import { fixtureText } from '../../../helpers/fixtures';
import { outline } from '../../../helpers/plan-outline';

const showplan = (body: string, statements = 1): string =>
  `<ShowPlanXML xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan"><BatchSequence><Batch><Statements>${Array.from(
    { length: statements },
    (_, index) =>
      `<StmtSimple StatementText="SELECT ${index}" StatementType="SELECT" StatementSubTreeCost="1" StatementEstRows="2"><QueryPlan>${body}</QueryPlan></StmtSimple>`,
  ).join('')}</Statements></Batch></BatchSequence></ShowPlanXML>`;

describe('readMssqlPlan', () => {
  it('reads operators, objects and predicates of the estimated plan', () => {
    const plan = readMssqlPlan(fixtureText('explain', 'mssql-estimated.xml'), false);
    expect(outline(plan)).toEqual([
      'Sort !sort',
      '  Compute Scalar',
      '    Stream Aggregate (Aggregate)',
      '      Nested Loops (Inner Join)',
      '        Nested Loops (Inner Join)',
      '          Sort !sort',
      '            Clustered Index Scan [customers c using PK__customer__3213E83F088A2A70] !full-scan',
      '          Index Seek [orders o using ix_orders_customer]',
      '        Clustered Index Seek [order_items i using PK__order_it__022945F6B3DD2BC3]',
    ]);
    expect(plan.root).toMatchObject({ cost: 0.0340125, rows: 4, detail: 'Expr1003' });
    expect(plan.analyzed).toBe(false);
  });

  it('adds per-thread run time figures of the actual plan', () => {
    const plan = readMssqlPlan(fixtureText('explain', 'mssql-actual.xml'), true);
    expect(plan.root).toMatchObject({ actualRows: 4, loops: 1, timeMs: 0 });
    expect(plan.properties).toEqual([
      ['Elapsed time', '0 ms'],
      ['CPU time', '0 ms'],
    ]);
    const seek = plan.root.children[0]?.children[0]?.children[0]?.children[0]?.children[1];
    expect(seek).toMatchObject({ loops: 4, actualRows: 1.75 });
  });

  it('turns missing index hints into CREATE INDEX notes and reads warnings', () => {
    const plan = readMssqlPlan(
      showplan(
        `<MissingIndexes><MissingIndexGroup Impact="87.5"><MissingIndex Database="[db]" Schema="[dbo]" Table="[orders]"><ColumnGroup Usage="EQUALITY"><Column Name="[customer_id]"/></ColumnGroup><ColumnGroup Usage="INCLUDE"><Column Name="[note]"/></ColumnGroup></MissingIndex></MissingIndexGroup></MissingIndexes>
        <Warnings><PlanAffectingConvert ConvertIssue="Seek Plan"/></Warnings>
        <RelOp PhysicalOp="Nested Loops" LogicalOp="Inner Join" EstimatedTotalSubtreeCost="5" EstimateRows="10"><Warnings NoJoinPredicate="true"/><NestedLoops>
          <RelOp PhysicalOp="Table Scan" LogicalOp="Table Scan" EstimatedTotalSubtreeCost="2"><TableScan><Object Table="[t]"/><Predicate><ScalarOperator ScalarString="[t].[a]=(1)"/></Predicate></TableScan></RelOp>
          <RelOp PhysicalOp="Sort" LogicalOp="Sort" EstimatedTotalSubtreeCost="2"><Warnings><SpillToTempDb SpillLevel="1"/><ColumnsWithNoStatistics/></Warnings><Sort/></RelOp>
        </NestedLoops></RelOp>`,
      ),
      false,
    );
    expect(plan.notes).toEqual([
      'Impact 88%: CREATE INDEX ON [db].[dbo].[orders] ([customer_id]) INCLUDE ([note])',
    ]);
    expect(plan.root.warnings).toEqual(['implicit-conversion', 'no-join-predicate']);
    expect(plan.root.children[0]).toMatchObject({
      object: 't',
      detail: '[t].[a]=(1)',
      warnings: ['full-scan'],
    });
    expect(plan.root.children[1]?.warnings).toEqual(['sort', 'spill', 'missing-statistics']);
  });

  it('puts the statements of a batch under one node', () => {
    const plan = readMssqlPlan(showplan('<RelOp PhysicalOp="Constant Scan"/>', 2), false);
    expect(outline(plan)).toEqual([
      'Batch',
      '  Statement 1',
      '    Constant Scan',
      '  Statement 2',
      '    Constant Scan',
    ]);
  });

  it('refuses something that is not a showplan or has no operators', () => {
    expect(() => readMssqlPlan('<x/>', false)).toThrow('other than a showplan');
    expect(() => readMssqlPlan(showplan(''), false)).toThrow('no operators');
  });
});

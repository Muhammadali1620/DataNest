// SQL Server plans (V8.2): the XML showplan — `SET SHOWPLAN_XML ON` for the estimated
// plan, `SET STATISTICS XML ON` for the actual one, which adds what each operator
// really did per thread. Missing index hints become notes.

import { DbError } from '../../core/errors';
import type { PlanNode, PlanWarning, QueryPlan } from '../../shared/query-plan';
import { numberOf, planNode } from './plan-node';
import { findAll, findFirst, parseXml, type XmlElement } from './xml-tree';
import { msg } from '../../core/user-message';

/** Parts of a RelOp that are not the operator itself. */
const NOT_OPERATOR = new Set([
  'OutputList',
  'RunTimeInformation',
  'MemoryFractions',
  'Warnings',
  'RunTimePartitionSummary',
  'InternalInfo',
]);

const PREDICATES = ['SeekPredicates', 'SeekPredicateNew', 'Predicate', 'ProbeResidual', 'Residual'];

export function readMssqlPlan(raw: string, analyzed: boolean): QueryPlan {
  const document = parseXml(raw);
  if (document.name !== 'ShowPlanXML') {
    throw new DbError('internal', msg('The server sent something other than a showplan'));
  }
  const statements = findAll(document, 'StmtSimple');
  const notes: string[] = [];
  const properties: [string, string][] = [];
  const roots = statements.flatMap((statement, index): PlanNode[] => {
    const plan = findFirst(statement, 'QueryPlan');
    const relOp = plan === undefined ? undefined : findFirst(plan, 'RelOp');
    if (plan !== undefined) {
      notes.push(...missingIndexes(plan));
      const times = findFirst(plan, 'QueryTimeStats', 'RelOp');
      if (times !== undefined) {
        const prefix = statements.length > 1 ? `Statement ${index + 1}: ` : '';
        properties.push(
          [`${prefix}Elapsed time`, `${times.attributes.ElapsedTime ?? '?'} ms`],
          [`${prefix}CPU time`, `${times.attributes.CpuTime ?? '?'} ms`],
        );
      }
    }
    if (relOp === undefined) {
      return [];
    }
    const node = relOpNode(relOp, plan === undefined ? [] : planWarnings(plan));
    if (statements.length === 1) {
      return [node];
    }
    return [
      planNode({
        operation: `Statement ${index + 1}`,
        detail: statement.attributes.StatementType,
        cost: numberOf(statement.attributes.StatementSubTreeCost),
        rows: numberOf(statement.attributes.StatementEstRows),
        properties: [['Text', statement.attributes.StatementText ?? '']],
        children: [node],
      }),
    ];
  });
  if (roots.length === 0) {
    throw new DbError('internal', msg('The showplan has no operators: the statement has no plan'));
  }
  const root =
    roots.length === 1 && roots[0] !== undefined
      ? roots[0]
      : planNode({ operation: 'Batch', children: roots });
  return { root, analyzed, properties, notes, raw };
}

function relOpNode(relOp: XmlElement, inherited: readonly PlanWarning[]): PlanNode {
  const { attributes } = relOp;
  const physical = attributes.PhysicalOp ?? 'Operator';
  const logical = attributes.LogicalOp;
  const operator = relOp.children.find((child) => !NOT_OPERATOR.has(child.name));
  const object = operator === undefined ? undefined : findFirst(operator, 'Object', 'RelOp');
  const counters = findAll(relOp, 'RunTimeCountersPerThread', 'RelOp');
  const executions = sum(counters.map((counter) => numberOf(counter.attributes.ActualExecutions)));
  const actualRows = sum(counters.map((counter) => numberOf(counter.attributes.ActualRows)));
  const elapsed = counters
    .map((counter) => numberOf(counter.attributes.ActualElapsedms))
    .filter((value): value is number => value !== undefined);
  const warnings: PlanWarning[] = [...inherited];
  if (/^(Table Scan|Clustered Index Scan|Index Scan)$/u.test(physical)) {
    warnings.push('full-scan');
  }
  if (physical === 'Sort') {
    warnings.push('sort');
  }
  if (physical.endsWith('Spool')) {
    warnings.push('temporary');
  }
  for (const element of relOp.children.filter((child) => child.name === 'Warnings')) {
    warnings.push(...warningsOf(element));
  }
  if (operator !== undefined) {
    const own = operator.children.find((child) => child.name === 'Warnings');
    if (own !== undefined) {
      warnings.push(...warningsOf(own));
    }
  }
  const children =
    operator === undefined ? [] : findAll(operator, 'RelOp').map((child) => relOpNode(child, []));
  return planNode({
    operation:
      logical !== undefined && logical !== physical ? `${physical} (${logical})` : physical,
    object: object === undefined ? undefined : objectName(object),
    detail: operator === undefined ? undefined : predicateOf(operator),
    cost: numberOf(attributes.EstimatedTotalSubtreeCost),
    rows: numberOf(attributes.EstimateRows),
    actualRows:
      actualRows === undefined
        ? undefined
        : executions !== undefined && executions > 0
          ? actualRows / executions
          : actualRows,
    loops: executions,
    timeMs: elapsed.length === 0 ? undefined : Math.max(...elapsed),
    warnings,
    properties: Object.entries(attributes).filter(
      ([key]) => key !== 'PhysicalOp' && key !== 'LogicalOp',
    ),
    children,
  });
}

function objectName(object: XmlElement): string {
  const strip = (value: string | undefined): string | undefined => value?.replace(/^\[|\]$/gu, '');
  const table = strip(object.attributes.Table);
  const alias = strip(object.attributes.Alias);
  const index = strip(object.attributes.Index);
  const base = [table, alias !== undefined && alias !== table ? alias : undefined]
    .filter((part) => part !== undefined)
    .join(' ');
  return index === undefined ? base : `${base} using ${index}`;
}

function predicateOf(operator: XmlElement): string | undefined {
  for (const name of PREDICATES) {
    const element = findFirst(operator, name, 'RelOp');
    const scalar = element === undefined ? undefined : findFirst(element, 'ScalarOperator');
    if (scalar?.attributes.ScalarString !== undefined) {
      return scalar.attributes.ScalarString;
    }
  }
  const order = findFirst(operator, 'OrderBy', 'RelOp');
  if (order !== undefined) {
    return findAll(order, 'ColumnReference')
      .map((column) => column.attributes.Column ?? '')
      .join(', ');
  }
  return undefined;
}

function warningsOf(element: XmlElement): PlanWarning[] {
  const found = element.children.flatMap((child): PlanWarning[] => {
    if (child.name.includes('Spill')) {
      return ['spill'];
    }
    if (child.name === 'ColumnsWithNoStatistics') {
      return ['missing-statistics'];
    }
    return child.name === 'PlanAffectingConvert' ? ['implicit-conversion'] : [];
  });
  const noJoin = element.attributes.NoJoinPredicate;
  if (noJoin === 'true' || noJoin === '1') {
    found.push('no-join-predicate');
  }
  return found;
}

/** Warnings the plan gives as a whole (conversions, no statistics) go on its top operator. */
function planWarnings(plan: XmlElement): PlanWarning[] {
  const element = plan.children.find((child) => child.name === 'Warnings');
  return element === undefined ? [] : warningsOf(element);
}

/** `CREATE INDEX` suggestions from the optimizer's missing index hints. */
function missingIndexes(plan: XmlElement): string[] {
  return findAll(plan, 'MissingIndexGroup', 'RelOp').flatMap((group) =>
    findAll(group, 'MissingIndex').map((index) => {
      const table = [index.attributes.Database, index.attributes.Schema, index.attributes.Table]
        .filter((part) => part !== undefined)
        .join('.');
      const columns = (usage: string): string[] =>
        findAll(index, 'ColumnGroup')
          .filter((columnGroup) => columnGroup.attributes.Usage === usage)
          .flatMap((columnGroup) =>
            findAll(columnGroup, 'Column').map((column) => column.attributes.Name ?? ''),
          );
      const keys = [...columns('EQUALITY'), ...columns('INEQUALITY')];
      const include = columns('INCLUDE');
      const impact = numberOf(group.attributes.Impact);
      return `${impact === undefined ? '' : `Impact ${Math.round(impact)}%: `}CREATE INDEX ON ${table} (${keys.join(', ')})${include.length > 0 ? ` INCLUDE (${include.join(', ')})` : ''}`;
    }),
  );
}

function sum(values: readonly (number | undefined)[]): number | undefined {
  const known = values.filter((value): value is number => value !== undefined);
  return known.length === 0 ? undefined : known.reduce((total, value) => total + value, 0);
}

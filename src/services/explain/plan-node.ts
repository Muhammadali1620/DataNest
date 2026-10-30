// Small helpers every plan reader (V8.2) shares: building nodes and reading the
// numbers and texts servers put in their plans.

import type { CellValue } from '../../shared/cell-value';
import { isMisestimate, type PlanNode, type PlanWarning } from '../../shared/query-plan';

export interface NodeParts {
  readonly operation: string;
  readonly object?: string | undefined;
  readonly detail?: string | undefined;
  readonly cost?: number | undefined;
  readonly rows?: number | undefined;
  readonly actualRows?: number | undefined;
  readonly loops?: number | undefined;
  readonly timeMs?: number | undefined;
  readonly warnings?: readonly PlanWarning[];
  readonly properties?: readonly (readonly [string, string])[];
  readonly children?: readonly PlanNode[];
}

/** A node without the absent fields; a misestimate is noticed here, once for all readers. */
export function planNode(parts: NodeParts): PlanNode {
  const warnings = [...(parts.warnings ?? [])];
  if (isMisestimate(parts.rows, parts.actualRows) && !warnings.includes('misestimate')) {
    warnings.push('misestimate');
  }
  return {
    operation: parts.operation,
    ...(parts.object === undefined || parts.object === '' ? {} : { object: parts.object }),
    ...(parts.detail === undefined || parts.detail === '' ? {} : { detail: parts.detail }),
    ...(finite(parts.cost) ? { cost: parts.cost } : {}),
    ...(finite(parts.rows) ? { rows: parts.rows } : {}),
    ...(finite(parts.actualRows) ? { actualRows: parts.actualRows } : {}),
    ...(finite(parts.loops) ? { loops: parts.loops } : {}),
    ...(finite(parts.timeMs) ? { timeMs: parts.timeMs } : {}),
    warnings: [...new Set(warnings)],
    properties: parts.properties ?? [],
    children: parts.children ?? [],
  };
}

function finite(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value);
}

/** A number from JSON or text; anything else is absent. */
export function numberOf(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** A cell as text, numbers and exact numbers included; NULL is absent. */
export function cellText(cell: CellValue | undefined): string | undefined {
  if (cell === null || cell === undefined) {
    return undefined;
  }
  if (typeof cell === 'string') {
    return cell;
  }
  if (typeof cell === 'number' || typeof cell === 'boolean') {
    return String(cell);
  }
  return 'text' in cell ? cell.text : undefined;
}

export function cellNumber(cell: CellValue | undefined): number | undefined {
  return numberOf(cellText(cell));
}

/** A property value as a short text: arrays joined, objects as JSON. */
export function propertyText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value) && value.every((item) => typeof item !== 'object' || item === null)) {
    return value.map(String).join(', ');
  }
  return typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
}

/** The text of a plan the server sent as rows of one column, line by line. */
export function joinedLines(rows: readonly (readonly CellValue[])[]): string {
  return rows.map((row) => cellText(row[0]) ?? '').join('\n');
}

/** Milliseconds from a number and the unit servers print after it. */
export function durationMs(value: number, unit: string): number {
  switch (unit) {
    case 'ns':
      return value / 1_000_000;
    case 'µs':
    case 'us':
      return value / 1000;
    case 's':
      return value * 1000;
    case 'm':
      return value * 60_000;
    default:
      return value;
  }
}

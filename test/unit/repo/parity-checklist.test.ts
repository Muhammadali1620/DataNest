// The parity checklist (V10.1) drives V10.2: its totals must match its rows, and every
// gap it sends to V10.2 must be a step of the plan, so neither can drift from the other.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from '../../helpers/repo';

const CHECKLIST = readFileSync(join(ROOT, 'docs/research/v10.1-parity-checklist.md'), 'utf8');
const ROADMAP = readFileSync(join(ROOT, 'ROADMAP.md'), 'utf8');

type Status = 'have' | 'partial' | 'v10' | 'backlog' | 'no';

const SUMMARY_LABELS: Readonly<Record<Status, RegExp>> = {
  have: /^Есть/u,
  partial: /^Частично/u,
  v10: /^Закрываем в V10\.2/u,
  backlog: /^Бэклог/u,
  no: /^Не делаем/u,
};

const SUBSTEP = /\*\*(V10\.2\.\d+)\*\*/u;

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/u, '')
    .replace(/\|$/u, '')
    .split('|')
    .map((cell) => cell.trim());
}

/** The table rows under the feature sections, i.e. every row after the summary. */
function featureRows(): string[][] {
  const body = CHECKLIST.slice(CHECKLIST.indexOf('\n## ', CHECKLIST.indexOf('## Итог') + 1));
  return body
    .split('\n')
    .filter((line) => line.startsWith('| ') && !/^\|\s*(Функция|СУБД) оригинала/u.test(line))
    .map(cells);
}

function statusOf(row: readonly string[]): Status | undefined {
  const [, status = '', where = ''] = row;
  if (SUBSTEP.test(status) || (status.startsWith('частично') && SUBSTEP.test(where))) {
    return 'v10';
  }
  if (status.startsWith('частично')) {
    return 'partial';
  }
  if (status.startsWith('есть')) {
    return 'have';
  }
  if (status.startsWith('бэклог')) {
    return 'backlog';
  }
  return status.startsWith('не делаем') ? 'no' : undefined;
}

function summary(): Map<Status, number> {
  const section = CHECKLIST.slice(CHECKLIST.indexOf('## Итог'));
  const totals = new Map<Status, number>();
  for (const line of section.slice(0, section.indexOf('\n## ', 1)).split('\n')) {
    const [label = '', count = ''] = cells(line);
    const status = (Object.keys(SUMMARY_LABELS) as Status[]).find((key) =>
      SUMMARY_LABELS[key].test(label),
    );
    if (status !== undefined) {
      totals.set(status, Number(count));
    }
  }
  return totals;
}

function roadmapSubsteps(): string[] {
  return [...ROADMAP.matchAll(/^\s*- \[.\] \*\*(V10\.2\.\d+)\*\*/gmu)].map(
    (match) => match[1] ?? '',
  );
}

describe('parity checklist', () => {
  it('gives every feature row a known status', () => {
    const rows = featureRows();
    expect(rows.length).toBeGreaterThan(100);
    expect(rows.filter((row) => statusOf(row) === undefined)).toEqual([]);
  });

  it('has totals that match its rows', () => {
    const counted = new Map<Status, number>();
    for (const row of featureRows()) {
      const status = statusOf(row);
      if (status !== undefined) {
        counted.set(status, (counted.get(status) ?? 0) + 1);
      }
    }
    expect(summary()).toEqual(counted);
  });

  it('sends gaps only to sub-steps the roadmap has', () => {
    const planned = new Set(roadmapSubsteps());
    const named = [...CHECKLIST.matchAll(/V10\.2\.\d+/gu)].map((match) => match[0]);
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((step) => !planned.has(step))).toEqual([]);
  });

  it('is the reason for every V10.2 sub-step of the roadmap', () => {
    const substeps = roadmapSubsteps();
    expect(substeps.length).toBeGreaterThan(0);
    expect(substeps.filter((step) => !CHECKLIST.includes(`**${step}**`))).toEqual([]);
  });

  it('is linked from the roadmap step that made it', () => {
    expect(ROADMAP).toMatch(
      /\*\*V10\.1\*\*[^\n]*\n[^\n]*docs\/research\/v10\.1-parity-checklist\.md/u,
    );
  });
});

import { describe, expect, it } from 'vitest';
import type { ScriptReport } from '../../../src/services/script-runner';
import {
  reasonOf,
  scriptReportText,
  type ScriptReportTexts,
} from '../../../src/vscode/script-report';

const TEXTS: ScriptReportTexts = {
  title: (file) => `Running ${file}`,
  target: (target) => `On ${target}`,
  finished: 'Finished',
  stopped: (line) => `Stopped at ${line}`,
  cancelled: 'Cancelled',
  totals: (statements, failed, rows) => `${statements} run, ${failed} failed, ${rows} rows`,
  read: (size, duration) => `${size} in ${duration}`,
  rolledBack: 'Rolled back',
  failures: 'Failures',
  more: (count) => `${count} more`,
  skipped: 'Skipped',
  line: (line) => `Line ${line}`,
  copyFromStdin: 'COPY skipped',
  psqlCommand: 'psql command',
};

const BASE: ScriptReport = {
  outcome: 'done',
  statements: 12,
  failedCount: 0,
  failures: [],
  skipped: [],
  affectedRows: 40,
  rolledBack: false,
  bytes: 2048,
  durationMs: 1500,
};

describe('scriptReportText', () => {
  it('summarizes a clean run', () => {
    expect(scriptReportText(BASE, 'dump.sql', 'Local / shop', TEXTS)).toBe(
      [
        '# Running dump.sql',
        '',
        '- On Local / shop',
        '- Finished',
        '- 12 run, 0 failed, 40 rows',
        '- 2 KB in 1.5 s',
        '',
      ].join('\n'),
    );
  });

  it('lists failures with their statements, and how many were left out', () => {
    const report: ScriptReport = {
      ...BASE,
      outcome: 'stopped',
      failedCount: 3,
      failures: [
        {
          kind: 'error',
          line: 4,
          statement: 'SELECT ```x',
          message: 'syntax error',
          code: 'syntax',
        },
        { kind: 'copy-from-stdin', line: 9, statement: 'COPY t FROM stdin' },
      ],
      stoppedAt: { kind: 'copy-from-stdin', line: 9, statement: 'COPY t FROM stdin' },
      skipped: [{ line: 1, text: '\\restrict `k`' }],
      rolledBack: true,
    };
    const text = scriptReportText(report, 'dump.sql', 'Local', TEXTS);
    expect(text).toContain('- Stopped at 9');
    expect(text).toContain('- Rolled back');
    expect(text).toContain('## Failures\n\n1. Line 4: syntax error\n\n````sql\nSELECT ```x\n````');
    expect(text).toContain('2. Line 9: COPY skipped');
    expect(text).toContain('1 more');
    expect(text).toContain("## Skipped\n\n- Line 1: `\\restrict 'k'`");
    expect(text).not.toMatch(/\n{3}/u);
  });

  it('says when a run was cancelled', () => {
    expect(scriptReportText({ ...BASE, outcome: 'cancelled' }, 'a.sql', 'L', TEXTS)).toContain(
      '- Cancelled',
    );
  });
});

describe('reasonOf', () => {
  it('names why each kind of failure happened', () => {
    expect(reasonOf({ kind: 'psql-command', line: 1, statement: '\\c x' }, TEXTS)).toBe(
      'psql command',
    );
    expect(reasonOf({ kind: 'error', line: 1, statement: 'x' }, TEXTS)).toBe('');
  });
});

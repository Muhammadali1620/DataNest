import { describe, expect, it } from 'vitest';
import type { TransferReport } from '../../../src/services/transfer/table-transfer';
import {
  transferReportText,
  type TransferReportTexts,
  worthReading,
} from '../../../src/vscode/transfer-report';

const TEXTS: TransferReportTexts = {
  title: (from, to) => `From ${from} to ${to}`,
  totals: (copied, rows, duration) => `${copied} tables, ${rows} rows, ${duration}`,
  cancelled: 'Cancelled',
  copied: (rows) => `${rows} rows`,
  created: 'Created',
  skipped: 'Skipped',
  failed: (error) => `Failed: ${error}`,
  note: (note) => `Note ${note.kind}`,
};

const CLEAN: TransferReport = {
  outcome: 'done',
  tables: [{ table: 'a', outcome: 'copied', created: true, rows: 3, notes: [] }],
  rows: 3,
  durationMs: 1200,
};

describe('transferReportText', () => {
  it('lists every table with what happened to it', () => {
    const report: TransferReport = {
      outcome: 'cancelled',
      tables: [
        {
          table: 'a',
          outcome: 'copied',
          created: true,
          rows: 3,
          notes: [{ kind: 'generated-skipped', column: 'x' }],
        },
        { table: 'b', outcome: 'skipped', created: false, rows: 0, notes: [] },
        { table: 'c', outcome: 'failed', created: false, rows: 0, notes: [], error: 'boom' },
      ],
      rows: 3,
      durationMs: 1200,
    };
    expect(transferReportText(report, 'X', 'Y', TEXTS)).toBe(
      [
        '# From X to Y',
        '',
        '- 1 tables, 3 rows, 1.2 s',
        '- Cancelled',
        '',
        '## a',
        '',
        '- Created',
        '- 3 rows',
        '- Note generated-skipped',
        '',
        '## b',
        '',
        '- Skipped',
        '',
        '## c',
        '',
        '- 0 rows',
        '- Failed: boom',
        '',
      ].join('\n'),
    );
  });
});

describe('worthReading', () => {
  it('is true only when there is more than counts', () => {
    expect(worthReading(CLEAN)).toBe(false);
    expect(
      worthReading({
        ...CLEAN,
        tables: [
          {
            table: 'a',
            outcome: 'copied',
            created: false,
            rows: 1,
            notes: [{ kind: 'columns-skipped', columns: ['x'] }],
          },
        ],
      }),
    ).toBe(true);
    expect(
      worthReading({
        ...CLEAN,
        tables: [{ table: 'a', outcome: 'skipped', created: false, rows: 0, notes: [] }],
      }),
    ).toBe(true);
  });
});

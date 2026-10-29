// The report of a transfer between connections (V5.6) as a Markdown document. Free
// of `vscode`, so the layout is covered by unit tests; the words come in translated.

import { formatDuration } from '../services/history-format';
import type { TransferNote, TransferReport } from '../services/transfer/table-transfer';

export interface TransferReportTexts {
  readonly title: (from: string, to: string) => string;
  readonly totals: (copied: number, rows: number, duration: string) => string;
  readonly cancelled: string;
  readonly copied: (rows: number) => string;
  readonly created: string;
  readonly skipped: string;
  readonly failed: (error: string) => string;
  readonly note: (note: TransferNote) => string;
}

export function transferReportText(
  report: TransferReport,
  from: string,
  to: string,
  texts: TransferReportTexts,
): string {
  const copied = report.tables.filter((table) => table.outcome === 'copied').length;
  const lines = [
    `# ${texts.title(from, to)}`,
    '',
    `- ${texts.totals(copied, report.rows, formatDuration(report.durationMs))}`,
  ];
  if (report.outcome === 'cancelled') {
    lines.push(`- ${texts.cancelled}`);
  }
  for (const table of report.tables) {
    lines.push('', `## ${table.table}`, '');
    if (table.outcome === 'skipped') {
      lines.push(`- ${texts.skipped}`);
    } else {
      if (table.created) {
        lines.push(`- ${texts.created}`);
      }
      lines.push(`- ${texts.copied(table.rows)}`);
    }
    if (table.error !== undefined) {
      lines.push(`- ${texts.failed(table.error)}`);
    }
    for (const note of table.notes) {
      lines.push(`- ${texts.note(note)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** True when the report holds more than counts: a failure, a skip or a note. */
export function worthReading(report: TransferReport): boolean {
  return report.tables.some(
    (table) => table.outcome !== 'copied' || table.error !== undefined || table.notes.length > 0,
  );
}

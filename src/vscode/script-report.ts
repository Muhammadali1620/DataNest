// The report of a SQL file run (V5.1) as a Markdown document. Free of `vscode`, so
// the layout is covered by unit tests; the words come in already translated.

import { formatSize } from '../shared/byte-size';
import { formatDuration } from '../services/history-format';
import type { ScriptFailure, ScriptReport } from '../services/script-runner';

export interface ScriptReportTexts {
  readonly title: (file: string) => string;
  readonly target: (target: string) => string;
  readonly finished: string;
  readonly stopped: (line: number) => string;
  readonly cancelled: string;
  readonly totals: (statements: number, failed: number, rows: number) => string;
  readonly read: (size: string, duration: string) => string;
  readonly rolledBack: string;
  readonly failures: string;
  readonly more: (count: number) => string;
  readonly skipped: string;
  readonly line: (line: number) => string;
  readonly copyFromStdin: string;
  readonly psqlCommand: string;
}

export function scriptReportText(
  report: ScriptReport,
  file: string,
  target: string,
  texts: ScriptReportTexts,
): string {
  const lines = [`# ${texts.title(file)}`, '', `- ${texts.target(target)}`];
  lines.push(`- ${outcomeText(report, texts)}`);
  lines.push(`- ${texts.totals(report.statements, report.failedCount, report.affectedRows)}`);
  lines.push(`- ${texts.read(formatSize(report.bytes), formatDuration(report.durationMs))}`);
  if (report.rolledBack) {
    lines.push(`- ${texts.rolledBack}`);
  }
  if (report.failures.length > 0) {
    lines.push('', `## ${texts.failures}`, '');
    report.failures.forEach((failure, index) => {
      lines.push(`${index + 1}. ${texts.line(failure.line)}: ${reasonOf(failure, texts)}`);
      lines.push('', fenced(failure.statement), '');
    });
    const hidden = report.failedCount - report.failures.length;
    if (hidden > 0) {
      lines.push(texts.more(hidden), '');
    }
  }
  if (report.skipped.length > 0) {
    lines.push('', `## ${texts.skipped}`, '');
    for (const item of report.skipped) {
      lines.push(`- ${texts.line(item.line)}: \`${item.text.replaceAll('`', "'")}\``);
    }
  }
  return `${lines
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trimEnd()}\n`;
}

export function reasonOf(failure: ScriptFailure, texts: ScriptReportTexts): string {
  switch (failure.kind) {
    case 'copy-from-stdin':
      return texts.copyFromStdin;
    case 'psql-command':
      return texts.psqlCommand;
    case 'error':
      return failure.message ?? '';
  }
}

function outcomeText(report: ScriptReport, texts: ScriptReportTexts): string {
  switch (report.outcome) {
    case 'done':
      return texts.finished;
    case 'cancelled':
      return texts.cancelled;
    case 'stopped':
      return texts.stopped(report.stoppedAt?.line ?? 0);
  }
}

/** A code block that a backtick run inside the statement cannot close early. */
function fenced(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/gu)].map((match) => match[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}sql\n${text}\n${fence}`;
}

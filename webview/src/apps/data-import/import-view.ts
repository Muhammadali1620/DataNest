// Words for what the import page shows; plain functions, so they are unit-tested.

import type { ImportPageReport } from '../../../../src/shared/protocols/data-import';
import type { MessageKey } from '../../l10n/en';
import type { Translate } from '../../lib/i18n';

/** Why a value does not fit its column, in the user's words. */
export function problemText(problem: string, t: Translate): string {
  const known: Record<string, MessageKey> = {
    'invalid-integer': 'grid.editError.invalid-integer',
    'invalid-number': 'grid.editError.invalid-number',
    'invalid-boolean': 'grid.editError.invalid-boolean',
    'invalid-date': 'grid.editError.invalid-date',
    'invalid-time': 'grid.editError.invalid-time',
    'invalid-datetime': 'grid.editError.invalid-datetime',
    'invalid-json': 'grid.editError.invalid-json',
    'invalid-enum': 'grid.editError.invalid-enum',
    'invalid-binary': 'import.problem.binary',
    'not-a-value': 'import.problem.nested',
  };
  const key = known[problem];
  return key === undefined ? problem : t(key);
}

/** One line of the failure list: where, which column, and why. */
export function failureText(failure: ImportPageReport['failures'][number], t: Translate): string {
  const where =
    failure.line === 0
      ? t('import.failure.after')
      : failure.lastLine === undefined
        ? t('import.failure.line', failure.line)
        : t('import.failure.lines', failure.line, failure.lastLine);
  const why =
    failure.problem !== undefined ? problemText(failure.problem, t) : (failure.message ?? '');
  return failure.column === undefined
    ? `${where}: ${why}`
    : `${where}, ${t('import.failure.column', failure.column)}: ${why}`;
}

/** The summary line of a finished import. */
export function reportText(report: ImportPageReport, t: Translate): string {
  if (report.outcome === 'cancelled') {
    return report.rolledBack
      ? t('import.report.cancelledNothing')
      : t('import.report.cancelled', report.inserted);
  }
  if (report.rolledBack) {
    return t('import.report.rolledBack', report.read);
  }
  return report.failedCount === 0
    ? t('import.report.done', report.inserted)
    : t('import.report.doneWithFailures', report.inserted, report.failedCount);
}

/** How a delimiter is named in the list. */
export const DELIMITER_LABELS: Readonly<Record<string, MessageKey>> = {
  ',': 'import.delimiter.comma',
  ';': 'import.delimiter.semicolon',
  '\t': 'import.delimiter.tab',
  '|': 'import.delimiter.pipe',
};

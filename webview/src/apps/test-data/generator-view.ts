// Words for the test data page; plain functions, so they are unit-tested.

import type { GeneratorId, TestDataReport } from '../../../../src/shared/protocols/test-data';
import type { MessageKey } from '../../l10n/en';
import type { Translate } from '../../lib/i18n';

/** The name of a generator in the list. */
export function generatorLabel(id: GeneratorId, t: Translate): string {
  return t(`generator.${id}` as MessageKey);
}

/** Why a column cannot be filled as chosen. */
export function problemLabel(problem: string, t: Translate): string {
  switch (problem) {
    case 'no-references':
      return t('testData.problem.noReferences');
    case 'no-options':
      return t('testData.problem.noOptions');
    case 'not-nullable':
      return t('testData.problem.notNullable');
    default:
      return problem;
  }
}

/** The summary of a finished run. */
export function reportLabel(report: TestDataReport, t: Translate): string {
  switch (report.outcome) {
    case 'done':
      return t('testData.report.done', report.inserted);
    case 'cancelled':
      return t('testData.report.cancelled');
    case 'stopped':
      return t('testData.report.stopped', report.message ?? '');
  }
}

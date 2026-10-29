import { describe, expect, it } from 'vitest';
import type { ImportPageReport } from '../../../../../src/shared/protocols/data-import';
import {
  failureText,
  problemText,
  reportText,
} from '../../../../../webview/src/apps/data-import/import-view';
import { createTranslator } from '../../../../../webview/src/lib/i18n';

const t = createTranslator('en');
const ru = createTranslator('ru');

const REPORT: ImportPageReport = {
  outcome: 'done',
  read: 5,
  inserted: 5,
  failedCount: 0,
  failures: [],
  rolledBack: false,
  durationMs: 1,
};

describe('problemText', () => {
  it('names each problem, and passes unknown ones through', () => {
    expect(problemText('invalid-date', t)).toBe('Enter a date as YYYY-MM-DD');
    expect(problemText('invalid-binary', t)).toContain('hex');
    expect(problemText('not-a-value', t)).toContain('JSON');
    expect(problemText('something-new', t)).toBe('something-new');
  });
});

describe('failureText', () => {
  it('says where and why', () => {
    expect(failureText({ line: 4, column: 'age', problem: 'invalid-integer' }, t)).toBe(
      'Line 4, column age: Enter a whole number',
    );
    expect(failureText({ line: 4, lastLine: 9, message: 'deadlock' }, t)).toBe(
      'Lines 4–9: deadlock',
    );
    expect(failureText({ line: 0, column: 'id', message: 'no sequence' }, t)).toBe(
      'After the import, column id: no sequence',
    );
    expect(failureText({ line: 2 }, ru)).toBe('Строка 2: ');
  });
});

describe('reportText', () => {
  it('sums up every outcome', () => {
    expect(reportText(REPORT, t)).toBe('Done: 5 rows imported');
    expect(reportText({ ...REPORT, inserted: 3, failedCount: 2 }, t)).toBe(
      'Done: 3 rows imported, 2 left out',
    );
    expect(reportText({ ...REPORT, outcome: 'stopped', rolledBack: true }, t)).toContain(
      'Nothing was imported',
    );
    expect(reportText({ ...REPORT, outcome: 'cancelled', inserted: 7 }, t)).toBe(
      'Stopped: 7 rows were imported before that',
    );
    expect(reportText({ ...REPORT, outcome: 'cancelled', rolledBack: true }, t)).toBe(
      'Stopped: nothing was imported',
    );
  });
});

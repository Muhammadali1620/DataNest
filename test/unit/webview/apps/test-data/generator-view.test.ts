import { describe, expect, it } from 'vitest';
import { GENERATOR_IDS } from '../../../../../src/shared/protocols/test-data';
import {
  generatorLabel,
  problemLabel,
  reportLabel,
} from '../../../../../webview/src/apps/test-data/generator-view';
import { createTranslator } from '../../../../../webview/src/lib/i18n';

const en = createTranslator('en');
const ru = createTranslator('ru');

describe('generatorLabel', () => {
  it('names every generator in both languages', () => {
    for (const id of GENERATOR_IDS) {
      expect(generatorLabel(id, en), id).not.toMatch(/^generator\./u);
      expect(generatorLabel(id, ru), id).not.toMatch(/^generator\./u);
    }
    expect(generatorLabel('email', en)).toBe('Email');
  });
});

describe('problemLabel and reportLabel', () => {
  it('says why and how it ended', () => {
    expect(problemLabel('no-options', en)).toBe('The column type lists no values');
    expect(problemLabel('other', en)).toBe('other');
    expect(reportLabel({ outcome: 'done', inserted: 5, durationMs: 1 }, en)).toBe(
      'Done: 5 rows inserted',
    );
    expect(reportLabel({ outcome: 'cancelled', inserted: 0, durationMs: 1 }, en)).toBe(
      'Stopped: nothing was inserted',
    );
    expect(reportLabel({ outcome: 'stopped', inserted: 0, durationMs: 1 }, ru)).toBe(
      'Ничего не вставлено: ',
    );
  });
});

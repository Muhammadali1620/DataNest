import { describe, expect, it } from 'vitest';
import { MAX_FILL_CELLS, seriesTexts, type SeriesSpec } from '../../../src/shared/cell-fill';

function numbers(
  spec: Omit<Extract<SeriesSpec, { kind: 'series' }>, 'kind'>,
  count: number,
): string[] {
  const made = seriesTexts({ kind: 'series', ...spec }, count);
  if (!made.ok) {
    throw new Error(made.problem);
  }
  return made.texts;
}

function dates(
  start: string,
  step: number,
  unit: Extract<SeriesSpec, { kind: 'dates' }>['unit'],
  count: number,
): string[] {
  const made = seriesTexts({ kind: 'dates', start, step, unit }, count);
  if (!made.ok) {
    throw new Error(made.problem);
  }
  return made.texts;
}

function problem(spec: SeriesSpec, count = 3): string | undefined {
  const made = seriesTexts(spec, count);
  return made.ok ? undefined : made.problem;
}

describe('number series (V12.6)', () => {
  it('counts up from the start', () => {
    expect(numbers({ start: '1', step: '1' }, 4)).toEqual(['1', '2', '3', '4']);
  });

  it('steps by any whole number, down as well as up', () => {
    expect(numbers({ start: '10', step: '5' }, 3)).toEqual(['10', '15', '20']);
    expect(numbers({ start: '3', step: '-2' }, 4)).toEqual(['3', '1', '-1', '-3']);
    expect(numbers({ start: '7', step: '0' }, 3)).toEqual(['7', '7', '7']);
  });

  it('is exact with decimals: 0.1 + 0.2 is 0.3', () => {
    expect(numbers({ start: '0.1', step: '0.1' }, 4)).toEqual(['0.1', '0.2', '0.3', '0.4']);
    expect(numbers({ start: '1', step: '0.25' }, 3)).toEqual(['1.00', '1.25', '1.50']);
    expect(numbers({ start: '-0.5', step: '0.25' }, 4)).toEqual(['-0.50', '-0.25', '0.00', '0.25']);
  });

  it('goes through zero with the right sign', () => {
    expect(numbers({ start: '-1', step: '1' }, 3)).toEqual(['-1', '0', '1']);
    expect(numbers({ start: '1', step: '-0.5' }, 4)).toEqual(['1.0', '0.5', '0.0', '-0.5']);
  });

  it('accepts a leading plus and spaces around the numbers', () => {
    expect(numbers({ start: ' +5 ', step: ' 2 ' }, 2)).toEqual(['5', '7']);
  });

  it('is exact beyond what a double can hold', () => {
    expect(numbers({ start: '9007199254740993', step: '1' }, 2)).toEqual([
      '9007199254740993',
      '9007199254740994',
    ]);
  });

  it('pads with leading zeros', () => {
    expect(numbers({ start: '8', step: '1', pad: 3 }, 4)).toEqual(['008', '009', '010', '011']);
    expect(numbers({ start: '-8', step: '4', pad: 3 }, 3)).toEqual(['-008', '-004', '000']);
    expect(numbers({ start: '5', step: '1', pad: 0 }, 1)).toEqual(['5']);
  });

  it('pads only the part before the point', () => {
    expect(numbers({ start: '1.5', step: '1', pad: 3 }, 2)).toEqual(['001.5', '002.5']);
  });

  it('keeps the pad within bounds', () => {
    expect(numbers({ start: '1', step: '1', pad: 1000 }, 1)[0]).toHaveLength(40);
  });

  it('puts the number into a template, every {n}', () => {
    expect(numbers({ start: '1', step: '1', template: 'user{n}@example.com' }, 2)).toEqual([
      'user1@example.com',
      'user2@example.com',
    ]);
    expect(numbers({ start: '1', step: '1', template: '{n}-{n}' }, 2)).toEqual(['1-1', '2-2']);
  });

  it('gives nothing for no cells', () => {
    expect(numbers({ start: '1', step: '1' }, 0)).toEqual([]);
  });

  it('refuses what is not a number', () => {
    for (const start of ['', 'abc', '1e3', '1,5', '1.', '.5', '--1', '1 2']) {
      expect(problem({ kind: 'series', start, step: '1' })).toBe('invalid-start');
    }
    for (const step of ['', 'x', '1/2']) {
      expect(problem({ kind: 'series', start: '1', step })).toBe('invalid-step');
    }
  });

  it('refuses numbers with too many digits', () => {
    expect(problem({ kind: 'series', start: '1'.repeat(31), step: '1' })).toBe('invalid-start');
    expect(problem({ kind: 'series', start: '1', step: `0.${'1'.repeat(30)}` })).toBe(
      'invalid-step',
    );
  });

  it('refuses a template without a place for the number', () => {
    expect(problem({ kind: 'series', start: '1', step: '1', template: 'user' })).toBe(
      'invalid-template',
    );
  });

  it('refuses more cells than a fill may touch', () => {
    expect(problem({ kind: 'series', start: '1', step: '1' }, MAX_FILL_CELLS + 1)).toBe(
      'too-many-cells',
    );
    expect(problem({ kind: 'series', start: '1', step: '1' }, MAX_FILL_CELLS)).toBeUndefined();
  });
});

describe('date series (V12.6)', () => {
  it('steps by days, across month and year ends', () => {
    expect(dates('2024-02-27', 1, 'day', 4)).toEqual([
      '2024-02-27',
      '2024-02-28',
      '2024-02-29',
      '2024-03-01',
    ]);
    expect(dates('2023-12-30', 1, 'day', 3)).toEqual(['2023-12-30', '2023-12-31', '2024-01-01']);
  });

  it('steps by weeks and backwards', () => {
    expect(dates('2024-01-01', 1, 'week', 3)).toEqual(['2024-01-01', '2024-01-08', '2024-01-15']);
    expect(dates('2024-01-03', -2, 'day', 3)).toEqual(['2024-01-03', '2024-01-01', '2023-12-30']);
  });

  it('steps by months and keeps the last day of a short month', () => {
    expect(dates('2024-01-31', 1, 'month', 4)).toEqual([
      '2024-01-31',
      '2024-02-29',
      '2024-03-31',
      '2024-04-30',
    ]);
    expect(dates('2024-03-15', -4, 'month', 2)).toEqual(['2024-03-15', '2023-11-15']);
  });

  it('steps by years, and a leap day lands on the 28th in other years', () => {
    expect(dates('2024-02-29', 1, 'year', 3)).toEqual(['2024-02-29', '2025-02-28', '2026-02-28']);
  });

  it('keeps the time of day as typed', () => {
    expect(dates('2024-01-01 08:30:00', 1, 'day', 2)).toEqual([
      '2024-01-01 08:30:00',
      '2024-01-02 08:30:00',
    ]);
    expect(dates('2024-01-01T08:30', 1, 'month', 2)).toEqual([
      '2024-01-01T08:30',
      '2024-02-01T08:30',
    ]);
  });

  it('a step of zero repeats the date', () => {
    expect(dates('2024-05-05', 0, 'day', 2)).toEqual(['2024-05-05', '2024-05-05']);
  });

  it('refuses what is not a date', () => {
    for (const start of [
      '',
      'tomorrow',
      '2024-13-01',
      '2024-02-30',
      '2023-02-29',
      '2024-00-10',
      '24-01-01',
    ]) {
      expect(problem({ kind: 'dates', start, step: 1, unit: 'day' })).toBe('invalid-start-date');
    }
  });

  it('refuses a step that is not whole or goes out of the calendar', () => {
    expect(problem({ kind: 'dates', start: '2024-01-01', step: 1.5, unit: 'day' })).toBe(
      'invalid-step',
    );
    expect(problem({ kind: 'dates', start: '9999-12-31', step: 1, unit: 'day' })).toBe(
      'invalid-step',
    );
    expect(problem({ kind: 'dates', start: '0001-01-01', step: -1, unit: 'year' })).toBe(
      'invalid-step',
    );
  });

  it('refuses an unknown unit', () => {
    expect(problem({ kind: 'dates', start: '2024-01-01', step: 1, unit: 'hour' as 'day' })).toBe(
      'invalid-step',
    );
  });

  it('refuses more cells than a fill may touch', () => {
    expect(
      problem({ kind: 'dates', start: '2024-01-01', step: 1, unit: 'day' }, MAX_FILL_CELLS + 1),
    ).toBe('too-many-cells');
  });
});

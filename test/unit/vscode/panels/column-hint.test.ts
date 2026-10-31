import type { ViewColumn } from 'vscode';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearColumnHint,
  hasColumnHint,
  hintColumn,
  takeColumnHint,
} from '../../../../src/vscode/panels/column-hint';

afterEach(clearColumnHint);

// The real enum is not loaded in unit tests; the hint only passes the number through.
// eslint-disable-next-line @typescript-eslint/no-unsafe-enum-assignment -- plain number stands in for the enum
const column = (n: number): ViewColumn => n;

describe('column hint', () => {
  it('is empty until a page hands its column over', () => {
    expect(hasColumnHint()).toBe(false);
    expect(takeColumnHint()).toBeUndefined();
  });

  it('gives the column to the next panel only once', () => {
    hintColumn(column(2));
    expect(hasColumnHint()).toBe(true);
    expect(takeColumnHint()).toBe(2);
    expect(hasColumnHint()).toBe(false);
    expect(takeColumnHint()).toBeUndefined();
  });

  it('forgets a column nobody used', () => {
    hintColumn(column(1));
    clearColumnHint();
    expect(takeColumnHint()).toBeUndefined();
  });

  it('keeps no hint for a page whose column is unknown', () => {
    hintColumn(undefined);
    expect(hasColumnHint()).toBe(false);
  });
});

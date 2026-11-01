import { describe, expect, it } from 'vitest';
import { folderCountView } from '../../../../src/vscode/tree/folder-count';

const format = (count: number): string => count.toLocaleString('en-US').replaceAll(',', ' ');

describe('folderCountView', () => {
  it('shows the loaded keys until the folder is counted', () => {
    expect(folderCountView(1200, undefined, format)).toEqual({ kind: 'loaded', text: '1 200' });
  });

  it('shows the climb while counting', () => {
    expect(folderCountView(5, { state: 'counting', found: 4200 }, format)).toEqual({
      kind: 'counting',
      found: '4 200',
      text: '… 4 200',
    });
    expect(folderCountView(5, { state: 'counting', found: 0 }, format).text).toBe('… 0');
  });

  it('shows the exact number as it is', () => {
    expect(folderCountView(5, { state: 'counted', count: 12840, exact: true }, format)).toEqual({
      kind: 'counted',
      exact: true,
      count: '12 840',
      text: '12 840',
    });
  });

  it('puts ≥ before a number that is only a lower bound', () => {
    expect(folderCountView(5, { state: 'counted', count: 100000, exact: false }, format)).toEqual({
      kind: 'counted',
      exact: false,
      count: '100 000',
      text: '≥ 100 000',
    });
  });

  it('shows zero keys, which a count can find', () => {
    expect(folderCountView(0, { state: 'counted', count: 0, exact: true }, format).text).toBe('0');
  });
});

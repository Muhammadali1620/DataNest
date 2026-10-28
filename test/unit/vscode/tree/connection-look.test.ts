import { describe, expect, it } from 'vitest';
import { CONNECTION_COLORS } from '../../../../src/shared/connection';
import { COLOR_THEME_IDS, lookOf } from '../../../../src/vscode/tree/connection-look';

describe('lookOf', () => {
  it('has no look without a color', () => {
    expect(lookOf(undefined)).toBeUndefined();
    expect(lookOf({ id: 'c', name: 'n', driver: 'mysql' })).toBeUndefined();
  });

  it('colors the label with a theme color and adds a dot', () => {
    expect(lookOf({ id: 'c', name: 'n', driver: 'mysql', color: 'red' })).toEqual({
      color: 'charts.red',
      badge: '●',
    });
  });

  it('maps every color onto a chart color of the theme', () => {
    for (const color of CONNECTION_COLORS) {
      expect(COLOR_THEME_IDS[color]).toBe(`charts.${color}`);
    }
  });
});

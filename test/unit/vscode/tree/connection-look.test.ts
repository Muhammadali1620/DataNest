import { describe, expect, it } from 'vitest';
import { CONNECTION_COLORS } from '../../../../src/shared/connection';
import { COLOR_THEME_IDS, lookOf, tagsOf } from '../../../../src/vscode/tree/connection-look';

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

describe('production and read-only marks', () => {
  const base = { id: 'c', name: 'n', driver: 'mysql' as const };

  it('lists the marks in a fixed order', () => {
    expect(tagsOf(undefined)).toEqual([]);
    expect(tagsOf({ ...base, readOnly: true, production: true })).toEqual([
      'production',
      'read-only',
    ]);
  });

  it('shows production in red with a P, unless another color was chosen', () => {
    expect(lookOf({ ...base, production: true }, (tag) => tag.toUpperCase())).toEqual({
      color: 'charts.red',
      badge: 'P',
      tooltip: 'PRODUCTION',
    });
    expect(lookOf({ ...base, production: true, color: 'blue' })?.color).toBe('charts.blue');
  });

  it('shows read-only with RO and no color of its own', () => {
    expect(lookOf({ ...base, readOnly: true })).toEqual({ badge: 'RO', tooltip: 'read-only' });
    expect(lookOf({ ...base, readOnly: true, production: true })).toMatchObject({
      badge: 'P',
      tooltip: 'production, read-only',
    });
  });
});

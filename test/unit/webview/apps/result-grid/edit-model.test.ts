import { describe, expect, it } from 'vitest';
import {
  controlFor,
  type EditColumn,
  initialText,
  isEditableColumn,
} from '../../../../../webview/src/apps/result-grid/edit-model';

function column(kind: EditColumn['kind'], options?: string[]): EditColumn {
  return { dataType: kind, kind, nullable: true, ...(options === undefined ? {} : { options }) };
}

describe('controlFor', () => {
  it('gives a boolean a true/false choice', () => {
    expect(controlFor(column('boolean'))).toEqual({ type: 'select', options: ['true', 'false'] });
  });

  it('gives an enum its allowed values, or free text when they are unknown', () => {
    expect(controlFor(column('enum', ['a', 'b']))).toEqual({ type: 'select', options: ['a', 'b'] });
    expect(controlFor(column('enum'))).toEqual({ type: 'input', inputType: 'text' });
  });

  it('gives a date the native date input', () => {
    expect(controlFor(column('date'))).toEqual({ type: 'input', inputType: 'date' });
  });

  it('says how to spell time, timestamps and JSON', () => {
    expect(controlFor(column('time'))).toMatchObject({ placeholder: 'HH:MM:SS' });
    expect(controlFor(column('datetime'))).toMatchObject({ placeholder: 'YYYY-MM-DD HH:MM:SS' });
    expect(controlFor(column('json'))).toMatchObject({ inputType: 'text' });
  });

  it('gives text and numbers a plain input', () => {
    for (const kind of ['text', 'integer', 'number'] as const) {
      expect(controlFor(column(kind))).toEqual({ type: 'input', inputType: 'text' });
    }
  });
});

describe('initialText', () => {
  it('starts empty for NULL and exact for everything else', () => {
    expect(initialText(null)).toBe('');
    expect(initialText('a\nb')).toBe('a\nb');
    expect(initialText(5)).toBe('5');
    expect(initialText(false)).toBe('false');
    expect(initialText({ kind: 'bigint', text: '9223372036854775807' })).toBe(
      '9223372036854775807',
    );
    expect(initialText({ kind: 'datetime', text: '2024-01-01 10:00:00.123456' })).toBe(
      '2024-01-01 10:00:00.123456',
    );
  });
});

describe('isEditableColumn', () => {
  it('rejects computed and binary columns', () => {
    expect(isEditableColumn(null)).toBe(false);
    expect(isEditableColumn(undefined)).toBe(false);
    expect(isEditableColumn(column('binary'))).toBe(false);
    expect(isEditableColumn(column('text'))).toBe(true);
  });
});

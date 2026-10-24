import { describe, expect, it } from 'vitest';
import {
  createTranslator,
  dictionaryFor,
  format,
  pageTranslator,
} from '../../../../webview/src/lib/i18n';
import { en } from '../../../../webview/src/l10n/en';
import { ru } from '../../../../webview/src/l10n/ru';

describe('format', () => {
  it('replaces numbered placeholders', () => {
    expect(format('{0} of {1}', [3, 'ten'])).toBe('3 of ten');
    expect(format('{1}{0}{1}', ['a', 'b'])).toBe('bab');
  });

  it('keeps placeholders without an argument', () => {
    expect(format('Hi {0} and {2}', ['Ann'])).toBe('Hi Ann and {2}');
  });

  it('does not interpret arguments as templates', () => {
    expect(format('{0}', ['{1}', 'x'])).toBe('{1}');
  });
});

describe('dictionaryFor', () => {
  it.each([
    ['en', en],
    ['ru', ru],
    ['RU', ru],
    ['ru-RU', ru],
    ['en-gb', en],
    ['de', en],
    ['', en],
  ])('picks a dictionary for %j', (lang, expected) => {
    expect(dictionaryFor(lang)).toBe(expected);
  });
});

describe('translations', () => {
  it('have the same keys in every language', () => {
    expect(Object.keys(ru).sort()).toEqual(Object.keys(en).sort());
  });

  it('have no empty strings', () => {
    for (const value of [...Object.values(en), ...Object.values(ru)]) {
      expect(value.trim()).not.toBe('');
    }
  });

  it('use the same placeholders in every language', () => {
    const placeholders = (text: string) => [...text.matchAll(/\{\d+\}/g)].map((m) => m[0]).sort();
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(placeholders(ru[key])).toEqual(placeholders(en[key]));
    }
  });
});

describe('translators', () => {
  it('translate keys with arguments', () => {
    expect(createTranslator('ru')('ping.reply', 2, 'ok')).toBe('Ответ №2: ok');
    expect(createTranslator('en')('ping.reply', 2, 'ok')).toBe('Reply #2: ok');
  });

  it('read the language from <html lang>', () => {
    document.documentElement.lang = 'ru';
    expect(pageTranslator()('ping.send')).toBe('Отправить');
    document.documentElement.lang = '';
    expect(pageTranslator()('ping.send')).toBe('Ping');
  });
});

import { en, type MessageKey } from '../l10n/en';
import { ru } from '../l10n/ru';

const DICTIONARIES: Readonly<Record<string, Readonly<Record<MessageKey, string>>>> = { en, ru };

/** Picks the dictionary for a VS Code language id like `ru` or `pt-br`; English otherwise. */
export function dictionaryFor(lang: string): Readonly<Record<MessageKey, string>> {
  const normalized = lang.toLowerCase();
  const base = normalized.replace(/-.*$/, '');
  return DICTIONARIES[normalized] ?? DICTIONARIES[base] ?? en;
}

/** Replaces `{0}`, `{1}`, … with the arguments; unknown placeholders stay as they are. */
export function format(template: string, args: readonly (string | number)[]): string {
  return template.replace(/\{(\d+)\}/g, (match, index: string) => {
    const value = args[Number(index)];
    return value === undefined ? match : String(value);
  });
}

export type Translate = (key: MessageKey, ...args: (string | number)[]) => string;

export function createTranslator(lang: string): Translate {
  const dictionary = dictionaryFor(lang);
  return (key, ...args) => format(dictionary[key], args);
}

/** The translator for the current page, using `<html lang>` set by the host. */
export function pageTranslator(doc: Pick<Document, 'documentElement'> = document): Translate {
  return createTranslator(doc.documentElement.lang || 'en');
}

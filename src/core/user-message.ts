// Messages the user reads that come from below the editor layer — errors, states,
// reports. They are written in English with {0}-style places for values, and the editor
// layer translates them (V9.2, D100): extension.ts installs a translator once, shared by
// every bundle through the global symbol registry, as DbError's brand is (D82). Without
// one — unit tests, a worker thread — the English text is used.

export type MessageArg = string | number | boolean;

/** Turns an English template and its values into the text to show. */
export type Translator = (template: string, args: readonly MessageArg[]) => string;

const TRANSLATOR = Symbol.for('datanest.translator');

interface TranslatorHolder {
  [TRANSLATOR]?: Translator;
}

/** Installs (or with undefined removes) the translator every bundle's `msg` uses. */
export function setTranslator(translator: Translator | undefined): void {
  (globalThis as TranslatorHolder)[TRANSLATOR] = translator;
}

/** Puts the values into `{0}`, `{1}`, …; a place without a value stays as written. */
export function formatMessage(template: string, args: readonly MessageArg[]): string {
  return template.replace(/\{(\d+)\}/g, (place, index: string) => {
    const value = args[Number(index)];
    return value === undefined ? place : String(value);
  });
}

/**
 * A message for the user, translated when the editor gave a translator. The template
 * must be a single-quoted literal: the Russian bundle is checked against every one
 * (test/unit/repo/l10n-bundle.test.ts).
 */
export function msg(template: string, ...args: MessageArg[]): string {
  const translator = (globalThis as TranslatorHolder)[TRANSLATOR];
  if (translator !== undefined) {
    try {
      return translator(template, args);
    } catch {
      // A failing translation must not hide the message itself: English it is.
      return formatMessage(template, args);
    }
  }
  return formatMessage(template, args);
}

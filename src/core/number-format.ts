// Numbers in messages, grouped the way the editor's language writes them. The extension
// host runs with the system's locale, which can differ from the display language: a
// Russian VS Code on an English system would otherwise show "1,000,000" (V9.2).

/** A count written for the given language (`vscode.env.language`), e.g. `1 000 000` for `ru`. */
export function formatCount(value: number, language?: string): string {
  try {
    return value.toLocaleString(language);
  } catch (error) {
    // An unknown language tag is a RangeError; the system's own way is still readable.
    if (error instanceof RangeError) {
      return value.toLocaleString();
    }
    throw error;
  }
}

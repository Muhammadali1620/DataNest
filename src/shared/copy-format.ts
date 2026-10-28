// The formats of "Copy as" and the reasons one can be refused, shared by the host that
// renders them and the page that offers them.

export const COPY_FORMATS = ['tsv', 'csv', 'json', 'markdown', 'insert', 'update', 'in'] as const;
export type CopyFormat = (typeof COPY_FORMATS)[number];

/** Why a format cannot be produced; the page turns each into a sentence. */
export const COPY_ERRORS = [
  'no-key',
  'nothing-to-write',
  'no-values',
  'no-rows',
  'too-many-rows',
] as const;
export type CopyError = (typeof COPY_ERRORS)[number];

/** Most rows one "Copy as" handles; a clipboard is not a place for a million rows. */
export const MAX_COPY_ROWS = 100_000;

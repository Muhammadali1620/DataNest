// What the export dialog offers; the page sends the choice to the host as it is.

export type ExportScope = 'result' | 'table' | 'database';
export type ExportFormatId = 'csv' | 'json' | 'sql' | 'markdown' | 'xlsx';

/** How often a result may refresh itself, in seconds; 0 is off. */
export const REFRESH_CHOICES = [0, 1, 3, 5, 30, 60, 300] as const;
export type RefreshSeconds = (typeof REFRESH_CHOICES)[number];

export function isRefreshSeconds(value: number): value is RefreshSeconds {
  return (REFRESH_CHOICES as readonly number[]).includes(value);
}

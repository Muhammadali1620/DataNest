// What the bar of a table page offers: the pages of one table and its history. The page
// names an action, the host maps it to a command, so a page never holds a command id.
// Every page of a table (data, properties, ER diagram, test data, compare, manager)
// shows the same bar with its own button lit, so the user moves between them in place.

import { boolean, literal, object } from './schema';

/** The pages of a table, in the order of the bar. */
export const TABLE_PAGES = ['properties', 'data', 'er', 'generate', 'compare', 'manager'] as const;

export type TablePage = (typeof TABLE_PAGES)[number];

export const TABLE_ACTIONS = [...TABLE_PAGES, 'history'] as const;

export type TableAction = (typeof TABLE_ACTIONS)[number];

export function isTableAction(value: unknown): value is TableAction {
  return TABLE_ACTIONS.includes(value as TableAction);
}

/** Page → host: a bar button was pressed; `dirty` is true while the page holds unsaved work. */
export const tableNavSchema = object({ action: literal(...TABLE_ACTIONS), dirty: boolean() });

/** Host → page: show the bar (a page of a table; absent for a page without a table). */
export const tableBarSchema = object({ isView: boolean() });

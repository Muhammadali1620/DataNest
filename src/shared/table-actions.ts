// What the bar of a table view offers beside "Data": the tools that used to hide in
// the tree's context menu. The page names an action, the host maps it to a command, so
// the page never holds a command id.

export const TABLE_ACTIONS = [
  'properties',
  'ddl',
  'er',
  'generate',
  'compare',
  'history',
  'dump',
  'transfer',
] as const;

export type TableAction = (typeof TABLE_ACTIONS)[number];

export function isTableAction(value: unknown): value is TableAction {
  return TABLE_ACTIONS.includes(value as TableAction);
}

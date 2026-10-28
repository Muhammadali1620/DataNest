/**
 * What the user can do to whole rows of an editable result. `revert` withdraws every
 * pending change of the rows: edits go, a deletion mark is lifted, a new row is dropped.
 */
export type RowAction = 'add' | 'duplicate' | 'delete' | 'restore' | 'revert';

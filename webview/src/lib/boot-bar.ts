// The page that took over the tab of another page of a table (D117) is told by the host,
// in its HTML, which page of the table it is: so its bar can stand in the very place of
// the bar of the page before while the new page is still loading, and the user sees the
// content change under a bar that does not move.

import { TABLE_PAGES, type TablePage } from '../../../src/shared/table-actions';

export interface BootBar {
  readonly page: TablePage;
  readonly isView: boolean;
}

/** What the host wrote on the body, if the page was opened from the bar of a table page. */
export function readBootBar(doc: Document = document): BootBar | undefined {
  const { tablePage, tableView } = doc.body.dataset;
  const page = TABLE_PAGES.find((candidate) => candidate === tablePage);
  return page === undefined ? undefined : { page, isView: tableView === 'view' };
}

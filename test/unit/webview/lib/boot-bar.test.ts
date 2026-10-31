import { afterEach, describe, expect, it } from 'vitest';
import { readBootBar } from '../../../../webview/src/lib/boot-bar';
import { TABLE_PAGES } from '../../../../src/shared/table-actions';

afterEach(() => {
  delete document.body.dataset.tablePage;
  delete document.body.dataset.tableView;
});

describe('readBootBar', () => {
  it('is absent on a page that was not opened from a bar', () => {
    expect(readBootBar()).toBeUndefined();
  });

  it('reads the page and whether it is a view', () => {
    document.body.dataset.tablePage = 'er';
    document.body.dataset.tableView = 'view';
    expect(readBootBar()).toEqual({ page: 'er', isView: true });
    document.body.dataset.tableView = 'table';
    expect(readBootBar()).toEqual({ page: 'er', isView: false });
  });

  it('knows every page of the bar', () => {
    for (const page of TABLE_PAGES) {
      document.body.dataset.tablePage = page;
      expect(readBootBar()?.page).toBe(page);
    }
  });

  it('ignores a name that is not a page of the bar', () => {
    for (const page of ['', 'history', '__proto__', 'ER']) {
      document.body.dataset.tablePage = page;
      expect(readBootBar(), page).toBeUndefined();
    }
  });
});

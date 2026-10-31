import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import BootBar from '../../../../webview/src/components/BootBar.svelte';
import { createTranslator } from '../../../../webview/src/lib/i18n';

const t = createTranslator('en');

afterEach(() => {
  cleanup();
  delete document.body.dataset.tablePage;
  delete document.body.dataset.tableView;
});

describe('BootBar', () => {
  it('shows nothing on a page that was not opened from a bar', () => {
    render(BootBar, { props: { t } });
    expect(screen.queryByTestId('table-bar')).toBeNull();
  });

  it('stands where the loaded bar will, with the page the host named lit', () => {
    document.body.dataset.tablePage = 'generate';
    document.body.dataset.tableView = 'table';
    render(BootBar, { props: { t } });
    expect(screen.getByTestId('table-bar')).toBeTruthy();
    expect(screen.getByTestId('table-tab-generate').getAttribute('aria-current')).toBe('page');
    expect(screen.getByTestId('table-tab-data').getAttribute('aria-current')).toBeNull();
  });

  it('leaves out the table-only tools of a view and does nothing when pressed', () => {
    document.body.dataset.tablePage = 'manager';
    document.body.dataset.tableView = 'view';
    render(BootBar, { props: { t } });
    expect(screen.queryByTestId('table-tab-er')).toBeNull();
    expect(screen.queryByTestId('table-tab-compare')).toBeNull();
    expect(() => {
      screen.getByTestId('table-tab-data').click();
    }).not.toThrow();
  });
});

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import {
  resultGridProtocol,
  type ResultGridProtocol,
  type ResultTab,
} from '../../../../../src/shared/protocols/result-grid';
import { RpcPeer } from '../../../../../src/shared/rpc';
import App from '../../../../../webview/src/apps/result-grid/App.svelte';
import { VIEW_STORAGE_KEY } from '../../../../../webview/src/apps/result-grid/grid-view';
import { createTranslator } from '../../../../../webview/src/lib/i18n';
import { chooseFromMenu, menuLabels } from '../../../../helpers/webview/menu';
import { createLinkedTransports, flush } from '../../../../helpers/rpc';

type HostPeer = RpcPeer<ResultGridProtocol['host'], ResultGridProtocol['webview']>;

const TAB: ResultTab = {
  id: 'result-1',
  title: 'SELECT * FROM t',
  statement: 'SELECT * FROM t',
  columns: [{ name: 'id' }, { name: 'note' }],
  rowCount: 2,
  truncated: false,
  durationMs: 1,
  changedCells: 0,
  insertedRows: 0,
  deletedRows: 0,
  revision: 0,
};

// The second column is far wider than any limit the tests use.
const ROWS = [
  [1, 'n'.repeat(190)],
  [2, 'short'],
];

async function open(look?: { rowHeight: number; maxColumnWidth: number }) {
  const transports = createLinkedTransports();
  const host: HostPeer = new RpcPeer({
    local: resultGridProtocol.host,
    remote: resultGridProtocol.webview,
    transport: transports.host,
  });
  const rpc = new RpcPeer({
    local: resultGridProtocol.webview,
    remote: resultGridProtocol.host,
    transport: transports.webview,
  });
  host.handle('rows', ({ resultId, offset, limit }) => ({
    resultId,
    offset,
    rows: ROWS.slice(offset, offset + limit),
    rowCount: ROWS.length,
    changes: [],
    states: [],
  }));
  render(App, { props: { rpc, t: createTranslator('en') } });
  await flush();
  host.emit('state', {
    tabs: [TAB],
    activeId: TAB.id,
    running: false,
    ...(look === undefined ? {} : { look }),
  });
  await waitFor(() => {
    expect(
      screen.queryAllByRole('gridcell').filter((item) => item.getAttribute('data-column') !== null)
        .length,
    ).toBeGreaterThan(0);
  });
  return { host };
}

const widthOf = (index: number): number =>
  Number.parseInt(
    screen
      .getAllByRole('columnheader')
      .find((item) => item.getAttribute('data-column') === String(index))?.style.width ?? '0',
    10,
  );

const rowHeight = (): string =>
  screen.getByTestId('grid').style.getPropertyValue('--dn-row-height');

function stored(): Record<string, unknown> {
  return JSON.parse(window.localStorage.getItem(VIEW_STORAGE_KEY) ?? '{}') as Record<
    string,
    unknown
  >;
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('the density button', () => {
  it('offers three row heights, four widths and a way back', async () => {
    await open();
    expect(await menuLabels('density')).toEqual([
      'Compact rows',
      'Normal rows',
      'Comfortable rows',
      'Columns up to 240 px',
      'Columns up to 420 px',
      'Columns up to 640 px',
      'Columns up to 900 px',
      'Back to the settings',
    ]);
  });

  it("starts from the grid's usual height when the settings say nothing", async () => {
    await open();
    expect(rowHeight()).toBe('32px');
    expect(widthOf(1)).toBe(420);
  });

  it('makes the rows compact and comfortable at once, and remembers the choice', async () => {
    await open();
    await chooseFromMenu('density', 'Compact rows');
    expect(rowHeight()).toBe('24px');
    expect(stored()).toMatchObject({ rowHeight: 24 });
    await chooseFromMenu('density', 'Comfortable rows');
    expect(rowHeight()).toBe('40px');
    expect(stored()).toMatchObject({ rowHeight: 40 });
  });

  it('narrows the widest column, then lets it grow again', async () => {
    await open();
    await chooseFromMenu('density', 'Columns up to 240 px');
    await waitFor(() => {
      expect(widthOf(1)).toBe(240);
    });
    expect(stored()).toMatchObject({ maxColumnWidth: 240 });
    await chooseFromMenu('density', 'Columns up to 900 px');
    await waitFor(() => {
      expect(widthOf(1)).toBe(900);
    });
  });

  it('leaves a short column alone', async () => {
    await open();
    const before = widthOf(0);
    await chooseFromMenu('density', 'Columns up to 240 px');
    await waitFor(() => {
      expect(widthOf(1)).toBe(240);
    });
    expect(widthOf(0)).toBe(before);
  });

  it('cuts down a width the user fitted, but does not stretch it back', async () => {
    await open();
    await fireEvent.click(screen.getByTestId('columns-toggle'));
    await fireEvent.click(screen.getByTestId('columns-fit-all'));
    await waitFor(() => {
      expect(widthOf(1)).toBeGreaterThan(420);
    });
    await chooseFromMenu('density', 'Columns up to 240 px');
    await waitFor(() => {
      expect(widthOf(1)).toBe(240);
    });
    await chooseFromMenu('density', 'Columns up to 900 px');
    await flush();
    expect(widthOf(1)).toBe(240);
  });

  it('goes back to what the settings ask for', async () => {
    await open({ rowHeight: 24, maxColumnWidth: 640 });
    await chooseFromMenu('density', 'Comfortable rows');
    await chooseFromMenu('density', 'Columns up to 240 px');
    await chooseFromMenu('density', 'Back to the settings');
    expect(rowHeight()).toBe('24px');
    await waitFor(() => {
      expect(widthOf(1)).toBe(640);
    });
    expect(stored()).not.toHaveProperty('rowHeight');
    expect(stored()).not.toHaveProperty('maxColumnWidth');
  });
});

describe('the look the settings ask for', () => {
  it('sets the first height and widths of the grid', async () => {
    await open({ rowHeight: 40, maxColumnWidth: 640 });
    expect(rowHeight()).toBe('40px');
    expect(widthOf(1)).toBe(640);
  });

  it('is beaten by what the user chose before', async () => {
    window.localStorage.setItem(
      VIEW_STORAGE_KEY,
      JSON.stringify({ rowHeight: 26, maxColumnWidth: 300 }),
    );
    await open({ rowHeight: 40, maxColumnWidth: 640 });
    expect(rowHeight()).toBe('26px');
    expect(widthOf(1)).toBe(300);
  });

  it('fills in only the half the user never chose', async () => {
    window.localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify({ rowHeight: 26 }));
    await open({ rowHeight: 40, maxColumnWidth: 640 });
    expect(rowHeight()).toBe('26px');
    expect(widthOf(1)).toBe(640);
  });

  it('follows a change of the settings while the grid is open', async () => {
    const { host } = await open({ rowHeight: 24, maxColumnWidth: 240 });
    expect(rowHeight()).toBe('24px');
    host.emit('state', {
      tabs: [TAB],
      activeId: TAB.id,
      running: false,
      look: { rowHeight: 40, maxColumnWidth: 900 },
    });
    await waitFor(() => {
      expect(rowHeight()).toBe('40px');
    });
    await waitFor(() => {
      expect(widthOf(1)).toBe(900);
    });
  });

  it('does not override a choice of the user when the settings change', async () => {
    const { host } = await open({ rowHeight: 24, maxColumnWidth: 240 });
    await chooseFromMenu('density', 'Comfortable rows');
    host.emit('state', {
      tabs: [TAB],
      activeId: TAB.id,
      running: false,
      look: { rowHeight: 32, maxColumnWidth: 240 },
    });
    await flush();
    expect(rowHeight()).toBe('40px');
  });

  it('keeps everything when the same look arrives again', async () => {
    const look = { rowHeight: 24, maxColumnWidth: 240 };
    const { host } = await open(look);
    await fireEvent.click(screen.getByTestId('columns-toggle'));
    await fireEvent.click(screen.getByTestId('columns-fit-all'));
    await waitFor(() => {
      expect(widthOf(1)).toBeGreaterThan(240);
    });
    const fitted = widthOf(1);
    host.emit('state', { tabs: [TAB], activeId: TAB.id, running: false, look });
    await flush();
    expect(widthOf(1)).toBe(fitted);
  });
});

describe('the widest column in the view settings', () => {
  it('steps the limit up and down within its range and remembers it', async () => {
    await open();
    await fireEvent.click(screen.getByTestId('view-toggle'));
    expect(screen.getByTestId('max-column-width').textContent).toBe('420');
    await fireEvent.click(screen.getByRole('button', { name: 'Narrower columns' }));
    expect(screen.getByTestId('max-column-width').textContent).toBe('360');
    await fireEvent.click(screen.getByRole('button', { name: 'Wider columns' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Wider columns' }));
    expect(screen.getByTestId('max-column-width').textContent).toBe('480');
    expect(stored()).toMatchObject({ maxColumnWidth: 480 });
    await waitFor(() => {
      expect(widthOf(1)).toBe(480);
    });
  });

  it('stops at the narrowest and the widest limit', async () => {
    window.localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify({ maxColumnWidth: 120 }));
    await open();
    await fireEvent.click(screen.getByTestId('view-toggle'));
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Narrower columns' }).disabled,
    ).toBe(true);
  });

  it('resets to the look of the settings, not to the built-in one', async () => {
    await open({ rowHeight: 24, maxColumnWidth: 640 });
    await fireEvent.click(screen.getByTestId('view-toggle'));
    await fireEvent.click(screen.getByRole('button', { name: 'Narrower columns' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));
    expect(screen.getByTestId('max-column-width').textContent).toBe('640');
    expect(screen.getByTestId('row-height').textContent).toBe('24');
  });
});

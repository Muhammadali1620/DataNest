import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import {
  type ChartConfigData,
  resultChartProtocol,
  type ResultChartProtocol,
  type ResultChartState,
} from '../../../../../src/shared/protocols/result-chart';
import { RpcPeer } from '../../../../../src/shared/rpc';
import App from '../../../../../webview/src/apps/result-chart/App.svelte';
import type { ChartColors } from '../../../../../webview/src/apps/result-chart/chart-svg';
import { createTranslator } from '../../../../../webview/src/lib/i18n';
import { createLinkedTransports, flush } from '../../../../helpers/rpc';
import { chooseFromMenu, menuLabels } from '../../../../helpers/webview/menu';

type HostPeer = RpcPeer<ResultChartProtocol['host'], ResultChartProtocol['webview']>;

const STATE: ResultChartState = {
  title: 'SELECT region, orders, total FROM sales',
  columns: [
    { name: 'region', kind: 'text' },
    { name: 'orders', kind: 'number' },
    { name: 'total', kind: 'number' },
    { name: 'note', kind: 'text' },
  ],
  rows: 3,
  truncated: false,
  config: { type: 'bar', x: 0, ys: [1, 2], aggregate: 'none' },
  data: {
    labels: ['north', 'south', 'east'],
    series: [
      { name: 'orders', values: [10, 5, 7] },
      { name: 'total', values: [100, 40, null] },
    ],
    labelKind: 'text',
    points: 3,
    skipped: 1,
  },
};

const COLORS: ChartColors = {
  ink: { axis: '#111', grid: '#222', text: '#333', muted: '#444', background: '#fff' },
  series: ['#a00'],
  font: 'sans-serif',
};

async function setup(state: ResultChartState = STATE, options: { failConfigure?: string } = {}) {
  const transports = createLinkedTransports();
  const host: HostPeer = new RpcPeer({
    local: resultChartProtocol.host,
    remote: resultChartProtocol.webview,
    transport: transports.host,
  });
  const rpc = new RpcPeer({
    local: resultChartProtocol.webview,
    remote: resultChartProtocol.host,
    transport: transports.webview,
  });
  const configs: ChartConfigData[] = [];
  const saves: { format: string; data: string }[] = [];
  host.handle('configure', ({ config }) => {
    configs.push(config);
    if (options.failConfigure !== undefined) {
      throw new Error(options.failConfigure);
    }
    return {
      data:
        config.type === 'pie'
          ? {
              ...state.data,
              series: state.data.series.slice(0, 1),
              labels: ['north', 'east', ''],
              folded: 2,
            }
          : state.data,
    };
  });
  host.handle('save', (params) => {
    saves.push(params);
    return { saved: true };
  });
  host.on('ready', () => {
    host.emit('state', state);
  });
  const toPng = vi.fn(() => Promise.resolve('iVBORw0KGgo='));
  render(App, { props: { rpc, t: createTranslator('en'), toPng, colors: () => COLORS } });
  await flush();
  await screen.findByRole('heading', { level: 1 });
  return { host, configs, saves, toPng };
}

describe('result chart page', () => {
  it('draws the chart the host chose, with what it leaves out said', async () => {
    await setup();
    const chart = screen.getByTestId('chart');
    expect(chart.querySelectorAll('rect').length).toBeGreaterThanOrEqual(5);
    expect(chart.textContent).toContain('north');
    expect(screen.getByRole('radio', { name: 'Bars' }).getAttribute('aria-checked')).toBe('true');
    const notes = screen.getByTestId('notes').textContent;
    expect(notes).toContain('Rows: 3.');
    expect(notes).toContain('1 values are not numbers');
    expect(screen.getByLabelText<HTMLInputElement>('orders').checked).toBe(true);
    // Text columns are no values to draw.
    expect(screen.queryByLabelText('note')).toBeNull();
  });

  it('changes the type, labels, values and grouping through the host', async () => {
    const { configs } = await setup();
    await fireEvent.click(screen.getByRole('radio', { name: 'Line' }));
    await waitFor(() => {
      expect(configs.at(-1)).toEqual({ type: 'line', x: 0, ys: [1, 2], aggregate: 'none' });
    });
    await fireEvent.click(screen.getByLabelText('total'));
    await waitFor(() => {
      expect(configs.at(-1)?.ys).toEqual([1]);
    });
    await fireEvent.change(screen.getByLabelText('Same labels'), { target: { value: 'sum' } });
    await waitFor(() => {
      expect(configs.at(-1)?.aggregate).toBe('sum');
    });
    await fireEvent.change(screen.getByLabelText('Labels (X)'), { target: { value: '3' } });
    await waitFor(() => {
      expect(configs.at(-1)?.x).toBe(3);
    });
    expect(screen.getByTestId('chart').querySelector('polyline')).not.toBeNull();
  });

  it('draws a pie of one value, the folded slices named', async () => {
    const { configs } = await setup();
    await fireEvent.click(screen.getByRole('radio', { name: 'Pie' }));
    await waitFor(() => {
      expect(configs.at(-1)).toEqual({ type: 'pie', x: 0, ys: [1], aggregate: 'none' });
    });
    await waitFor(() => {
      expect(screen.getByTestId('chart').querySelectorAll('path').length).toBe(3);
    });
    expect(screen.getByTestId('notes').textContent).toContain('2 small slices are in “Other”');
    expect(screen.getByTestId('chart').textContent).toContain('Other');
    await fireEvent.change(screen.getByLabelText('Value'), { target: { value: '2' } });
    await waitFor(() => {
      expect(configs.at(-1)?.ys).toEqual([2]);
    });
  });

  it('turns the values off while it counts rows', async () => {
    await setup({ ...STATE, config: { type: 'bar', x: 0, ys: [], aggregate: 'count' } });
    expect(screen.getByLabelText<HTMLInputElement>('orders').closest('fieldset')?.disabled).toBe(
      true,
    );
  });

  it('saves the chart as SVG and as PNG in the theme colours', async () => {
    const { saves, toPng } = await setup();
    expect(await menuLabels('chart-export')).toEqual(['Save SVG', 'Save PNG']);
    await chooseFromMenu('chart-export', 'Save SVG');
    await waitFor(() => {
      expect(saves).toHaveLength(1);
    });
    expect(saves[0]?.format).toBe('svg');
    expect(saves[0]?.data).toContain('<svg');
    expect(saves[0]?.data).toContain('#a00');
    await chooseFromMenu('chart-export', 'Save PNG');
    await waitFor(() => {
      expect(saves[1]).toEqual({ format: 'png', data: 'iVBORw0KGgo=' });
    });
    expect(toPng).toHaveBeenCalledWith(expect.stringContaining('<svg'), 800, 420);
  });

  it('shows the values under the pointer', async () => {
    await setup();
    const chart = screen.getByTestId('chart');
    const bar = [...chart.querySelectorAll('rect')].find(
      (rect) => Number(rect.getAttribute('width')) > 20,
    );
    const x = Number(bar?.getAttribute('x')) + 2;
    const y = Number(bar?.getAttribute('y')) + 2;
    chart.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      right: 800,
      bottom: 420,
      width: 800,
      height: 420,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    await fireEvent.pointerMove(chart, { clientX: x, clientY: y });
    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent).toContain('north');
    expect(tip.textContent).toContain('orders: 10');
    await fireEvent.pointerLeave(chart);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('reads the values with the keyboard, for screen readers too (V9.3)', async () => {
    await setup();
    const values = screen.getByRole('slider', { name: 'Values of the chart' });
    expect(values.tabIndex).toBe(0);
    expect(values.getAttribute('aria-valuemax')).toBe('3');
    expect(values.getAttribute('aria-valuetext')).toBe('Use the arrow keys to read the values');
    expect(screen.queryByRole('tooltip')).toBeNull();
    await fireEvent.keyDown(values, { key: 'ArrowRight' });
    expect(values.getAttribute('aria-valuenow')).toBe('1');
    expect(values.getAttribute('aria-valuetext')).toBe('north: orders 10, total 100');
    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent).toContain('north');
    expect(tip.textContent).toContain('total: 100');
    await fireEvent.keyDown(values, { key: 'End' });
    expect(values.getAttribute('aria-valuetext')).toBe('east: orders 7, total —');
    await fireEvent.keyDown(values, { key: 'ArrowRight' });
    expect(values.getAttribute('aria-valuenow')).toBe('3');
    await fireEvent.keyDown(values, { key: 'ArrowLeft' });
    expect(values.getAttribute('aria-valuenow')).toBe('2');
    await fireEvent.keyDown(values, { key: 'Home' });
    expect(values.getAttribute('aria-valuenow')).toBe('1');
    await fireEvent.keyDown(values, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(values.getAttribute('aria-valuetext')).toBe('Use the arrow keys to read the values');
  });

  it('starts from the last label when stepping back with nothing chosen', async () => {
    await setup();
    const values = screen.getByRole('slider');
    await fireEvent.keyDown(values, { key: 'ArrowLeft' });
    expect(values.getAttribute('aria-valuenow')).toBe('3');
  });

  it('says when there is nothing to draw, and when the result was cut', async () => {
    await setup({
      ...STATE,
      truncated: true,
      data: { ...STATE.data, labels: [], series: [], points: 0, skipped: 0 },
    });
    expect(screen.getByText(/Nothing to draw/u)).toBeTruthy();
    expect(screen.getByTestId('notes').textContent).toContain('cut by the row limit');
  });

  it('shows points left out over the limit', async () => {
    await setup({ ...STATE, data: { ...STATE.data, points: 2500, skipped: 0 } });
    expect(screen.getByTestId('notes').textContent).toContain('Shown 3 points of 2500');
  });

  it('hides and shows the settings beside the chart', async () => {
    await setup();
    const toggle = screen.getByRole('button', { name: 'Chart settings' });
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('complementary', { name: 'Chart settings' })).toBeTruthy();
    await fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(screen.queryByLabelText('Labels (X)')).toBeNull();
    // The chart stays, and its type can still be changed from the toolbar.
    expect(screen.getByTestId('chart')).toBeTruthy();
    await fireEvent.click(toggle);
    expect(screen.getByLabelText('Labels (X)')).toBeTruthy();
  });

  it('marks each chosen value with the colour of its series', async () => {
    await setup();
    const swatch = (name: string): Element | null | undefined =>
      screen.getByLabelText(name).closest('label')?.querySelector('.swatch');
    expect(swatch('orders')?.classList.contains('fill-0')).toBe(true);
    expect(swatch('total')?.classList.contains('fill-1')).toBe(true);
    await fireEvent.click(screen.getByLabelText('orders'));
    await waitFor(() => {
      expect(swatch('orders')).toBeNull();
    });
    expect(swatch('total')?.classList.contains('fill-0')).toBe(true);
  });

  it('cannot save a picture while there is nothing to draw', async () => {
    await setup({
      ...STATE,
      data: { ...STATE.data, labels: [], series: [], points: 0, skipped: 0 },
    });
    expect(screen.getByTestId('chart-export').hasAttribute('disabled')).toBe(true);
  });

  it('shows a refused change', async () => {
    await setup(STATE, { failConfigure: 'Pick a column of values, or count the rows' });
    await fireEvent.click(screen.getByLabelText('orders'));
    expect((await screen.findByRole('alert')).textContent).toContain('Pick a column');
  });
});

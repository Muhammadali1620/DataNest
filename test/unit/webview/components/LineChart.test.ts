import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import LineChart from '../../../../webview/src/components/LineChart.svelte';
import { createTranslator } from '../../../../webview/src/lib/i18n';

const t = createTranslator('en');
const TIMES = [60_000, 63_000, 66_000, 69_000];
const SERIES = [
  { key: 'read', label: 'read', color: 'var(--c1)', values: [1, 4, 2, 0] },
  { key: 'hit', label: 'hit', color: 'var(--c2)', values: [0, 2, 8, 3] },
];

function chart(props: Partial<{ times: number[]; series: typeof SERIES; bytes: boolean }> = {}) {
  return render(LineChart, {
    props: {
      title: 'Traffic',
      icon: 'graph-line',
      times: props.times ?? TIMES,
      series: props.series ?? SERIES,
      format: (value: number) => `${value} KB`,
      t,
      windowMs: 300_000,
      ...(props.bytes === undefined ? {} : { bytes: props.bytes }),
    },
  });
}

const plot = () => screen.getByRole('slider');

describe('LineChart', () => {
  it('draws a line and a soft area per series, in the series colour', () => {
    const { container } = chart();
    const lines = container.querySelectorAll('path.line');
    expect(lines).toHaveLength(2);
    expect((lines[0] as SVGElement).style.stroke).toBe('var(--c1)');
    expect(container.querySelectorAll('path.area')).toHaveLength(2);
    expect(screen.getByTestId('chart').textContent).toContain('Traffic');
  });

  it('names its series in a legend that the reader skips (the table has them)', () => {
    const { container } = chart();
    const legend = container.querySelector('.legend');
    expect(legend?.getAttribute('aria-hidden')).toBe('true');
    expect(legend?.textContent).toContain('read');
    expect(legend?.textContent).toContain('hit');
  });

  it('puts a tidy axis from zero up to the highest value, labelled with the format', () => {
    const { container } = chart();
    const labels = [...container.querySelectorAll('text.tick')].map((node) => node.textContent);
    expect(labels).toContain('0 KB');
    expect(labels).toContain('8 KB');
  });

  it('labels the time axis with clock times', () => {
    const { container } = chart();
    const times = [...container.querySelectorAll('text.tick')]
      .map((node) => node.textContent)
      .filter((text) => /^\d\d:\d\d:\d\d$/.test(text));
    expect(times.length).toBeGreaterThanOrEqual(2);
  });

  it('says it is waiting before the first reading', () => {
    chart({ times: [], series: SERIES.map((one) => ({ ...one, values: [] })) });
    expect(screen.getByText('Waiting for the first readings…')).toBeTruthy();
    expect(plot().getAttribute('aria-valuetext')).toBe('Waiting for the first readings…');
  });

  it('shows a tooltip with every value of the sample under the keys', async () => {
    chart();
    expect(screen.queryByTestId('tooltip')).toBeNull();
    plot().focus();
    await fireEvent.keyDown(plot(), { key: 'ArrowLeft' });
    const tip = screen.getByTestId('tooltip');
    expect(tip.textContent).toContain('read');
    expect(tip.textContent).toContain('8 KB');
    expect(plot().getAttribute('aria-valuenow')).toBe('2');
    await fireEvent.keyDown(plot(), { key: 'Home' });
    expect(plot().getAttribute('aria-valuenow')).toBe('0');
    await fireEvent.keyDown(plot(), { key: 'End' });
    expect(plot().getAttribute('aria-valuenow')).toBe('3');
    await fireEvent.keyDown(plot(), { key: 'ArrowRight' });
    expect(plot().getAttribute('aria-valuenow')).toBe('3');
    await fireEvent.keyDown(plot(), { key: 'Escape' });
    expect(screen.queryByTestId('tooltip')).toBeNull();
  });

  it('follows the pointer to the nearest sample and lets go when it leaves', async () => {
    chart();
    await fireEvent.pointerMove(plot(), { clientX: 0 });
    expect(screen.getByTestId('tooltip').textContent).toContain('1 KB');
    await fireEvent.pointerLeave(plot());
    expect(screen.queryByTestId('tooltip')).toBeNull();
  });

  it('reads out the latest sample for a screen reader, and keeps the last ten in a table', () => {
    const { container } = chart();
    expect(plot().getAttribute('aria-valuetext')).toContain('read 0 KB, hit 3 KB');
    expect(plot().getAttribute('aria-roledescription')).toBe('line chart');
    const rows = container.querySelectorAll('table.sr-only tbody tr');
    expect(rows).toHaveLength(4);
    const many = Array.from({ length: 14 }, (_, index) => 60_000 + index * 3000);
    const { container: other } = chart({
      times: many,
      series: SERIES.map((one) => ({ ...one, values: many.map(() => 1) })),
    });
    expect(other.querySelectorAll('table.sr-only tbody tr')).toHaveLength(10);
  });

  it('is one stop for the keyboard', () => {
    const { container } = chart();
    expect(container.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
  });

  it('draws a flat zero without breaking', () => {
    const { container } = chart({
      series: SERIES.map((one) => ({ ...one, values: [0, 0, 0, 0] })),
    });
    expect(container.querySelectorAll('path.line')).toHaveLength(2);
    expect(container.textContent).not.toContain('NaN');
  });

  it('counts a byte axis in one unit with tidy steps, and the tooltip keeps the exact format', async () => {
    const MB = 1024 * 1024;
    const { container } = chart({
      bytes: true,
      series: SERIES.map((one) => ({ ...one, values: one.values.map((value) => value * MB) })),
    });
    const labels = [...container.querySelectorAll('text.tick')].map((node) => node.textContent);
    expect(labels).toContain('0 MB');
    expect(labels).toContain('2 MB');
    expect(labels).toContain('8 MB');
    plot().focus();
    await fireEvent.keyDown(plot(), { key: 'End' });
    expect(screen.getByTestId('tooltip').textContent).toContain(`${3 * MB} KB`);
  });
});

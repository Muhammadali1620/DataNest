<script lang="ts">
  import {
    areaPath,
    axisTimes,
    byteUnit,
    clockLabel,
    nearestIndex,
    niceScale,
    smoothPath,
    timeX,
    windowFor,
    type Point,
  } from '../lib/chart-geometry';
  import type { CodiconName } from '../lib/codicons';
  import type { Translate } from '../lib/i18n';
  import Icon from './Icon.svelte';

  export interface ChartSeries {
    readonly key: string;
    readonly label: string;
    /** A CSS colour, normally a theme chart colour. */
    readonly color: string;
    readonly values: readonly number[];
  }

  interface Props {
    title: string;
    icon: CodiconName;
    /** Reading times, oldest first; every series has one value per time. */
    times: readonly number[];
    series: readonly ChartSeries[];
    /** A value as the axis and the tooltip write it. */
    format: (value: number) => string;
    t: Translate;
    /** The values are bytes: the axis counts in B, KB, MB… with tidy steps in that unit. */
    bytes?: boolean;
    /** The most time the axis ever spans. */
    windowMs: number;
    /** The least it spans, so a first reading does not fill the width. */
    leastMs?: number;
    height?: number;
  }

  const {
    title,
    icon,
    times,
    series,
    format,
    t,
    windowMs,
    leastMs = 60_000,
    height = 200,
    bytes = false,
  }: Props = $props();

  /** Keeps `measured` at the width of the plot; a page without ResizeObserver reads it once. */
  function track(node: HTMLElement): { destroy(): void } {
    const read = (): void => {
      measured = node.clientWidth;
    };
    read();
    if (typeof ResizeObserver === 'undefined') {
      return { destroy: () => undefined };
    }
    const observer = new ResizeObserver(read);
    observer.observe(node);
    return {
      destroy: () => {
        observer.disconnect();
      },
    };
  }

  const MARGIN = { left: 52, right: 14, top: 10, bottom: 24 };
  // jsdom and a hidden page measure nothing: a sensible width keeps the maths finite.
  let measured = $state(0);
  const width = $derived(measured > 0 ? measured : 640);
  const left = MARGIN.left;
  const right = $derived(width - MARGIN.right);
  const top = MARGIN.top;
  const bottom = $derived(height - MARGIN.bottom);

  const end = $derived(times.at(-1) ?? 0);
  const span = $derived(windowFor(times, leastMs, windowMs));
  const highest = $derived(Math.max(0, ...series.flatMap((one) => one.values)));
  const unit = $derived(bytes ? byteUnit(highest) : { divisor: 1, suffix: '' });
  const scale = $derived.by(() => {
    const tidy = niceScale(highest / unit.divisor);
    return { max: tidy.max * unit.divisor, ticks: tidy.ticks.map((tick) => tick * unit.divisor) };
  });
  /** An axis number: in the unit of the whole axis, so 0, 2.5 MB, 5 MB, … line up. */
  function axis(value: number): string {
    return bytes ? `${Number((value / unit.divisor).toFixed(2))} ${unit.suffix}` : format(value);
  }
  const xs = $derived(times.map((time) => timeX(time, end, span, left, right)));

  function yOf(value: number): number {
    return bottom - (value / scale.max) * (bottom - top);
  }

  const lines = $derived(
    series.map((one) => {
      const points: Point[] = one.values.map((value, index) => ({
        x: xs[index] ?? left,
        y: yOf(value),
      }));
      return { one, line: smoothPath(points), area: areaPath(points, bottom) };
    }),
  );
  const labels = $derived(
    times.length === 0 ? [] : axisTimes(end, span, Math.max(2, Math.min(6, Math.floor((right - left) / 110)))),
  );

  let cursor = $state<number | undefined>(undefined);
  const at = $derived(cursor === undefined || cursor >= times.length ? undefined : cursor);

  function pointer(event: PointerEvent): void {
    const box = (event.currentTarget as Element).getBoundingClientRect();
    cursor = nearestIndex(xs, ((event.clientX - box.left) / (box.width || width)) * width);
  }

  function key(event: KeyboardEvent): void {
    const last = times.length - 1;
    if (last < 0) {
      return;
    }
    const step: Record<string, number | undefined> = {
      ArrowLeft: Math.max(0, (cursor ?? last) - 1),
      ArrowRight: Math.min(last, (cursor ?? last) + 1),
      Home: 0,
      End: last,
    };
    if (event.key === 'Escape') {
      cursor = undefined;
    } else if (step[event.key] !== undefined) {
      cursor = step[event.key];
    } else {
      return;
    }
    event.preventDefault();
  }

  /** What a screen reader says for the sample the cursor is on (the latest without one). */
  const spoken = $derived.by(() => {
    const index = at ?? times.length - 1;
    const values = series.map((one) => `${one.label} ${format(one.values[index] ?? 0)}`);
    return `${clockLabel(times[index] ?? 0)}: ${values.join(', ')}`;
  });
  const tableRows = $derived(times.map((time, index) => ({ time, index })).slice(-10));
</script>

<section class="chart" data-testid="chart" aria-label={title}>
  <header>
    <span class="title"><Icon name={icon} size={14} />{title}</span>
    <ul class="legend" aria-hidden="true">
      {#each series as one (one.key)}
        <li><span class="swatch" style="background: {one.color};"></span>{one.label}</li>
      {/each}
    </ul>
  </header>
  <!-- One stop for the keyboard: ← → Home End read the samples, Esc lets go. -->
  <div
    class="plot"
    role="slider"
    aria-roledescription={t('chart.role')}
    aria-label={title}
    aria-orientation="horizontal"
    aria-valuemin={0}
    aria-valuemax={Math.max(0, times.length - 1)}
    aria-valuenow={at ?? Math.max(0, times.length - 1)}
    aria-valuetext={times.length === 0 ? t('chart.waiting') : spoken}
    tabindex="0"
    use:track
    onpointermove={pointer}
    onpointerleave={() => {
      cursor = undefined;
    }}
    onkeydown={key}
    style="height: {height}px;"
  >
    <svg viewBox="0 0 {width} {height}" {width} {height} aria-hidden="true">
      {#each scale.ticks as tick (tick)}
        <line class="grid" x1={left} x2={right} y1={yOf(tick)} y2={yOf(tick)} />
        <text class="tick" x={left - 8} y={yOf(tick)} text-anchor="end" dominant-baseline="middle">{axis(tick)}</text>
      {/each}
      {#each labels as time, index (time)}
        <text class="tick" x={timeX(time, end, span, left, right)} y={height - 6} text-anchor={index === labels.length - 1 ? 'end' : index === 0 ? 'start' : 'middle'}>{clockLabel(time)}</text>
      {/each}
      {#each lines as { one, line, area } (one.key)}
        <path class="area" d={area} style="fill: {one.color};" />
        <path class="line" d={line} style="stroke: {one.color};" />
      {/each}
      {#if at !== undefined}
        <line class="guide" x1={xs[at]} x2={xs[at]} y1={top} y2={bottom} />
        {#each series as one (one.key)}
          <circle class="dot" cx={xs[at]} cy={yOf(one.values[at] ?? 0)} r="4" style="stroke: {one.color};" />
        {/each}
      {/if}
    </svg>
    {#if at !== undefined}
      {@const place = ((xs[at] ?? 0) / width) * 100}
      <div class="tooltip" class:flip={place > 60} style="left: {place}%;" role="status" data-testid="tooltip">
        <strong>{clockLabel(times[at] ?? 0)}</strong>
        {#each series as one (one.key)}
          <span><span class="swatch" style="background: {one.color};"></span>{one.label}<b>{format(one.values[at] ?? 0)}</b></span>
        {/each}
      </div>
    {/if}
    {#if times.length === 0}
      <p class="waiting"><Icon name="loading" size={14} spin />{t('chart.waiting')}</p>
    {/if}
  </div>
  <table class="sr-only">
    <caption>{title}</caption>
    <thead>
      <tr><th>{t('chart.time')}</th>{#each series as one (one.key)}<th>{one.label}</th>{/each}</tr>
    </thead>
    <tbody>
      {#each tableRows as row (row.time)}
        <tr>
          <td>{clockLabel(row.time)}</td>
          {#each series as one (one.key)}<td>{format(one.values[row.index] ?? 0)}</td>{/each}
        </tr>
      {/each}
    </tbody>
  </table>
</section>

<style>
  .chart {
    display: flex;
    flex-direction: column;
    gap: var(--dn-gap-s);
    padding: var(--dn-gap-m) var(--dn-gap-m) var(--dn-gap);
    border: 1px solid var(--dn-border);
    border-radius: var(--dn-radius-l);
    background: var(--dn-surface);
    min-width: 0;
  }

  header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--dn-gap);
  }

  .title {
    display: inline-flex;
    align-items: center;
    gap: var(--dn-gap);
    font-weight: 600;
  }

  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: var(--dn-gap-s) var(--dn-gap-m);
    margin: 0;
    padding: 0;
    list-style: none;
    font-size: var(--dn-font-small);
    color: var(--dn-muted);
  }

  .legend li {
    display: inline-flex;
    align-items: center;
    gap: var(--dn-gap-s);
  }

  .swatch {
    display: inline-block;
    flex: none;
    width: 10px;
    height: 10px;
    border-radius: 50%;
  }

  .plot {
    position: relative;
    border-radius: var(--dn-radius);
    outline-offset: 2px;
  }

  .plot:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
  }

  svg {
    display: block;
    width: 100%;
    height: 100%;
    overflow: visible;
  }

  .grid {
    stroke: var(--dn-divider);
    stroke-dasharray: 3 4;
  }

  .tick {
    fill: var(--dn-muted);
    font-size: 11px;
  }

  .line {
    fill: none;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .area {
    fill-opacity: 0.1;
    stroke: none;
  }

  .guide {
    stroke: var(--dn-muted);
    stroke-dasharray: 3 3;
  }

  .dot {
    fill: var(--vscode-editor-background);
    stroke-width: 2;
  }

  .tooltip {
    position: absolute;
    top: 8px;
    z-index: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 120px;
    padding: var(--dn-gap);
    border: 1px solid var(--dn-border);
    border-radius: var(--dn-radius-l);
    background: var(--vscode-editorHoverWidget-background, var(--dn-surface));
    color: var(--vscode-editorHoverWidget-foreground, inherit);
    box-shadow: 0 2px 8px var(--vscode-widget-shadow, transparent);
    font-size: var(--dn-font-small);
    pointer-events: none;
    transform: translateX(12px);
  }

  .tooltip.flip {
    transform: translateX(calc(-100% - 12px));
  }

  .tooltip span {
    display: flex;
    align-items: center;
    gap: var(--dn-gap-s);
  }

  .tooltip b {
    margin-left: auto;
    padding-left: var(--dn-gap-m);
    font-variant-numeric: tabular-nums;
  }

  .waiting {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--dn-gap);
    margin: 0;
    color: var(--dn-muted);
  }
</style>

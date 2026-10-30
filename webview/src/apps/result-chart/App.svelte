<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import type {
    ChartConfigData,
    ChartDataView,
    ResultChartProtocol,
    ResultChartState,
  } from '../../../../src/shared/protocols/result-chart';
  import { CHART_AGGREGATES, CHART_TYPES } from '../../../../src/shared/protocols/result-chart';
  import type { RpcPeer } from '../../../../src/shared/rpc';
  import type { MessageKey } from '../../l10n/en';
  import type { Translate } from '../../lib/i18n';
  import { svgToPng } from '../er-diagram/picture';
  import { type ChartColors, sceneToSvg } from './chart-svg';
  import {
    chartScene,
    formatNumber,
    hitAt,
    hitForIndex,
    pointText,
    SERIES_COLORS,
  } from './chart-view';

  interface Props {
    rpc: RpcPeer<ResultChartProtocol['webview'], ResultChartProtocol['host']>;
    t: Translate;
    /** Replaced in tests, which have no canvas. */
    toPng?: (svg: string, width: number, height: number) => Promise<string>;
    colors?: () => ChartColors;
  }

  const { rpc, t, toPng = svgToPng, colors = themeColors }: Props = $props();

  /** The size a chart gets where the page cannot measure itself (tests). */
  const FALLBACK = { width: 800, height: 420 };

  let page = $state<ResultChartState | undefined>(undefined);
  let config = $state<ChartConfigData | undefined>(undefined);
  let data = $state<ChartDataView | undefined>(undefined);
  let error = $state<string | undefined>(undefined);
  let busy = $state(false);
  let area = $state<HTMLDivElement | undefined>(undefined);
  let width = $state(0);
  let height = $state(0);
  let pointer = $state<{ x: number; y: number } | undefined>(undefined);
  /** The label the keyboard points at (V9.3); the mouse, when over the chart, wins. */
  let cursor = $state<number | undefined>(undefined);

  const locale = document.documentElement.lang || 'en';

  const scene = $derived(
    data === undefined || config === undefined
      ? undefined
      : chartScene({
          data,
          kind: config.type,
          width: width > 0 ? width : FALLBACK.width,
          height: height > 0 ? height : FALLBACK.height,
          otherLabel: t('chart.other'),
          locale,
        }),
  );
  const hit = $derived(
    scene === undefined
      ? undefined
      : pointer !== undefined
        ? hitAt(scene, pointer.x, pointer.y)
        : cursor !== undefined
          ? hitForIndex(scene, cursor)
          : undefined,
  );
  /** Where the tooltip goes: by the pointer, or above the point the keyboard chose. */
  const tipAt = $derived(
    pointer ?? (hit === undefined ? undefined : { x: hit.x + hit.width / 2, y: hit.y }),
  );

  /** Arrows step through the labels, Home and End jump, Escape lets go. */
  function onChartKey(event: KeyboardEvent): void {
    const count = data?.labels.length ?? 0;
    if (count === 0) {
      return;
    }
    const last = count - 1;
    const at = cursor === undefined ? undefined : Math.min(cursor, last);
    let next: number | undefined;
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
      next = at === undefined ? 0 : Math.min(last, at + 1);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
      next = at === undefined ? last : Math.max(0, at - 1);
    } else if (event.key === 'Home') {
      next = 0;
    } else if (event.key === 'End') {
      next = last;
    } else if (event.key === 'Escape') {
      next = undefined;
    } else {
      return;
    }
    event.preventDefault();
    cursor = next;
  }
  const counting = $derived(config?.aggregate === 'count');

  const TYPE_KEYS: Record<ChartConfigData['type'], MessageKey> = {
    line: 'chart.type.line',
    bar: 'chart.type.bar',
    pie: 'chart.type.pie',
  };
  const AGGREGATE_KEYS: Record<ChartConfigData['aggregate'], MessageKey> = {
    none: 'chart.aggregate.none',
    sum: 'chart.aggregate.sum',
    avg: 'chart.aggregate.avg',
    count: 'chart.aggregate.count',
    min: 'chart.aggregate.min',
    max: 'chart.aggregate.max',
  };

  async function apply(next: ChartConfigData): Promise<void> {
    config = next;
    try {
      data = (await rpc.request('configure', { config: next })).data;
      error = undefined;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
  }

  function change(patch: Partial<ChartConfigData>): void {
    if (config === undefined) {
      return;
    }
    const next = { ...config, ...patch };
    // A pie shows one value; the other charts keep the values the pie set aside.
    void apply(next.type === 'pie' ? { ...next, ys: next.ys.slice(0, 1) } : next);
  }

  function toggleY(index: number, on: boolean): void {
    if (config === undefined) {
      return;
    }
    const ys = on ? [...config.ys, index] : config.ys.filter((one) => one !== index);
    change({ ys });
  }

  async function save(format: 'svg' | 'png'): Promise<void> {
    if (scene === undefined) {
      return;
    }
    busy = true;
    try {
      const svg = sceneToSvg(scene, colors());
      const picture = format === 'svg' ? svg : await toPng(svg, scene.width, scene.height);
      await rpc.request('save', { format, data: picture });
      error = undefined;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      busy = false;
    }
  }

  /** The theme's colours, so the saved picture looks like the page. */
  function themeColors(): ChartColors {
    const style = getComputedStyle(document.body);
    const pick = (name: string, fallback: string): string =>
      style.getPropertyValue(name).trim() || fallback;
    return {
      ink: {
        axis: pick('--vscode-descriptionForeground', '#717171'),
        grid: pick('--vscode-editorWidget-border', '#d4d4d4'),
        text: pick('--vscode-foreground', '#333333'),
        muted: pick('--vscode-descriptionForeground', '#717171'),
        background: pick('--vscode-editor-background', '#ffffff'),
      },
      series: SERIES.map(([name, fallback]) => pick(name, fallback)),
      font: pick('--vscode-font-family', 'sans-serif'),
    };
  }

  const SERIES: readonly (readonly [string, string])[] = [
    ['--vscode-charts-blue', '#3794ff'],
    ['--vscode-charts-orange', '#d18616'],
    ['--vscode-charts-green', '#388a34'],
    ['--vscode-charts-red', '#e51400'],
    ['--vscode-charts-purple', '#652d90'],
    ['--vscode-charts-yellow', '#bf8803'],
    ['--dn-chart-teal', '#1a9e9e'],
    ['--dn-chart-pink', '#c2185b'],
  ];

  function onMove(event: PointerEvent): void {
    const box = (event.currentTarget as SVGSVGElement).getBoundingClientRect();
    pointer = { x: event.clientX - box.left, y: event.clientY - box.top };
  }

  $effect(() => {
    const element = area;
    if (element === undefined) {
      return undefined;
    }
    const measure = (): void => {
      width = element.clientWidth;
      height = element.clientHeight;
    };
    // Untracked: the effect depends on the element only, never on what it measures.
    untrack(measure);
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => {
        window.removeEventListener('resize', measure);
      };
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  });

  onMount(() => {
    const subscription = rpc.on('state', (next) => {
      page = next;
      config = { ...next.config, ys: [...next.config.ys] };
      data = next.data;
    });
    rpc.emit('ready', {});
    return () => {
      subscription.dispose();
    };
  });
</script>

<main>
  {#if page === undefined || config === undefined || data === undefined}
    <p class="hint">{t('chart.loading')}</p>
  {:else}
    <header class="bar">
      <h1 title={page.title}>{page.title}</h1>
      <span class="grow"></span>
      <button type="button" class="button secondary" disabled={busy} onclick={() => void save('svg')}>{t('chart.saveSvg')}</button>
      <button type="button" class="button secondary" disabled={busy} onclick={() => void save('png')}>{t('chart.savePng')}</button>
    </header>

    <div class="controls">
      <div class="types" role="radiogroup" aria-label={t('chart.type')}>
        {#each CHART_TYPES as type (type)}
          <button
            type="button"
            role="radio"
            class="tab"
            aria-checked={config.type === type}
            onclick={() => {
              change({ type });
            }}>{t(TYPE_KEYS[type])}</button
          >
        {/each}
      </div>
      <label>
        {config.type === 'pie' ? t('chart.slices') : t('chart.x')}
        <select class="control" value={config.x} onchange={(event) => {
            change({ x: Number(event.currentTarget.value) });
          }}>
          {#each page.columns as column, index (index)}
            <option value={index}>{column.name}</option>
          {/each}
        </select>
      </label>
      <label>
        {t('chart.aggregate')}
        <select
          class="control"
          value={config.aggregate}
          onchange={(event) => {
            const aggregate = CHART_AGGREGATES.find((one) => one === event.currentTarget.value);
            if (aggregate !== undefined) {
              change({ aggregate });
            }
          }}
        >
          {#each CHART_AGGREGATES as aggregate (aggregate)}
            <option value={aggregate}>{t(AGGREGATE_KEYS[aggregate])}</option>
          {/each}
        </select>
      </label>
      {#if config.type === 'pie'}
        <label>
          {t('chart.value')}
          <select
            class="control"
            value={config.ys[0] ?? ''}
            disabled={counting}
            onchange={(event) => {
              change({ ys: [Number(event.currentTarget.value)] });
            }}
          >
            {#each page.columns as column, index (index)}
              {#if index !== config.x}<option value={index}>{column.name}</option>{/if}
            {/each}
          </select>
        </label>
      {:else}
        <fieldset class="ys" disabled={counting}>
          <legend>{t('chart.y')}</legend>
          {#each page.columns as column, index (index)}
            {#if index !== config.x && column.kind === 'number'}
              <label class="inline">
                <input
                  type="checkbox"
                  checked={config.ys.includes(index)}
                  disabled={!config.ys.includes(index) && config.ys.length >= SERIES_COLORS}
                  onchange={(event) => {
                    toggleY(index, event.currentTarget.checked);
                  }}
                />
                {column.name}
              </label>
            {/if}
          {/each}
        </fieldset>
      {/if}
    </div>

    {#if error !== undefined}
      <p class="error" role="alert">{error}</p>
    {/if}
    <p class="hint" data-testid="notes">
      {t('chart.rows', page.rows)}
      {#if page.truncated}{t('chart.truncated')}{/if}
      {#if data.points > data.labels.length && data.folded === undefined}{t('chart.points', data.labels.length, data.points)}{/if}
      {#if data.skipped > 0}{t('chart.skipped', data.skipped)}{/if}
      {#if data.folded !== undefined}{t('chart.folded', data.folded)}{/if}
    </p>

    <div class="area" bind:this={area}>
      {#if data.labels.length === 0 || data.series.length === 0}
        <p class="hint">{t('chart.empty')}</p>
      {:else if scene !== undefined}
        <div
          class="values"
          role="slider"
          tabindex="0"
          aria-label={t('chart.cursor')}
          aria-valuemin={1}
          aria-valuemax={data.labels.length}
          aria-valuenow={cursor === undefined ? 1 : Math.min(cursor, data.labels.length - 1) + 1}
          aria-valuetext={cursor === undefined
            ? t('chart.cursorHint')
            : pointText(data, Math.min(cursor, data.labels.length - 1), {
                locale,
                otherLabel: t('chart.other'),
              })}
          data-testid="chart-values"
          onkeydown={onChartKey}
        >
        <svg
          width={scene.width}
          height={scene.height}
          viewBox={`0 0 ${scene.width} ${scene.height}`}
          role="img"
          aria-label={page.title}
          data-testid="chart"
          onpointermove={onMove}
          onpointerleave={() => (pointer = undefined)}
        >
          {#each scene.shapes as shape, index (index)}
            {#if shape.kind === 'line'}
              <line x1={shape.x1} y1={shape.y1} x2={shape.x2} y2={shape.y2} class={`ink-${shape.ink}`} />
            {:else if shape.kind === 'polyline'}
              <polyline points={shape.points} class={`series series-${shape.series % SERIES_COLORS}`} />
            {:else if shape.kind === 'circle'}
              <circle cx={shape.cx} cy={shape.cy} r={shape.r} class={`fill-${shape.series % SERIES_COLORS}`} />
            {:else if shape.kind === 'rect'}
              <rect x={shape.x} y={shape.y} width={shape.width} height={shape.height} class={`fill-${shape.series % SERIES_COLORS}`} />
            {:else if shape.kind === 'arc'}
              <path d={shape.d} class={`slice fill-${shape.series % SERIES_COLORS}`} />
            {:else}
              <text x={shape.x} y={shape.y} text-anchor={shape.anchor} class={`text-${shape.ink}`}>{shape.text}</text>
            {/if}
          {/each}
          {#if hit !== undefined && config.type === 'line'}
            {@const x = scene.xs[hit.index] ?? 0}
            <line x1={x} y1={scene.plot.top} x2={x} y2={scene.plot.bottom} class="guide" />
          {/if}
        </svg>
        </div>
        {#if hit !== undefined && tipAt !== undefined}
          <div class="tip" role="tooltip" style={`left: ${tipAt.x + 14}px; top: ${tipAt.y + 10}px`}>
            <b>{data.labels[hit.index] === '' && data.folded !== undefined ? t('chart.other') : data.labels[hit.index]}</b>
            {#each data.series as series, seriesIndex (seriesIndex)}
              {#if hit.series === undefined || hit.series === seriesIndex}
                <span><i class={`swatch fill-${(config.type === 'pie' ? hit.index : seriesIndex) % SERIES_COLORS}`}></i>{series.name}: {series.values[hit.index] === null || series.values[hit.index] === undefined ? '—' : formatNumber(series.values[hit.index] ?? 0, locale)}</span>
              {/if}
            {/each}
          </div>
        {/if}
      {/if}
    </div>
  {/if}
</main>

<style>
  main {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 8px 12px;
    height: 100vh;
    box-sizing: border-box;
    --dn-series-0: var(--vscode-charts-blue, #3794ff);
    --dn-series-1: var(--vscode-charts-orange, #d18616);
    --dn-series-2: var(--vscode-charts-green, #388a34);
    --dn-series-3: var(--vscode-charts-red, #e51400);
    --dn-series-4: var(--vscode-charts-purple, #652d90);
    --dn-series-5: var(--vscode-charts-yellow, #bf8803);
    --dn-series-6: #1a9e9e;
    --dn-series-7: #c2185b;
  }
  .bar,
  .controls,
  .types {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
  }
  .controls label:not(.inline) {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .controls select {
    width: auto;
  }
  h1 {
    font-size: 1.1em;
    margin: 0;
    font-family: var(--vscode-editor-font-family, monospace);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .grow {
    flex: 1;
  }
  .hint {
    color: var(--vscode-descriptionForeground);
    margin: 0;
  }
  .error {
    color: var(--vscode-errorForeground);
    margin: 0;
  }
  .tab {
    font: inherit;
    background: transparent;
    color: var(--vscode-foreground);
    border: none;
    border-bottom: 2px solid transparent;
    padding: 2px 6px;
    cursor: pointer;
  }
  .tab[aria-checked='true'] {
    border-bottom-color: var(--vscode-focusBorder);
  }
  .ys {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 12px;
    border: 1px solid var(--vscode-panel-border, transparent);
    padding: 2px 8px;
  }
  .inline {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .area {
    position: relative;
    flex: 1;
    min-height: 200px;
    overflow: hidden;
  }
  svg {
    display: block;
    font-size: 11px;
    font-family: var(--vscode-font-family, sans-serif);
  }
  .ink-axis {
    stroke: var(--vscode-descriptionForeground);
  }
  .ink-grid {
    stroke: var(--vscode-editorWidget-border, rgba(128, 128, 128, 0.25));
  }
  .text-text {
    fill: var(--vscode-foreground);
  }
  .text-muted,
  .text-axis {
    fill: var(--vscode-descriptionForeground);
  }
  .text-background {
    fill: var(--vscode-editor-background);
  }
  .series {
    fill: none;
    stroke-width: 2;
    stroke-linejoin: round;
  }
  .slice {
    stroke: var(--vscode-editor-background);
    stroke-width: 1;
  }
  .guide {
    stroke: var(--vscode-focusBorder);
    stroke-dasharray: 3 3;
  }
  .series-0 { stroke: var(--dn-series-0); }
  .series-1 { stroke: var(--dn-series-1); }
  .series-2 { stroke: var(--dn-series-2); }
  .series-3 { stroke: var(--dn-series-3); }
  .series-4 { stroke: var(--dn-series-4); }
  .series-5 { stroke: var(--dn-series-5); }
  .series-6 { stroke: var(--dn-series-6); }
  .series-7 { stroke: var(--dn-series-7); }
  .fill-0 { fill: var(--dn-series-0); background: var(--dn-series-0); }
  .fill-1 { fill: var(--dn-series-1); background: var(--dn-series-1); }
  .fill-2 { fill: var(--dn-series-2); background: var(--dn-series-2); }
  .fill-3 { fill: var(--dn-series-3); background: var(--dn-series-3); }
  .fill-4 { fill: var(--dn-series-4); background: var(--dn-series-4); }
  .fill-5 { fill: var(--dn-series-5); background: var(--dn-series-5); }
  .fill-6 { fill: var(--dn-series-6); background: var(--dn-series-6); }
  .fill-7 { fill: var(--dn-series-7); background: var(--dn-series-7); }
  .tip {
    position: absolute;
    pointer-events: none;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 4px 8px;
    background: var(--vscode-editorHoverWidget-background, var(--vscode-editor-background));
    color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground));
    border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-focusBorder));
    white-space: nowrap;
  }
  .swatch {
    display: inline-block;
    width: 8px;
    height: 8px;
    margin-right: 4px;
  }
</style>

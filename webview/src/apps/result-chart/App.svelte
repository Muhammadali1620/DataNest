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
  import Icon from '../../components/Icon.svelte';
  import IconButton from '../../components/IconButton.svelte';
  import MenuButton from '../../components/MenuButton.svelte';
  import type { CodiconName } from '../../lib/codicons';
  import type { MessageKey } from '../../l10n/en';
  import type { Translate } from '../../lib/i18n';
  import { cssColor, svgToPng } from '../er-diagram/picture';
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
  let root = $state<HTMLElement | undefined>(undefined);
  /** The panel of axes and grouping; open at first, out of the way when not needed. */
  let settingsOpen = $state(true);
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
  const TYPE_ICONS: Record<ChartConfigData['type'], CodiconName> = {
    line: 'graph-line',
    bar: 'graph',
    pie: 'pie-chart',
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

  /**
   * The theme's colours, so the saved picture looks like the page: the page names them
   * once (see the styles below) and the browser resolves them to plain colours.
   */
  function themeColors(): ChartColors {
    const host = root ?? document.body;
    const pick = (name: string, fallback: string): string =>
      cssColor(`var(${name})`, fallback, host);
    return {
      ink: {
        axis: pick('--chart-axis', '#717171'),
        grid: pick('--chart-grid', '#d4d4d4'),
        text: pick('--vscode-foreground', '#333333'),
        muted: pick('--dn-muted', '#717171'),
        background: pick('--vscode-editor-background', '#ffffff'),
      },
      series: SERIES_FALLBACKS.map((fallback, index) => pick(`--chart-series-${index}`, fallback)),
      font:
        getComputedStyle(document.body).getPropertyValue('--vscode-font-family').trim() ||
        'sans-serif',
    };
  }

  /** Where no theme colour can be read: the editor's default chart colours. */
  const SERIES_FALLBACKS: readonly string[] = [
    '#3794ff',
    '#d18616',
    '#388a34',
    '#e51400',
    '#652d90',
    '#bf8803',
    '#1a9e9e',
    '#c2185b',
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

<main bind:this={root}>
  {#if page === undefined || config === undefined || data === undefined}
    <div class="empty" role="status">
      <Icon name="loading" size={20} spin />
      <p class="empty-title">{t('chart.loading')}</p>
    </div>
  {:else}
    <header class="toolbar-row">
      <div class="title">
        <Icon name="graph" />
        <h1 title={page.title}>{page.title}</h1>
      </div>
      <span class="spacer"></span>
      <div class="toolbar" role="toolbar" aria-label={t('chart.toolbar')}>
        <div class="types" role="radiogroup" aria-label={t('chart.type')}>
          {#each CHART_TYPES as type (type)}
            <IconButton
              icon={TYPE_ICONS[type]}
              label={t(TYPE_KEYS[type])}
              role="radio"
              aria-checked={config.type === type}
              onclick={() => {
                change({ type });
              }}
            />
          {/each}
        </div>
        <span class="toolbar-separator"></span>
        <IconButton
          icon="settings-gear"
          label={t('chart.settings')}
          pressed={settingsOpen}
          data-testid="chart-settings-toggle"
          onclick={() => {
            settingsOpen = !settingsOpen;
          }}
        />
        <MenuButton
          icon="export"
          label={t('chart.export')}
          testid="chart-export"
          disabled={busy || scene === undefined || data.labels.length === 0}
          items={[
            { id: 'svg', label: t('chart.saveSvg'), icon: 'file-code' },
            { id: 'png', label: t('chart.savePng'), icon: 'file-media' },
          ]}
          onSelect={(format: 'svg' | 'png') => {
            void save(format);
          }}
        />
      </div>
    </header>

    {#if error !== undefined}
      <div class="notice error problem fade-in" role="alert"><Icon name="error" /><span>{error}</span></div>
    {/if}

    <div class="body">
      <div class="area" bind:this={area}>
        {#if data.labels.length === 0 || data.series.length === 0}
          <div class="empty">
            <span class="empty-icon"><Icon name="graph" size={28} /></span>
            <p class="empty-title">{t('chart.empty')}</p>
          </div>
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
                  <rect
                    x={shape.x}
                    y={shape.y}
                    width={shape.width}
                    height={shape.height}
                    class={`fill-${shape.series % SERIES_COLORS}`}
                  />
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
            <div class="tip fade-in" role="tooltip" style={`left: ${tipAt.x + 14}px; top: ${tipAt.y + 10}px`}>
              <b>{data.labels[hit.index] === '' && data.folded !== undefined ? t('chart.other') : data.labels[hit.index]}</b>
              {#each data.series as series, seriesIndex (seriesIndex)}
                {#if hit.series === undefined || hit.series === seriesIndex}
                  <span class="tip-row"><i class={`swatch fill-${(config.type === 'pie' ? hit.index : seriesIndex) % SERIES_COLORS}`}></i>{series.name}: {series.values[hit.index] === null || series.values[hit.index] === undefined ? '—' : formatNumber(series.values[hit.index] ?? 0, locale)}</span>
                {/if}
              {/each}
            </div>
          {/if}
        {/if}
      </div>

      {#if settingsOpen}
        <aside class="settings fade-in" aria-label={t('chart.settings')} data-testid="chart-settings">
          <label class="field">
            <span class="field-label">{config.type === 'pie' ? t('chart.slices') : t('chart.x')}</span>
            <select
              class="control"
              value={config.x}
              onchange={(event) => {
                change({ x: Number(event.currentTarget.value) });
              }}
            >
              {#each page.columns as column, index (index)}
                <option value={index}>{column.name}</option>
              {/each}
            </select>
          </label>
          {#if config.type === 'pie'}
            <label class="field">
              <span class="field-label">{t('chart.value')}</span>
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
              <legend class="field-label">{t('chart.y')}</legend>
              {#each page.columns as column, index (index)}
                {#if index !== config.x && column.kind === 'number'}
                  {@const at = config.ys.indexOf(index)}
                  <label class="check">
                    <input
                      type="checkbox"
                      checked={at !== -1}
                      disabled={at === -1 && config.ys.length >= SERIES_COLORS}
                      onchange={(event) => {
                        toggleY(index, event.currentTarget.checked);
                      }}
                    />
                    <span class="check-name">{column.name}</span>
                    {#if at !== -1 && !counting}<i class={`swatch fill-${at % SERIES_COLORS}`} aria-hidden="true"></i>{/if}
                  </label>
                {/if}
              {/each}
            </fieldset>
          {/if}
          <label class="field">
            <span class="field-label">{t('chart.aggregate')}</span>
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
        </aside>
      {/if}
    </div>

    <footer class="status">
      <p class="notes" data-testid="notes">
        <span>{t('chart.rows', page.rows)}</span>
        {#if page.truncated}<span class="warn"><Icon name="warning" size={14} />{t('chart.truncated')}</span>{/if}
        {#if data.points > data.labels.length && data.folded === undefined}<span>{t('chart.points', data.labels.length, data.points)}</span>{/if}
        {#if data.skipped > 0}<span>{t('chart.skipped', data.skipped)}</span>{/if}
        {#if data.folded !== undefined}<span>{t('chart.folded', data.folded)}</span>{/if}
      </p>
    </footer>
  {/if}
</main>

<style>
  main {
    /*
     * The chart's colours, named once: the page draws with them and the saved picture
     * reads them back (themeColors). The editor has six chart colours; two more are
     * mixed from them.
     */
    --chart-axis: var(--dn-muted);
    --chart-grid: color-mix(in srgb, var(--dn-muted) 22%, transparent);
    --chart-series-0: var(--vscode-charts-blue);
    --chart-series-1: var(--vscode-charts-orange);
    --chart-series-2: var(--vscode-charts-green);
    --chart-series-3: var(--vscode-charts-red);
    --chart-series-4: var(--vscode-charts-purple);
    --chart-series-5: var(--vscode-charts-yellow);
    --chart-series-6: color-mix(in srgb, var(--vscode-charts-blue) 50%, var(--vscode-charts-green));
    --chart-series-7: color-mix(in srgb, var(--vscode-charts-red) 55%, var(--vscode-charts-purple));

    position: relative;
    display: flex;
    flex-direction: column;
    height: 100vh;
  }

  .spacer {
    flex: 1;
  }

  .toolbar-row {
    display: flex;
    flex: none;
    flex-wrap: wrap;
    gap: 4px var(--dn-gap);
    align-items: center;
    min-height: 36px;
    padding: 4px 8px;
    border-bottom: 1px solid var(--dn-divider);
  }

  .title {
    display: flex;
    flex: 1 1 200px;
    gap: 6px;
    align-items: center;
    min-width: 0;
    color: var(--dn-muted);
  }

  h1 {
    overflow: hidden;
    color: var(--vscode-foreground);
    font-family: var(--dn-mono);
    font-size: var(--dn-font-small);
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .types {
    display: flex;
    gap: 2px;
  }

  /* The chart types are radio buttons: the chosen one looks pressed. */
  .types :global(.icon-button[aria-checked='true']) {
    color: var(--vscode-inputOption-activeForeground, var(--vscode-foreground));
    background: var(--vscode-inputOption-activeBackground, var(--dn-pressed));
    border-color: var(--vscode-inputOption-activeBorder, transparent);
  }

  .problem {
    flex: none;
    margin: 8px 8px 0;
  }

  .body {
    display: flex;
    flex: 1;
    min-height: 0;
  }

  .area {
    position: relative;
    display: flex;
    flex: 1;
    min-width: 0;
    min-height: 200px;
    overflow: hidden;
  }

  .values:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
  }

  /* Axes and grouping, beside the chart. */
  .settings {
    display: flex;
    flex: none;
    flex-direction: column;
    gap: var(--dn-gap-m);
    width: 230px;
    padding: var(--dn-gap-m);
    overflow-y: auto;
    background: var(--dn-surface);
    border-left: 1px solid var(--dn-divider);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .field-label {
    color: var(--dn-muted);
    font-size: var(--dn-font-small);
  }

  .ys {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
    margin: 0;
    padding: 0;
    border: none;
  }

  .ys legend {
    margin-bottom: 6px;
    padding: 0;
  }

  .ys:disabled {
    opacity: 0.5;
  }

  .check {
    display: flex;
    gap: 8px;
    align-items: center;
    min-width: 0;
    cursor: pointer;
  }

  .check-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Empty and waiting states, centred. */
  .empty {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--dn-gap);
    align-items: center;
    justify-content: center;
    padding: var(--dn-gap-xl);
    color: var(--dn-muted);
    text-align: center;
  }

  .empty-icon {
    display: inline-flex;
    padding: 14px;
    background: var(--dn-surface);
    border: 1px solid var(--dn-border);
    border-radius: 50%;
  }

  .empty-title {
    max-width: 420px;
    margin: 0;
    color: var(--vscode-foreground);
    font-size: 14px;
  }

  .status {
    display: flex;
    flex: none;
    align-items: center;
    min-height: 26px;
    padding: 2px 8px;
    color: var(--dn-muted);
    border-top: 1px solid var(--dn-divider);
    font-size: var(--dn-font-small);
  }

  .notes {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 10px;
    margin: 0;
  }

  .warn {
    display: inline-flex;
    gap: 4px;
    align-items: center;
    color: var(--dn-warning);
  }

  svg {
    display: block;
    font-family: var(--vscode-font-family, sans-serif);
    font-size: 11px;
  }

  .ink-axis {
    stroke: var(--chart-axis);
  }

  .ink-grid {
    stroke: var(--chart-grid);
  }

  .text-text {
    fill: var(--vscode-foreground);
  }

  .text-muted,
  .text-axis {
    fill: var(--dn-muted);
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

  .series-0 { stroke: var(--chart-series-0); }
  .series-1 { stroke: var(--chart-series-1); }
  .series-2 { stroke: var(--chart-series-2); }
  .series-3 { stroke: var(--chart-series-3); }
  .series-4 { stroke: var(--chart-series-4); }
  .series-5 { stroke: var(--chart-series-5); }
  .series-6 { stroke: var(--chart-series-6); }
  .series-7 { stroke: var(--chart-series-7); }
  .fill-0 { fill: var(--chart-series-0); background: var(--chart-series-0); }
  .fill-1 { fill: var(--chart-series-1); background: var(--chart-series-1); }
  .fill-2 { fill: var(--chart-series-2); background: var(--chart-series-2); }
  .fill-3 { fill: var(--chart-series-3); background: var(--chart-series-3); }
  .fill-4 { fill: var(--chart-series-4); background: var(--chart-series-4); }
  .fill-5 { fill: var(--chart-series-5); background: var(--chart-series-5); }
  .fill-6 { fill: var(--chart-series-6); background: var(--chart-series-6); }
  .fill-7 { fill: var(--chart-series-7); background: var(--chart-series-7); }

  .tip {
    position: absolute;
    z-index: 5;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px 10px;
    color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground));
    background: var(--vscode-editorHoverWidget-background, var(--dn-surface));
    border: 1px solid var(--vscode-editorHoverWidget-border, var(--dn-border));
    border-radius: var(--dn-radius);
    box-shadow: var(--dn-shadow);
    font-size: var(--dn-font-small);
    white-space: nowrap;
    pointer-events: none;
  }

  .tip-row {
    display: flex;
    gap: 6px;
    align-items: center;
  }

  .swatch {
    display: inline-block;
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 2px;
  }

  .check .swatch {
    margin-left: auto;
  }

  /* Beside a narrow editor the settings go under the chart. */
  @media (max-width: 640px) {
    .body {
      flex-direction: column;
    }

    .settings {
      flex-flow: row wrap;
      width: auto;
      max-height: 40vh;
      border-top: 1px solid var(--dn-divider);
      border-left: none;
    }

    .field {
      flex: 1 1 140px;
    }

    .ys {
      flex: 1 1 100%;
      flex-flow: row wrap;
      gap: 6px 14px;
    }

    .ys legend {
      width: 100%;
    }
  }
</style>

<script lang="ts">
  import { onMount } from 'svelte';
  import type {
    QueryPlanProtocol,
    QueryPlanRow,
    QueryPlanState,
  } from '../../../../src/shared/protocols/query-plan';
  import type { PlanWarning } from '../../../../src/shared/query-plan';
  import type { RpcPeer } from '../../../../src/shared/rpc';
  import type { Translate } from '../../lib/i18n';
  import type { MessageKey } from '../../l10n/en';
  import { formatMs, formatNumber, parentOf, percent, rowsText, visibleRows } from './plan-view';

  interface Props {
    rpc: RpcPeer<QueryPlanProtocol['webview'], QueryPlanProtocol['host']>;
    t: Translate;
  }

  const { rpc, t }: Props = $props();

  let page = $state<QueryPlanState | undefined>(undefined);
  let collapsed = $state<number[]>([]);
  let selected = $state(0);
  let tree = $state<HTMLDivElement | undefined>(undefined);
  /** Numbers in the editor's language, which the host put on the page. */
  const locale = document.documentElement.lang || undefined;

  const rows = $derived(page?.rows ?? []);
  const shown = $derived(visibleRows(rows, new Set(collapsed)));
  const current = $derived<QueryPlanRow | undefined>(rows[selected]);
  const hasTime = $derived(rows.some((row) => row.timeMs !== undefined));
  const hasCost = $derived(rows.some((row) => row.cost !== undefined));
  const hasLoops = $derived(rows.some((row) => row.loops !== undefined));
  /** The same columns in every row, so the numbers line up under their heading. */
  const columns = $derived(
    [
      'minmax(240px, 1fr)',
      '110px',
      hasTime ? '90px' : '',
      hasCost ? '80px' : '',
      '120px',
      hasLoops ? '56px' : '',
    ]
      .filter((width) => width !== '')
      .join(' '),
  );

  const WARNING_KEYS: Record<PlanWarning, MessageKey> = {
    'full-scan': 'plan.warning.fullScan',
    sort: 'plan.warning.sort',
    temporary: 'plan.warning.temporary',
    misestimate: 'plan.warning.misestimate',
    spill: 'plan.warning.spill',
    'no-join-predicate': 'plan.warning.noJoinPredicate',
    'implicit-conversion': 'plan.warning.implicitConversion',
    'missing-statistics': 'plan.warning.missingStatistics',
  };

  const WARNING_HINTS: Record<PlanWarning, MessageKey> = {
    'full-scan': 'plan.hint.fullScan',
    sort: 'plan.hint.sort',
    temporary: 'plan.hint.temporary',
    misestimate: 'plan.hint.misestimate',
    spill: 'plan.hint.spill',
    'no-join-predicate': 'plan.hint.noJoinPredicate',
    'implicit-conversion': 'plan.hint.implicitConversion',
    'missing-statistics': 'plan.hint.missingStatistics',
  };

  function applyState(next: QueryPlanState): void {
    const before = page?.rows ?? [];
    const sameRows =
      page !== undefined &&
      before.length === next.rows.length &&
      before.every((row, index) => row.operation === next.rows[index]?.operation);
    page = next;
    if (!sameRows) {
      collapsed = [];
      selected = 0;
    }
  }

  function toggle(index: number): void {
    collapsed = collapsed.includes(index)
      ? collapsed.filter((one) => one !== index)
      : [...collapsed, index];
  }

  function setExpanded(index: number, expanded: boolean): void {
    if (expanded === collapsed.includes(index)) {
      toggle(index);
    }
  }

  function expandAll(): void {
    collapsed = [];
  }

  function collapseAll(): void {
    collapsed = rows.flatMap((row, index) => (row.descendants > 0 && index > 0 ? [index] : []));
  }

  function onKey(event: KeyboardEvent): void {
    const at = shown.indexOf(selected);
    const row = rows[selected];
    switch (event.key) {
      case 'ArrowDown':
        selected = shown[Math.min(shown.length - 1, at + 1)] ?? selected;
        break;
      case 'ArrowUp':
        selected = shown[Math.max(0, at - 1)] ?? selected;
        break;
      case 'ArrowRight':
        if (row !== undefined && row.descendants > 0) {
          if (collapsed.includes(selected)) {
            setExpanded(selected, true);
          } else {
            selected = selected + 1;
          }
        }
        break;
      case 'ArrowLeft':
        if (row !== undefined && row.descendants > 0 && !collapsed.includes(selected)) {
          setExpanded(selected, false);
        } else {
          selected = parentOf(rows, selected) ?? selected;
        }
        break;
      case 'Home':
        selected = shown[0] ?? 0;
        break;
      case 'End':
        selected = shown.at(-1) ?? selected;
        break;
      default:
        return;
    }
    event.preventDefault();
    tree?.querySelector(`[data-row="${selected}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  function explain(analyze: boolean): void {
    rpc.emit('explain', { analyze });
  }

  onMount(() => {
    const subscription = rpc.on('state', (next) => {
      applyState(next);
    });
    rpc.emit('ready', {});
    return () => {
      subscription.dispose();
    };
  });

  const basisText = $derived(
    page === undefined
      ? ''
      : page.basis === 'time'
        ? t('plan.basis.time')
        : page.basis === 'cost'
          ? t('plan.basis.cost')
          : t('plan.basis.none'),
  );
</script>

<main>
  <header class="bar">
    <h1>{t('plan.title')}</h1>
    {#if page !== undefined}
      <span class="badge" class:actual={page.analyzed}>
        {page.analyzed ? t('plan.actual') : t('plan.estimated')}
      </span>
      <span class="hint">{page.connection}</span>
      <span class="grow"></span>
      <button
        type="button"
        class="button secondary"
        disabled={page.running}
        onclick={() => {
          explain(false);
        }}>{t('plan.explain')}</button
      >
      <button
        type="button"
        class="button secondary"
        disabled={page.running || !page.canAnalyze}
        title={page.canAnalyze ? t('plan.analyzeHint') : t('plan.analyzeUnavailable')}
        onclick={() => {
          explain(true);
        }}>{t('plan.analyze')}</button
      >
      <button type="button" class="button secondary" disabled={rows.length === 0} onclick={expandAll}
        >{t('plan.expandAll')}</button
      >
      <button
        type="button"
        class="button secondary"
        disabled={rows.length === 0}
        onclick={collapseAll}>{t('plan.collapseAll')}</button
      >
      <button
        type="button"
        class="button secondary"
        disabled={rows.length === 0}
        onclick={() => {
          rpc.emit('showRaw', {});
        }}>{t('plan.raw')}</button
      >
    {/if}
  </header>

  {#if page === undefined}
    <p class="hint">{t('form.loading')}</p>
  {:else}
    <pre class="statement" title={page.statement}>{page.statement}</pre>
    {#if page.running}
      <p class="hint" role="status">{t('plan.running')}</p>
    {/if}
    {#if page.error !== undefined}
      <p class="error" role="alert">{page.error}</p>
    {/if}
    {#if page.notes.length > 0}
      <section class="notes" aria-label={t('plan.notes')}>
        <h2>{t('plan.notes')}</h2>
        <ul>
          {#each page.notes as note, index (index)}
            <li><code>{note}</code></li>
          {/each}
        </ul>
      </section>
    {/if}
    {#if rows.length > 0}
      <p class="hint summary">
        {basisText}
        {#each page.properties as [key, value], index (index)}
          <span class="prop"><span class="key">{key}:</span> {value}</span>
        {/each}
      </p>
      <div class="layout">
        <div
          class="tree"
          role="tree"
          tabindex="0"
          aria-label={t('plan.title')}
          style="--columns: {columns}"
          bind:this={tree}
          onkeydown={onKey}
        >
          <div class="head" aria-hidden="true">
            <span class="op">{t('plan.column.operation')}</span>
            <span class="num">{t('plan.column.share')}</span>
            {#if hasTime}<span class="num">{t('plan.column.time')}</span>{/if}
            {#if hasCost}<span class="num">{t('plan.column.cost')}</span>{/if}
            <span class="num">{t('plan.column.rows')}</span>
            {#if hasLoops}<span class="num">{t('plan.column.loops')}</span>{/if}
          </div>
          {#each shown as index (index)}
            {@const row = rows[index]}
            {#if row !== undefined}
              <div
                class="row heat-{row.heat}"
                class:selected={index === selected}
                role="treeitem"
                tabindex="-1"
                aria-level={row.depth + 1}
                aria-selected={index === selected}
                aria-expanded={row.descendants > 0 ? !collapsed.includes(index) : undefined}
                data-row={index}
                onclick={() => {
                  selected = index;
                }}
                onkeydown={() => undefined}
              >
                <span class="op" style="padding-left: {row.depth * 16 + 4}px">
                  {#if row.descendants > 0}
                    <button
                      type="button"
                      class="twisty"
                      tabindex="-1"
                      aria-label={collapsed.includes(index) ? t('plan.expand') : t('plan.collapse')}
                      onclick={(event) => {
                        event.stopPropagation();
                        toggle(index);
                      }}>{collapsed.includes(index) ? '▸' : '▾'}</button
                    >
                  {:else}
                    <span class="twisty-space"></span>
                  {/if}
                  <span class="name">{row.operation}</span>
                  {#if row.object !== undefined}<span class="object">{row.object}</span>{/if}
                  {#each row.warnings as warning (warning)}
                    <span class="warning">{t(WARNING_KEYS[warning])}</span>
                  {/each}
                  {#if row.detail !== undefined}<span class="detail">{row.detail}</span>{/if}
                </span>
                <span class="num share" title={percent(row.share)}>
                  <span class="bar" style="width: {Math.round(row.share * 100)}%"></span>
                  <span class="value">{page.basis === 'none' ? '' : percent(row.share)}</span>
                </span>
                {#if hasTime}<span class="num">{formatMs(row.timeMs, locale)}</span>{/if}
                {#if hasCost}<span class="num">{formatNumber(row.cost, locale)}</span>{/if}
                <span class="num">{rowsText(row, locale)}</span>
                {#if hasLoops}<span class="num">{formatNumber(row.loops, locale)}</span>{/if}
              </div>
            {/if}
          {/each}
        </div>
        {#if current !== undefined}
          <aside class="details" aria-label={t('plan.details')}>
            <h2>{current.operation}</h2>
            {#if current.object !== undefined}<p class="object">{current.object}</p>{/if}
            {#if current.warnings.length > 0}
              <ul class="warnings">
                {#each current.warnings as warning (warning)}
                  <li>{t(WARNING_HINTS[warning])}</li>
                {/each}
              </ul>
            {/if}
            <table>
              <tbody>
                {#if page.basis !== 'none'}
                  <tr
                    ><th>{t('plan.selfShare')}</th><td
                      >{percent(current.share)} ({page.basis === 'time'
                        ? formatMs(current.self, locale)
                        : formatNumber(current.self, locale)})</td
                    ></tr
                  >
                {/if}
                {#each current.properties as [key, value], index (index)}
                  <tr><th>{key}</th><td>{value}</td></tr>
                {/each}
              </tbody>
            </table>
          </aside>
        {/if}
      </div>
    {/if}
  {/if}
</main>

<style>
  main {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 12px;
    height: 100vh;
  }
  .bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }
  h1 {
    font-size: 1.2em;
    margin: 0 4px 0 0;
  }
  h2 {
    font-size: 1em;
    margin: 0 0 4px;
  }
  .grow {
    flex: 1;
  }
  .badge {
    padding: 1px 6px;
    border-radius: 8px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    font-size: 0.85em;
  }
  .badge.actual {
    background: var(--vscode-charts-green, var(--vscode-badge-background));
  }
  .hint {
    color: var(--vscode-descriptionForeground);
    margin: 0;
  }
  .error {
    color: var(--vscode-errorForeground);
    margin: 0;
    white-space: pre-wrap;
  }
  .statement {
    margin: 0;
    max-height: 4.5em;
    overflow: hidden;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.9em;
    color: var(--vscode-descriptionForeground);
    white-space: pre-wrap;
  }
  .notes ul {
    margin: 0;
    padding-left: 18px;
  }
  .notes code {
    font-family: var(--vscode-editor-font-family, monospace);
    user-select: text;
  }
  .summary {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 14px;
  }
  .prop .key {
    opacity: 0.8;
  }
  .layout {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(220px, 32%);
    gap: 10px;
  }
  /* Beside a narrow editor the details go under the tree. */
  @media (max-width: 900px) {
    .layout {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: minmax(0, 2fr) minmax(0, 1fr);
    }
  }
  .tree {
    overflow: auto;
    border: 1px solid var(--vscode-panel-border, transparent);
    font-size: 0.95em;
  }
  .tree:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
  }
  .head,
  .row {
    display: grid;
    grid-template-columns: var(--columns);
    align-items: center;
    column-gap: 10px;
    padding: 2px 8px 2px 0;
  }
  .head {
    position: sticky;
    top: 0;
    background: var(--vscode-editor-background);
    color: var(--vscode-descriptionForeground);
    border-bottom: 1px solid var(--vscode-panel-border, transparent);
    font-size: 0.9em;
  }
  .row {
    cursor: default;
    border-left: 3px solid transparent;
  }
  .row:hover {
    background: var(--vscode-list-hoverBackground);
  }
  .row.selected {
    background: var(--vscode-list-inactiveSelectionBackground);
  }
  .heat-hot {
    border-left-color: var(--vscode-charts-red, #f14c4c);
  }
  .heat-warm {
    border-left-color: var(--vscode-charts-orange, #d18616);
  }
  .heat-mild {
    border-left-color: var(--vscode-charts-yellow, #cca700);
  }
  .op {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 2px 6px;
    min-width: 0;
  }
  .twisty {
    font: inherit;
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    padding: 0;
    width: 14px;
  }
  .twisty-space {
    display: inline-block;
    width: 14px;
  }
  .name {
    font-weight: 600;
  }
  .object {
    color: var(--vscode-textLink-foreground);
    margin: 0;
  }
  .detail {
    flex-basis: 100%;
    padding-left: 20px;
    color: var(--vscode-descriptionForeground);
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.9em;
    overflow-wrap: anywhere;
  }
  .warning {
    padding: 0 5px;
    border-radius: 6px;
    font-size: 0.8em;
    background: var(--vscode-inputValidation-warningBackground, rgba(204, 167, 0, 0.2));
    border: 1px solid var(--vscode-inputValidation-warningBorder, transparent);
  }
  .num {
    text-align: right;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .share {
    position: relative;
    height: 1.3em;
  }
  .share .bar {
    position: absolute;
    left: 0;
    top: 15%;
    height: 70%;
    background: var(--vscode-charts-orange, #d18616);
    opacity: 0.35;
  }
  .heat-hot .share .bar {
    background: var(--vscode-charts-red, #f14c4c);
    opacity: 0.5;
  }
  .share .value {
    position: relative;
  }
  .details {
    overflow: auto;
    border: 1px solid var(--vscode-panel-border, transparent);
    padding: 6px 8px;
  }
  .details table {
    border-collapse: collapse;
    width: 100%;
    font-size: 0.9em;
  }
  .details th,
  .details td {
    text-align: left;
    vertical-align: top;
    padding: 2px 4px;
    border-bottom: 1px solid var(--vscode-panel-border, transparent);
    overflow-wrap: anywhere;
    user-select: text;
  }
  .details th {
    font-weight: normal;
    color: var(--vscode-descriptionForeground);
    width: 40%;
  }
  .warnings {
    margin: 4px 0 8px;
    padding-left: 18px;
  }
</style>

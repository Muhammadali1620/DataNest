<script lang="ts">
  import { onMount } from 'svelte';
  import type {
    QueryPlanProtocol,
    QueryPlanRow,
    QueryPlanState,
  } from '../../../../src/shared/protocols/query-plan';
  import type { PlanWarning } from '../../../../src/shared/query-plan';
  import type { RpcPeer } from '../../../../src/shared/rpc';
  import Icon from '../../components/Icon.svelte';
  import IconButton from '../../components/IconButton.svelte';
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
      'minmax(160px, 1fr)',
      'minmax(44px, 120px)',
      hasTime ? '84px' : '',
      hasCost ? '72px' : '',
      '110px',
      hasLoops ? '52px' : '',
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
  {#if page?.running === true}
    <div class="progress-bar" role="progressbar" aria-label={t('plan.running')}></div>
  {/if}
  {#if page === undefined}
    <div class="empty" role="status">
      <Icon name="loading" size={20} spin />
      <p class="empty-title">{t('form.loading')}</p>
    </div>
  {:else}
    <header class="toolbar-row">
      <div class="title">
        <Icon name="list-tree" />
        <h1>{t('plan.title')}</h1>
        {#if page.analyzed}
          <span class="badge success"><Icon name="pulse" size={12} />{t('plan.actual')}</span>
        {:else}
          <span class="badge outline"><Icon name="lightbulb" size={12} />{t('plan.estimated')}</span>
        {/if}
        <span class="connection muted small" title={page.connection}>{page.connection}</span>
      </div>
      <span class="spacer"></span>
      <div class="toolbar" role="toolbar" aria-label={t('plan.toolbar')}>
        <IconButton
          icon="play"
          label={t('plan.explain')}
          text={t('plan.explain')}
          hint={t('plan.explainHint')}
          disabled={page.running}
          onclick={() => {
            explain(false);
          }}
        />
        <IconButton
          icon="watch"
          label={t('plan.analyze')}
          text={t('plan.analyze')}
          hint={page.canAnalyze ? t('plan.analyzeHint') : t('plan.analyzeUnavailable')}
          disabled={page.running || !page.canAnalyze}
          onclick={() => {
            explain(true);
          }}
        />
        <span class="toolbar-separator"></span>
        <IconButton
          icon="expand-all"
          label={t('plan.expandAll')}
          disabled={rows.length === 0}
          onclick={expandAll}
        />
        <IconButton
          icon="collapse-all"
          label={t('plan.collapseAll')}
          disabled={rows.length === 0}
          onclick={collapseAll}
        />
        <IconButton
          icon="file-code"
          label={t('plan.raw')}
          hint={t('plan.rawHint')}
          disabled={rows.length === 0}
          onclick={() => {
            rpc.emit('showRaw', {});
          }}
        />
      </div>
    </header>

    <div class="intro">
      <pre class="statement" title={page.statement}>{page.statement}</pre>
      {#if page.error !== undefined}
        <div class="notice error" role="alert"><Icon name="error" /><span class="error-text">{page.error}</span></div>
      {/if}
      {#if page.notes.length > 0}
        <section class="notice info notes" aria-label={t('plan.notes')}>
          <Icon name="lightbulb" />
          <div>
            <h2>{t('plan.notes')}</h2>
            <ul>
              {#each page.notes as note, index (index)}
                <li><code>{note}</code></li>
              {/each}
            </ul>
          </div>
        </section>
      {/if}
    </div>

    {#if rows.length > 0}
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
                      }}
                      ><Icon name={collapsed.includes(index) ? 'chevron-right' : 'chevron-down'} /></button
                    >
                  {:else}
                    <span class="twisty-space"></span>
                  {/if}
                  <span class="op-body">
                    <span class="name">{row.operation}</span>
                    {#if row.object !== undefined}<span class="object">{row.object}</span>{/if}
                    {#each row.warnings as warning (warning)}
                      <span class="badge warning"><Icon name="warning" size={12} />{t(WARNING_KEYS[warning])}</span>
                    {/each}
                    {#if row.detail !== undefined}<span class="detail">{row.detail}</span>{/if}
                  </span>
                </span>
                <span class="num share" title={percent(row.share)}>
                  {#if page.basis !== 'none'}
                    <span class="track" aria-hidden="true"
                      ><span class="fill" style="transform: scaleX({row.share})"></span></span
                    >
                    <span class="value">{percent(row.share)}</span>
                  {/if}
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
            {#each current.warnings as warning (warning)}
              <div class="notice warning hint"><Icon name="warning" /><span>{t(WARNING_HINTS[warning])}</span></div>
            {/each}
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
    {:else if page.error === undefined && !page.running}
      <div class="empty">
        <span class="empty-icon"><Icon name="list-tree" size={28} /></span>
        <p class="empty-title">{t('plan.empty')}</p>
      </div>
    {:else}
      <div class="spacer"></div>
    {/if}

    <footer class="status">
      {#if page.running}
        <span class="running" role="status">{t('plan.running')}</span>
      {:else if rows.length > 0}
        <span>{basisText}</span>
      {/if}
      {#each page.properties as [key, value], index (index)}
        <span class="prop"><span class="key">{key}:</span> {value}</span>
      {/each}
    </footer>
  {/if}
</main>

<style>
  main {
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
    gap: 8px;
    align-items: center;
    min-width: 0;
    color: var(--dn-muted);
  }

  h1 {
    color: var(--vscode-foreground);
    font-size: 13px;
    white-space: nowrap;
  }

  .connection {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  h2 {
    margin: 0 0 4px;
  }

  /* The statement and what the server said about it. */
  .intro {
    display: flex;
    flex: none;
    flex-direction: column;
    gap: var(--dn-gap);
    padding: var(--dn-gap) var(--dn-gap) 0;
  }

  .statement {
    display: -webkit-box;
    margin: 0;
    padding: 6px 10px;
    overflow: hidden;
    color: var(--dn-muted);
    background: var(--vscode-textCodeBlock-background, var(--dn-surface));
    border-radius: var(--dn-radius);
    font-size: var(--dn-font-small);
    white-space: pre-wrap;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    user-select: text;
  }

  .error-text {
    font-family: var(--dn-mono);
    white-space: pre-wrap;
  }

  .notes ul {
    margin: 0;
    padding-left: 16px;
  }

  .notes code {
    font-size: var(--dn-font-small);
    user-select: text;
  }

  .layout {
    display: grid;
    flex: 1;
    grid-template-columns: minmax(0, 1fr) minmax(240px, 30%);
    min-height: 0;
    margin-top: var(--dn-gap);
    border-top: 1px solid var(--dn-divider);
  }

  /* Beside a narrow editor the details go under the tree. */
  @media (max-width: 760px) {
    .layout {
      grid-template-rows: minmax(0, 2fr) minmax(0, 1fr);
      grid-template-columns: minmax(0, 1fr);
    }

    .details {
      border-top: 1px solid var(--dn-divider);
      border-left: none !important;
    }
  }

  .tree {
    overflow: auto;
    container-type: inline-size;
  }

  /* In a narrow tree the share is told in figures only. */
  @container (max-width: 520px) {
    .track {
      display: none;
    }
  }

  .tree:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
  }

  .head,
  .row {
    display: grid;
    grid-template-columns: var(--columns);
    column-gap: 12px;
    align-items: center;
    padding: 3px 10px 3px 0;
  }

  .head {
    position: sticky;
    top: 0;
    z-index: 1;
    min-height: 26px;
    color: var(--dn-muted);
    background: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-editor-background));
    border-bottom: 1px solid var(--dn-divider);
    font-size: var(--dn-font-small);
    font-weight: 600;
  }

  .head .op {
    padding-left: 8px;
  }

  .row {
    min-height: 26px;
    border-left: 3px solid transparent;
    cursor: default;
    transition: background-color var(--dn-duration) var(--dn-ease);
  }

  .row:hover {
    background: var(--vscode-list-hoverBackground);
  }

  .row.selected {
    background: var(--vscode-list-inactiveSelectionBackground);
  }

  .tree:focus .row.selected {
    color: var(--vscode-list-activeSelectionForeground, inherit);
    background: var(--vscode-list-activeSelectionBackground);
  }

  /* How much of the work a row takes: an edge in warmer colours, and the share in words. */
  .heat-hot {
    --heat: var(--dn-danger);

    border-left-color: var(--heat);
  }

  .heat-warm {
    --heat: var(--vscode-charts-orange, var(--dn-warning));

    border-left-color: var(--heat);
  }

  .heat-mild {
    --heat: var(--dn-warning);

    border-left-color: var(--heat);
  }

  .op {
    display: flex;
    gap: 2px;
    align-items: flex-start;
    min-width: 0;
  }

  .op-body {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 6px;
    align-items: center;
    min-width: 0;
  }

  .twisty {
    display: inline-flex;
    flex: none;
    margin-top: 1px;
    width: 16px;
    padding: 0;
    color: inherit;
    background: none;
    border: none;
    cursor: pointer;
  }

  .twisty-space {
    display: inline-block;
    flex: none;
    width: 16px;
  }

  .name {
    font-weight: 600;
  }

  .object {
    margin: 0;
    color: var(--vscode-textLink-foreground);
  }

  .detail {
    flex-basis: 100%;
    color: var(--dn-muted);
    font-family: var(--dn-mono);
    font-size: var(--dn-font-small);
    overflow-wrap: anywhere;
  }

  .num {
    font-variant-numeric: tabular-nums;
    text-align: right;
    white-space: nowrap;
  }

  .share {
    display: flex;
    gap: 8px;
    align-items: center;
    justify-content: flex-end;
  }

  .track {
    flex: 1;
    height: 6px;
    overflow: hidden;
    background: var(--dn-hover);
    border-radius: 3px;
  }

  .fill {
    display: block;
    height: 100%;
    background: var(--heat, var(--dn-muted));
    border-radius: 3px;
    transform-origin: left;
  }

  .value {
    min-width: 3ch;
  }

  .details {
    display: flex;
    flex-direction: column;
    gap: var(--dn-gap);
    min-height: 0;
    padding: var(--dn-gap-m);
    overflow: auto;
    background: var(--dn-surface);
    border-left: 1px solid var(--dn-divider);
  }

  .details h2 {
    margin: 0;
    font-size: 13px;
  }

  .details table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--dn-font-small);
  }

  .details th,
  .details td {
    padding: 4px 4px 4px 0;
    text-align: left;
    vertical-align: top;
    border-bottom: 1px solid var(--dn-divider);
    overflow-wrap: anywhere;
    user-select: text;
  }

  .details th {
    width: 40%;
    color: var(--dn-muted);
    font-weight: normal;
  }

  .hint {
    font-size: var(--dn-font-small);
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
    margin: 0;
    color: var(--vscode-foreground);
    font-size: 14px;
  }

  .status {
    display: flex;
    flex: none;
    flex-wrap: wrap;
    gap: 2px 14px;
    align-items: center;
    min-height: 26px;
    padding: 2px 8px;
    color: var(--dn-muted);
    border-top: 1px solid var(--dn-divider);
    font-size: var(--dn-font-small);
  }

  .running {
    color: var(--vscode-foreground);
  }

  .prop .key {
    opacity: 0.8;
  }
</style>

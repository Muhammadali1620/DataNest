<script lang="ts">
  import { onMount } from 'svelte';
  import type {
    MonitorProcess,
    MonitorScope,
    MonitorSetting,
    MonitorStatusRow,
    MonitorSummary,
    ServerMonitorProtocol,
    ServerMonitorState,
  } from '../../../../src/shared/protocols/server-monitor';
  import type { RpcPeer } from '../../../../src/shared/rpc';
  import Icon from '../../components/Icon.svelte';
  import IconButton from '../../components/IconButton.svelte';
  import type { CodiconName } from '../../lib/codicons';
  import type { MessageKey } from '../../l10n/en';
  import type { Translate } from '../../lib/i18n';
  import { formatBytes } from '../redis-key/key-view';
  import {
    DEFAULT_SORT,
    filterProcesses,
    filterSettings,
    filterStatus,
    formatDuration,
    formatRate,
    nextSort,
    type ProcessColumn,
    type ProcessSort,
    pushReading,
    sortProcesses,
    sparkline,
    statusKey,
    usage,
  } from './monitor-view';

  interface Props {
    rpc: RpcPeer<ServerMonitorProtocol['webview'], ServerMonitorProtocol['host']>;
    t: Translate;
    /** The Manager page shows one tab at a time, without the page's own title and tab strip. */
    only?: 'processes' | 'settings' | 'status';
  }

  const { rpc, t, only }: Props = $props();

  type Tab = 'processes' | 'settings' | 'status';

  const INTERVALS = [2, 5, 10, 30];
  const units = $derived({ seconds: t('monitor.unit.seconds'), days: t('monitor.unit.days') });

  let page = $state<ServerMonitorState | undefined>(undefined);
  // `only` is fixed for the life of the page: it is the tab a host page pins.
  // svelte-ignore state_referenced_locally
  let tab = $state<Tab>(only ?? 'processes');
  let auto = $state(true);
  let interval = $state(5);
  // Read by the timer, which Svelte's analysis does not see as a reader.
  const timerSettings = (): { auto: boolean; interval: number; tab: Tab } => ({ auto, interval, tab });

  let processes = $state<MonitorProcess[]>([]);
  let processesAt = $state<number | undefined>(undefined);
  let processFilter = $state('');
  let hideIdle = $state(true);
  let sort = $state<ProcessSort>(DEFAULT_SORT);
  let chosenId = $state<string | undefined>(undefined);

  let scope = $state<MonitorScope>('session');
  let settings = $state<MonitorSetting[]>([]);
  let settingsLoaded = $state(false);
  let settingFilter = $state('');
  let changedOnly = $state(false);

  let status = $state<MonitorStatusRow[]>([]);
  let summary = $state<MonitorSummary | undefined>(undefined);
  let statusAt = $state<number | undefined>(undefined);
  /** The rate of the latest readings, for the trend line on its card. */
  let rates = $state<number[]>([]);
  let statusFilter = $state('');
  let changingOnly = $state(false);

  const errors = $state<Record<Tab, string | undefined>>({
    processes: undefined,
    settings: undefined,
    status: undefined,
  });
  const busy = { processes: false, settings: false, status: false };
  let stopping = $state(false);

  const features = $derived(page?.features);
  const shownProcesses = $derived(sortProcesses(filterProcesses(processes, processFilter, hideIdle), sort));
  const chosen = $derived(processes.find((row) => row.id === chosenId));
  const anyChanged = $derived(settings.some((row) => row.changed === true));
  // The other scope may have nothing marked, and then no box to untick.
  const shownSettings = $derived(filterSettings(settings, settingFilter, changedOnly && anyChanged));
  const shownStatus = $derived(filterStatus(status, statusFilter, changingOnly));
  const grouped = $derived(status.some((row) => row.group !== undefined));
  const canStop = $derived(
    chosen !== undefined && !chosen.mine && page !== undefined && !page.readOnly && !stopping,
  );

  const SCOPE_KEYS: Record<NonNullable<ServerMonitorState['features']>['serverScope'], MessageKey> = {
    global: 'monitor.scope.global',
    cluster: 'monitor.scope.cluster',
    server: 'monitor.scope.server',
    system: 'monitor.scope.system',
  };

  const COLUMNS: { column: ProcessColumn; key: MessageKey }[] = [
    { column: 'id', key: 'monitor.column.id' },
    { column: 'user', key: 'monitor.column.user' },
    { column: 'host', key: 'monitor.column.host' },
    { column: 'database', key: 'monitor.column.database' },
    { column: 'state', key: 'monitor.column.state' },
    { column: 'seconds', key: 'monitor.column.time' },
    { column: 'query', key: 'monitor.column.query' },
  ];

  function failure(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  async function loadProcesses(): Promise<void> {
    if (busy.processes) {
      return;
    }
    busy.processes = true;
    try {
      const answer = await rpc.request('processes', {});
      processes = answer.rows;
      processesAt = answer.at;
      errors.processes = undefined;
    } catch (error) {
      errors.processes = failure(error);
    } finally {
      busy.processes = false;
    }
  }

  async function loadSettings(next: MonitorScope): Promise<void> {
    scope = next;
    if (busy.settings) {
      return;
    }
    busy.settings = true;
    try {
      const answer = await rpc.request('settings', { scope: next });
      if (next === scope) {
        settings = answer.rows;
        settingsLoaded = true;
      }
      errors.settings = undefined;
    } catch (error) {
      errors.settings = failure(error);
    } finally {
      busy.settings = false;
    }
  }

  async function loadStatus(): Promise<void> {
    if (busy.status) {
      return;
    }
    busy.status = true;
    try {
      const answer = await rpc.request('status', {});
      status = answer.rows;
      summary = answer.summary;
      if (answer.summary.rate !== undefined) {
        rates = pushReading(rates, answer.summary.rate.perSecond);
      }
      statusAt = answer.at;
      errors.status = undefined;
    } catch (error) {
      errors.status = failure(error);
    } finally {
      busy.status = false;
    }
  }

  /** What the current tab shows, and the numbers on top. */
  async function refresh(current: Tab): Promise<void> {
    const reads: Promise<void>[] = [loadStatus()];
    if (current === 'processes') {
      reads.push(loadProcesses());
    } else if (current === 'settings') {
      reads.push(loadSettings(scope));
    }
    await Promise.all(reads);
  }

  function open(next: Tab): void {
    tab = next;
    if (next === 'processes') {
      void loadProcesses();
    } else if (next === 'settings' && !settingsLoaded) {
      void loadSettings(scope);
    } else if (next === 'status') {
      void loadStatus();
    }
  }

  function applyState(next: ServerMonitorState): void {
    const first = page?.features === undefined && next.features !== undefined;
    page = next;
    if (first && next.features !== undefined) {
      scope = next.features.scopes[0] ?? 'session';
      tab = only ?? (next.features.processes ? 'processes' : 'settings');
      void refresh(tab);
    }
  }

  async function stop(kind: 'cancel' | 'terminate'): Promise<void> {
    if (chosen === undefined) {
      return;
    }
    stopping = true;
    try {
      const answer = await rpc.request('stop', { id: chosen.id, kind });
      errors.processes = undefined;
      if (answer.stopped) {
        await loadProcesses();
      }
    } catch (error) {
      errors.processes = failure(error);
    } finally {
      stopping = false;
    }
  }

  onMount(() => {
    const subscription = rpc.on('state', (next) => {
      applyState(next);
    });
    let elapsed = 0;
    const timer = setInterval(() => {
      const current = timerSettings();
      elapsed += 1;
      if (current.auto && elapsed >= current.interval && current.tab !== 'settings') {
        elapsed = 0;
        void refresh(current.tab);
      }
    }, 1000);
    rpc.emit('ready', {});
    return () => {
      subscription.dispose();
      clearInterval(timer);
    };
  });

  const TAB_ICONS: Record<Tab, CodiconName> = {
    processes: 'server-process',
    settings: 'settings-gear',
    status: 'pulse',
  };
  /** Size of the trend line on the rate card. */
  const TREND = { width: 120, height: 28 };

  function time(at: number | undefined): string {
    return at === undefined ? '' : t('monitor.at', new Date(at).toLocaleTimeString());
  }
</script>

<main class:embedded={only !== undefined}>
  {#if page === undefined}
    <div class="empty" role="status">
      <Icon name="loading" size={20} spin />
      <p class="empty-title">{t('monitor.loading')}</p>
    </div>
  {:else}
    <header class="toolbar-row">
      <div class="title">
        {#if only === undefined}
          <Icon name="pulse" />
          <h1>{page.connectionName}</h1>
        {/if}
        {#if page.server !== undefined}
          <span class="server" data-testid="server">{page.server}{summary?.version === undefined ? '' : ` ${summary.version}`}</span>
        {/if}
      </div>
      <span class="spacer"></span>
      {#if features !== undefined && page.error === undefined}
        <div class="toolbar" role="toolbar" aria-label={t('monitor.toolbar')}>
          <IconButton
            icon={auto ? 'debug-pause' : 'play'}
            label={auto ? t('monitor.pause') : t('monitor.resume')}
            data-testid="monitor-auto"
            onclick={() => {
              auto = !auto;
            }}
          />
          <select
            class="control interval"
            bind:value={interval}
            aria-label={t('monitor.interval')}
            title={t('monitor.interval')}
          >
            {#each INTERVALS as seconds (seconds)}
              <option value={seconds}>{t('monitor.seconds', seconds)}</option>
            {/each}
          </select>
          <IconButton icon="refresh" label={t('monitor.refresh')} onclick={() => void refresh(tab)} />
        </div>
      {/if}
    </header>

    {#if page.error !== undefined}
      <div class="empty">
        <div class="notice error" role="alert"><Icon name="error" /><span class="pre">{page.error}</span></div>
      </div>
    {:else if features === undefined}
      <div class="empty" role="status">
        <Icon name="loading" size={20} spin />
        <p class="empty-title">{t('monitor.loading')}</p>
      </div>
    {:else}
      <section class="cards" data-testid="cards" aria-label={t('monitor.summary')}>
        {#if summary?.uptimeSeconds !== undefined}
          <div class="card metric">
            <span class="label"><Icon name="watch" size={14} />{t('monitor.uptime')}</span>
            <span class="figure">{formatDuration(summary.uptimeSeconds, units)}</span>
          </div>
        {/if}
        {#if summary?.connections !== undefined}
          {@const used = usage(summary.connections, summary.maxConnections)}
          <div class="card metric">
            <span class="label"><Icon name="plug" size={14} />{t('monitor.connections')}</span>
            <span class="figure">{summary.connections.toLocaleString()}{#if summary.maxConnections !== undefined}<span class="of">{` / ${summary.maxConnections.toLocaleString()}`}</span>{/if}</span>
            {#if used !== undefined}
              <span class="meter" class:high={used >= 0.8} aria-hidden="true"><span style="transform: scaleX({used})"></span></span>
            {/if}
          </div>
        {/if}
        {#if summary?.rate !== undefined}
          {@const line = sparkline(rates, TREND.width, TREND.height)}
          <div class="card metric">
            <span class="label"><Icon name="graph-line" size={14} />{t(summary.rate.kind === 'queries' ? 'monitor.queriesPerSecond' : 'monitor.transactionsPerSecond')}</span>
            <span class="figure">{summary.rate.perSecond.toFixed(1)}</span>
            {#if line !== ''}
              <svg
                class="trend"
                viewBox="0 0 {TREND.width} {TREND.height}"
                preserveAspectRatio="none"
                aria-hidden="true"
                data-testid="trend"
              >
                <polyline points={line} />
              </svg>
            {/if}
          </div>
        {/if}
        {#if summary?.sizeBytes !== undefined}
          <div class="card metric">
            <span class="label"><Icon name="database" size={14} />{t('monitor.size')}</span>
            <span class="figure">{formatBytes(summary.sizeBytes)}</span>
          </div>
        {/if}
      </section>

      <div class="tabs" role="tablist" hidden={only !== undefined}>
        {#if features.processes}
          <button
            type="button"
            role="tab"
            class="tab"
            aria-selected={tab === 'processes'}
            onclick={() => {
              open('processes');
            }}><Icon name={TAB_ICONS.processes} size={14} />{t('monitor.tab.processes', processes.length)}</button
          >
        {/if}
        <button
          type="button"
          role="tab"
          class="tab"
          aria-selected={tab === 'settings'}
          onclick={() => {
            open('settings');
          }}><Icon name={TAB_ICONS.settings} size={14} />{t('monitor.tab.settings')}</button
        >
        <button
          type="button"
          role="tab"
          class="tab"
          aria-selected={tab === 'status'}
          onclick={() => {
            open('status');
          }}><Icon name={TAB_ICONS.status} size={14} />{t('monitor.tab.status')}</button
        >
      </div>

      {#if tab === 'processes'}
        <div class="tab-tools">
          <div class="find">
            <span class="find-icon"><Icon name="filter" size={14} /></span>
            <input class="control find-input" type="search" bind:value={processFilter} placeholder={t('monitor.filter')} aria-label={t('monitor.filter')} />
          </div>
          <label class="check"><input type="checkbox" bind:checked={hideIdle} />{t('monitor.hideIdle')}</label>
          <span class="spacer"></span>
          {#if features.cancel}
            <IconButton icon="debug-stop" label={t('monitor.cancel')} text={t('monitor.cancel')} disabled={!canStop} onclick={() => void stop('cancel')} />
          {/if}
          {#if features.terminate}
            <IconButton icon="close" label={t('monitor.terminate')} text={t('monitor.terminate')} disabled={!canStop} onclick={() => void stop('terminate')} />
          {/if}
        </div>
      {:else if tab === 'settings'}
        <div class="tab-tools">
          {#if features.scopes.length > 1}
            <div class="scopes" role="radiogroup" aria-label={t('monitor.scope')}>
              {#each features.scopes as one (one)}
                <label class="check">
                  <input type="radio" name="scope" checked={scope === one} onchange={() => void loadSettings(one)} />
                  {one === 'session' ? t('monitor.scope.session') : t(SCOPE_KEYS[features.serverScope])}
                </label>
              {/each}
            </div>
          {/if}
          <div class="find">
            <span class="find-icon"><Icon name="filter" size={14} /></span>
            <input class="control find-input" type="search" bind:value={settingFilter} placeholder={t('monitor.filter')} aria-label={t('monitor.filter')} />
          </div>
          {#if anyChanged}
            <label class="check"><input type="checkbox" bind:checked={changedOnly} />{t('monitor.changedOnly')}</label>
          {/if}
        </div>
      {:else}
        <div class="tab-tools">
          <div class="find">
            <span class="find-icon"><Icon name="filter" size={14} /></span>
            <input class="control find-input" type="search" bind:value={statusFilter} placeholder={t('monitor.filter')} aria-label={t('monitor.filter')} />
          </div>
          <label class="check"><input type="checkbox" bind:checked={changingOnly} />{t('monitor.changingOnly')}</label>
        </div>
      {/if}

      {#if errors[tab] !== undefined}
        <div class="notice error problem" role="alert"><Icon name="error" /><span class="pre">{errors[tab]}</span></div>
      {/if}
      {#if tab === 'processes' && page.readOnly}
        <div class="notice info problem"><Icon name="lock" /><span>{t('monitor.readOnly')}</span></div>
      {/if}

      {#if tab === 'processes'}
        <div class="table">
          <table data-testid="processes">
            <thead>
              <tr>
                {#each COLUMNS as entry (entry.column)}
                  <th
                    class:number={entry.column === 'seconds'}
                    aria-sort={sort.column === entry.column ? (sort.descending ? 'descending' : 'ascending') : 'none'}
                  >
                    <button type="button" class="sort" onclick={() => (sort = nextSort(sort, entry.column))}>
                      {t(entry.key)}{#if sort.column === entry.column}<Icon name={sort.descending ? 'arrow-down' : 'arrow-up'} size={12} />{/if}
                    </button>
                  </th>
                {/each}
              </tr>
            </thead>
            <tbody>
              {#each shownProcesses as row (row.id)}
                <tr
                  class:chosen={row.id === chosenId}
                  class:idle={row.idle}
                  aria-selected={row.id === chosenId}
                  onclick={() => (chosenId = row.id)}
                >
                  <td>{row.id}{#if row.mine}<span class="badge outline mine">{t('monitor.mine')}</span>{/if}</td>
                  <td>{row.user ?? ''}</td>
                  <td>{row.host ?? ''}</td>
                  <td>{row.database ?? ''}</td>
                  <td>
                    {row.state ?? ''}
                    {#if row.blockedBy !== undefined}<span class="badge danger blocked"><Icon name="lock" size={12} />{t('monitor.blockedBy', row.blockedBy)}</span>{/if}
                  </td>
                  <td class="number">{row.seconds === undefined ? '' : formatDuration(row.seconds, units)}</td>
                  <td class="query" title={row.query ?? ''}>{row.query ?? ''}</td>
                </tr>
              {/each}
            </tbody>
          </table>
          {#if shownProcesses.length === 0}
            <p class="table-empty"><Icon name={processes.length === 0 ? 'server-process' : 'filter'} /><span>{processes.length === 0 ? t('monitor.noProcesses') : t('monitor.nothing')}</span></p>
          {/if}
        </div>
        {#if chosen !== undefined}
          <section class="details" data-testid="details" aria-label={t('monitor.process', chosen.id)}>
            <p class="details-head">
              <Icon name="server-process" size={14} />
              <span class="details-title">{t('monitor.process', chosen.id)}</span>
              {#if chosen.application !== undefined}<span class="muted">{chosen.application}</span>{/if}
              {#if chosen.blockedBy !== undefined}<span class="badge danger"><Icon name="lock" size={12} />{t('monitor.blockedBy', chosen.blockedBy)}</span>{/if}
            </p>
            <pre>{chosen.query ?? t('monitor.noQuery')}</pre>
          </section>
        {/if}
      {:else if tab === 'settings'}
        <div class="table">
          <table data-testid="settings">
            <thead>
              <tr><th>{t('monitor.column.name')}</th><th>{t('monitor.column.value')}</th><th>{t('monitor.column.description')}</th></tr>
            </thead>
            <tbody>
              {#each shownSettings as row (row.name)}
                <tr class:changed={row.changed === true}>
                  <td>{row.name}{#if row.changed === true}<span class="changed-mark" title={t('monitor.changed')}><Icon name="circle-filled" size={8} /><span class="sr-only">{t('monitor.changed')}</span></span>{/if}</td>
                  <td class="value">{row.value}{row.unit === undefined ? '' : ` ${row.unit}`}</td>
                  <td class="description">{row.description ?? ''}</td>
                </tr>
              {/each}
            </tbody>
          </table>
          {#if settingsLoaded && shownSettings.length === 0}
            <p class="table-empty"><Icon name="filter" /><span>{t('monitor.nothing')}</span></p>
          {/if}
        </div>
      {:else}
        <div class="table">
          <table data-testid="status">
            <thead>
              <tr>
                {#if grouped}<th>{t('monitor.column.group')}</th>{/if}
                <th>{t('monitor.column.name')}</th>
                <th class="number">{t('monitor.column.value')}</th>
                <th class="number">{t('monitor.column.perSecond')}</th>
              </tr>
            </thead>
            <tbody>
              {#each shownStatus as row (statusKey(row))}
                <tr>
                  {#if grouped}<td class="group">{row.group ?? ''}</td>{/if}
                  <td>{row.name}</td>
                  <td class="value number">{row.value}</td>
                  <td class="number rate">{row.perSecond === undefined ? '' : formatRate(row.perSecond)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
          {#if statusAt !== undefined && shownStatus.length === 0}
            <p class="table-empty"><Icon name="filter" /><span>{t('monitor.nothing')}</span></p>
          {/if}
        </div>
      {/if}

      <footer class="status">
        <span>{time(tab === 'processes' ? processesAt : statusAt)}</span>
        <span class="auto" data-testid="auto-state">
          <Icon name={auto ? 'sync' : 'debug-pause'} size={12} />{auto ? t('monitor.every', interval) : t('monitor.paused')}
        </span>
      </footer>
    {/if}
  {/if}
</main>

<style>
  main {
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100vh;
  }

  main.embedded {
    height: 100%;
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
    overflow: hidden;
    color: var(--vscode-foreground);
    font-size: 13px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .server {
    font-size: var(--dn-font-small);
    white-space: nowrap;
  }

  .interval {
    min-height: 24px;
    padding-top: 2px;
    padding-bottom: 2px;
  }

  /* Metric tiles: the figure large, what it is small above it. */
  .cards {
    display: grid;
    flex: none;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: var(--dn-gap);
    padding: var(--dn-gap-m) var(--dn-gap) var(--dn-gap);
  }

  .cards:empty {
    display: none;
  }

  .metric {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
    padding: 10px 12px;
    overflow: hidden;
  }

  .label {
    display: flex;
    gap: 6px;
    align-items: center;
    color: var(--dn-muted);
    font-size: var(--dn-font-small);
  }

  .figure {
    position: relative;
    font-size: 20px;
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    line-height: 1.2;
    white-space: nowrap;
  }

  .of {
    color: var(--dn-muted);
    font-size: 13px;
    font-weight: normal;
  }

  .meter {
    height: 3px;
    margin-top: 2px;
    overflow: hidden;
    background: var(--dn-hover);
    border-radius: 2px;
  }

  .meter span {
    display: block;
    height: 100%;
    background: var(--dn-info);
    transform-origin: left;
    transition: transform var(--dn-duration) var(--dn-ease);
  }

  .meter.high span {
    background: var(--dn-warning);
  }

  .trend {
    position: absolute;
    right: 12px;
    bottom: 10px;
    width: 45%;
    height: 28px;
    overflow: visible;
  }

  .trend polyline {
    fill: none;
    stroke: var(--vscode-charts-blue, var(--dn-info));
    stroke-linejoin: round;
    stroke-width: 1.5;
    vector-effect: non-scaling-stroke;
  }

  /* Tabs drawn like the editor's panel titles, as the result page has. */
  .tabs[hidden] {
    display: none;
  }

  .tabs {
    display: flex;
    flex: none;
    gap: 2px;
    height: 32px;
    padding: 0 8px;
    overflow-x: auto;
    border-bottom: 1px solid var(--dn-divider);
    scrollbar-width: thin;
  }

  .tab {
    display: inline-flex;
    flex: none;
    gap: 6px;
    align-items: center;
    margin-bottom: -1px;
    padding: 0 10px;
    color: var(--vscode-panelTitle-inactiveForeground, var(--dn-muted));
    background: transparent;
    border: none;
    border-bottom: 1px solid transparent;
    font-family: inherit;
    font-size: inherit;
    white-space: nowrap;
    cursor: pointer;
    transition: color var(--dn-duration) var(--dn-ease);
  }

  .tab:hover,
  .tab[aria-selected='true'] {
    color: var(--vscode-panelTitle-activeForeground, var(--vscode-foreground));
  }

  .tab[aria-selected='true'] {
    border-bottom-color: var(--vscode-panelTitle-activeBorder, var(--dn-accent));
  }

  .tab-tools,
  .scopes {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 14px;
    align-items: center;
  }

  .tab-tools {
    flex: none;
    min-height: 36px;
    padding: 4px 8px;
  }

  .find {
    position: relative;
    display: flex;
    align-items: center;
  }

  .find-icon {
    position: absolute;
    left: 7px;
    display: inline-flex;
    color: var(--dn-muted);
    pointer-events: none;
  }

  .find-input {
    width: 220px;
    min-width: 120px;
    padding-left: 26px;
  }

  .check {
    display: inline-flex;
    gap: 6px;
    align-items: center;
    white-space: nowrap;
    cursor: pointer;
  }

  .problem {
    flex: none;
    margin: 0 8px 8px;
  }

  .pre {
    white-space: pre-wrap;
  }

  /* Tables in the editor's list colours. */
  .table {
    flex: 1;
    min-height: 0;
    overflow: auto;
    border-top: 1px solid var(--dn-divider);
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--dn-font-small);
  }

  th,
  td {
    max-width: 420px;
    padding: 4px 10px;
    overflow: hidden;
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
    border-bottom: 1px solid var(--dn-divider);
    user-select: text;
  }

  td {
    font-family: var(--dn-mono);
  }

  th {
    position: sticky;
    top: 0;
    z-index: 1;
    color: var(--dn-muted);
    background: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-editor-background));
    font-weight: 600;
  }

  .sort {
    display: inline-flex;
    gap: 4px;
    align-items: center;
    padding: 0;
    color: inherit;
    background: none;
    border: none;
    font: inherit;
    cursor: pointer;
  }

  .sort:hover {
    color: var(--vscode-foreground);
  }

  th.number .sort {
    flex-direction: row-reverse;
  }

  tbody tr {
    cursor: default;
    transition: background-color var(--dn-duration) var(--dn-ease);
  }

  tbody tr:hover {
    background: var(--vscode-list-hoverBackground);
  }

  tr.idle td {
    color: var(--dn-muted);
  }

  tr.chosen td {
    color: var(--vscode-list-activeSelectionForeground, inherit);
    background: var(--vscode-list-activeSelectionBackground);
  }

  tr.changed td:first-child {
    font-weight: 600;
  }

  .changed-mark {
    display: inline-flex;
    margin-left: 6px;
    color: var(--dn-info);
    vertical-align: middle;
  }

  .number {
    text-align: right;
  }

  .query {
    max-width: 600px;
  }

  .description {
    min-width: 240px;
    color: var(--dn-muted);
    font-family: var(--vscode-font-family);
    white-space: normal;
  }

  .value.number,
  td.value {
    white-space: pre-wrap;
    word-break: break-all;
  }

  .group {
    color: var(--dn-muted);
  }

  .rate {
    color: var(--dn-info);
  }

  .mine {
    margin-left: 6px;
    font-family: var(--vscode-font-family);
  }

  .blocked {
    margin-left: 6px;
    font-family: var(--vscode-font-family);
  }

  .table-empty {
    display: flex;
    gap: 8px;
    align-items: center;
    justify-content: center;
    margin: 0;
    padding: var(--dn-gap-xl);
    color: var(--dn-muted);
  }

  /* The chosen process: its whole statement. */
  .details {
    flex: none;
    max-height: 30vh;
    padding: 8px 12px;
    overflow: auto;
    background: var(--dn-surface);
    border-top: 1px solid var(--dn-divider);
  }

  .details-head {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 8px;
    align-items: center;
    margin: 0 0 6px;
    color: var(--dn-muted);
    font-size: var(--dn-font-small);
  }

  .details-title {
    color: var(--vscode-foreground);
    font-weight: 600;
  }

  pre {
    margin: 0;
    font-family: var(--dn-mono);
    white-space: pre-wrap;
    word-break: break-word;
    user-select: text;
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

  .empty .notice {
    max-width: 640px;
    text-align: left;
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

  .auto {
    display: inline-flex;
    gap: 4px;
    align-items: center;
  }
</style>

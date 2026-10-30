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
    sortProcesses,
    statusKey,
  } from './monitor-view';

  interface Props {
    rpc: RpcPeer<ServerMonitorProtocol['webview'], ServerMonitorProtocol['host']>;
    t: Translate;
  }

  const { rpc, t }: Props = $props();

  type Tab = 'processes' | 'settings' | 'status';

  const INTERVALS = [2, 5, 10, 30];
  const units = $derived({ seconds: t('monitor.unit.seconds'), days: t('monitor.unit.days') });

  let page = $state<ServerMonitorState | undefined>(undefined);
  let tab = $state<Tab>('processes');
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
      tab = next.features.processes ? 'processes' : 'settings';
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

  function time(at: number | undefined): string {
    return at === undefined ? '' : t('monitor.at', new Date(at).toLocaleTimeString());
  }
</script>

<main>
  {#if page === undefined}
    <p class="hint">{t('monitor.loading')}</p>
  {:else}
    <header class="bar">
      <h1>{page.connectionName}</h1>
      {#if page.server !== undefined}
        <span class="hint" data-testid="server">{page.server}{summary?.version === undefined ? '' : ` ${summary.version}`}</span>
      {/if}
      <span class="grow"></span>
      {#if features !== undefined}
        <span class="hint">{time(tab === 'processes' ? processesAt : statusAt)}</span>
        <label class="inline">
          <input type="checkbox" bind:checked={auto} />
          {t('monitor.auto')}
        </label>
        <select class="control interval" bind:value={interval} aria-label={t('monitor.interval')}>
          {#each INTERVALS as seconds (seconds)}
            <option value={seconds}>{t('monitor.seconds', seconds)}</option>
          {/each}
        </select>
        <button type="button" class="button secondary" onclick={() => void refresh(tab)}>{t('monitor.refresh')}</button>
      {/if}
    </header>

    {#if page.error !== undefined}
      <p class="error" role="alert">{page.error}</p>
    {:else if features === undefined}
      <p class="hint">{t('monitor.loading')}</p>
    {:else}
      <section class="cards" data-testid="cards">
        {#if summary?.uptimeSeconds !== undefined}
          <div class="card"><span class="label">{t('monitor.uptime')}</span><span>{formatDuration(summary.uptimeSeconds, units)}</span></div>
        {/if}
        {#if summary?.connections !== undefined}
          <div class="card">
            <span class="label">{t('monitor.connections')}</span>
            <span>{summary.connections.toLocaleString()}{summary.maxConnections === undefined ? '' : ` / ${summary.maxConnections.toLocaleString()}`}</span>
          </div>
        {/if}
        {#if summary?.rate !== undefined}
          <div class="card">
            <span class="label">{t(summary.rate.kind === 'queries' ? 'monitor.queriesPerSecond' : 'monitor.transactionsPerSecond')}</span>
            <span>{summary.rate.perSecond.toFixed(1)}</span>
          </div>
        {/if}
        {#if summary?.sizeBytes !== undefined}
          <div class="card"><span class="label">{t('monitor.size')}</span><span>{formatBytes(summary.sizeBytes)}</span></div>
        {/if}
      </section>

      <div class="tabs" role="tablist">
        {#if features.processes}
          <button type="button" role="tab" class="tab" aria-selected={tab === 'processes'} onclick={() => {
              open('processes');
            }}
            >{t('monitor.tab.processes', processes.length)}</button
          >
        {/if}
        <button type="button" role="tab" class="tab" aria-selected={tab === 'settings'} onclick={() => {
              open('settings');
            }}
          >{t('monitor.tab.settings')}</button
        >
        <button type="button" role="tab" class="tab" aria-selected={tab === 'status'} onclick={() => {
              open('status');
            }}
          >{t('monitor.tab.status')}</button
        >
      </div>

      {#if errors[tab] !== undefined}
        <p class="error" role="alert">{errors[tab]}</p>
      {/if}

      {#if tab === 'processes'}
        <div class="toolbar">
          <input class="control filter" bind:value={processFilter} placeholder={t('monitor.filter')} aria-label={t('monitor.filter')} />
          <label class="inline"><input type="checkbox" bind:checked={hideIdle} /> {t('monitor.hideIdle')}</label>
          <span class="grow"></span>
          {#if features.cancel}
            <button type="button" class="button secondary" disabled={!canStop} onclick={() => void stop('cancel')}>{t('monitor.cancel')}</button>
          {/if}
          {#if features.terminate}
            <button type="button" class="button secondary" disabled={!canStop} onclick={() => void stop('terminate')}>{t('monitor.terminate')}</button>
          {/if}
        </div>
        {#if page.readOnly}
          <p class="hint">{t('monitor.readOnly')}</p>
        {/if}
        <div class="table">
          <table data-testid="processes">
            <thead>
              <tr>
                {#each COLUMNS as entry (entry.column)}
                  <th aria-sort={sort.column === entry.column ? (sort.descending ? 'descending' : 'ascending') : 'none'}>
                    <button type="button" class="sort" onclick={() => (sort = nextSort(sort, entry.column))}>
                      {t(entry.key)}{sort.column === entry.column ? (sort.descending ? ' ▾' : ' ▴') : ''}
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
                  <td>{row.id}{#if row.mine}<span class="mine">{t('monitor.mine')}</span>{/if}</td>
                  <td>{row.user ?? ''}</td>
                  <td>{row.host ?? ''}</td>
                  <td>{row.database ?? ''}</td>
                  <td>
                    {row.state ?? ''}
                    {#if row.blockedBy !== undefined}<span class="blocked">{t('monitor.blockedBy', row.blockedBy)}</span>{/if}
                  </td>
                  <td class="number">{row.seconds === undefined ? '' : formatDuration(row.seconds, units)}</td>
                  <td class="query" title={row.query ?? ''}>{row.query ?? ''}</td>
                </tr>
              {/each}
            </tbody>
          </table>
          {#if shownProcesses.length === 0}
            <p class="hint">{processes.length === 0 ? t('monitor.noProcesses') : t('monitor.nothing')}</p>
          {/if}
        </div>
        {#if chosen !== undefined}
          <section class="details" data-testid="details">
            <p class="hint">
              {t('monitor.process', chosen.id)}
              {#if chosen.application !== undefined}· {chosen.application}{/if}
              {#if chosen.blockedBy !== undefined}· {t('monitor.blockedBy', chosen.blockedBy)}{/if}
            </p>
            <pre>{chosen.query ?? t('monitor.noQuery')}</pre>
          </section>
        {/if}
      {:else if tab === 'settings'}
        <div class="toolbar">
          {#if features.scopes.length > 1}
            <div class="scopes" role="radiogroup" aria-label={t('monitor.scope')}>
              {#each features.scopes as one (one)}
                <label class="inline">
                  <input type="radio" name="scope" checked={scope === one} onchange={() => void loadSettings(one)} />
                  {one === 'session' ? t('monitor.scope.session') : t(SCOPE_KEYS[features.serverScope])}
                </label>
              {/each}
            </div>
          {/if}
          <input class="control filter" bind:value={settingFilter} placeholder={t('monitor.filter')} aria-label={t('monitor.filter')} />
          {#if anyChanged}
            <label class="inline"><input type="checkbox" bind:checked={changedOnly} /> {t('monitor.changedOnly')}</label>
          {/if}
        </div>
        <div class="table">
          <table data-testid="settings">
            <thead>
              <tr><th>{t('monitor.column.name')}</th><th>{t('monitor.column.value')}</th><th>{t('monitor.column.description')}</th></tr>
            </thead>
            <tbody>
              {#each shownSettings as row (row.name)}
                <tr class:changed={row.changed === true}>
                  <td>{row.name}</td>
                  <td class="value">{row.value}{row.unit === undefined ? '' : ` ${row.unit}`}</td>
                  <td class="description">{row.description ?? ''}</td>
                </tr>
              {/each}
            </tbody>
          </table>
          {#if settingsLoaded && shownSettings.length === 0}
            <p class="hint">{t('monitor.nothing')}</p>
          {/if}
        </div>
      {:else}
        <div class="toolbar">
          <input class="control filter" bind:value={statusFilter} placeholder={t('monitor.filter')} aria-label={t('monitor.filter')} />
          <label class="inline"><input type="checkbox" bind:checked={changingOnly} /> {t('monitor.changingOnly')}</label>
        </div>
        <div class="table">
          <table data-testid="status">
            <thead>
              <tr>
                {#if grouped}<th>{t('monitor.column.group')}</th>{/if}
                <th>{t('monitor.column.name')}</th>
                <th>{t('monitor.column.value')}</th>
                <th>{t('monitor.column.perSecond')}</th>
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
            <p class="hint">{t('monitor.nothing')}</p>
          {/if}
        </div>
      {/if}
    {/if}
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
  }
  .bar,
  .toolbar,
  .tabs,
  .scopes {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
  }
  h1 {
    font-size: 1.2em;
    margin: 0;
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
    white-space: pre-wrap;
  }
  .inline {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .interval {
    width: auto;
  }
  .filter {
    max-width: 320px;
  }
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 8px;
  }
  .cards:empty {
    display: none;
  }
  .card {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px 8px;
    border: 1px solid var(--vscode-panel-border, var(--vscode-focusBorder));
  }
  .label {
    color: var(--vscode-descriptionForeground);
    font-size: 0.9em;
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
  .tab[aria-selected='true'] {
    border-bottom-color: var(--vscode-focusBorder);
  }
  .table {
    flex: 1;
    min-height: 0;
    overflow: auto;
    border: 1px solid var(--vscode-panel-border, transparent);
  }
  table {
    border-collapse: collapse;
    width: 100%;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.9em;
  }
  th,
  td {
    text-align: left;
    padding: 2px 8px;
    border-bottom: 1px solid var(--vscode-panel-border, transparent);
    white-space: nowrap;
    max-width: 420px;
    overflow: hidden;
    text-overflow: ellipsis;
    user-select: text;
  }
  th {
    position: sticky;
    top: 0;
    background: var(--vscode-editor-background);
    color: var(--vscode-descriptionForeground);
    font-weight: normal;
  }
  .sort {
    font: inherit;
    color: inherit;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
  }
  tbody tr {
    cursor: default;
  }
  tr.idle td {
    color: var(--vscode-descriptionForeground);
  }
  tr.chosen td {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
  }
  tr.changed td:first-child {
    font-weight: 600;
  }
  .number {
    text-align: right;
  }
  .query {
    max-width: 600px;
  }
  .description {
    white-space: normal;
    color: var(--vscode-descriptionForeground);
    min-width: 240px;
  }
  .value {
    white-space: pre-wrap;
    word-break: break-all;
  }
  .group {
    color: var(--vscode-descriptionForeground);
  }
  .rate {
    color: var(--vscode-charts-blue, var(--vscode-foreground));
  }
  .mine {
    margin-left: 6px;
    color: var(--vscode-descriptionForeground);
  }
  .blocked {
    margin-left: 6px;
    color: var(--vscode-errorForeground);
  }
  .details {
    flex: none;
    max-height: 30vh;
    overflow: auto;
  }
  pre {
    margin: 4px 0 0;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: var(--vscode-editor-font-family, monospace);
    user-select: text;
  }
</style>

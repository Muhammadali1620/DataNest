<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import type { ToolsProtocol } from '../../../../src/shared/protocols/tools';
  import type { RpcPeer } from '../../../../src/shared/rpc';
  import {
    filterProcesses,
    formatCpu,
    formatMemory,
    formatRuntime,
    type ProcessInfo,
    type ProcessSortKey,
    sortProcesses,
  } from '../../../../src/shared/tools/processes';
  import Icon from '../../components/Icon.svelte';
  import IconButton from '../../components/IconButton.svelte';
  import type { Translate } from '../../lib/i18n';
  import Card from './Card.svelte';
  import { useToolsState } from './state';

  interface Props {
    rpc: RpcPeer<ToolsProtocol['webview'], ToolsProtocol['host']>;
    t: Translate;
  }

  const { rpc, t }: Props = $props();
  const remember = useToolsState();

  const KEYS: readonly ProcessSortKey[] = ['name', 'cpu', 'memory', 'user', 'pid', 'runtime', 'command'];
  const REFRESH = [0, 5, 10, 30] as const;
  const ROW = 30;
  const VIEW = 520;

  let items = $state<ProcessInfo[]>([]);
  let platform = $state('');
  let currentUser = $state('');
  let truncated = $state(false);
  let loaded = $state(false);
  let loading = $state(false);
  let failed = $state(false);
  let message = $state<{ kind: 'ok' | 'error'; text: string } | undefined>(undefined);

  let query = $state(remember.get('tasks.query', ''));
  let onlyMine = $state(remember.get('tasks.onlyMine', false));
  const savedKey = remember.get('tasks.sort', 'cpu');
  let sortKey = $state<ProcessSortKey>(KEYS.find((key) => key === savedKey) ?? 'cpu');
  let descending = $state(remember.get('tasks.desc', true));
  let every = $state<number>(remember.get('tasks.every', 0));
  let scrollTop = $state(0);

  $effect(() => {
    remember.set('tasks.query', query);
    remember.set('tasks.onlyMine', onlyMine);
    remember.set('tasks.sort', sortKey);
    remember.set('tasks.desc', descending);
    remember.set('tasks.every', every);
  });

  const shown = $derived(
    sortProcesses(
      filterProcesses(items, { query, onlyUser: onlyMine ? currentUser : undefined }),
      sortKey,
      descending,
    ),
  );
  const first = $derived(Math.max(0, Math.floor(scrollTop / ROW) - 6));
  const last = $derived(Math.min(shown.length, Math.ceil((scrollTop + VIEW) / ROW) + 6));
  const windowed = $derived(shown.slice(first, last));
  const canForce = $derived(platform !== 'win32');

  async function refresh(): Promise<void> {
    if (loading) {
      return;
    }
    loading = true;
    try {
      const answer = await rpc.request('processes', {});
      failed = answer.error !== undefined;
      if (!failed) {
        items = answer.items;
        platform = answer.platform;
        currentUser = answer.currentUser;
        truncated = answer.truncated;
      }
      loaded = true;
    } catch {
      failed = true;
      loaded = true;
    } finally {
      loading = false;
    }
  }

  function sortBy(key: ProcessSortKey): void {
    if (sortKey === key) {
      descending = !descending;
    } else {
      sortKey = key;
      // Numbers read best biggest-first; names and commands from A.
      descending = key === 'cpu' || key === 'memory' || key === 'runtime';
    }
  }

  async function end(item: ProcessInfo, force: boolean): Promise<void> {
    message = undefined;
    try {
      const answer = await rpc.request('killProcess', { pid: item.pid, name: item.name, force });
      if (answer.ok) {
        message = { kind: 'ok', text: t('tools.tasks.ended', item.name, item.pid) };
        setTimeout(() => {
          void refresh();
        }, 400);
      } else if (answer.error !== 'cancelled') {
        message = {
          kind: 'error',
          text: t(`tools.tasks.error.${answer.error ?? 'failed'}`, item.name, item.pid),
        };
      }
    } catch {
      message = { kind: 'error', text: t('tools.tasks.error.failed', item.name, item.pid) };
    }
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  $effect(() => {
    clearInterval(timer);
    timer = every > 0 ? setInterval(() => void refresh(), every * 1000) : undefined;
  });

  onMount(() => {
    void refresh();
  });

  onDestroy(() => {
    clearInterval(timer);
  });

  const HEADERS: readonly { key: ProcessSortKey; label: string; right?: boolean }[] = [
    { key: 'name', label: 'tools.tasks.process' },
    { key: 'cpu', label: 'tools.tasks.cpu', right: true },
    { key: 'memory', label: 'tools.tasks.memory', right: true },
    { key: 'user', label: 'tools.tasks.user' },
    { key: 'pid', label: 'tools.tasks.pid', right: true },
    { key: 'runtime', label: 'tools.tasks.runtime', right: true },
    { key: 'command', label: 'tools.tasks.command' },
  ];
</script>

<Card title={t('tools.tasks')} icon="server-process" tone="red">
  {#snippet actions()}
    <IconButton icon="refresh" tone="teal" label={t('tools.refresh')} spin={loading} data-testid="tasks-refresh" onclick={() => { void refresh(); }} />
  {/snippet}
  <div class="bar">
    <span class="muted small">{t('tools.tasks.platform')} <strong data-testid="tasks-platform">{platform === '' ? '-' : platform}</strong></span>
    <span class="muted small">{t('tools.tasks.currentUser')} <strong data-testid="tasks-user">{currentUser === '' ? '-' : currentUser}</strong></span>
    <input class="control search" type="search" placeholder={t('tools.tasks.search')} aria-label={t('tools.tasks.search')} bind:value={query} data-testid="tasks-search" />
    <label class="tl-check">
      <input type="checkbox" bind:checked={onlyMine} data-testid="tasks-mine" />{t('tools.tasks.onlyMine')}
    </label>
    <label class="auto">
      <span class="muted small">{t('tools.tasks.auto')}</span>
      <select class="control" bind:value={every} data-testid="tasks-every">
        {#each REFRESH as seconds (seconds)}
          <option value={seconds}>{seconds === 0 ? t('tools.tasks.autoOff') : t('tools.tasks.autoEvery', seconds)}</option>
        {/each}
      </select>
    </label>
  </div>

  {#if message !== undefined}
    <p class={message.kind === 'ok' ? 'notice success' : 'notice error'} role="status" data-testid="tasks-message">
      <Icon name={message.kind === 'ok' ? 'pass' : 'error'} size={14} />{message.text}
    </p>
  {/if}
  {#if failed}
    <p class="notice error" role="alert" data-testid="tasks-failed"><Icon name="error" size={14} />{t('tools.tasks.failed')}</p>
  {/if}

  <div class="table" role="table" aria-label={t('tools.tasks')} aria-rowcount={shown.length + 1} data-testid="tasks-table">
    <div class="row head" role="row">
      {#each HEADERS as header (header.key)}
        <div role="columnheader" aria-sort={sortKey === header.key ? (descending ? 'descending' : 'ascending') : 'none'} class:right={header.right} class={`c-${header.key}`}>
          <button type="button" class="sort" data-testid={`sort-${header.key}`} onclick={() => { sortBy(header.key); }}>
            {t(header.label as 'tools.tasks.process')}
            {#if sortKey === header.key}<Icon name={descending ? 'arrow-down' : 'arrow-up'} size={11} />{/if}
          </button>
        </div>
      {/each}
      <div role="columnheader" class="c-act"><span class="sr-only">{t('tools.tasks.actions')}</span></div>
    </div>
    <div class="body" style="height: {Math.min(VIEW, Math.max(shown.length, 1) * ROW)}px;" onscroll={(event) => { scrollTop = event.currentTarget.scrollTop; }} role="rowgroup" tabindex="-1">
      <div class="space" style="height: {shown.length * ROW}px;">
        <div class="slice" style="transform: translateY({first * ROW}px);">
          {#each windowed as item (item.pid)}
            <div class="row" role="row" data-pid={item.pid} style="height: {ROW}px;">
              <div role="cell" class="c-name" title={item.name}>{item.name}</div>
              <div role="cell" class="c-cpu right">{formatCpu(item)}</div>
              <div role="cell" class="c-memory right">{formatMemory(item.memoryKb)}</div>
              <div role="cell" class="c-user" title={item.user}>{item.user === '' ? '-' : item.user}</div>
              <div role="cell" class="c-pid right">{item.pid}</div>
              <div role="cell" class="c-runtime right">{formatRuntime(item.runtimeSec)}</div>
              <div role="cell" class="c-command tl-mono" title={item.command}>{item.command}</div>
              <div role="cell" class="c-act">
                <IconButton icon="debug-stop" tone="orange" label={t('tools.tasks.end', item.name)} data-testid={`end-${item.pid}`} onclick={() => { void end(item, false); }} />
                {#if canForce}
                  <IconButton icon="trash" tone="red" label={t('tools.tasks.force', item.name)} data-testid={`force-${item.pid}`} onclick={() => { void end(item, true); }} />
                {/if}
              </div>
            </div>
          {/each}
        </div>
      </div>
    </div>
  </div>
  {#if loaded && shown.length === 0 && !failed}
    <p class="muted" data-testid="tasks-empty">{t('tools.tasks.none')}</p>
  {/if}
  <p class="muted small" data-testid="tasks-count">
    {t('tools.tasks.count', shown.length, items.length)}{#if truncated} · {t('tools.tasks.truncated')}{/if}
  </p>
</Card>

<style>
  .bar {
    display: flex;
    flex-wrap: wrap;
    gap: 10px 16px;
    align-items: center;
  }

  .search {
    flex: 1;
    min-width: 200px;
  }

  .auto {
    display: inline-flex;
    gap: 6px;
    align-items: center;
  }

  .table {
    overflow: hidden;
    border: 1px solid var(--dn-divider);
    border-radius: 10px;
  }

  .row {
    display: grid;
    grid-template-columns: minmax(120px, 1.1fr) 80px 96px minmax(80px, 0.8fr) 70px 100px minmax(160px, 2.4fr) 72px;
    gap: 8px;
    align-items: center;
    padding: 0 10px;
    font-size: var(--dn-font-small);
  }

  .row > div {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .row:not(.head):hover {
    background: var(--dn-hover);
  }

  .head {
    height: 32px;
    color: var(--dn-muted);
    background: var(--dn-surface);
    border-bottom: 1px solid var(--dn-divider);
  }

  .right {
    text-align: right;
  }

  .sort {
    padding: 0;
    color: inherit;
    font: inherit;
    font-weight: 600;
    background: none;
    border: none;
    cursor: pointer;
  }

  .sort:hover {
    color: var(--vscode-foreground);
  }

  .body {
    overflow-y: auto;
  }

  .space {
    position: relative;
  }

  .slice {
    position: absolute;
    inset: 0 0 auto;
  }

  .c-act {
    display: inline-flex;
    gap: 2px;
    justify-content: flex-end;
  }
</style>

<script lang="ts">
  import { onMount } from 'svelte';
  import type {
    ManagerProtocol,
    ManagerSection,
    ManagerState,
  } from '../../../../src/shared/protocols/manager';
  import type { RpcPeer } from '../../../../src/shared/rpc';
  import type { TableAction } from '../../../../src/shared/table-actions';
  import Icon from '../../components/Icon.svelte';
  import TableBar from '../../components/TableBar.svelte';
  import type { Translate } from '../../lib/i18n';
  import DumpSection from './DumpSection.svelte';
  import LogSection from './LogSection.svelte';
  import MonitorSection from './MonitorSection.svelte';
  import { SECTION_LOOK, sectionAfterKey } from './sections';
  import SyncSection from './SyncSection.svelte';

  interface Props {
    rpc: RpcPeer<ManagerProtocol['webview'], ManagerProtocol['host']>;
    t: Translate;
  }

  const { rpc, t }: Props = $props();

  let page = $state<ManagerState | undefined>(undefined);
  let section = $state<ManagerSection>('log');
  const buttons = $state<Record<string, HTMLButtonElement | undefined>>({});

  function navigate(action: TableAction): void {
    rpc.emit('tableNav', { action, dirty: false });
  }

  function open(next: ManagerSection): void {
    section = next;
  }

  function keydown(event: KeyboardEvent): void {
    if (page === undefined) {
      return;
    }
    const next = sectionAfterKey(page.sections, section, event.key);
    if (next !== undefined) {
      event.preventDefault();
      open(next);
      buttons[next]?.focus();
    }
  }

  onMount(() => {
    const subscription = rpc.on('state', (next) => {
      page = next;
      section = next.section;
    });
    rpc.emit('ready', {});
    return () => {
      subscription.dispose();
    };
  });
</script>

<main>
  {#if page === undefined}
    <div class="empty" role="status">
      <Icon name="loading" size={20} spin />
      <p class="empty-title">{t('manager.loading')}</p>
    </div>
  {:else}
    <header class="top">
      <span class="top-icon"><Icon name="dashboard" size={18} /></span>
      <div class="top-text">
        <h1>{t('manager.title')}</h1>
        <p class="muted small">
          {page.connectionName}
          {#if page.production}<span class="badge danger">{t('manager.production')}</span>{/if}
          {#if page.readOnly}<span class="badge outline">{t('manager.readOnly')}</span>{/if}
        </p>
      </div>
    </header>

    {#if page.table !== undefined}
      <TableBar
        active="manager"
        isView={page.table.kind === 'view'}
        {t}
        onAction={navigate}
      />
    {/if}

    <div class="body">
      <div
        class="nav"
        role="tablist"
        aria-orientation="vertical"
        aria-label={t('manager.sections')}
      >
        {#each page.sections as id (id)}
          {@const look = SECTION_LOOK[id]}
          <button
            type="button"
            role="tab"
            id="manager-tab-{id}"
            class="nav-item"
            aria-selected={section === id}
            aria-controls="manager-panel"
            tabindex={section === id ? 0 : -1}
            bind:this={buttons[id]}
            onkeydown={keydown}
            onclick={() => {
              open(id);
            }}
          >
            <Icon name={look.icon} tone={look.tone} />
            <span>{t(look.label)}</span>
          </button>
        {/each}
      </div>

      <div
        class="content"
        id="manager-panel"
        role="tabpanel"
        aria-labelledby="manager-tab-{section}"
      >
        {#key section}
          {#if section === 'log'}
            <LogSection {rpc} {t} />
          {:else if section === 'dashboard'}
            <MonitorSection {rpc} {t} only="status" />
          {:else if section === 'processes'}
            <MonitorSection {rpc} {t} only="processes" />
          {:else if section === 'dump'}
            <DumpSection {rpc} {t} />
          {:else}
            <SyncSection {rpc} {t} {page} />
          {/if}
        {/key}
      </div>
    </div>

    <footer class="status">
      <span><Icon name="plug" size={12} />{page.connectionName}</span>
      {#if page.database !== undefined}<span><Icon name="database" size={12} />{page.database}</span>{/if}
      {#if page.schema !== undefined}<span><Icon name="symbol-structure" size={12} />{page.schema}</span>{/if}
      {#if page.table !== undefined}<span><Icon name="table" size={12} />{page.table.name}</span>{/if}
    </footer>
  {/if}
</main>

<style>
  main {
    display: flex;
    flex-direction: column;
    height: 100vh;
  }

  .top {
    display: flex;
    flex: none;
    gap: var(--dn-gap-m);
    align-items: center;
    padding: var(--dn-gap-m) var(--dn-gap-l);
    border-bottom: 1px solid var(--dn-divider);
  }

  .top-icon {
    display: inline-flex;
    padding: 7px;
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
    border-radius: var(--dn-radius-l);
  }

  h1 {
    margin: 0;
    font-size: 14px;
  }

  .top-text p {
    display: flex;
    gap: 6px;
    align-items: center;
    margin: 0;
  }

  .body {
    display: flex;
    flex: 1;
    min-height: 0;
  }

  .nav {
    display: flex;
    flex: none;
    flex-direction: column;
    gap: 2px;
    width: 176px;
    padding: var(--dn-gap);
    border-right: 1px solid var(--dn-divider);
  }

  .nav-item {
    display: flex;
    gap: 10px;
    align-items: center;
    padding: 7px 10px;
    color: var(--vscode-foreground);
    text-align: left;
    background: transparent;
    border: 0;
    border-radius: var(--dn-radius-l);
    cursor: pointer;
    transition:
      background-color var(--dn-duration),
      color var(--dn-duration);
  }

  .nav-item:hover {
    background: var(--dn-hover);
  }

  .nav-item[aria-selected='true'] {
    color: var(--vscode-list-activeSelectionForeground);
    background: var(--vscode-list-activeSelectionBackground);
  }

  .content {
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
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

  .status span {
    display: inline-flex;
    gap: 4px;
    align-items: center;
  }

  @media (max-width: 560px) {
    .nav {
      width: 44px;
    }

    .nav-item span {
      display: none;
    }
  }
</style>

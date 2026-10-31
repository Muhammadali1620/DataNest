<script lang="ts">
  import type { TableAction } from '../../../../src/shared/table-actions';
  import Icon from '../../components/Icon.svelte';
  import IconButton from '../../components/IconButton.svelte';
  import MenuButton from '../../components/MenuButton.svelte';
  import type { CodiconName } from '../../lib/codicons';
  import type { MessageKey } from '../../l10n/en';
  import type { Translate } from '../../lib/i18n';

  interface Props {
    onAction: (action: TableAction) => void;
    t: Translate;
    /** A database view: the tools that only make sense for a table are left out. */
    isView?: boolean;
  }

  const { onAction, t, isView = false }: Props = $props();

  // Tabs that open another page for the same table, then the one that is this page.
  const TABS: readonly { id: TableAction | 'data'; icon: CodiconName; key: MessageKey; hint: MessageKey }[] = [
    { id: 'properties', icon: 'symbol-property', key: 'tableBar.properties', hint: 'tableBar.properties.hint' },
    { id: 'data', icon: 'table', key: 'tableBar.data', hint: 'tableBar.data.hint' },
    { id: 'er', icon: 'type-hierarchy', key: 'tableBar.er', hint: 'tableBar.er.hint' },
    { id: 'generate', icon: 'beaker', key: 'tableBar.generate', hint: 'tableBar.generate.hint' },
    { id: 'compare', icon: 'diff', key: 'tableBar.compare', hint: 'tableBar.compare.hint' },
  ];

  const MORE = ['ddl', 'dump', 'transfer'] as const;
  const MORE_KEYS: Record<(typeof MORE)[number], MessageKey> = {
    ddl: 'tableBar.ddl',
    dump: 'tableBar.dump',
    transfer: 'tableBar.transfer',
  };
  const MORE_ICONS: Record<(typeof MORE)[number], CodiconName> = {
    ddl: 'code',
    dump: 'save',
    transfer: 'arrow-swap',
  };
  /** What a view cannot do: its rows are not its own to compare, fill or move. */
  const TABLE_ONLY = new Set<string>(['er', 'generate', 'compare', 'transfer']);
  const tabs = $derived(TABS.filter((tab) => !isView || !TABLE_ONLY.has(tab.id)));
  const more = $derived(MORE.filter((action) => !isView || !TABLE_ONLY.has(action)));
</script>

<div class="table-bar" role="toolbar" aria-label={t('tableBar.label')} data-testid="table-bar">
  {#each tabs as tab (tab.id)}
    {#if tab.id === 'data'}
      <span class="chip active" aria-current="page" data-testid="table-tab-data">
        <Icon name={tab.icon} size={14} />{t(tab.key)}
      </span>
    {:else}
      <button
        type="button"
        class="chip"
        data-testid={`table-tab-${tab.id}`}
        title={t(tab.hint)}
        onclick={() => {
          onAction(tab.id as TableAction);
        }}
      >
        <Icon name={tab.icon} size={14} />{t(tab.key)}
      </button>
    {/if}
  {/each}
  <MenuButton
    icon="ellipsis"
    label={t('tableBar.more')}
    testid="table-more"
    align="start"
    items={more.map((action) => ({
      id: action,
      label: t(MORE_KEYS[action]),
      icon: MORE_ICONS[action],
    }))}
    onSelect={(action: TableAction) => {
      onAction(action);
    }}
  />
  <IconButton
    icon="history"
    tone="purple"
    label={t('tableBar.history')}
    hint={t('tableBar.historyHint')}
    data-testid="table-history"
    onclick={() => {
      onAction('history');
    }}
  />
</div>

<style>
  .table-bar {
    display: flex;
    flex: none;
    gap: 6px;
    align-items: center;
    height: 40px;
    padding: 0 10px;
    overflow-x: auto;
    border-bottom: 1px solid var(--dn-divider);
    scrollbar-width: none;
  }

  .chip {
    display: inline-flex;
    flex: none;
    gap: 6px;
    align-items: center;
    height: 28px;
    padding: 0 12px 0 10px;
    color: var(--vscode-panelTitle-inactiveForeground, var(--dn-muted));
    background: transparent;
    border: 1px solid transparent;
    border-radius: 14px;
    font-family: inherit;
    font-size: inherit;
    white-space: nowrap;
    cursor: pointer;
  }

  .chip:hover {
    color: var(--vscode-panelTitle-activeForeground, var(--vscode-foreground));
    background: var(--dn-hover);
  }

  .chip.active {
    color: var(--vscode-panelTitle-activeForeground, var(--vscode-foreground));
    background: color-mix(in srgb, var(--dn-accent) 18%, transparent);
    border-color: color-mix(in srgb, var(--dn-accent) 55%, transparent);
    cursor: default;
  }

  .chip:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: 1px;
  }
</style>

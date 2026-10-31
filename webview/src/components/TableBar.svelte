<script lang="ts">
  import type { TableAction, TablePage } from '../../../src/shared/table-actions';
  import type { MessageKey } from '../l10n/en';
  import type { CodiconName } from '../lib/codicons';
  import type { Translate } from '../lib/i18n';
  import Icon from './Icon.svelte';
  import IconButton from './IconButton.svelte';
  import type { Tone } from './tone';

  interface Props {
    /** The page this bar sits on: its button is lit and does nothing. */
    active: TablePage;
    onAction: (action: TableAction) => void;
    t: Translate;
    /** A database view: the tools that only make sense for a table are left out. */
    isView?: boolean;
  }

  const { active, onAction, t, isView = false }: Props = $props();

  const TABS: readonly { id: TablePage; icon: CodiconName; tone: Tone; key: MessageKey; hint: MessageKey }[] = [
    { id: 'properties', icon: 'symbol-property', tone: 'purple', key: 'tableBar.properties', hint: 'tableBar.properties.hint' },
    { id: 'data', icon: 'table', tone: 'blue', key: 'tableBar.data', hint: 'tableBar.data.hint' },
    { id: 'er', icon: 'type-hierarchy', tone: 'pink', key: 'tableBar.er', hint: 'tableBar.er.hint' },
    { id: 'generate', icon: 'beaker', tone: 'yellow', key: 'tableBar.generate', hint: 'tableBar.generate.hint' },
    { id: 'compare', icon: 'diff', tone: 'orange', key: 'tableBar.compare', hint: 'tableBar.compare.hint' },
    { id: 'manager', icon: 'tools', tone: 'teal', key: 'tableBar.manager', hint: 'tableBar.manager.hint' },
  ];

  /** What a view cannot do: its rows are not its own to compare or fill. */
  const TABLE_ONLY = new Set<TablePage>(['er', 'generate', 'compare']);
  const tabs = $derived(TABS.filter((tab) => !isView || !TABLE_ONLY.has(tab.id)));
</script>

<div class="table-bar" role="toolbar" aria-label={t('tableBar.label')} data-testid="table-bar">
  {#each tabs as tab (tab.id)}
    {#if tab.id === active}
      <span class="chip active" aria-current="page" data-testid={`table-tab-${tab.id}`}>
        <Icon name={tab.icon} size={14} tone={tab.tone} />{t(tab.key)}
      </span>
    {:else}
      <button
        type="button"
        class="chip"
        data-testid={`table-tab-${tab.id}`}
        title={t(tab.hint)}
        onclick={() => {
          onAction(tab.id);
        }}
      >
        <Icon name={tab.icon} size={14} tone={tab.tone} />{t(tab.key)}
      </button>
    {/if}
  {/each}
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
    flex-wrap: wrap;
    gap: 4px 6px;
    align-items: center;
    min-height: 40px;
    padding: 4px 10px;
    border-bottom: 1px solid var(--dn-divider);
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

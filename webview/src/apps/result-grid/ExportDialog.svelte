<script lang="ts">
  import Icon from '../../components/Icon.svelte';
  import IconButton from '../../components/IconButton.svelte';
  import type { CodiconName } from '../../lib/codicons';
  import type { Translate } from '../../lib/i18n';
  import type { ExportFormatId, ExportScope } from './export-options';


  interface Props {
    /** A table view can also export the whole table or the whole database. */
    wide: boolean;
    onExport: (scope: ExportScope, format: ExportFormatId) => void;
    onClose: () => void;
    t: Translate;
  }

  const { wide, onExport, onClose, t }: Props = $props();

  const FORMATS: readonly { id: ExportFormatId; label: string }[] = [
    { id: 'xlsx', label: 'XLSX' },
    { id: 'csv', label: 'CSV' },
    { id: 'json', label: 'JSON' },
    { id: 'sql', label: 'SQL' },
    { id: 'markdown', label: 'Markdown' },
  ];
  const SCOPES: readonly { id: ExportScope; icon: CodiconName }[] = [
    { id: 'result', icon: 'filter' },
    { id: 'table', icon: 'table' },
    { id: 'database', icon: 'database' },
  ];

  let scope = $state<ExportScope>('result');
  let format = $state<ExportFormatId>('xlsx');

  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  }
</script>

<div
  class="modal-backdrop fade-in"
  role="presentation"
  onpointerdown={(event) => {
    if (event.target === event.currentTarget) {
      onClose();
    }
  }}
  onkeydown={onKey}
>
  <div class="modal narrow" role="dialog" aria-modal="true" aria-label={t('export.title')} data-testid="export-dialog">
    <div class="modal-head">
      <span class="head-icon"><Icon name="export" size={18} /></span>
      <h2 class="modal-title">{t('export.title')}</h2>
      <IconButton icon="close" label={t('dialog.close')} onclick={onClose} />
    </div>

    {#if wide}
      <div class="choices" role="group" aria-label={t('export.scope')}>
        {#each SCOPES as item (item.id)}
          <button
            type="button"
            class="choice"
            aria-pressed={scope === item.id}
            data-testid={`export-scope-${item.id}`}
            onclick={() => {
              scope = item.id;
            }}
          >
            <Icon name={item.icon} size={18} />
            <span class="choice-text">
              <span>{t(`export.scope.${item.id}`)}</span>
              <span class="choice-hint">{t(`export.scope.${item.id}.hint`)}</span>
            </span>
          </button>
        {/each}
      </div>
    {/if}

    <div class="formats">
      <span class="label">{t('export.format')}</span>
      <div class="seg" role="group" aria-label={t('export.format')}>
        {#each FORMATS as item (item.id)}
          <button
            type="button"
            aria-pressed={format === item.id}
            data-testid={`export-format-${item.id}`}
            onclick={() => {
              format = item.id;
            }}
          >
            {item.label}
          </button>
        {/each}
      </div>
    </div>

    <div class="modal-foot">
      <button type="button" class="button secondary" onclick={onClose}>
        <Icon name="close" />{t('dialog.close')}
      </button>
      <button
        type="button"
        class="button"
        data-testid="export-run"
        onclick={() => {
          onExport(wide ? scope : 'result', format);
        }}
      >
        <Icon name="export" />{t('export.run')}
      </button>
    </div>
  </div>
</div>

<style>
  .narrow {
    width: min(520px, 100%);
  }

  .head-icon {
    display: inline-flex;
    color: var(--vscode-charts-green, var(--dn-success));
  }

  .choices {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .formats {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
  }

  .label {
    color: var(--dn-muted);
  }
</style>

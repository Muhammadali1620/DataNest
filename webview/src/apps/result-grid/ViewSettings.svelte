<script lang="ts">
  import Icon from '../../components/Icon.svelte';
  import IconButton from '../../components/IconButton.svelte';
  import type { Translate } from '../../lib/i18n';
  import {
    DEFAULT_VIEW,
    FONT_SIZES,
    GRID_ALIGNS,
    GRID_LINES,
    type GridView,
    ROW_HEIGHTS,
  } from './grid-view';

  interface Props {
    view: GridView;
    onChange: (next: GridView) => void;
    onClose: () => void;
    t: Translate;
  }

  const { view, onChange, onClose, t }: Props = $props();

  function set<K extends keyof GridView>(key: K, value: GridView[K]): void {
    onChange({ ...view, [key]: value });
  }

  const HEIGHT_NAMES = ['compact', 'normal', 'roomy'] as const;
</script>

<div class="popover fade-in" role="dialog" aria-label={t('view.title')} data-testid="view-settings">
  <div class="head">
    <Icon name="eye" size={16} />
    <h2>{t('view.title')}</h2>
    <span class="grow"></span>
    <IconButton
      icon="discard"
      tone="orange"
      label={t('view.reset')}
      onclick={() => {
        onChange(DEFAULT_VIEW);
      }}
    />
    <IconButton icon="close" label={t('dialog.close')} onclick={onClose} />
  </div>

  <div class="row">
    <span>{t('view.rowNumbers')}</span>
    <input
      type="checkbox"
      class="switch"
      checked={view.rowNumbers}
      aria-label={t('view.rowNumbers')}
      onchange={(event) => {
        set('rowNumbers', event.currentTarget.checked);
      }}
    />
  </div>
  <div class="row">
    <span>{t('view.checkboxes')}</span>
    <input
      type="checkbox"
      class="switch"
      checked={view.checkboxes}
      aria-label={t('view.checkboxes')}
      onchange={(event) => {
        set('checkboxes', event.currentTarget.checked);
      }}
    />
  </div>

  <div class="row">
    <span>{t('view.rowHeight')}</span>
    <div class="seg" role="group" aria-label={t('view.rowHeight')}>
      {#each ROW_HEIGHTS as height, index (height)}
        <button type="button" aria-pressed={view.rowHeight === height} onclick={() => { set('rowHeight', height); }}>
          {t(`view.height.${HEIGHT_NAMES[index] ?? 'normal'}`)}
        </button>
      {/each}
    </div>
  </div>

  <div class="row">
    <span>{t('view.fontSize')}</span>
    <div class="seg" role="group" aria-label={t('view.fontSize')}>
      {#each FONT_SIZES as size (size)}
        <button type="button" aria-pressed={view.fontSize === size} onclick={() => { set('fontSize', size); }}>
          {size}
        </button>
      {/each}
    </div>
  </div>

  <div class="row">
    <span>{t('view.align')}</span>
    <div class="seg" role="group" aria-label={t('view.align')}>
      {#each GRID_ALIGNS as align (align)}
        <button type="button" aria-pressed={view.align === align} onclick={() => { set('align', align); }}>
          {t(`view.align.${align}`)}
        </button>
      {/each}
    </div>
  </div>

  <div class="row">
    <span>{t('view.lines')}</span>
    <div class="seg" role="group" aria-label={t('view.lines')}>
      {#each GRID_LINES as lines (lines)}
        <button type="button" aria-pressed={view.lines === lines} onclick={() => { set('lines', lines); }}>
          {t(`view.lines.${lines}`)}
        </button>
      {/each}
    </div>
  </div>
</div>

<style>
  .popover {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 20;
    display: flex;
    flex-direction: column;
    gap: 10px;
    width: min(420px, 90vw);
    padding: 12px 14px;
    background: var(--dn-surface);
    border: 1px solid var(--dn-border);
    border-radius: 14px;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
  }

  .head {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  h2 {
    margin: 0;
    font-size: 13px;
  }

  .grow {
    flex: 1;
  }

  .row {
    display: flex;
    gap: 12px;
    align-items: center;
    justify-content: space-between;
  }

  .switch {
    display: block;
    width: 34px;
    height: 20px;
    margin: 0;
    border: none;
    cursor: pointer;
    appearance: none;
    background: color-mix(in srgb, var(--vscode-foreground) 22%, transparent);
    border-radius: 10px;
    transition: background-color var(--dn-duration) var(--dn-ease);
  }

  .switch::before {
    content: none;
  }

  .switch::after {
    display: block;
    width: 14px;
    height: 14px;
    margin: 3px;
    content: '';
    background: var(--vscode-foreground);
    border-radius: 50%;
    transition: transform var(--dn-duration) var(--dn-ease);
  }

  .switch:checked {
    background: var(--vscode-button-background);
  }

  .switch:checked::after {
    background: var(--vscode-button-foreground);
    transform: translateX(14px);
  }
</style>

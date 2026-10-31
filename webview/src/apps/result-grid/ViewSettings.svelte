<script lang="ts">
  import Icon from '../../components/Icon.svelte';
  import IconButton from '../../components/IconButton.svelte';
  import type { Translate } from '../../lib/i18n';
  import {
    DEFAULT_VIEW,
    FONT_SIZES,
    GRID_ALIGNS,
    GRID_FONTS,
    GRID_LAYOUTS,
    GRID_LINES,
    type GridView,
    MAX_ROW_HEIGHT,
    MIN_ROW_HEIGHT,
    ROW_HEIGHT_STEP,
  } from './grid-view';

  interface Props {
    view: GridView;
    onChange: (next: GridView) => void;
    /** Opens the columns menu (hide, pin, fit). */
    onColumns: () => void;
    onClose: () => void;
    t: Translate;
  }

  const { view, onChange, onColumns, onClose, t }: Props = $props();

  function set<K extends keyof GridView>(key: K, value: GridView[K]): void {
    onChange({ ...view, [key]: value });
  }

  function step(delta: number): void {
    set('rowHeight', Math.min(MAX_ROW_HEIGHT, Math.max(MIN_ROW_HEIGHT, view.rowHeight + delta)));
  }
</script>

<div class="popover fade-in" role="dialog" aria-label={t('view.title')} data-testid="view-settings" tabindex="-1">
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
    <span>{t('view.layout')}</span>
    <div class="seg" role="group" aria-label={t('view.layout')}>
      {#each GRID_LAYOUTS as layout (layout)}
        <button type="button" aria-pressed={view.layout === layout} onclick={() => { set('layout', layout); }}>
          {t(`view.layout.${layout}`)}
        </button>
      {/each}
    </div>
  </div>

  <h3>{t('view.cells')}</h3>
  <div class="row">
    <span>{t('view.rowNumbers')}</span>
    <input type="checkbox" class="switch" checked={view.rowNumbers} aria-label={t('view.rowNumbers')}
      onchange={(event) => { set('rowNumbers', event.currentTarget.checked); }} />
  </div>
  <div class="row">
    <span>{t('view.checkboxes')}</span>
    <input type="checkbox" class="switch" checked={view.checkboxes} aria-label={t('view.checkboxes')}
      onchange={(event) => { set('checkboxes', event.currentTarget.checked); }} />
  </div>
  <div class="row">
    <span>{t('view.rowHeight')}</span>
    <div class="stepper" role="group" aria-label={t('view.rowHeight')}>
      <IconButton icon="chevron-down" label={t('view.lower')} disabled={view.rowHeight <= MIN_ROW_HEIGHT}
        onclick={() => { step(-ROW_HEIGHT_STEP); }} />
      <output data-testid="row-height">{view.rowHeight}</output>
      <IconButton icon="chevron-up" label={t('view.taller')} disabled={view.rowHeight >= MAX_ROW_HEIGHT}
        onclick={() => { step(ROW_HEIGHT_STEP); }} />
    </div>
  </div>
  <div class="row">
    <span>{t('view.columns')}</span>
    <button type="button" class="button secondary" data-testid="view-columns" onclick={() => { onClose(); onColumns(); }}>
      <Icon name="list-selection" />{t('view.columnsButton')}
    </button>
  </div>

  <h3>{t('view.tools')}</h3>
  <div class="row">
    <span>{t('view.draggable')}</span>
    <input type="checkbox" class="switch" checked={view.draggableColumns} aria-label={t('view.draggable')}
      onchange={(event) => { set('draggableColumns', event.currentTarget.checked); }} />
  </div>
  <div class="row">
    <span>{t('view.showTime')}</span>
    <input type="checkbox" class="switch" checked={view.showTime} aria-label={t('view.showTime')}
      onchange={(event) => { set('showTime', event.currentTarget.checked); }} />
  </div>

  <h3>{t('view.style')}</h3>
  <div class="row">
    <span>{t('view.fontSize')}</span>
    <div class="seg" role="group" aria-label={t('view.fontSize')}>
      {#each FONT_SIZES as size (size)}
        <button type="button" aria-pressed={view.fontSize === size} onclick={() => { set('fontSize', size); }}>{size}</button>
      {/each}
    </div>
  </div>
  <div class="row">
    <span>{t('view.font')}</span>
    <div class="seg" role="group" aria-label={t('view.font')}>
      {#each GRID_FONTS as font (font)}
        <button type="button" aria-pressed={view.font === font} onclick={() => { set('font', font); }}>
          {t(`view.font.${font}`)}
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
    width: min(460px, 92vw);
    max-height: 80vh;
    overflow: auto;
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

  h3 {
    margin: 4px 0 -2px;
    color: var(--dn-muted);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .stepper {
    display: inline-flex;
    gap: 6px;
    align-items: center;
  }

  .stepper output {
    min-width: 28px;
    text-align: center;
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

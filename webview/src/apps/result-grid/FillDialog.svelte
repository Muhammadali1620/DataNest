<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import Icon from '../../components/Icon.svelte';
  import IconButton from '../../components/IconButton.svelte';
  import type { Translate } from '../../lib/i18n';
  import { DATE_UNITS, type FillSpec, seriesTexts } from '../../../../src/shared/cell-fill';

  type Mode = 'value' | 'null' | 'default' | 'down' | 'series' | 'dates';

  interface Props {
    /** Rows and columns the fill covers, for the title. */
    rows: number;
    columns: number;
    /** Applies the fill; resolves to the reason it failed, or a note when some cells were skipped. */
    onFill: (fill: FillSpec) => Promise<string | undefined>;
    onClose: () => void;
    t: Translate;
  }

  const { rows, columns, onFill, onClose, t }: Props = $props();

  const MODES: readonly Mode[] = ['value', 'null', 'default', 'down', 'series', 'dates'];
  const today = new Date().toISOString().slice(0, 10);

  // Only the first selection decides the starting mode; the dialog keeps what the user picks.
  let mode = $state<Mode>(untrack(() => (rows > 1 ? 'series' : 'value')));
  let text = $state('');
  let start = $state('1');
  let step = $state('1');
  let template = $state('{n}');
  let pad = $state(0);
  let dateStart = $state(today);
  let dateStep = $state(1);
  let unit = $state<(typeof DATE_UNITS)[number]>('day');
  let problem = $state<string | undefined>(undefined);
  let busy = $state(false);
  let box = $state<HTMLElement | undefined>(undefined);

  onMount(() => {
    box?.querySelector<HTMLElement>('select, input')?.focus();
  });

  const spec = $derived<FillSpec>(
    mode === 'value'
      ? { kind: 'value', input: { kind: 'text', text } }
      : mode === 'null'
        ? { kind: 'value', input: { kind: 'null' } }
        : mode === 'default'
          ? { kind: 'value', input: { kind: 'default' } }
          : mode === 'down'
            ? { kind: 'down' }
            : mode === 'series'
              ? { kind: 'series', start, step, template, pad: Math.max(0, Math.trunc(pad) || 0) }
              : { kind: 'dates', start: dateStart, step: Math.trunc(dateStep) || 0, unit },
  );

  /** The first values of a series, so the user sees what they are about to write. */
  const preview = $derived.by((): string | undefined => {
    if (spec.kind !== 'series' && spec.kind !== 'dates') {
      return undefined;
    }
    const made = seriesTexts(spec, Math.min(rows, 5));
    if (!made.ok) {
      return t(`grid.editError.${made.problem}`);
    }
    return made.texts.join(', ') + (rows > 5 ? ', …' : '');
  });

  async function apply(): Promise<void> {
    if (busy) {
      return;
    }
    busy = true;
    problem = undefined;
    problem = await onFill(spec);
    busy = false;
    if (problem === undefined) {
      onClose();
    }
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (event.key === 'Enter' && !(event.target instanceof HTMLSelectElement)) {
      event.preventDefault();
      void apply();
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
  <div class="modal" role="dialog" aria-modal="true" aria-label={t('fill.title')} data-testid="fill-dialog">
    <div class="modal-head">
      <span class="head-icon"><Icon name="list-ordered" size={18} /></span>
      <h2 class="modal-title">{t('fill.title')}</h2>
      <IconButton icon="close" label={t('dialog.close')} onclick={onClose} />
    </div>

    <p class="note">{t('fill.scope', rows, columns)}</p>

    <div class="fields" bind:this={box}>
      <div class="field">
        <label for="fill-mode">{t('fill.mode')}</label>
        <select id="fill-mode" class="control" data-testid="fill-mode" bind:value={mode}>
          {#each MODES as option (option)}
            <option value={option} disabled={option === 'down' && rows < 2}>{t(`fill.mode.${option}`)}</option>
          {/each}
        </select>
      </div>

      {#if mode === 'value'}
        <div class="field">
          <label for="fill-text">{t('fill.value')}</label>
          <input id="fill-text" class="control" type="text" spellcheck="false" bind:value={text} />
        </div>
      {:else if mode === 'series'}
        <div class="row">
          <div class="field">
            <label for="fill-start">{t('fill.start')}</label>
            <input id="fill-start" class="control" type="text" inputmode="decimal" bind:value={start} />
          </div>
          <div class="field">
            <label for="fill-step">{t('fill.step')}</label>
            <input id="fill-step" class="control" type="text" inputmode="decimal" bind:value={step} />
          </div>
          <div class="field">
            <label for="fill-pad">{t('fill.pad')}</label>
            <input id="fill-pad" class="control" type="number" min="0" max="40" bind:value={pad} />
          </div>
        </div>
        <div class="field">
          <label for="fill-template">{t('fill.template')}</label>
          <input id="fill-template" class="control" type="text" spellcheck="false" bind:value={template} />
        </div>
      {:else if mode === 'dates'}
        <div class="row">
          <div class="field">
            <label for="fill-date-start">{t('fill.start')}</label>
            <input id="fill-date-start" class="control" type="text" bind:value={dateStart} />
          </div>
          <div class="field">
            <label for="fill-date-step">{t('fill.step')}</label>
            <input id="fill-date-step" class="control" type="number" step="1" bind:value={dateStep} />
          </div>
          <div class="field">
            <label for="fill-unit">{t('fill.unit')}</label>
            <select id="fill-unit" class="control" bind:value={unit}>
              {#each DATE_UNITS as option (option)}
                <option value={option}>{t(`fill.unit.${option}`)}</option>
              {/each}
            </select>
          </div>
        </div>
      {/if}
    </div>

    {#if preview !== undefined}
      <p class="preview" data-testid="fill-preview"><span class="muted">{t('fill.preview')}</span> {preview}</p>
    {/if}
    {#if problem !== undefined}
      <p class="problem" role="alert" data-testid="fill-problem"><Icon name="error" size={14} />{problem}</p>
    {/if}

    <div class="modal-foot">
      <span class="grow note">{t('fill.hint')}</span>
      <button type="button" class="button secondary" onclick={onClose}>
        <Icon name="close" />{t('dialog.close')}
      </button>
      <button type="button" class="button" disabled={busy} data-testid="fill-run" onclick={() => { void apply(); }}>
        <Icon name={busy ? 'loading' : 'check'} spin={busy} />{t('fill.run')}
      </button>
    </div>
  </div>
</div>

<style>
  .head-icon {
    display: inline-flex;
    color: var(--vscode-charts-orange, var(--dn-warning));
  }

  .fields {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .row {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }

  label {
    font-size: var(--dn-font-small);
  }

  .preview {
    margin: 0;
    overflow: hidden;
    font-family: var(--dn-mono);
    font-size: var(--dn-font-small);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .muted,
  .note {
    margin: 0;
    color: var(--dn-muted);
    font-size: var(--dn-font-small);
  }

  .problem {
    display: flex;
    gap: 6px;
    align-items: center;
    margin: 0;
    color: var(--dn-danger);
    font-size: var(--dn-font-small);
  }

  .grow {
    flex: 1;
  }
</style>

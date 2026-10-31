<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from '../../components/Icon.svelte';
  import IconButton from '../../components/IconButton.svelte';
  import type { Translate } from '../../lib/i18n';
  import type { ResultColumnInfo } from '../../../../src/shared/protocols/result-grid';
  import { controlFor, type EditColumn } from './edit-model';

  interface Props {
    /** Name of the table the row goes into, for the title. */
    title: string;
    columns: readonly ResultColumnInfo[];
    /** How each column is edited; null for a computed one, which is left out. */
    editColumns: readonly (EditColumn | null)[];
    /** Adds the row with the filled fields and saves it; resolves to the reason it failed. */
    onInsert: (values: ReadonlyMap<number, string>) => Promise<string | undefined>;
    onClose: () => void;
    t: Translate;
  }

  const { title, columns, editColumns, onInsert, onClose, t }: Props = $props();

  interface Field {
    readonly column: number;
    readonly name: string;
    readonly info: EditColumn;
  }

  const fields = $derived<Field[]>(
    columns.flatMap((column, index) => {
      const info = editColumns[index];
      return info === null || info === undefined || info.kind === 'binary'
        ? []
        : [{ column: index, name: column.name, info }];
    }),
  );

  const values = $state<Record<number, string>>({});
  let problem = $state<string | undefined>(undefined);
  let busy = $state(false);
  let box = $state<HTMLElement | undefined>(undefined);

  onMount(() => {
    box?.querySelector<HTMLElement>('.control')?.focus();
  });

  async function insert(): Promise<void> {
    if (busy) {
      return;
    }
    busy = true;
    problem = undefined;
    const filled = new Map<number, string>(
      Object.entries(values)
        .filter(([, text]) => text !== '')
        .map(([column, text]) => [Number(column), text]),
    );
    problem = await onInsert(filled);
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
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void insert();
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
  <div class="modal wide" role="dialog" aria-modal="true" aria-label={t('insert.title', title)} data-testid="insert-dialog">
    <div class="modal-head">
      <span class="head-icon"><Icon name="new-file" size={18} /></span>
      <h2 class="modal-title">{t('insert.title', title)}</h2>
      <IconButton icon="close" label={t('dialog.close')} onclick={onClose} />
    </div>

    <div class="fields" bind:this={box}>
      {#each fields as field (field.column)}
        {@const control = controlFor(field.info)}
        {@const id = `insert-${field.column}`}
        <div class="field">
          <label for={id}>
            {#if !field.info.nullable}<span class="required" title={t('insert.required')}>*</span>{/if}{field.name}
            <span class="type">{field.info.dataType}</span>
          </label>
          {#if control.type === 'select'}
            <select
              {id}
              class="control"
              value={values[field.column] ?? ''}
              onchange={(event) => {
                values[field.column] = event.currentTarget.value;
              }}
            >
              <option value="">{t('insert.default')}</option>
              {#each control.options as option (option)}
                <option value={option}>{option}</option>
              {/each}
            </select>
          {:else if field.info.kind === 'json' || field.info.kind === 'text'}
            <textarea
              {id}
              class="control"
              rows="1"
              spellcheck="false"
              placeholder={field.info.nullable ? t('insert.nullable') : t('insert.default')}
              value={values[field.column] ?? ''}
              oninput={(event) => {
                values[field.column] = event.currentTarget.value;
              }}
            ></textarea>
          {:else}
            <input
              {id}
              class="control"
              type={control.inputType}
              placeholder={control.placeholder ?? (field.info.nullable ? t('insert.nullable') : t('insert.default'))}
              value={values[field.column] ?? ''}
              oninput={(event) => {
                values[field.column] = event.currentTarget.value;
              }}
            />
          {/if}
        </div>
      {/each}
    </div>

    {#if problem !== undefined}
      <p class="problem" role="alert" data-testid="insert-problem"><Icon name="error" size={14} />{problem}</p>
    {/if}

    <div class="modal-foot">
      <span class="grow note">{t('insert.hint')}</span>
      <button type="button" class="button secondary" onclick={onClose}>
        <Icon name="close" />{t('dialog.close')}
      </button>
      <button type="button" class="button" disabled={busy} data-testid="insert-run" onclick={() => { void insert(); }}>
        <Icon name={busy ? 'loading' : 'add'} spin={busy} />{t('insert.run')}
      </button>
    </div>
  </div>
</div>

<style>
  .wide {
    width: min(760px, 100%);
  }

  .head-icon {
    display: inline-flex;
    color: var(--vscode-charts-green, var(--dn-success));
  }

  .fields {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px 18px;
    min-height: 0;
    padding-right: 4px;
    overflow: auto;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }

  label {
    display: flex;
    gap: 6px;
    align-items: baseline;
    overflow: hidden;
    font-size: var(--dn-font-small);
    white-space: nowrap;
  }

  .required {
    margin-inline-end: 3px;
    color: var(--dn-danger);
    font-weight: 700;
  }

  .type {
    overflow: hidden;
    color: var(--dn-muted);
    text-overflow: ellipsis;
  }

  textarea.control {
    min-height: 28px;
    max-height: 120px;
    font-family: var(--dn-mono);
    resize: vertical;
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

  .note {
    color: var(--dn-muted);
    font-size: var(--dn-font-small);
  }

  @media (max-width: 560px) {
    .fields {
      grid-template-columns: 1fr;
    }
  }
</style>

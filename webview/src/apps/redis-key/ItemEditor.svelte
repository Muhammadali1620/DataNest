<script lang="ts">
  import type { RedisValue } from '../../../../src/shared/redis-value';
  import Icon from '../../components/Icon.svelte';
  import IconButton from '../../components/IconButton.svelte';
  import type { Translate } from '../../lib/i18n';
  import ValueEditor from './ValueEditor.svelte';
  import {
    deleteRequest,
    type ItemDraft,
    type PageItem,
    type PageRequest,
    saveRequest,
  } from './key-view';

  interface Props {
    type: string;
    /** The item being edited; undefined for a new one. */
    item: PageItem | undefined;
    readOnly: boolean;
    busy: boolean;
    t: Translate;
    onsubmit: (request: PageRequest) => void;
    oncancel: () => void;
  }

  const { type, item, readOnly, busy, t, onsubmit, oncancel }: Props = $props();

  const EMPTY: RedisValue = { text: '' };

  // The editor is recreated per item: the draft starts from it once.
  // svelte-ignore state_referenced_locally
  const draft = $state<ItemDraft>({
    field: item?.field ?? EMPTY,
    value: item?.value ?? EMPTY,
    score: item?.score ?? '0',
    end: 'tail',
    id: '*',
    pairs: [{ field: '', value: '' }],
  });
  const isNew = $derived(item === undefined);
  const request = $derived(saveRequest(type, item, draft));
  const removal = $derived(item === undefined ? undefined : deleteRequest(type, item));
  // Stream entries cannot change: they are added or deleted.
  const editable = $derived(!readOnly && (type !== 'stream' || isNew));
  const cut = $derived(item?.value?.truncated === true || item?.field?.truncated === true);
</script>

<section class="editor" aria-label={isNew ? t('redis.newItem') : t('redis.editItem')}>
  <header class="head">
    <Icon name={isNew ? 'add' : 'edit'} />
    <h2>{isNew ? t('redis.newItem') : t('redis.editItem')}</h2>
    <IconButton icon="close" label={t('redis.close')} onclick={oncancel} />
  </header>
  <div class="body">
    {#if type === 'hash'}
      <ValueEditor
        value={item?.field ?? EMPTY}
        label={t('redis.field')}
        rows={1}
        readonly={!editable}
        {t}
        onchange={(value: RedisValue | undefined) => {
          draft.field = value;
        }}
      />
    {/if}
    {#if type === 'stream'}
      {#if isNew}
        <label class="field">
          <span class="field-label">{t('redis.entryId')}</span>
          <input class="control mono" bind:value={draft.id} aria-label={t('redis.entryId')} />
        </label>
        <span class="field-label">{t('redis.fields')}</span>
        {#each draft.pairs ?? [] as pair, index (index)}
          <div class="pair">
            <input
              class="control mono"
              bind:value={pair.field}
              placeholder={t('redis.field')}
              aria-label={`${t('redis.field')} ${index + 1}`}
            />
            <input
              class="control mono"
              bind:value={pair.value}
              placeholder={t('redis.value')}
              aria-label={`${t('redis.value')} ${index + 1}`}
            />
          </div>
        {/each}
        <button
          type="button"
          class="link-button add-field"
          onclick={() => {
            draft.pairs?.push({ field: '', value: '' });
          }}><Icon name="add" size={14} />{t('redis.addField')}</button
        >
      {:else}
        <table class="fields">
          <tbody>
            {#each item?.fields ?? [] as pair, index (index)}
              <tr><th scope="row">{pair.field.text}</th><td>{pair.value.text}</td></tr>
            {/each}
          </tbody>
        </table>
      {/if}
    {:else}
      <ValueEditor
        value={item?.value ?? EMPTY}
        label={type === 'set' || type === 'zset' ? t('redis.member') : t('redis.value')}
        rows={8}
        readonly={!editable}
        {t}
        onchange={(value: RedisValue | undefined) => {
          draft.value = value;
        }}
      />
    {/if}
    {#if type === 'zset'}
      <label class="field">
        <span class="field-label">{t('redis.score')}</span>
        <input
          class="control mono"
          bind:value={draft.score}
          readonly={!editable}
          aria-label={t('redis.score')}
        />
      </label>
    {/if}
    {#if type === 'list' && isNew}
      <label class="field">
        <span class="field-label">{t('redis.addTo')}</span>
        <select class="control" bind:value={draft.end} aria-label={t('redis.addTo')}>
          <option value="tail">{t('redis.tail')}</option>
          <option value="head">{t('redis.head')}</option>
        </select>
      </label>
    {/if}
  </div>
  <footer class="actions">
    {#if !readOnly && removal !== undefined}
      <button
        type="button"
        class="button secondary"
        disabled={busy}
        onclick={() => {
          onsubmit(removal);
        }}><Icon name="trash" />{t('redis.deleteItem')}</button
      >
    {/if}
    <span class="grow"></span>
    {#if editable && !cut}
      <button
        type="button"
        class="button"
        disabled={busy || request === undefined}
        onclick={() => {
          if (request !== undefined) {
            onsubmit(request);
          }
        }}><Icon name={isNew ? 'add' : 'save'} />{isNew ? t('redis.add') : t('redis.save')}</button
      >
    {/if}
  </footer>
</section>

<style>
  .editor {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }

  .head {
    display: flex;
    flex: none;
    gap: var(--dn-gap);
    align-items: center;
    min-height: 34px;
    padding: 4px 6px 4px var(--dn-gap-m);
    border-bottom: 1px solid var(--dn-divider);
  }

  .head > :global(.codicon-glyph) {
    color: var(--dn-muted);
  }

  h2 {
    flex: 1;
  }

  .body {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--dn-gap-m);
    min-height: 0;
    padding: var(--dn-gap-m);
    overflow: auto;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .field-label {
    color: var(--dn-muted);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .mono {
    font-family: var(--dn-mono);
  }

  .pair {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 2fr);
    gap: var(--dn-gap-s);
  }

  .add-field {
    display: inline-flex;
    gap: 4px;
    align-items: center;
    align-self: flex-start;
  }

  .fields {
    width: 100%;
    border-collapse: collapse;
    font-family: var(--dn-mono);
    font-size: var(--dn-font-small);
  }

  .fields th,
  .fields td {
    padding: 3px 8px;
    text-align: left;
    vertical-align: top;
    overflow-wrap: anywhere;
  }

  .fields tr:nth-child(even) {
    background: var(--vscode-keybindingTable-rowsBackground, transparent);
  }

  .fields th {
    width: 35%;
    color: var(--dn-muted);
    font-weight: normal;
  }

  .grow {
    flex: 1;
  }

  .actions {
    display: flex;
    flex: none;
    gap: var(--dn-gap);
    align-items: center;
    padding: var(--dn-gap) var(--dn-gap-m);
    border-top: 1px solid var(--dn-divider);
  }
</style>

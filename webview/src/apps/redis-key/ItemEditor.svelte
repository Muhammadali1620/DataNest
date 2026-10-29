<script lang="ts">
  import type { RedisValue } from '../../../../src/shared/redis-value';
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
      <label class="inline">
        <span>{t('redis.entryId')}</span>
        <input class="control" bind:value={draft.id} aria-label={t('redis.entryId')} />
      </label>
      {#each draft.pairs ?? [] as pair, index (index)}
        <div class="pair">
          <input
            class="control"
            bind:value={pair.field}
            placeholder={t('redis.field')}
            aria-label={`${t('redis.field')} ${index + 1}`}
          />
          <input
            class="control"
            bind:value={pair.value}
            placeholder={t('redis.value')}
            aria-label={`${t('redis.value')} ${index + 1}`}
          />
        </div>
      {/each}
      <button
        type="button"
        class="button secondary"
        onclick={() => {
          draft.pairs?.push({ field: '', value: '' });
        }}>{t('redis.addField')}</button
      >
    {:else}
      <table class="fields">
        <tbody>
          {#each item?.fields ?? [] as pair, index (index)}
            <tr><th>{pair.field.text}</th><td>{pair.value.text}</td></tr>
          {/each}
        </tbody>
      </table>
    {/if}
  {:else}
    <ValueEditor
      value={item?.value ?? EMPTY}
      label={type === 'set' || type === 'zset' ? t('redis.member') : t('redis.value')}
      readonly={!editable}
      {t}
      onchange={(value: RedisValue | undefined) => {
        draft.value = value;
      }}
    />
  {/if}
  {#if type === 'zset'}
    <label class="inline">
      <span>{t('redis.score')}</span>
      <input
        class="control"
        bind:value={draft.score}
        readonly={!editable}
        aria-label={t('redis.score')}
      />
    </label>
  {/if}
  {#if type === 'list' && isNew}
    <label class="inline">
      <span>{t('redis.addTo')}</span>
      <select class="control" bind:value={draft.end} aria-label={t('redis.addTo')}>
        <option value="tail">{t('redis.tail')}</option>
        <option value="head">{t('redis.head')}</option>
      </select>
    </label>
  {/if}
  <div class="actions">
    {#if editable && !cut}
      <button
        type="button"
        class="button"
        disabled={busy || request === undefined}
        onclick={() => {
          if (request !== undefined) {
            onsubmit(request);
          }
        }}>{isNew ? t('redis.add') : t('redis.save')}</button
      >
    {/if}
    {#if !readOnly && removal !== undefined}
      <button
        type="button"
        class="button secondary"
        disabled={busy}
        onclick={() => {
          onsubmit(removal);
        }}>{t('redis.deleteItem')}</button
      >
    {/if}
    <button type="button" class="button secondary" onclick={oncancel}>{t('redis.close')}</button>
  </div>
</section>

<style>
  .editor {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 8px;
    border: 1px solid var(--vscode-panel-border, transparent);
  }
  .inline {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .pair {
    display: grid;
    grid-template-columns: 1fr 2fr;
    gap: 4px;
  }
  .actions {
    display: flex;
    gap: 8px;
  }
  .fields th {
    text-align: left;
    padding-right: 12px;
    font-weight: 600;
  }
</style>

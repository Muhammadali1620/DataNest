<script lang="ts">
  import Icon from '../../components/Icon.svelte';
  import IconButton from '../../components/IconButton.svelte';
  import type { Translate } from '../../lib/i18n';

  interface Props {
    /** Names of the table's triggers; undefined while they are being read. */
    triggers: readonly string[] | undefined;
    error: string | undefined;
    t: Translate;
    onaction: (action: 'view' | 'edit' | 'drop' | 'new', name?: string) => void;
    onrefresh: () => void;
  }

  const { triggers, error, t, onaction, onrefresh }: Props = $props();
</script>

<div class="toolbar">
  <button type="button" class="button secondary" onclick={() => {
      onaction('new');
    }}
    ><Icon name="add" />{t('designer.trigger.new')}</button
  >
  <IconButton icon="refresh" label={t('designer.ddl.refresh')} onclick={onrefresh} />
</div>

{#if error !== undefined}
  <p class="notice error" role="alert"><Icon name="error" /><span>{error}</span></p>
{:else if triggers === undefined}
  <p class="muted" role="status"><Icon name="loading" spin /> {t('designer.loading')}</p>
{:else if triggers.length === 0}
  <div class="empty">
    <span class="empty-icon"><Icon name="symbol-event" size={24} /></span>
    <p class="empty-title">{t('designer.trigger.none')}</p>
    <p class="empty-hint">{t('designer.trigger.noneHint')}</p>
  </div>
{:else}
  <ul class="rows" aria-label={t('designer.tabTriggers')}>
    {#each triggers as name (name)}
      <li class="row">
        <Icon name="symbol-event" />
        <span class="name">{name}</span>
        <span class="tools">
          <IconButton
            icon="eye"
            tone="teal"
            label={t('designer.trigger.view', name)}
            onclick={() => {
      onaction('view', name);
    }}
          />
          <IconButton
            icon="edit"
            tone="orange"
            label={t('designer.trigger.edit', name)}
            onclick={() => {
      onaction('edit', name);
    }}
          />
          <IconButton
            icon="trash"
            tone="red"
            label={t('designer.trigger.drop', name)}
            onclick={() => {
      onaction('drop', name);
    }}
          />
        </span>
      </li>
    {/each}
  </ul>
{/if}

<style>
  .rows {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .row {
    display: flex;
    gap: var(--dn-gap);
    align-items: center;
    padding: 4px var(--dn-gap);
    border-top: 1px solid var(--dn-divider);
  }

  .name {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .tools {
    display: inline-flex;
    gap: var(--dn-gap-s);
  }
</style>

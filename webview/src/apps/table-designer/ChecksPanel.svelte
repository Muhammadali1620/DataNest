<script lang="ts">
  import Icon from '../../components/Icon.svelte';
  import IconButton from '../../components/IconButton.svelte';
  import type { Translate } from '../../lib/i18n';

  interface Props {
    checks: readonly { name: string; expression: string }[] | undefined;
    error: string | undefined;
    t: Translate;
    onadd: (name: string, expression: string) => Promise<boolean>;
    ondrop: (name: string) => void;
    onrefresh: () => void;
  }

  const { checks, error, t, onadd, ondrop, onrefresh }: Props = $props();

  let name = $state('');
  let expression = $state('');
  let adding = $state(false);

  async function add(): Promise<void> {
    if (adding) {
      return;
    }
    adding = true;
    try {
      // The fields are cleared only when the check really went in.
      if (await onadd(name.trim(), expression.trim())) {
        name = '';
        expression = '';
      }
    } finally {
      adding = false;
    }
  }
</script>

<div class="toolbar">
  <IconButton icon="refresh" label={t('designer.ddl.refresh')} onclick={onrefresh} />
</div>

{#if error !== undefined}
  <p class="notice error" role="alert"><Icon name="error" /><span>{error}</span></p>
{:else if checks === undefined}
  <p class="muted" role="status"><Icon name="loading" spin /> {t('designer.loading')}</p>
{:else if checks.length === 0}
  <div class="empty">
    <span class="empty-icon"><Icon name="checklist" size={24} /></span>
    <p class="empty-title">{t('designer.check.none')}</p>
    <p class="empty-hint">{t('designer.check.noneHint')}</p>
  </div>
{:else}
  <div class="scroll">
    <table class="design-table">
      <thead>
        <tr>
          <th>{t('designer.check.name')}</th>
          <th>{t('designer.check.expression')}</th>
          <th class="tools-cell"><span class="sr-only">{t('designer.col.remove')}</span></th>
        </tr>
      </thead>
      <tbody>
        {#each checks as check (check.name)}
          <tr>
            <td class="name-cell">{check.name}</td>
            <td><code>{check.expression}</code></td>
            <td class="tools-cell">
              <IconButton
                icon="trash"
                tone="red"
                label={t('designer.check.drop', check.name)}
                onclick={() => {
                  ondrop(check.name);
                }}
              />
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<form
  class="add-form"
  onsubmit={(event) => {
    event.preventDefault();
    void add();
  }}
>
  <input
    class="control name-input"
    bind:value={name}
    placeholder={t('designer.check.name')}
    aria-label={t('designer.check.name')}
    autocomplete="off"
    spellcheck="false"
  />
  <input
    class="control expression-input"
    bind:value={expression}
    placeholder={t('designer.check.expressionHint')}
    aria-label={t('designer.check.expression')}
    autocomplete="off"
    spellcheck="false"
  />
  <button
    type="submit"
    class="button secondary"
    disabled={adding || name.trim() === '' || expression.trim() === ''}
    ><Icon name="add" />{t('designer.check.add')}</button
  >
</form>

<style>
  td {
    padding: 4px;
    vertical-align: middle;
    border-top: 1px solid var(--dn-divider);
  }

  .name-cell {
    width: 28%;
    min-width: 140px;
    overflow-wrap: anywhere;
  }

  code {
    font-family: var(--dn-mono);
    overflow-wrap: anywhere;
    user-select: text;
  }

  .tools-cell {
    width: 1%;
  }

  .add-form {
    display: flex;
    flex-wrap: wrap;
    gap: var(--dn-gap);
    align-items: center;
  }

  .name-input {
    flex: 0 1 220px;
  }

  .expression-input {
    flex: 1 1 260px;
    font-family: var(--dn-mono);
  }
</style>

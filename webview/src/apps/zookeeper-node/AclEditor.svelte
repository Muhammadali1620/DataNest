<script lang="ts">
  import type { ZnodeAclEntry } from '../../../../src/shared/protocols/zookeeper-node';
  import { ACL_PERMS, ACL_SCHEMES, aclProblem } from '../../../../src/shared/zk-acl';
  import Icon from '../../components/Icon.svelte';
  import type { Translate } from '../../lib/i18n';

  interface Props {
    /** The ACL as the server has it: the editor starts from a copy. */
    acl: readonly ZnodeAclEntry[];
    busy: boolean;
    t: Translate;
    onsave: (acl: ZnodeAclEntry[]) => void;
    oncancel: () => void;
  }

  const { acl, busy, t, onsave, oncancel }: Props = $props();

  // The editor is opened over one ACL; a fresh read closes it and opens a new one.
  // svelte-ignore state_referenced_locally
  const rows = $state<ZnodeAclEntry[]>(acl.map((entry) => ({ ...entry })));

  const problems = $derived(rows.map((row) => aclProblem(row)));
  const valid = $derived(rows.length > 0 && problems.every((problem) => problem === undefined));

  function setScheme(row: ZnodeAclEntry, scheme: string): void {
    row.scheme = scheme;
    // The two schemes with a fixed id get it, so the row is valid as soon as it is chosen.
    if (scheme === 'world') {
      row.id = 'anyone';
    } else if (scheme === 'auth') {
      row.id = '';
    }
  }

  function toggle(row: ZnodeAclEntry, bit: number): void {
    row.perms = row.perms ^ bit;
  }

  function add(): void {
    rows.push({ perms: 1, scheme: 'digest', id: '' });
  }
</script>

<div class="editor" data-testid="acl-editor">
  <ul class="rows">
    {#each rows as row, index (index)}
      <li class="row" class:bad={problems[index] !== undefined}>
        <select
          class="control"
          value={row.scheme}
          aria-label={t('zk.aclScheme')}
          onchange={(event) => {
            setScheme(row, event.currentTarget.value);
          }}
        >
          {#each ACL_SCHEMES as scheme (scheme)}
            <option value={scheme}>{scheme}</option>
          {/each}
          {#if !(ACL_SCHEMES as readonly string[]).includes(row.scheme)}
            <option value={row.scheme}>{row.scheme}</option>
          {/if}
        </select>
        <input
          class="control id"
          bind:value={row.id}
          disabled={row.scheme === 'auth'}
          placeholder={row.scheme === 'digest' ? t('zk.aclDigestHint') : t('zk.aclId')}
          aria-label={t('zk.aclId')}
          spellcheck="false"
          autocomplete="off"
        />
        <span class="perms" role="group" aria-label={t('zk.aclPerms')}>
          {#each ACL_PERMS as perm (perm.bit)}
            <label class="perm" title={t(`zk.perm.${perm.letter}`)}>
              <input
                type="checkbox"
                checked={(row.perms & perm.bit) !== 0}
                aria-label={t(`zk.perm.${perm.letter}`)}
                onchange={() => {
                  toggle(row, perm.bit);
                }}
              />{perm.letter}
            </label>
          {/each}
        </span>
        <button
          type="button"
          class="remove"
          aria-label={t('zk.aclRemove')}
          title={t('zk.aclRemove')}
          disabled={rows.length === 1}
          onclick={() => {
            rows.splice(index, 1);
          }}><Icon name="trash" size={14} /></button
        >
      </li>
    {/each}
  </ul>
  <p class="hint">{t('zk.aclHint')}</p>
  <div class="actions">
    <button type="button" class="button secondary" disabled={busy} onclick={add}
      ><Icon name="add" />{t('zk.aclAdd')}</button
    >
    <button
      type="button"
      class="button"
      disabled={busy || !valid}
      onclick={() => {
        onsave(rows.map((row) => ({ ...row })));
      }}><Icon name="save" />{t('zk.aclSave')}</button
    >
    <button type="button" class="button secondary" disabled={busy} onclick={oncancel}
      >{t('zk.aclCancel')}</button
    >
  </div>
</div>

<style>
  .editor {
    display: flex;
    flex-direction: column;
    gap: var(--dn-gap);
  }

  .rows {
    display: flex;
    flex-direction: column;
    gap: var(--dn-gap);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .row {
    display: grid;
    grid-template-columns: auto 1fr auto;
    gap: var(--dn-gap-s);
    align-items: center;
    padding: var(--dn-gap-s);
    border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
    border-radius: var(--dn-radius);
  }

  .row.bad {
    border-color: var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground));
  }

  .id {
    min-width: 0;
  }

  .perms {
    display: inline-flex;
    gap: var(--dn-gap-s);
    grid-column: 1 / span 2;
    font-family: var(--dn-mono);
  }

  .perm {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    cursor: pointer;
  }

  .remove {
    display: inline-flex;
    padding: 2px;
    color: var(--vscode-icon-foreground);
    background: none;
    border: none;
    cursor: pointer;
  }

  .remove:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .hint {
    margin: 0;
    color: var(--dn-muted);
    font-size: var(--dn-font-small);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--dn-gap-s);
  }
</style>

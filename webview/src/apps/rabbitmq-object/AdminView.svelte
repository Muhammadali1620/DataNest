<script lang="ts">
  import type {
    RabbitAdminView,
    RabbitObjectProtocol,
    RabbitPolicyView,
    RabbitUserView,
  } from '../../../../src/shared/protocols/rabbitmq-object';
  import { RABBIT_POLICY_TARGETS } from '../../../../src/shared/protocols/rabbitmq-object';
  import type { RpcPeer } from '../../../../src/shared/rpc';
  import Icon from '../../components/Icon.svelte';
  import IconButton from '../../components/IconButton.svelte';
  import type { Translate } from '../../lib/i18n';
  import { parseTags, stateTone } from './object-view';

  interface Props {
    admin: RabbitAdminView;
    readOnly: boolean;
    rpc: RpcPeer<RabbitObjectProtocol['webview'], RabbitObjectProtocol['host']>;
    busy: boolean;
    t: Translate;
    /** Runs one request with the page's busy flag and error line. */
    run: (action: () => Promise<unknown>, after?: () => void) => Promise<void>;
  }

  const { admin, readOnly, rpc, busy, t, run }: Props = $props();

  // The form that gives a user access to the virtual host.
  let grantUser = $state('');
  let configure = $state('.*');
  let write = $state('.*');
  let read = $state('.*');

  // The form that makes a user.
  let creating = $state(false);
  let newName = $state('');
  let newPassword = $state('');
  let newTags = $state('');

  // The form that changes the password or the tags of a user.
  let editUser = $state('');
  let editOriginalTags = $state('');
  let editTags = $state('');
  let editPassword = $state('');

  // The form that saves a policy.
  let editingPolicy = $state(false);
  let policyName = $state('');
  let policyPattern = $state('');
  let policyApplyTo = $state<(typeof RABBIT_POLICY_TARGETS)[number]>('all');
  let policyPriority = $state(0);
  let policyDefinition = $state('{\n  "max-length": 1000\n}');

  function editPermission(user: RabbitUserView): void {
    grantUser = user.name;
    configure = user.permission?.configure ?? '.*';
    write = user.permission?.write ?? '.*';
    read = user.permission?.read ?? '.*';
  }

  function startEditUser(user: RabbitUserView): void {
    editUser = user.name;
    editOriginalTags = user.tags.join(', ');
    editTags = editOriginalTags;
    editPassword = '';
  }

  function saveUser(): void {
    const tags = editTags.trim() === editOriginalTags.trim() ? undefined : parseTags(editTags);
    void run(
      () =>
        rpc.request('updateUser', {
          name: editUser,
          ...(editPassword === '' ? {} : { password: editPassword }),
          ...(tags === undefined ? {} : { tags }),
        }),
      () => {
        editUser = '';
        editPassword = '';
      },
    );
  }

  function grant(): void {
    void run(() => rpc.request('setPermission', { user: grantUser, configure, write, read }), () => {
      grantUser = '';
    });
  }

  function createUser(): void {
    void run(
      () => rpc.request('createUser', { name: newName, password: newPassword, tags: parseTags(newTags) }),
      () => {
        newName = '';
        newPassword = '';
        newTags = '';
        creating = false;
      },
    );
  }

  function editPolicy(policy: RabbitPolicyView): void {
    editingPolicy = true;
    policyName = policy.name;
    policyPattern = policy.pattern;
    policyApplyTo = RABBIT_POLICY_TARGETS.find((one) => one === policy.applyTo) ?? 'all';
    policyPriority = policy.priority;
    policyDefinition = policy.definition;
  }

  function savePolicy(): void {
    void run(
      () =>
        rpc.request('setPolicy', {
          name: policyName,
          pattern: policyPattern,
          applyTo: policyApplyTo,
          priority: Number.isFinite(policyPriority) ? Math.trunc(policyPriority) : 0,
          definition: policyDefinition,
        }),
      () => {
        editingPolicy = false;
      },
    );
  }

  const moreConnections = $derived(admin.connectionsTotal - admin.connections.length);
</script>

<section class="block" aria-label={t('rabbit.admin.connections')} data-testid="connections">
  <h2 class="section"><Icon name="plug" tone="blue" />{t('rabbit.admin.connections')}</h2>
  {#if admin.connectionsError !== undefined}
    <p class="notice error" role="alert"><Icon name="error" /><span>{admin.connectionsError}</span></p>
  {:else if admin.connections.length === 0}
    <p class="hint">{t('rabbit.admin.noConnections')}</p>
  {:else}
    <table class="list">
      <thead>
        <tr>
          <th>{t('rabbit.admin.client')}</th>
          <th>{t('rabbit.admin.user')}</th>
          <th>{t('rabbit.admin.peer')}</th>
          <th>{t('rabbit.admin.state')}</th>
          <th>{t('rabbit.admin.channels')}</th>
          <th>{t('rabbit.admin.since')}</th>
          <th>{t('rabbit.admin.traffic')}</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {#each admin.connections as connection (connection.name)}
          <tr>
            <td class="mono clip" title={connection.name}>
              {connection.clientName === '' ? connection.name : connection.clientName}
              {#if connection.product !== ''}<span class="badge outline">{connection.product}</span>{/if}
            </td>
            <td class="mono">{connection.user}</td>
            <td class="mono">{connection.peer}</td>
            <td><span class="badge {stateTone(connection.state)}">{connection.state}</span></td>
            <td class="num">{connection.channels}</td>
            <td class="size">{connection.connectedAt === '' ? '—' : connection.connectedAt}</td>
            <td class="size">↓ {connection.received} · ↑ {connection.sent}</td>
            <td class="actions-cell">
              {#if !readOnly}
                <IconButton
                  icon="close"
                  tone="red"
                  label={t('rabbit.admin.closeConnection')}
                  disabled={busy}
                  onclick={() => void run(() => rpc.request('closeConnection', { name: connection.name }))}
                />
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
    {#if moreConnections > 0}
      <p class="hint">{t('rabbit.admin.moreConnections', moreConnections)}</p>
    {/if}
  {/if}
</section>

<section class="block" aria-label={t('rabbit.admin.users')} data-testid="users">
  <div class="heading">
    <h2 class="section"><Icon name="person" tone="green" />{t('rabbit.admin.users')}</h2>
    {#if !readOnly && admin.usersError === undefined}
      <button
        type="button"
        class="button"
        aria-pressed={creating}
        disabled={busy}
        onclick={() => {
          creating = !creating;
        }}><Icon name="add" />{t('rabbit.admin.newUser')}</button
      >
    {/if}
  </div>
  {#if admin.usersError !== undefined}
    <p class="notice error" role="alert"><Icon name="error" /><span>{admin.usersError}</span></p>
    <p class="hint">{t('rabbit.admin.needsAdmin')}</p>
  {:else}
    {#if creating && !readOnly}
      <div class="form" data-testid="new-user">
        <label class="field">
          <span>{t('rabbit.admin.name')}</span>
          <input class="control mono" bind:value={newName} aria-label={t('rabbit.admin.name')} autocomplete="off" spellcheck="false" />
        </label>
        <label class="field">
          <span>{t('rabbit.admin.password')}</span>
          <input class="control" type="password" bind:value={newPassword} aria-label={t('rabbit.admin.password')} autocomplete="new-password" />
        </label>
        <label class="field grow">
          <span>{t('rabbit.admin.tags')}</span>
          <input class="control mono" bind:value={newTags} placeholder="management, policymaker" aria-label={t('rabbit.admin.tags')} autocomplete="off" spellcheck="false" />
        </label>
        <button type="button" class="button" disabled={busy} onclick={createUser}><Icon name="add" />{t('rabbit.admin.create')}</button>
      </div>
    {/if}
    <table class="list static">
      <thead>
        <tr>
          <th>{t('rabbit.admin.name')}</th>
          <th>{t('rabbit.admin.tags')}</th>
          <th>{t('rabbit.admin.configure')}</th>
          <th>{t('rabbit.admin.write')}</th>
          <th>{t('rabbit.admin.read')}</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {#each admin.users as user (user.name)}
          <tr>
            <td class="mono">
              {user.name}
              {#if user.name === admin.me}<span class="badge outline">{t('rabbit.admin.you')}</span>{/if}
            </td>
            <td>
              {#each user.tags as tag (tag)}<span class="badge {tag === 'administrator' ? 'warning' : 'outline'}">{tag}</span>{/each}
            </td>
            {#if user.permission === undefined}
              <td colspan="3"><span class="badge outline">{t('rabbit.admin.noAccess')}</span></td>
            {:else}
              <td class="mono">{user.permission.configure === '' ? '—' : user.permission.configure}</td>
              <td class="mono">{user.permission.write === '' ? '—' : user.permission.write}</td>
              <td class="mono">{user.permission.read === '' ? '—' : user.permission.read}</td>
            {/if}
            <td class="actions-cell">
              {#if !readOnly}
                <IconButton
                  icon="edit"
                  tone="green"
                  label={t('rabbit.admin.editUser')}
                  disabled={busy}
                  onclick={() => {
                    startEditUser(user);
                  }}
                />
                <IconButton
                  icon="key"
                  tone="blue"
                  label={t('rabbit.admin.editAccess')}
                  disabled={busy}
                  onclick={() => {
                    editPermission(user);
                  }}
                />
                {#if user.permission !== undefined}
                  <IconButton
                    icon="lock"
                    tone="orange"
                    label={t('rabbit.admin.clearAccess')}
                    disabled={busy}
                    onclick={() => void run(() => rpc.request('clearPermission', { user: user.name }))}
                  />
                {/if}
                <IconButton
                  icon="trash"
                  tone="red"
                  label={t('rabbit.admin.deleteUser')}
                  disabled={busy || user.name === admin.me}
                  onclick={() => void run(() => rpc.request('deleteUser', { name: user.name }))}
                />
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
    {#if editUser !== '' && !readOnly}
      <div class="form" data-testid="edit-user">
        <span class="who"><Icon name="edit" tone="green" />{t('rabbit.admin.editOf', editUser)}</span>
        <label class="field">
          <span>{t('rabbit.admin.newPassword')}</span>
          <input class="control" type="password" bind:value={editPassword} aria-label={t('rabbit.admin.newPassword')} placeholder={t('rabbit.admin.keepPassword')} autocomplete="new-password" />
        </label>
        <label class="field grow">
          <span>{t('rabbit.admin.tags')}</span>
          <input class="control mono" bind:value={editTags} placeholder="management, policymaker" aria-label={t('rabbit.admin.tags')} autocomplete="off" spellcheck="false" />
        </label>
        <button type="button" class="button" disabled={busy} onclick={saveUser}><Icon name="check" />{t('rabbit.admin.saveUser')}</button>
        <button
          type="button"
          class="button secondary"
          onclick={() => {
            editUser = '';
          }}>{t('rabbit.admin.cancel')}</button
        >
      </div>
    {/if}
    {#if grantUser !== '' && !readOnly}
      <div class="form" data-testid="grant">
        <span class="who"><Icon name="key" tone="blue" />{t('rabbit.admin.accessOf', grantUser)}</span>
        <label class="field grow">
          <span>{t('rabbit.admin.configure')}</span>
          <input class="control mono" bind:value={configure} aria-label={t('rabbit.admin.configure')} spellcheck="false" />
        </label>
        <label class="field grow">
          <span>{t('rabbit.admin.write')}</span>
          <input class="control mono" bind:value={write} aria-label={t('rabbit.admin.write')} spellcheck="false" />
        </label>
        <label class="field grow">
          <span>{t('rabbit.admin.read')}</span>
          <input class="control mono" bind:value={read} aria-label={t('rabbit.admin.read')} spellcheck="false" />
        </label>
        <button type="button" class="button" disabled={busy} onclick={grant}><Icon name="check" />{t('rabbit.admin.grant')}</button>
        <button
          type="button"
          class="button secondary"
          onclick={() => {
            grantUser = '';
          }}>{t('rabbit.admin.cancel')}</button
        >
      </div>
      <p class="hint">{t('rabbit.admin.patternHint')}</p>
    {/if}
  {/if}
</section>

<section class="block" aria-label={t('rabbit.admin.policies')} data-testid="policies">
  <div class="heading">
    <h2 class="section"><Icon name="checklist" tone="purple" />{t('rabbit.admin.policies')}</h2>
    {#if !readOnly && admin.policiesError === undefined}
      <button
        type="button"
        class="button"
        aria-pressed={editingPolicy}
        disabled={busy}
        onclick={() => {
          editingPolicy = !editingPolicy;
        }}><Icon name="add" />{t('rabbit.admin.newPolicy')}</button
      >
    {/if}
  </div>
  {#if admin.policiesError !== undefined}
    <p class="notice error" role="alert"><Icon name="error" /><span>{admin.policiesError}</span></p>
  {:else}
    {#if admin.policies.length === 0}
      <p class="hint">{t('rabbit.admin.noPolicies')}</p>
    {:else}
      <table class="list static">
        <thead>
          <tr>
            <th>{t('rabbit.admin.name')}</th>
            <th>{t('rabbit.admin.pattern')}</th>
            <th>{t('rabbit.admin.appliesTo')}</th>
            <th>{t('rabbit.admin.priority')}</th>
            <th>{t('rabbit.admin.definition')}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each admin.policies as policy (policy.name)}
            <tr>
              <td class="mono">{policy.name}</td>
              <td class="mono">{policy.pattern}</td>
              <td><span class="badge outline">{policy.applyTo}</span></td>
              <td class="num">{policy.priority}</td>
              <td class="mono clip" title={policy.definition}>{policy.definition.replaceAll(/\s+/gu, ' ')}</td>
              <td class="actions-cell">
                {#if !readOnly}
                  <IconButton
                    icon="edit"
                    tone="blue"
                    label={t('rabbit.admin.editPolicy')}
                    disabled={busy}
                    onclick={() => {
                      editPolicy(policy);
                    }}
                  />
                  <IconButton
                    icon="trash"
                    tone="red"
                    label={t('rabbit.admin.deletePolicy')}
                    disabled={busy}
                    onclick={() => void run(() => rpc.request('deletePolicy', { name: policy.name }))}
                  />
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
    {#if editingPolicy && !readOnly}
      <div class="form column" data-testid="policy-form">
        <div class="form">
          <label class="field">
            <span>{t('rabbit.admin.name')}</span>
            <input class="control mono" bind:value={policyName} aria-label={t('rabbit.admin.name')} autocomplete="off" spellcheck="false" />
          </label>
          <label class="field grow">
            <span>{t('rabbit.admin.pattern')}</span>
            <input class="control mono" bind:value={policyPattern} placeholder="^tmp\." aria-label={t('rabbit.admin.pattern')} autocomplete="off" spellcheck="false" />
          </label>
          <label class="field">
            <span>{t('rabbit.admin.appliesTo')}</span>
            <select class="control" bind:value={policyApplyTo} aria-label={t('rabbit.admin.appliesTo')}>
              {#each RABBIT_POLICY_TARGETS as target (target)}
                <option value={target}>{target}</option>
              {/each}
            </select>
          </label>
          <label class="field narrow">
            <span>{t('rabbit.admin.priority')}</span>
            <input class="control" type="number" bind:value={policyPriority} aria-label={t('rabbit.admin.priority')} />
          </label>
        </div>
        <label class="field">
          <span>{t('rabbit.admin.definition')}</span>
          <textarea class="control mono" rows="4" bind:value={policyDefinition} aria-label={t('rabbit.admin.definition')} spellcheck="false"></textarea>
        </label>
        <div class="actions">
          <button
            type="button"
            class="button secondary"
            onclick={() => {
              editingPolicy = false;
            }}>{t('rabbit.admin.cancel')}</button
          >
          <button type="button" class="button" disabled={busy} onclick={savePolicy}><Icon name="save" />{t('rabbit.admin.savePolicy')}</button>
        </div>
      </div>
    {/if}
  {/if}
</section>

<style>
  .mono {
    font-family: var(--dn-mono);
  }

  .block {
    padding: var(--dn-gap-m) var(--dn-gap-l);
    border-bottom: 1px solid var(--dn-divider);
  }

  .heading {
    display: flex;
    gap: var(--dn-gap-m);
    align-items: center;
    justify-content: space-between;
  }

  .section {
    display: flex;
    gap: var(--dn-gap-s);
    align-items: center;
    margin: 0 0 var(--dn-gap);
    font-size: 13px;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--dn-font-small);
  }

  th {
    padding: 4px 8px;
    color: var(--dn-muted);
    font-weight: 600;
    text-align: left;
    border-bottom: 1px solid var(--dn-divider);
  }

  td {
    padding: 4px 8px;
    border-bottom: 1px solid var(--dn-divider);
    overflow-wrap: anywhere;
  }

  .list tbody tr:hover {
    background: var(--vscode-list-hoverBackground);
  }

  .clip {
    max-width: 320px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .size {
    white-space: nowrap;
  }

  .num {
    text-align: right;
  }

  .actions-cell {
    text-align: right;
    white-space: nowrap;
  }

  .hint {
    margin: var(--dn-gap) 0 0;
    color: var(--dn-muted);
    font-size: var(--dn-font-small);
  }

  .form {
    display: flex;
    flex-wrap: wrap;
    gap: var(--dn-gap) var(--dn-gap-m);
    align-items: flex-end;
    margin-top: var(--dn-gap-m);
  }

  .form.column {
    flex-direction: column;
    align-items: stretch;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 2px;
    color: var(--dn-muted);
    font-size: var(--dn-font-small);
  }

  .grow {
    flex: 1;
    min-width: 140px;
  }

  .field.narrow .control {
    width: 90px;
  }

  .who {
    display: inline-flex;
    gap: 6px;
    align-items: center;
    padding-bottom: 4px;
    font-size: var(--dn-font-small);
  }

  .actions {
    display: flex;
    gap: var(--dn-gap);
    justify-content: flex-end;
  }
</style>

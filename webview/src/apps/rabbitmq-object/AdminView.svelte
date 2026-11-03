<script lang="ts">
  import type {
    RabbitAdminView,
    RabbitObjectProtocol,
    RabbitPolicyView,
    RabbitUserView,
  } from '../../../../src/shared/protocols/rabbitmq-object';
  import { RABBIT_POLICY_TARGETS, RABBIT_QUEUE_TYPES } from '../../../../src/shared/protocols/rabbitmq-object';
  import type { RpcPeer } from '../../../../src/shared/rpc';
  import Icon from '../../components/Icon.svelte';
  import IconButton from '../../components/IconButton.svelte';
  import type { Translate } from '../../lib/i18n';
  import { parseTags, stateTone } from './object-view';
  import {
    hintOf,
    joinDefinition,
    type PolicyValues,
    splitDefinition,
    visibleFields,
  } from './policy-definition';

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
  let policyOperator = $state(false);
  /** The fields of the definition (message TTL, length limits, dead lettering…). */
  let policyValues = $state<PolicyValues>({});
  /** The keys the fields do not cover, as JSON. */
  let policyExtra = $state('');
  let policyProblem = $state<string | undefined>(undefined);
  const fields = $derived(visibleFields(policyApplyTo, policyValues));

  // The settings of the virtual host: what is typed over what the broker said, until saved.
  let settingsEdit = $state<{ description: string; tags: string; queueType: string } | undefined>(
    undefined,
  );
  const settingsNow = $derived({
    description: settingsEdit?.description ?? admin.settings?.description ?? '',
    tags: settingsEdit?.tags ?? (admin.settings?.tags ?? []).join(', '),
    queueType: settingsEdit?.queueType ?? admin.settings?.defaultQueueType ?? '',
  });

  function saveSettings(): void {
    const queueType = RABBIT_QUEUE_TYPES.find((one) => one === settingsNow.queueType) ?? '';
    void run(
      () =>
        rpc.request('setVhostSettings', {
          description: settingsNow.description,
          tags: settingsNow.tags.split(',').map((tag) => tag.trim()).filter((tag) => tag !== ''),
          defaultQueueType: queueType,
        }),
      () => {
        settingsEdit = undefined;
      },
    );
  }

  // The form that sets the limits of the virtual host.
  const limitInputs = $state<Record<string, string>>({ 'max-connections': '', 'max-queues': '' });
  let limitProblem = $state<string | undefined>(undefined);

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
    policyOperator = policy.operator === true;
    const parts = splitDefinition(policy.definition);
    policyValues = parts.values;
    policyExtra = parts.extra;
    policyProblem = undefined;
  }

  function newPolicy(): void {
    editingPolicy = !editingPolicy;
    policyName = '';
    policyPattern = '';
    policyApplyTo = 'all';
    policyPriority = 0;
    policyOperator = false;
    policyValues = {};
    policyExtra = '';
    policyProblem = undefined;
  }

  function setLimit(limit: 'max-connections' | 'max-queues', clear: boolean): void {
    const text = (limitInputs[limit] ?? '').trim();
    if (!clear && !/^\d{1,10}$/u.test(text)) {
      limitProblem = t('rabbit.admin.limitInvalid');
      return;
    }
    limitProblem = undefined;
    void run(
      () => rpc.request('setLimit', clear ? { limit } : { limit, value: Number(text) }),
      () => {
        limitInputs[limit] = '';
      },
    );
  }

  function savePolicy(): void {
    const joined = joinDefinition(policyValues, policyExtra);
    if (!joined.ok) {
      policyProblem =
        joined.reason === 'number'
          ? t('rabbit.admin.policy.numberInvalid', joined.key)
          : t('rabbit.admin.policy.extraInvalid');
      return;
    }
    policyProblem = undefined;
    void run(
      () =>
        rpc.request('setPolicy', {
          name: policyName,
          pattern: policyPattern,
          applyTo: policyApplyTo,
          priority: Number.isFinite(policyPriority) ? Math.trunc(policyPriority) : 0,
          definition: joined.json,
          ...(policyOperator ? { operator: true } : {}),
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

<section class="block" aria-label={t('rabbit.admin.settings')} data-testid="settings">
  <h2 class="section"><Icon name="settings-gear" tone="blue" />{t('rabbit.admin.settings')}</h2>
  {#if admin.settingsError !== undefined}
    <p class="notice error" role="alert"><Icon name="error" /><span>{admin.settingsError}</span></p>
  {:else if admin.settings !== undefined}
    <div class="form">
      <label class="field grow">
        <span>{t('rabbit.admin.description')}</span>
        <input
          class="control"
          value={settingsNow.description}
          disabled={readOnly}
          aria-label={t('rabbit.admin.description')}
          oninput={(event) => {
            settingsEdit = { ...settingsNow, description: event.currentTarget.value };
          }}
          autocomplete="off"
        />
      </label>
      <label class="field">
        <span>{t('rabbit.admin.vhostTags')}</span>
        <input
          class="control mono"
          value={settingsNow.tags}
          disabled={readOnly}
          aria-label={t('rabbit.admin.vhostTags')}
          oninput={(event) => {
            settingsEdit = { ...settingsNow, tags: event.currentTarget.value };
          }}
          autocomplete="off"
          spellcheck="false"
        />
      </label>
      <label class="field">
        <span>{t('rabbit.admin.queueType')}</span>
        <select
          class="control"
          value={settingsNow.queueType}
          disabled={readOnly}
          aria-label={t('rabbit.admin.queueType')}
          onchange={(event) => {
            settingsEdit = { ...settingsNow, queueType: event.currentTarget.value };
          }}
        >
          {#each RABBIT_QUEUE_TYPES as kind (kind)}
            <option value={kind}>{kind === '' ? t('rabbit.admin.queueTypeBroker') : kind}</option>
          {/each}
        </select>
      </label>
      {#if !readOnly}
        <button type="button" class="button" disabled={busy || settingsEdit === undefined} onclick={saveSettings}><Icon name="save" />{t('rabbit.admin.saveSettings')}</button>
      {/if}
    </div>
    <p class="hint">{t('rabbit.admin.settingsHint')}</p>
  {/if}
</section>

<section class="block" aria-label={t('rabbit.admin.limits')} data-testid="limits">
  <h2 class="section"><Icon name="dashboard" tone="orange" />{t('rabbit.admin.limits')}</h2>
  {#if admin.limitsError !== undefined}
    <p class="notice error" role="alert"><Icon name="error" /><span>{admin.limitsError}</span></p>
  {:else}
    {#each [{ key: 'max-connections' as const, current: admin.limits?.maxConnections }, { key: 'max-queues' as const, current: admin.limits?.maxQueues }] as limit (limit.key)}
      <div class="limit" data-testid="limit-{limit.key}">
        <span class="limit-name mono">{limit.key}</span>
        <span class="badge {limit.current === undefined ? 'outline' : 'warning'}">{limit.current ?? t('rabbit.admin.noLimit')}</span>
        {#if !readOnly}
          <input
            class="control mono limit-input"
            type="text"
            inputmode="numeric"
            bind:value={limitInputs[limit.key]}
            placeholder="0"
            aria-label={limit.key}
            autocomplete="off"
          />
          <button type="button" class="button secondary" disabled={busy} onclick={() => { setLimit(limit.key, false); }}><Icon name="check" />{t('rabbit.admin.setLimit')}</button>
          <button type="button" class="button secondary" disabled={busy || limit.current === undefined} onclick={() => { setLimit(limit.key, true); }}><Icon name="close" />{t('rabbit.admin.liftLimit')}</button>
        {/if}
      </div>
    {/each}
    {#if limitProblem !== undefined}
      <p class="notice error" role="alert" data-testid="limit-problem"><Icon name="error" /><span>{limitProblem}</span></p>
    {/if}
    <p class="hint">{t('rabbit.admin.limitsHint')}</p>
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
        onclick={newPolicy}><Icon name="add" />{t('rabbit.admin.newPolicy')}</button
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
          {#each admin.policies as policy (`${policy.operator === true ? 'o' : 'p'}/${policy.name}`)}
            <tr>
              <td class="mono">{policy.name}{#if policy.operator === true} <span class="badge outline" data-testid="operator-badge">{t('rabbit.admin.operatorBadge')}</span>{/if}</td>
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
                    onclick={() => void run(() => rpc.request('deletePolicy', { name: policy.name, ...(policy.operator === true ? { operator: true } : {}) }))}
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
        <label class="check">
          <input type="checkbox" bind:checked={policyOperator} data-testid="policy-operator" />
          <span>{t('rabbit.admin.operatorPolicy')}</span>
        </label>
        {#if policyOperator}
          <p class="hint">{t('rabbit.admin.operatorHint')}</p>
        {/if}
        <div class="fields-box" role="group" aria-label={t('rabbit.admin.policy.settings')}>
          <span class="legend">{t('rabbit.admin.policy.settings')}</span>
          <div class="fields" data-testid="policy-fields">
          {#each fields as field (field.key)}
            <label class="field">
              <span class="mono">{field.key}</span>
              {#if field.kind === 'select'}
                <select class="control" bind:value={policyValues[field.key]} aria-label={field.key} data-testid="field-{field.key}">
                  <option value="">{t('rabbit.admin.policy.unset')}</option>
                  {#each field.options ?? [] as option (option)}
                    <option value={option}>{option}</option>
                  {/each}
                </select>
              {:else}
                {@const hint = hintOf(field)}
                <input
                  class="control mono"
                  type="text"
                  inputmode={field.kind === 'number' ? 'numeric' : 'text'}
                  bind:value={policyValues[field.key]}
                  placeholder={hint === undefined ? '' : t(hint)}
                  aria-label={field.key}
                  data-testid="field-{field.key}"
                  autocomplete="off"
                  spellcheck="false"
                />
              {/if}
            </label>
          {/each}
          </div>
        </div>
        <label class="field">
          <span>{t('rabbit.admin.policy.extra')}</span>
          <textarea class="control mono" rows="3" bind:value={policyExtra} placeholder={'{"queue-version": 2}'} aria-label={t('rabbit.admin.definition')} spellcheck="false"></textarea>
        </label>
        {#if policyProblem !== undefined}
          <p class="notice error" role="alert" data-testid="policy-problem"><Icon name="error" /><span>{policyProblem}</span></p>
        {/if}
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
    /* A column that wraps stretches its items to the height of the page. */
    flex-wrap: nowrap;
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

  .fields-box {
    position: relative;
    padding: var(--dn-gap-m);
    border: 1px solid var(--dn-border);
    border-radius: var(--dn-radius-l);
  }

  .fields-box .legend {
    display: block;
    margin-bottom: var(--dn-gap);
    color: var(--dn-muted);
    font-size: var(--dn-font-small);
  }

  .fields {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
    gap: var(--dn-gap) var(--dn-gap-m);
  }

  .limit {
    display: flex;
    flex-wrap: wrap;
    gap: var(--dn-gap);
    align-items: center;
    padding: var(--dn-gap-s) 0;
  }

  .limit-name {
    min-width: 130px;
    font-size: var(--dn-font-small);
  }

  .limit-input {
    width: 110px;
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

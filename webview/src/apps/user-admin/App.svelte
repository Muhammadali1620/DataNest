<script lang="ts">
  import { onMount } from 'svelte';
  import type {
    AdminChange,
    AdminGrant,
    AdminLevel,
    AdminUser,
    UserAdminProtocol,
    UserAdminState,
  } from '../../../../src/shared/protocols/user-admin';
  import type { RpcPeer } from '../../../../src/shared/rpc';
  import Field from '../../components/Field.svelte';
  import Icon from '../../components/Icon.svelte';
  import IconButton from '../../components/IconButton.svelte';
  import type { MessageKey } from '../../l10n/en';
  import type { Translate } from '../../lib/i18n';
  import {
    filterUsers,
    type GrantForm,
    grantChange,
    grantReady,
    privilegesOf,
    ref,
    revokeChange,
    sortGrants,
    targetFields,
    targetLabel,
    userKey,
    userLabel,
  } from './users-view';

  interface Props {
    rpc: RpcPeer<UserAdminProtocol['webview'], UserAdminProtocol['host']>;
    t: Translate;
  }

  const { rpc, t }: Props = $props();

  type Mode = 'none' | 'create' | 'password' | 'grant';

  let page = $state<UserAdminState | undefined>(undefined);
  let users = $state<AdminUser[]>([]);
  let filter = $state('');
  let chosenKey = $state<string | undefined>(undefined);
  let grants = $state<AdminGrant[]>([]);
  let mode = $state<Mode>('none');
  let pending = $state<{ change: AdminChange; statements: string[] } | undefined>(undefined);
  let error = $state<string | undefined>(undefined);
  let notice = $state<string | undefined>(undefined);
  let busy = $state(false);

  const create = $state({ name: '', host: '%', password: '', options: ['login'] as string[] });
  let newPassword = $state('');
  const form = $state<GrantForm & { privileges: string[] }>({
    level: 'server',
    database: '',
    schema: '',
    name: '',
    role: '',
    host: '%',
    privileges: [],
    grantable: false,
  });
  const suggestions = $state<{ database: string[]; schema: string[]; name: string[] }>({
    database: [],
    schema: [],
    name: [],
  });

  const features = $derived(page?.features);
  const shownUsers = $derived(filterUsers(users, filter));
  const chosen = $derived(users.find((user) => userKey(user) === chosenKey));
  const shownGrants = $derived(sortGrants(grants));
  const roles = $derived(users.filter((user) => user.role === true || features?.hosts === true));

  const LEVEL_KEYS: Record<AdminLevel, MessageKey> = {
    server: 'users.level.server',
    database: 'users.level.database',
    schema: 'users.level.schema',
    allTables: 'users.level.allTables',
    table: 'users.level.table',
    sequence: 'users.level.sequence',
    routine: 'users.level.routine',
    role: 'users.level.role',
  };
  const FLAG_KEYS: Readonly<Record<string, MessageKey>> = {
    locked: 'users.flag.locked',
    expired: 'users.flag.expired',
    superuser: 'users.flag.superuser',
    createdb: 'users.flag.createdb',
    createrole: 'users.flag.createrole',
    replication: 'users.flag.replication',
    'users.xml': 'users.flag.file',
    'no login': 'users.flag.noLogin',
    'fixed role': 'users.flag.fixedRole',
  };
  const OPTION_KEYS: Readonly<Record<string, MessageKey>> = {
    login: 'users.option.login',
    superuser: 'users.option.superuser',
    createdb: 'users.option.createdb',
    createrole: 'users.option.createrole',
  };

  /** Locked and expired accounts cannot sign in: their marks warn. */
  const WARNING_FLAGS: ReadonlySet<string> = new Set(['locked', 'expired']);

  function flagText(flag: string): string {
    const key = FLAG_KEYS[flag];
    return key === undefined ? flag : t(key);
  }

  function failure(caught: unknown): string {
    return caught instanceof Error ? caught.message : String(caught);
  }

  async function loadUsers(): Promise<void> {
    try {
      users = (await rpc.request('users', {})).rows;
      error = undefined;
    } catch (caught) {
      error = failure(caught);
    }
  }

  async function loadGrants(user: AdminUser | undefined): Promise<void> {
    grants = [];
    if (user === undefined) {
      return;
    }
    try {
      const answer = await rpc.request('grants', { user: ref(user) });
      if (chosenKey === userKey(user)) {
        grants = answer.rows;
      }
    } catch (caught) {
      error = failure(caught);
    }
  }

  function choose(user: AdminUser): void {
    chosenKey = userKey(user);
    mode = 'none';
    pending = undefined;
    notice = undefined;
    void loadGrants(user);
  }

  async function preview(change: AdminChange): Promise<void> {
    notice = undefined;
    try {
      const answer = await rpc.request('preview', { change });
      pending = { change, statements: answer.statements };
      error = undefined;
    } catch (caught) {
      pending = undefined;
      error = failure(caught);
    }
  }

  async function run(): Promise<void> {
    const change = pending?.change;
    if (change === undefined) {
      return;
    }
    busy = true;
    try {
      const answer = await rpc.request('run', { change });
      if (!answer.done) {
        return;
      }
      pending = undefined;
      error = undefined;
      notice = t('users.done');
      mode = 'none';
      if (change.kind === 'create') {
        chosenKey = userKey(change.user);
        create.name = '';
        create.password = '';
      } else if (change.kind === 'drop') {
        chosenKey = undefined;
      } else if (change.kind === 'password') {
        newPassword = '';
      }
      await loadUsers();
      await loadGrants(users.find((user) => userKey(user) === chosenKey));
    } catch (caught) {
      error = failure(caught);
    } finally {
      busy = false;
    }
  }

  async function openInEditor(): Promise<void> {
    const change = pending?.change;
    if (change === undefined) {
      return;
    }
    try {
      await rpc.request('openInEditor', { change });
    } catch (caught) {
      error = failure(caught);
    }
  }

  async function suggest(field: 'database' | 'schema' | 'name'): Promise<void> {
    if (features === undefined) {
      return;
    }
    const kind = field === 'name' ? 'table' : field;
    const database = features.tablesIn === 'database' ? form.database : page?.database;
    try {
      const answer = await rpc.request('objects', {
        kind,
        ...(database === undefined || database === '' ? {} : { database }),
        ...(field === 'name' && features.tablesIn === 'schema' && form.schema !== ''
          ? { schema: form.schema }
          : {}),
      });
      suggestions[field] = answer.names;
    } catch {
      // Suggestions are a convenience; typing the name still works.
      suggestions[field] = [];
    }
  }

  function startGrant(): void {
    mode = 'grant';
    pending = undefined;
    notice = undefined;
    const first = features?.levels.find((entry) => entry.level !== 'role');
    form.level = first?.level ?? 'role';
    form.privileges = [];
    form.grantable = false;
  }

  function togglePrivilege(privilege: string, on: boolean): void {
    form.privileges = on
      ? [...form.privileges, privilege]
      : form.privileges.filter((one) => one !== privilege);
  }

  function toggleOption(option: string, on: boolean): void {
    create.options = on
      ? [...create.options, option]
      : create.options.filter((one) => one !== option);
  }

  onMount(() => {
    const subscription = rpc.on('state', (next) => {
      const first = page?.features === undefined && next.features !== undefined;
      page = next;
      if (first) {
        create.options = next.features?.createOptions.includes('login') === true ? ['login'] : [];
        void loadUsers();
      }
    });
    rpc.emit('ready', {});
    return () => {
      subscription.dispose();
    };
  });
</script>

<main class="page">
  <header class="topbar">
    <span class="title-icon"><Icon name="organization" /></span>
    <div class="title">
      <h1>{t('users.title')}</h1>
      {#if page !== undefined}
        <span class="muted small where" data-testid="where">
          {[page.connectionName, page.server, page.database]
            .filter((part) => part !== undefined)
            .join(' · ')}
        </span>
      {/if}
    </div>
    <span class="spacer"></span>
    {#if page !== undefined && features !== undefined}
      <div class="toolbar" role="toolbar" aria-label={t('users.toolbar')}>
        <IconButton
          icon="person-add"
          label={t('users.new')}
          text={t('users.new')}
          pressed={mode === 'create'}
          onclick={() => {
            mode = 'create';
            chosenKey = undefined;
            pending = undefined;
            notice = undefined;
          }}
        />
        <span class="toolbar-separator"></span>
        <IconButton
          icon="refresh"
          label={t('users.refresh')}
          onclick={() => {
            void loadUsers();
            void loadGrants(chosen);
          }}
        />
      </div>
    {/if}
  </header>

  {#if page === undefined || (features === undefined && page.error === undefined)}
    <div class="empty" role="status">
      <span class="empty-icon"><Icon name="loading" size={24} spin /></span>
      <p class="empty-title">{t('users.loading')}</p>
    </div>
  {:else if page.error !== undefined}
    <div class="empty">
      <span class="empty-icon"><Icon name="organization" size={24} /></span>
      <p class="notice error" role="alert"><Icon name="error" /><span>{page.error}</span></p>
    </div>
  {:else if features !== undefined}
    {#if page.readOnly}
      <p class="notice warning read-only"><Icon name="lock" /><span>{t('users.readOnly')}</span></p>
    {/if}
    <div class="columns">
      <aside class="users">
        <div class="search">
          <Icon name="search" />
          <input
            class="control"
            bind:value={filter}
            placeholder={t('users.filter')}
            aria-label={t('users.filter')}
            autocomplete="off"
            spellcheck="false"
          />
        </div>
        <ul class="list" aria-label={t('users.title')}>
          {#each shownUsers as user (userKey(user))}
            <li>
              <button
                type="button"
                class="user"
                aria-pressed={userKey(user) === chosenKey}
                onclick={() => {
                  choose(user);
                }}
              >
                <Icon name={user.role === true ? 'organization' : 'person'} />
                <span class="name">{userLabel(user)}</span>
                {#if user.role === true}<span class="badge outline">{t('users.role')}</span
                  >{:else if !user.login}<span class="badge outline">{t('users.noLogin')}</span
                  >{/if}
                {#each user.flags as flag (flag)}<span
                    class="badge"
                    class:warning={WARNING_FLAGS.has(flag)}
                    class:outline={!WARNING_FLAGS.has(flag)}>{flagText(flag)}</span
                  >{/each}
              </button>
            </li>
          {/each}
        </ul>
        {#if shownUsers.length === 0}
          <p class="muted small none">{t('users.none')}</p>
        {/if}
      </aside>

      <section class="details">
        <div class="details-scroll">
          {#if error !== undefined}
            <p class="notice error fade-in" role="alert"><Icon name="error" /><span>{error}</span></p>
          {/if}
          {#if notice !== undefined}
            <p class="notice success fade-in" role="status">
              <Icon name="pass" /><span>{notice}</span>
            </p>
          {/if}

          {#if mode === 'create'}
            <form
              class="card form"
              onsubmit={(event) => {
                event.preventDefault();
                void preview({
                  kind: 'create',
                  user: features.hosts
                    ? { name: create.name.trim(), host: create.host.trim() || '%' }
                    : { name: create.name.trim() },
                  password: create.password,
                  options: create.options,
                });
              }}
            >
              <h2 class="section-title"><Icon name="person-add" />{t('users.newTitle')}</h2>
              <div class="pair">
                <Field label={t('users.name')}>
                  <input
                    class="control"
                    bind:value={create.name}
                    required
                    autocomplete="off"
                    spellcheck="false"
                  />
                </Field>
                {#if features.hosts}
                  <Field label={t('users.host')}>
                    <input
                      class="control"
                      bind:value={create.host}
                      autocomplete="off"
                      spellcheck="false"
                    />
                  </Field>
                {/if}
              </div>
              <Field label={features.passwordOptional ? t('users.passwordOptional') : t('users.password')}>
                <input
                  class="control"
                  type="password"
                  autocomplete="new-password"
                  bind:value={create.password}
                  required={!features.passwordOptional}
                />
              </Field>
              {#if features.createOptions.length > 0}
                <div class="checks">
                  {#each features.createOptions as option (option)}
                    <label class="check">
                      <input
                        type="checkbox"
                        checked={create.options.includes(option)}
                        onchange={(event) => {
                          toggleOption(option, event.currentTarget.checked);
                        }}
                      />
                      {OPTION_KEYS[option] === undefined ? option : t(OPTION_KEYS[option])}
                    </label>
                  {/each}
                </div>
              {/if}
              <div class="form-actions">
                <button type="submit" class="button" disabled={create.name.trim() === ''}
                  ><Icon name="preview" />{t('users.preview')}</button
                >
              </div>
            </form>
          {:else if chosen !== undefined}
            <div class="account">
              <span class="account-icon"
                ><Icon name={chosen.role === true ? 'organization' : 'person'} size={20} /></span
              >
              <div class="account-text">
                <h2>{userLabel(chosen)}</h2>
                {#if chosen.memberOf.length > 0}
                  <p class="muted small member">{t('users.memberOf', chosen.memberOf.join(', '))}</p>
                {/if}
              </div>
              <span class="spacer"></span>
              {#if chosen.readOnly !== true}
                <div class="toolbar actions" role="toolbar" aria-label={t('users.actions')}>
                  {#if chosen.login}
                    <IconButton
                      icon="key"
                      label={t('users.changePassword')}
                      text={t('users.changePassword')}
                      pressed={mode === 'password'}
                      onclick={() => {
                        mode = 'password';
                        pending = undefined;
                      }}
                    />
                  {/if}
                  {#if features.lock && chosen.login}
                    {@const locked = chosen.flags.includes('locked')}
                    <IconButton
                      icon={locked ? 'unlock' : 'lock'}
                      label={locked ? t('users.unlock') : t('users.lock')}
                      text={locked ? t('users.unlock') : t('users.lock')}
                      onclick={() =>
                        void preview({ kind: locked ? 'unlock' : 'lock', user: ref(chosen) })}
                    />
                  {/if}
                  <IconButton
                    icon="add"
                    label={t('users.grant')}
                    text={t('users.grant')}
                    pressed={mode === 'grant'}
                    onclick={startGrant}
                  />
                  <span class="toolbar-separator"></span>
                  <IconButton
                    icon="trash"
                    class="danger"
                    label={chosen.role === true ? t('users.dropRole') : t('users.drop')}
                    text={chosen.role === true ? t('users.dropRole') : t('users.drop')}
                    onclick={() =>
                      void preview({
                        kind: 'drop',
                        user: ref(chosen),
                        ...(chosen.role === true ? { role: true } : {}),
                      })}
                  />
                </div>
              {/if}
            </div>
            {#if chosen.readOnly === true}
              <p class="notice info"><Icon name="info" /><span>{t('users.fileUser')}</span></p>
            {/if}

            {#if mode === 'password'}
              <form
                class="card form"
                onsubmit={(event) => {
                  event.preventDefault();
                  void preview({ kind: 'password', user: ref(chosen), password: newPassword });
                }}
              >
                <h3 class="section-title"><Icon name="key" />{t('users.changePassword')}</h3>
                <Field label={t('users.newPassword')}>
                  <input
                    class="control"
                    type="password"
                    autocomplete="new-password"
                    bind:value={newPassword}
                    required
                  />
                </Field>
                <div class="form-actions">
                  <button type="submit" class="button" disabled={newPassword === ''}
                    ><Icon name="preview" />{t('users.preview')}</button
                  >
                </div>
              </form>
            {:else if mode === 'grant'}
              <form
                class="card form"
                onsubmit={(event) => {
                  event.preventDefault();
                  void preview(grantChange(chosen, form, features));
                }}
              >
                <h3 class="section-title"><Icon name="add" />{t('users.grantTitle')}</h3>
                <div class="pair">
                  <Field label={t('users.level')}>
                    <select
                      class="control"
                      bind:value={form.level}
                      onchange={() => (form.privileges = [])}
                    >
                      {#each features.levels as entry (entry.level)}
                        <option value={entry.level}>{t(LEVEL_KEYS[entry.level])}</option>
                      {/each}
                    </select>
                  </Field>
                  {#each targetFields(form.level, features) as field (field)}
                    {#if field === 'role'}
                      <Field label={t('users.roleName')}>
                        <input
                          class="control"
                          list="dn-roles"
                          bind:value={form.role}
                          autocomplete="off"
                        />
                      </Field>
                      <datalist id="dn-roles"
                        >{#each roles as role (userKey(role))}<option value={role.name}
                          ></option>{/each}</datalist
                      >
                    {:else if field === 'host'}
                      <Field label={t('users.roleHost')}>
                        <input class="control" bind:value={form.host} autocomplete="off" />
                      </Field>
                    {:else}
                      <Field
                        label={field === 'database'
                          ? t('users.database')
                          : field === 'schema'
                            ? t('users.schema')
                            : t('users.object')}
                      >
                        <input
                          class="control"
                          list={`dn-${field}`}
                          bind:value={form[field]}
                          autocomplete="off"
                          onfocus={() => void suggest(field)}
                        />
                      </Field>
                      <datalist id={`dn-${field}`}
                        >{#each suggestions[field] as name (name)}<option value={name}
                          ></option>{/each}</datalist
                      >
                    {/if}
                  {/each}
                </div>
                {#if form.level !== 'role'}
                  <fieldset class="privileges">
                    <legend>{t('users.privileges')}</legend>
                    {#each privilegesOf(features, form.level) as privilege (privilege)}
                      <label class="check">
                        <input
                          type="checkbox"
                          checked={form.privileges.includes(privilege)}
                          onchange={(event) => {
                            togglePrivilege(privilege, event.currentTarget.checked);
                          }}
                        />
                        <code>{privilege}</code>
                      </label>
                    {/each}
                  </fieldset>
                {/if}
                <label class="check">
                  <input type="checkbox" bind:checked={form.grantable} />
                  {form.level === 'role' ? t('users.adminOption') : t('users.grantOption')}
                </label>
                <div class="form-actions">
                  <button type="submit" class="button" disabled={!grantReady(form, features)}
                    ><Icon name="preview" />{t('users.preview')}</button
                  >
                </div>
              </form>
            {/if}

            <section class="grants" aria-label={t('users.privileges')}>
              <h3 class="section-title"><Icon name="shield" />{t('users.grants', grants.length)}</h3>
              {#if shownGrants.length === 0}
                <p class="muted small">{t('users.noGrants')}</p>
              {:else}
                <div class="scroll">
                  <table data-testid="grants">
                    <thead>
                      <tr>
                        <th>{t('users.level')}</th>
                        <th>{t('users.object')}</th>
                        <th>{t('users.privilege')}</th>
                        <th class="flag">{t('users.grantable')}</th>
                        <th><span class="sr-only">{t('users.actions')}</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {#each shownGrants as grant, index (index)}
                        <tr>
                          <td>{t(LEVEL_KEYS[grant.level])}</td>
                          <td class="code">{targetLabel(grant)}</td>
                          <td class="code">{grant.privilege}</td>
                          <td class="flag"
                            >{#if grant.grantable}<Icon name="check" /><span class="sr-only"
                                >{t('users.grantableYes')}</span
                              >{/if}</td
                          >
                          <td class="row-action">
                            {#if grant.fixed !== true && chosen.readOnly !== true}
                              <button
                                type="button"
                                class="link-button"
                                onclick={() => void preview(revokeChange(chosen, grant))}
                                >{t('users.revoke')}</button
                              >
                            {/if}
                          </td>
                        </tr>
                      {/each}
                    </tbody>
                  </table>
                </div>
              {/if}
            </section>
          {:else}
            <div class="empty">
              <span class="empty-icon"><Icon name="person" size={24} /></span>
              <p class="empty-title">{t('users.pick')}</p>
            </div>
          {/if}
        </div>

        {#if pending !== undefined}
          <section class="pending fade-in" data-testid="preview" aria-label={t('users.previewTitle')}>
            <h3 class="section-title"><Icon name="code" />{t('users.previewTitle')}</h3>
            <pre>{pending.statements.join(';\n')};</pre>
            <div class="pending-actions">
              <span class="spacer"></span>
              <button type="button" class="button secondary" onclick={() => (pending = undefined)}
                >{t('users.cancel')}</button
              >
              <button type="button" class="button secondary" onclick={() => void openInEditor()}
                ><Icon name="go-to-file" />{t('users.openInEditor')}</button
              >
              <button
                type="button"
                class="button"
                disabled={busy || page.readOnly}
                onclick={() => void run()}
                ><Icon name={busy ? 'loading' : 'play'} spin={busy} />{t('users.run')}</button
              >
            </div>
          </section>
        {/if}
      </section>
    </div>
  {/if}
</main>

<style>
  .page {
    display: flex;
    flex-direction: column;
    height: 100vh;
  }

  /* The title and the page's own actions, as a view's title bar. */
  .topbar {
    display: flex;
    flex: none;
    flex-wrap: wrap;
    gap: var(--dn-gap) var(--dn-gap-m);
    align-items: center;
    padding: var(--dn-gap-m) var(--dn-gap-l);
    border-bottom: 1px solid var(--dn-divider);
  }

  .title-icon {
    display: inline-flex;
    padding: 6px;
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
    border-radius: var(--dn-radius-l);
  }

  .title {
    display: flex;
    flex-wrap: wrap;
    gap: 2px var(--dn-gap-m);
    align-items: baseline;
    min-width: 0;
  }

  .title h1 {
    font-size: 15px;
  }

  .spacer {
    flex: 1;
  }

  .read-only {
    flex: none;
    margin: var(--dn-gap-m) var(--dn-gap-l) 0;
  }

  .columns {
    display: grid;
    flex: 1;
    grid-template-columns: minmax(220px, 300px) 1fr;
    min-height: 0;
  }

  /* The accounts: a list like the editor's views, with a filter on top. */
  .users {
    display: flex;
    flex-direction: column;
    gap: var(--dn-gap);
    min-height: 0;
    padding: var(--dn-gap-m) var(--dn-gap);
    overflow: auto;
    border-right: 1px solid var(--dn-divider);
  }

  .search {
    position: relative;
    display: flex;
    flex: none;
    margin: 0 var(--dn-gap-s);
  }

  .search > :global(.codicon-glyph) {
    position: absolute;
    top: 5px;
    left: 7px;
    color: var(--dn-muted);
    pointer-events: none;
  }

  .search input {
    flex: 1;
    min-width: 0;
    padding-left: 28px;
  }

  .list {
    display: flex;
    flex-direction: column;
    gap: 1px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .user {
    display: flex;
    flex-wrap: wrap;
    gap: var(--dn-gap-s) 6px;
    align-items: center;
    width: 100%;
    min-height: 26px;
    padding: 3px var(--dn-gap);
    color: var(--vscode-foreground);
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--dn-radius);
    font: inherit;
    text-align: left;
    cursor: pointer;
    transition: background-color var(--dn-duration) var(--dn-ease);
  }

  .user > :global(.codicon-glyph) {
    color: var(--dn-muted);
  }

  .user:hover:not([aria-pressed='true']) {
    background: var(--vscode-list-hoverBackground);
  }

  .user[aria-pressed='true'] {
    color: var(--vscode-list-activeSelectionForeground);
    background: var(--vscode-list-activeSelectionBackground);
  }

  .user[aria-pressed='true'] > :global(.codicon-glyph) {
    color: inherit;
  }

  .name {
    font-family: var(--dn-mono);
  }

  .none {
    margin: 0 var(--dn-gap);
  }

  /* The chosen account: scrolls, with the SQL to run pinned under it. */
  .details {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }

  .details-scroll {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--dn-gap-m);
    min-height: 0;
    padding: var(--dn-gap-l) var(--dn-gap-xl) var(--dn-gap-xl);
    overflow: auto;
  }

  .details-scroll > .notice {
    margin: 0;
  }

  .account {
    display: flex;
    flex-wrap: wrap;
    gap: var(--dn-gap) var(--dn-gap-m);
    align-items: center;
  }

  .account-icon {
    display: inline-flex;
    padding: 8px;
    color: var(--dn-muted);
    background: var(--dn-surface);
    border: 1px solid var(--dn-border);
    border-radius: 50%;
  }

  .account-text {
    min-width: 0;
  }

  .account h2 {
    font-family: var(--dn-mono);
    font-size: 15px;
    overflow-wrap: anywhere;
  }

  .member {
    margin: 2px 0 0;
  }

  .actions {
    flex: 0 1 auto;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .actions :global(.icon-button.danger) {
    color: var(--dn-danger);
  }

  .section-title {
    display: flex;
    gap: var(--dn-gap);
    align-items: center;
    margin: 0;
    font-size: 13px;
    font-weight: 600;
  }

  .section-title :global(.codicon-glyph) {
    color: var(--dn-muted);
  }

  .form {
    display: flex;
    flex-direction: column;
    gap: var(--dn-gap-m);
    max-width: 640px;
  }

  .pair {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: var(--dn-gap-m);
  }

  .checks {
    display: flex;
    flex-direction: column;
    gap: var(--dn-gap);
  }

  .check {
    display: flex;
    gap: var(--dn-gap);
    align-items: center;
    cursor: pointer;
  }

  .privileges {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
    gap: var(--dn-gap) var(--dn-gap-m);
    margin: 0;
    padding: var(--dn-gap) var(--dn-gap-m) var(--dn-gap-m);
    border: 1px solid var(--dn-border);
    border-radius: var(--dn-radius);
  }

  .privileges legend {
    padding: 0 var(--dn-gap-s);
    color: var(--dn-muted);
    font-size: var(--dn-font-small);
  }

  .privileges code {
    padding: 0;
    color: inherit;
    background: none;
    font-size: var(--dn-font-small);
  }

  .form-actions {
    display: flex;
    justify-content: flex-end;
  }

  .grants {
    display: flex;
    flex-direction: column;
    gap: var(--dn-gap);
    margin-top: var(--dn-gap-s);
  }

  .grants p {
    margin: 0;
  }

  .scroll {
    overflow-x: auto;
  }

  table {
    width: 100%;
    border-collapse: collapse;
  }

  th {
    padding: 0 10px 6px;
    color: var(--dn-muted);
    font-size: var(--dn-font-small);
    font-weight: 600;
    text-align: left;
    white-space: nowrap;
    border-bottom: 1px solid var(--dn-divider);
  }

  td {
    padding: 5px 10px;
    text-align: left;
    border-bottom: 1px solid var(--dn-divider);
    user-select: text;
  }

  tbody tr:last-child td {
    border-bottom: none;
  }

  tbody tr {
    transition: background-color var(--dn-duration) var(--dn-ease);
  }

  tbody tr:hover {
    background: var(--vscode-list-hoverBackground);
  }

  .code {
    font-family: var(--dn-mono);
    font-size: var(--dn-font-small);
  }

  .flag {
    width: 1%;
    color: var(--dn-success);
    text-align: center;
    white-space: nowrap;
  }

  th.flag {
    color: var(--dn-muted);
  }

  .row-action {
    width: 1%;
    text-align: right;
    white-space: nowrap;
  }

  /* The SQL a change runs: pinned under the account, with what to do with it. */
  .pending {
    display: flex;
    flex: none;
    flex-direction: column;
    gap: var(--dn-gap);
    max-height: 45%;
    padding: var(--dn-gap-m) var(--dn-gap-xl);
    background: var(--dn-surface);
    border-top: 1px solid var(--dn-divider);
    box-shadow: var(--dn-shadow);
  }

  .pending pre {
    min-height: 0;
    margin: 0;
    padding: var(--dn-gap) var(--dn-gap-m);
    overflow: auto;
    background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background));
    border: 1px solid var(--dn-border);
    border-radius: var(--dn-radius);
    font-family: var(--dn-mono);
    font-size: var(--vscode-editor-font-size);
    white-space: pre-wrap;
    word-break: break-word;
    user-select: text;
  }

  .pending-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--dn-gap);
    align-items: center;
  }

  .empty {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--dn-gap);
    align-items: center;
    justify-content: center;
    padding: var(--dn-gap-xl);
    color: var(--dn-muted);
    text-align: center;
  }

  .empty .notice {
    margin: 0;
  }

  .empty-icon {
    display: inline-flex;
    padding: 12px;
    background: var(--dn-surface);
    border: 1px solid var(--dn-border);
    border-radius: 50%;
  }

  .empty-title {
    margin: 0;
    color: var(--vscode-foreground);
    font-size: 14px;
  }

  @media (max-width: 600px) {
    .columns {
      grid-template-columns: 1fr;
      grid-template-rows: minmax(120px, 34%) 1fr;
    }

    .users {
      border-right: none;
      border-bottom: 1px solid var(--dn-divider);
    }

    .topbar,
    .details-scroll,
    .pending {
      padding-right: var(--dn-gap-m);
      padding-left: var(--dn-gap-m);
    }
  }
</style>

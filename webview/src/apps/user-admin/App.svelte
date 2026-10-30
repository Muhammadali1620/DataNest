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

<main>
  <header class="bar">
    <h1>{t('users.title')}</h1>
    {#if page !== undefined}
      <span class="hint" data-testid="where">
        {[page.connectionName, page.server, page.database].filter((part) => part !== undefined).join(' · ')}
      </span>
      <span class="grow"></span>
      {#if features !== undefined}
        <button
          type="button"
          class="button secondary"
          onclick={() => {
            void loadUsers();
            void loadGrants(chosen);
          }}>{t('users.refresh')}</button
        >
      {/if}
    {/if}
  </header>

  {#if page === undefined || (features === undefined && page.error === undefined)}
    <p class="hint">{t('users.loading')}</p>
  {:else if page.error !== undefined}
    <p class="error" role="alert">{page.error}</p>
  {:else if features !== undefined}
    {#if page.readOnly}
      <p class="hint">{t('users.readOnly')}</p>
    {/if}
    <div class="columns">
      <aside class="users">
        <div class="row">
          <input class="control" bind:value={filter} placeholder={t('users.filter')} aria-label={t('users.filter')} />
          <button
            type="button"
            class="button"
            onclick={() => {
              mode = 'create';
              chosenKey = undefined;
              pending = undefined;
              notice = undefined;
            }}>{t('users.new')}</button
          >
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
                <span class="name">{userLabel(user)}</span>
                {#if user.role === true}<span class="badge">{t('users.role')}</span>{:else if !user.login}<span class="badge">{t('users.noLogin')}</span>{/if}
                {#each user.flags as flag (flag)}<span class="badge" class:warn={flag === 'locked' || flag === 'expired'}>{flagText(flag)}</span>{/each}
              </button>
            </li>
          {/each}
        </ul>
        {#if shownUsers.length === 0}
          <p class="hint">{t('users.none')}</p>
        {/if}
      </aside>

      <section class="details">
        {#if error !== undefined}
          <p class="error" role="alert">{error}</p>
        {/if}
        {#if notice !== undefined}
          <p class="notice" role="status">{notice}</p>
        {/if}

        {#if mode === 'create'}
          <h2>{t('users.newTitle')}</h2>
          <form
            class="form"
            onsubmit={(event) => {
              event.preventDefault();
              void preview({
                kind: 'create',
                user: features.hosts ? { name: create.name.trim(), host: create.host.trim() || '%' } : { name: create.name.trim() },
                password: create.password,
                options: create.options,
              });
            }}
          >
            <label>{t('users.name')} <input class="control" bind:value={create.name} required /></label>
            {#if features.hosts}
              <label>{t('users.host')} <input class="control" bind:value={create.host} /></label>
            {/if}
            <label>
              {features.passwordOptional ? t('users.passwordOptional') : t('users.password')}
              <input class="control" type="password" autocomplete="new-password" bind:value={create.password} required={!features.passwordOptional} />
            </label>
            {#each features.createOptions as option (option)}
              <label class="inline">
                <input type="checkbox" checked={create.options.includes(option)} onchange={(event) => {
                    toggleOption(option, event.currentTarget.checked);
                  }} />
                {OPTION_KEYS[option] === undefined ? option : t(OPTION_KEYS[option])}
              </label>
            {/each}
            <div class="row"><button type="submit" class="button" disabled={create.name.trim() === ''}>{t('users.preview')}</button></div>
          </form>
        {:else if chosen !== undefined}
          <div class="row">
            <h2>{userLabel(chosen)}</h2>
            <span class="grow"></span>
            {#if chosen.login && chosen.readOnly !== true}
              <button type="button" class="button secondary" onclick={() => {
                mode = 'password';
                pending = undefined;
              }}>{t('users.changePassword')}</button>
            {/if}
            {#if features.lock && chosen.login && chosen.readOnly !== true}
              <button
                type="button"
                class="button secondary"
                onclick={() => void preview({ kind: chosen.flags.includes('locked') ? 'unlock' : 'lock', user: ref(chosen) })}
                >{chosen.flags.includes('locked') ? t('users.unlock') : t('users.lock')}</button
              >
            {/if}
            {#if chosen.readOnly !== true}
              <button type="button" class="button secondary" onclick={startGrant}>{t('users.grant')}</button>
              <button
                type="button"
                class="button secondary danger"
                onclick={() => void preview({ kind: 'drop', user: ref(chosen), ...(chosen.role === true ? { role: true } : {}) })}
                >{chosen.role === true ? t('users.dropRole') : t('users.drop')}</button
              >
            {/if}
          </div>
          {#if chosen.readOnly === true}
            <p class="hint">{t('users.fileUser')}</p>
          {/if}
          {#if chosen.memberOf.length > 0}
            <p class="hint">{t('users.memberOf', chosen.memberOf.join(', '))}</p>
          {/if}

          {#if mode === 'password'}
            <form
              class="form"
              onsubmit={(event) => {
                event.preventDefault();
                void preview({ kind: 'password', user: ref(chosen), password: newPassword });
              }}
            >
              <label>{t('users.newPassword')} <input class="control" type="password" autocomplete="new-password" bind:value={newPassword} required /></label>
              <div class="row"><button type="submit" class="button" disabled={newPassword === ''}>{t('users.preview')}</button></div>
            </form>
          {:else if mode === 'grant'}
            <form
              class="form"
              onsubmit={(event) => {
                event.preventDefault();
                void preview(grantChange(chosen, form, features));
              }}
            >
              <label>
                {t('users.level')}
                <select class="control" bind:value={form.level} onchange={() => (form.privileges = [])}>
                  {#each features.levels as entry (entry.level)}
                    <option value={entry.level}>{t(LEVEL_KEYS[entry.level])}</option>
                  {/each}
                </select>
              </label>
              {#each targetFields(form.level, features) as field (field)}
                {#if field === 'role'}
                  <label>{t('users.roleName')} <input class="control" list="dn-roles" bind:value={form.role} /></label>
                  <datalist id="dn-roles">{#each roles as role (userKey(role))}<option value={role.name}></option>{/each}</datalist>
                {:else if field === 'host'}
                  <label>{t('users.roleHost')} <input class="control" bind:value={form.host} /></label>
                {:else}
                  <label>
                    {field === 'database' ? t('users.database') : field === 'schema' ? t('users.schema') : t('users.object')}
                    <input class="control" list={`dn-${field}`} bind:value={form[field]} onfocus={() => void suggest(field)} />
                  </label>
                  <datalist id={`dn-${field}`}>{#each suggestions[field] as name (name)}<option value={name}></option>{/each}</datalist>
                {/if}
              {/each}
              {#if form.level !== 'role'}
                <fieldset class="privileges">
                  <legend>{t('users.privileges')}</legend>
                  {#each privilegesOf(features, form.level) as privilege (privilege)}
                    <label class="inline">
                      <input type="checkbox" checked={form.privileges.includes(privilege)} onchange={(event) => {
                          togglePrivilege(privilege, event.currentTarget.checked);
                        }} />
                      {privilege}
                    </label>
                  {/each}
                </fieldset>
              {/if}
              <label class="inline"><input type="checkbox" bind:checked={form.grantable} /> {form.level === 'role' ? t('users.adminOption') : t('users.grantOption')}</label>
              <div class="row"><button type="submit" class="button" disabled={!grantReady(form, features)}>{t('users.preview')}</button></div>
            </form>
          {/if}

          <h3>{t('users.grants', grants.length)}</h3>
          {#if shownGrants.length === 0}
            <p class="hint">{t('users.noGrants')}</p>
          {:else}
            <table data-testid="grants">
              <thead>
                <tr><th>{t('users.level')}</th><th>{t('users.object')}</th><th>{t('users.privilege')}</th><th>{t('users.grantable')}</th><th></th></tr>
              </thead>
              <tbody>
                {#each shownGrants as grant, index (index)}
                  <tr>
                    <td>{t(LEVEL_KEYS[grant.level])}</td>
                    <td>{targetLabel(grant)}</td>
                    <td>{grant.privilege}</td>
                    <td>{grant.grantable ? '✓' : ''}</td>
                    <td>
                      {#if grant.fixed !== true && chosen.readOnly !== true}
                        <button type="button" class="link" onclick={() => void preview(revokeChange(chosen, grant))}>{t('users.revoke')}</button>
                      {/if}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {/if}
        {:else}
          <p class="hint">{t('users.pick')}</p>
        {/if}

        {#if pending !== undefined}
          <section class="preview" data-testid="preview">
            <h3>{t('users.previewTitle')}</h3>
            <pre>{pending.statements.join(';\n')};</pre>
            <div class="row">
              <button type="button" class="button" disabled={busy || page.readOnly} onclick={() => void run()}>{t('users.run')}</button>
              <button type="button" class="button secondary" onclick={() => void openInEditor()}>{t('users.openInEditor')}</button>
              <button type="button" class="button secondary" onclick={() => (pending = undefined)}>{t('users.cancel')}</button>
            </div>
          </section>
        {/if}
      </section>
    </div>
  {/if}
</main>

<style>
  main {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 8px 12px;
    height: 100vh;
    box-sizing: border-box;
  }
  .bar,
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  h1 {
    font-size: 1.2em;
    margin: 0;
  }
  h2 {
    font-size: 1.1em;
    margin: 0;
  }
  h3 {
    font-size: 1em;
    margin: 8px 0 4px;
  }
  .grow {
    flex: 1;
  }
  .hint {
    color: var(--vscode-descriptionForeground);
    margin: 0;
  }
  .error {
    color: var(--vscode-errorForeground);
    margin: 0;
    white-space: pre-wrap;
  }
  .notice {
    color: var(--vscode-gitDecoration-addedResourceForeground, var(--vscode-foreground));
    margin: 0;
  }
  .columns {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(220px, 300px) 1fr;
    gap: 12px;
  }
  .users,
  .details {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-height: 0;
    overflow: auto;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .user {
    width: 100%;
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    align-items: center;
    text-align: left;
    font: inherit;
    color: var(--vscode-foreground);
    background: transparent;
    border: none;
    padding: 3px 6px;
    cursor: pointer;
  }
  .user[aria-pressed='true'] {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
  }
  .user:hover:not([aria-pressed='true']) {
    background: var(--vscode-list-hoverBackground);
  }
  .name {
    font-family: var(--vscode-editor-font-family, monospace);
  }
  .badge {
    font-size: 0.85em;
    padding: 0 4px;
    border-radius: 3px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
  }
  .badge.warn {
    background: var(--vscode-inputValidation-warningBackground, var(--vscode-badge-background));
  }
  .form {
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-width: 520px;
    padding: 8px;
    border: 1px solid var(--vscode-panel-border, transparent);
  }
  .form label:not(.inline) {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .inline {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .privileges {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
    gap: 2px 10px;
    border: 1px solid var(--vscode-panel-border, transparent);
  }
  table {
    border-collapse: collapse;
    width: 100%;
    font-size: 0.95em;
  }
  th,
  td {
    text-align: left;
    padding: 2px 8px;
    border-bottom: 1px solid var(--vscode-panel-border, transparent);
    user-select: text;
  }
  th {
    color: var(--vscode-descriptionForeground);
    font-weight: normal;
  }
  td:nth-child(2),
  td:nth-child(3) {
    font-family: var(--vscode-editor-font-family, monospace);
  }
  .link {
    font: inherit;
    background: none;
    border: none;
    padding: 0;
    color: var(--vscode-textLink-foreground);
    cursor: pointer;
  }
  .danger {
    color: var(--vscode-errorForeground);
  }
  .preview {
    padding: 8px;
    border: 1px solid var(--vscode-focusBorder);
  }
  pre {
    margin: 0 0 8px;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: var(--vscode-editor-font-family, monospace);
    user-select: text;
  }
</style>

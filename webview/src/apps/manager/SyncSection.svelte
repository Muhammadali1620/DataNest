<script lang="ts">
  import { onMount } from 'svelte';
  import type {
    ManagerProtocol,
    ManagerScope,
    ManagerState,
    ManagerSyncConnection,
  } from '../../../../src/shared/protocols/manager';
  import type { RpcPeer } from '../../../../src/shared/rpc';
  import type { SchemaCompareProtocol } from '../../../../src/shared/protocols/schema-compare';
  import Icon from '../../components/Icon.svelte';
  import type { Translate } from '../../lib/i18n';
  import { scopedRpc } from '../../lib/scoped-rpc';
  import CompareApp from '../schema-compare/App.svelte';

  interface Props {
    rpc: RpcPeer<ManagerProtocol['webview'], ManagerProtocol['host']>;
    t: Translate;
    page: ManagerState;
  }

  const { rpc, t, page }: Props = $props();

  interface Side {
    connectionId: string;
    database: string;
    schema: string;
    databases: string[];
    schemas: string[];
  }

  let connections = $state<ManagerSyncConnection[]>([]);
  // The page's own scope is where the form starts; the user changes it from there.
  // svelte-ignore state_referenced_locally
  let source = $state<Side>(empty(page.connectionId, page.database ?? '', page.schema ?? ''));
  let target = $state<Side>(empty('', '', ''));
  let started = $state(false);
  let busy = $state(false);
  let error = $state<string | undefined>(undefined);

  const comparison = $derived(
    scopedRpc<SchemaCompareProtocol['webview'], SchemaCompareProtocol['host']>(rpc, 'compare'),
  );

  function empty(connectionId: string, database: string, schema: string): Side {
    return { connectionId, database, schema, databases: [], schemas: [] };
  }

  const ready = $derived(
    source.connectionId !== '' &&
      target.connectionId !== '' &&
      !(source.connectionId === target.connectionId &&
        source.database === target.database &&
        source.schema === target.schema),
  );

  function failure(value: unknown): string {
    return value instanceof Error ? value.message : String(value);
  }

  /** Reads the databases and schemas the connection offers and picks sensible ones. */
  async function fill(side: Side): Promise<Side> {
    if (side.connectionId === '') {
      return side;
    }
    const scopes = await rpc.request('sync.scopes', {
      connectionId: side.connectionId,
      ...(side.database === '' ? {} : { database: side.database }),
    });
    return {
      ...side,
      ...scopes,
      database: scopes.databases.includes(side.database) ? side.database : (scopes.databases[0] ?? ''),
      schema: scopes.schemas.includes(side.schema) ? side.schema : (scopes.schemas[0] ?? ''),
    };
  }

  async function pick(which: 'source' | 'target', change: Partial<Side>): Promise<void> {
    try {
      const next = await fill({ ...(which === 'source' ? source : target), ...change });
      if (which === 'source') {
        source = next;
      } else {
        target = next;
      }
      error = undefined;
    } catch (problem) {
      error = failure(problem);
    }
  }

  function scopeOf(side: Side): ManagerScope {
    return {
      connectionId: side.connectionId,
      ...(side.database === '' ? {} : { database: side.database }),
      ...(side.schema === '' ? {} : { schema: side.schema }),
    };
  }

  async function compare(): Promise<void> {
    busy = true;
    error = undefined;
    try {
      await rpc.request('sync.start', { source: scopeOf(source), target: scopeOf(target) });
      started = true;
    } catch (problem) {
      error = failure(problem);
    } finally {
      busy = false;
    }
  }

  onMount(() => {
    void (async () => {
      try {
        connections = (await rpc.request('sync.options', {})).connections;
        source = await fill(source);
      } catch (problem) {
        error = failure(problem);
      }
    })();
  });
</script>

{#if started}
  <div class="compare">
    <div class="back">
      <button
        type="button"
        class="button secondary"
        onclick={() => {
          started = false;
        }}><Icon name="arrow-left" />{t('manager.sync.back')}</button
      >
    </div>
    <div class="host"><CompareApp rpc={comparison} {t} embedded /></div>
  </div>
{:else}
  <section class="sync" aria-label={t('manager.section.sync')}>
    <h2 class="section-head"><Icon name="git-compare" tone="purple" />{t('manager.sync.title')}</h2>
    <p class="muted small">{t('manager.sync.hint')}</p>
    {#if error !== undefined}
      <div class="notice error" role="alert"><Icon name="error" /><span class="pre">{error}</span></div>
    {/if}
    <div class="pair">
      {#each [{ which: 'source', side: source, title: 'manager.sync.reference', icon: 'database' }, { which: 'target', side: target, title: 'manager.sync.target', icon: 'target' }] as const as column (column.which)}
        <div class="card side" data-testid="sync-{column.which}">
          <h3><Icon name={column.icon} tone={column.which === 'source' ? 'blue' : 'orange'} />{t(column.title)}</h3>
          <label class="field">
            <span class="label">{t('manager.sync.connection')}</span>
            <select
              class="control"
              value={column.side.connectionId}
              onchange={(event) => {
                void pick(column.which, { connectionId: event.currentTarget.value, database: '', schema: '' });
              }}
            >
              <option value="" disabled>{t('manager.sync.select')}</option>
              {#each connections as connection (connection.id)}
                <option value={connection.id}>{connection.name}</option>
              {/each}
            </select>
          </label>
          {#if column.side.databases.length > 0}
            <label class="field">
              <span class="label">{t('manager.dump.database')}</span>
              <select
                class="control"
                value={column.side.database}
                onchange={(event) => {
                  void pick(column.which, { database: event.currentTarget.value, schema: '' });
                }}
              >
                {#each column.side.databases as name (name)}
                  <option value={name}>{name}</option>
                {/each}
              </select>
            </label>
          {/if}
          {#if column.side.schemas.length > 0}
            <label class="field">
              <span class="label">{t('manager.dump.schema')}</span>
              <select
                class="control"
                value={column.side.schema}
                onchange={(event) => {
                  void pick(column.which, { schema: event.currentTarget.value });
                }}
              >
                {#each column.side.schemas as name (name)}
                  <option value={name}>{name}</option>
                {/each}
              </select>
            </label>
          {/if}
        </div>
        {#if column.which === 'source'}
          <span class="arrow" aria-hidden="true"><Icon name="arrow-right" size={20} /></span>
        {/if}
      {/each}
    </div>
    <div class="go">
      <button type="button" class="button" disabled={!ready || busy} onclick={() => void compare()}>
        <Icon name={busy ? 'loading' : 'git-compare'} spin={busy} />{t('manager.sync.compare')}
      </button>
    </div>
  </section>
{/if}

<style>
  .sync {
    display: flex;
    flex-direction: column;
    gap: var(--dn-gap-m);
    height: 100%;
    padding: var(--dn-gap-m) var(--dn-gap-l);
    overflow: auto;
  }

  .compare {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }

  .back {
    flex: none;
    padding: var(--dn-gap) var(--dn-gap-m);
    border-bottom: 1px solid var(--dn-divider);
  }

  .host {
    flex: 1;
    min-height: 0;
  }

  .pair {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    gap: var(--dn-gap-m);
    align-items: start;
  }

  .side {
    display: flex;
    flex-direction: column;
    gap: var(--dn-gap);
    padding: var(--dn-gap-m);
  }

  h3 {
    display: flex;
    gap: 8px;
    align-items: center;
    margin: 0;
    font-size: 13px;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .label {
    font-size: var(--dn-font-small);
    color: var(--dn-muted);
  }

  .arrow {
    align-self: center;
    color: var(--dn-muted);
  }

  .go {
    display: flex;
    justify-content: center;
  }

  @media (max-width: 640px) {
    .pair {
      grid-template-columns: 1fr;
    }

    .arrow {
      display: none;
    }
  }
</style>

<script lang="ts">
  import { onMount } from 'svelte';
  import type { ToolsAction, ToolsProtocol } from '../../../../src/shared/protocols/tools';
  import type { RpcPeer } from '../../../../src/shared/rpc';
  import type { SettingGroup, SettingItem, SettingValue } from '../../../../src/shared/tools/settings-map';
  import Icon from '../../components/Icon.svelte';
  import IconButton from '../../components/IconButton.svelte';
  import type { CodiconName } from '../../lib/codicons';
  import type { Translate } from '../../lib/i18n';
  import Card from './Card.svelte';

  interface Props {
    rpc: RpcPeer<ToolsProtocol['webview'], ToolsProtocol['host']>;
    t: Translate;
  }

  const { rpc, t }: Props = $props();

  let groups = $state<SettingGroup[]>([]);
  let loaded = $state(false);
  let problem = $state<string | undefined>(undefined);
  let done = $state<string | undefined>(undefined);
  let doneTimer: ReturnType<typeof setTimeout> | undefined;

  const SECTIONS = ['connections', 'other'] as const;

  const ACTIONS: readonly { id: ToolsAction; icon: CodiconName; label: string; section: 'connections' | 'other'; tone: 'blue' | 'green' | 'orange' | 'red' | 'purple' }[] = [
    { id: 'exportConnections', icon: 'export', label: 'tools.set.export', section: 'connections', tone: 'blue' },
    { id: 'importConnections', icon: 'cloud-download', label: 'tools.set.import', section: 'connections', tone: 'green' },
    { id: 'closeConnections', icon: 'debug-disconnect', label: 'tools.set.closeAll', section: 'other', tone: 'orange' },
    { id: 'clearCache', icon: 'clear-all', label: 'tools.set.clearCache', section: 'other', tone: 'purple' },
    { id: 'reportIssue', icon: 'link-external', label: 'tools.set.report', section: 'other', tone: 'red' },
  ];

  const GROUP_ICONS: Record<SettingGroup['id'], CodiconName> = {
    general: 'settings-gear',
    editor: 'edit',
    format: 'json',
    sql: 'database',
    tree: 'list-tree',
    result: 'table',
    redis: 'key',
  };

  function note(text: string): void {
    done = text;
    clearTimeout(doneTimer);
    doneTimer = setTimeout(() => {
      done = undefined;
    }, 2500);
  }

  async function load(): Promise<void> {
    try {
      groups = (await rpc.request('settingsList', {})).groups;
    } catch {
      problem = t('tools.set.failed');
    }
    loaded = true;
  }

  async function save(item: SettingItem, value: SettingValue): Promise<void> {
    problem = undefined;
    try {
      const answer = await rpc.request('settingsSet', { id: item.id, value });
      if (!answer.ok) {
        problem = t('tools.set.rejected', item.id);
        await load();
      }
    } catch {
      problem = t('tools.set.failed');
    }
  }

  async function reset(group: SettingGroup): Promise<void> {
    problem = undefined;
    try {
      await rpc.request('settingsReset', { ids: group.items.map((item) => item.id) });
      note(t('tools.set.resetDone', t(`tools.set.group.${group.id}`)));
      await load();
    } catch {
      problem = t('tools.set.failed');
    }
  }

  async function act(action: ToolsAction): Promise<void> {
    problem = undefined;
    try {
      const answer = await rpc.request('runAction', { action });
      if (answer.ok) {
        const ACTION_DONE: Partial<Record<ToolsAction, 'tools.set.closeDone' | 'tools.set.cacheDone'>> = {
          closeConnections: 'tools.set.closeDone',
          clearCache: 'tools.set.cacheDone',
        };
        const text = ACTION_DONE[action];
        if (text !== undefined) {
          note(t(text));
        }
      } else {
        problem = t('tools.set.failed');
      }
    } catch {
      problem = t('tools.set.failed');
    }
  }

  /** A number field commits on change: a half-typed value is not a setting yet. */
  function commitNumber(item: SettingItem, event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    const value = Number(input.value);
    if (input.value.trim() === '' || !Number.isFinite(value)) {
      input.value = String(item.value);
      return;
    }
    if (value !== item.value) {
      void save(item, value);
    }
  }

  onMount(() => {
    void load();
    const subscription = rpc.on('settingsChanged', (next) => {
      groups = next.groups;
    });
    return () => {
      subscription.dispose();
      clearTimeout(doneTimer);
    };
  });
</script>

<div class="set">
  <div class="col">
    {#each SECTIONS as section (section)}
      <Card
        title={t(`tools.set.section.${section}`)}
        icon={section === 'connections' ? 'plug' : 'tools'}
        tone={section === 'connections' ? 'blue' : 'orange'}
      >
        <div class="buttons">
          {#each ACTIONS.filter((action) => action.section === section) as action (action.id)}
            <button type="button" class="button secondary" data-testid={`act-${action.id}`} onclick={() => { void act(action.id); }}>
              <Icon name={action.icon} />{t(action.label as 'tools.set.export')}
            </button>
          {/each}
        </div>
        {#if section === 'connections'}
          <p class="muted small">{t('tools.set.noCloud')}</p>
        {/if}
      </Card>
    {/each}
    {#if done !== undefined}
      <p class="notice success" role="status" data-testid="set-done"><Icon name="pass" size={14} />{done}</p>
    {/if}
    {#if problem !== undefined}
      <p class="notice error" role="alert" data-testid="set-problem"><Icon name="error" size={14} />{problem}</p>
    {/if}
  </div>

  <div class="col wide">
    {#each groups as group (group.id)}
      <Card title={t(`tools.set.group.${group.id}`)} icon={GROUP_ICONS[group.id]} tone="teal">
        {#snippet actions()}
          <IconButton icon="discard" tone="orange" label={t('tools.set.reset', t(`tools.set.group.${group.id}`))} data-testid={`reset-${group.id}`} onclick={() => { void reset(group); }} />
        {/snippet}
        <ul class="items">
          {#each group.items as item (item.id)}
            <li data-testid={`item-${item.id}`}>
              {#if item.kind === 'boolean'}
                <label class="tl-check">
                  <input type="checkbox" checked={item.value === true} onchange={(event) => { void save(item, event.currentTarget.checked); }} />
                  <span>{item.label}</span>
                </label>
              {:else}
                <label class="field">
                  <span>{item.label}</span>
                  {#if item.kind === 'choice'}
                    <select class="control" value={String(item.value)} onchange={(event) => { void save(item, event.currentTarget.value); }}>
                      {#each item.choices ?? [] as choice (choice.value)}
                        <option value={choice.value}>{choice.label}</option>
                      {/each}
                    </select>
                  {:else if item.kind === 'number'}
                    <input class="control num" type="number" value={item.value} min={item.min} max={item.max} step={item.integer === true ? 1 : 'any'} onchange={(event) => { commitNumber(item, event); }} />
                  {:else}
                    <input class="control text" value={String(item.value)} maxlength="200" onchange={(event) => { void save(item, event.currentTarget.value); }} />
                  {/if}
                </label>
              {/if}
              <code class="id" title={item.description}>{item.id}{#if item.value !== item.default}<span class="changed" title={t('tools.set.changed')}> ●</span>{/if}</code>
            </li>
          {/each}
        </ul>
      </Card>
    {/each}
    {#if loaded && groups.length === 0}
      <p class="muted">{t('tools.set.empty')}</p>
    {/if}
  </div>
</div>

<style>
  .set {
    display: grid;
    grid-template-columns: minmax(280px, 380px) minmax(0, 1fr);
    gap: 14px;
    align-items: start;
  }

  @media (max-width: 760px) {
    .set {
      grid-template-columns: minmax(0, 1fr);
    }
  }

  .col {
    display: flex;
    flex-direction: column;
    gap: 14px;
    min-width: 0;
  }

  .col.wide {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
    align-items: start;
  }

  .buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .items {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .field {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 12px;
    align-items: center;
    justify-content: space-between;
  }

  .field > span {
    flex: 1;
    min-width: 180px;
  }

  .num {
    width: 120px;
  }

  .text {
    width: 160px;
  }

  .id {
    display: block;
    margin-top: 2px;
    color: var(--dn-muted);
    font-family: var(--dn-mono);
    font-size: 11px;
  }

  .changed {
    color: var(--dn-accent);
  }
</style>

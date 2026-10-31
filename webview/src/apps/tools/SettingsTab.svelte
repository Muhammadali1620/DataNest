<script lang="ts">
  import { onMount } from 'svelte';
  import type { ToolsAction, ToolsProtocol } from '../../../../src/shared/protocols/tools';
  import type { RpcPeer } from '../../../../src/shared/rpc';
  import {
    type SettingGroup,
    type SettingItem,
    type SettingValue,
    detailOf,
    inlineSpans,
  } from '../../../../src/shared/tools/settings-map';
  import Icon from '../../components/Icon.svelte';
  import IconButton from '../../components/IconButton.svelte';
  import type { CodiconName } from '../../lib/codicons';
  import type { Translate } from '../../lib/i18n';
  import Card from './Card.svelte';
  import { useToolsState } from './state';

  interface Props {
    rpc: RpcPeer<ToolsProtocol['webview'], ToolsProtocol['host']>;
    t: Translate;
  }

  const { rpc, t }: Props = $props();
  const remember = useToolsState();

  let groups = $state<SettingGroup[]>([]);
  let loaded = $state(false);
  let problem = $state<string | undefined>(undefined);
  let done = $state<string | undefined>(undefined);
  let doneTimer: ReturnType<typeof setTimeout> | undefined;

  const SECTIONS = ['connections', 'other'] as const;

  const ACTIONS: readonly {
    id: ToolsAction;
    icon: CodiconName;
    label: string;
    section: 'connections' | 'other';
  }[] = [
    { id: 'exportConnections', icon: 'export', label: 'tools.set.export', section: 'connections' },
    {
      id: 'importConnections',
      icon: 'cloud-download',
      label: 'tools.set.import',
      section: 'connections',
    },
    {
      id: 'closeConnections',
      icon: 'debug-disconnect',
      label: 'tools.set.closeAll',
      section: 'other',
    },
    { id: 'clearCache', icon: 'clear-all', label: 'tools.set.clearCache', section: 'other' },
    { id: 'reportIssue', icon: 'link-external', label: 'tools.set.report', section: 'other' },
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

  /** The nav: our two cards first, then the groups of settings. */
  const entries = $derived<{ id: string; icon: CodiconName; label: string }[]>([
    { id: 'connections', icon: 'plug', label: t('tools.set.section.connections') },
    { id: 'other', icon: 'tools', label: t('tools.set.section.other') },
    ...groups.map((group) => ({
      id: group.id,
      icon: GROUP_ICONS[group.id],
      label: t(`tools.set.group.${group.id}`),
    })),
  ]);

  let current = $state(remember.get('set.section', 'connections'));
  let content = $state<HTMLElement | undefined>(undefined);

  function go(id: string): void {
    current = id;
    remember.set('set.section', id);
    const target = content?.querySelector(`[data-section="${id}"]`);
    // jsdom has no layout; in the editor the section scrolls to the top.
    if (target instanceof HTMLElement && typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  }

  // The nav follows the scroll: the section nearest the top edge is the current one.
  $effect(() => {
    if (groups.length === 0 || content === undefined || typeof IntersectionObserver === 'undefined') {
      return;
    }
    const tops: Record<string, number> = {};
    const observer = new IntersectionObserver(
      (changes) => {
        for (const change of changes) {
          const id = (change.target as HTMLElement).dataset.section;
          if (id !== undefined) {
            tops[id] = change.isIntersecting ? change.boundingClientRect.top : Infinity;
          }
        }
        let nearest: string | undefined;
        let distance = Infinity;
        for (const [id, top] of Object.entries(tops)) {
          if (Math.abs(top) < distance) {
            nearest = id;
            distance = Math.abs(top);
          }
        }
        if (nearest !== undefined) {
          current = nearest;
        }
      },
      { rootMargin: '0px 0px -70% 0px' },
    );
    for (const section of content.querySelectorAll('[data-section]')) {
      observer.observe(section);
    }
    return () => {
      observer.disconnect();
    };
  });

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
        const ACTION_DONE: Partial<
          Record<ToolsAction, 'tools.set.closeDone' | 'tools.set.cacheDone'>
        > = {
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

{#snippet rich(text: string)}{#each inlineSpans(text) as span, index (index)}{#if span.style === 'code'}<code>{span.text}</code>{:else if span.style === 'bold'}<strong>{span.text}</strong>{:else}{span.text}{/if}{/each}{/snippet}

<div class="set">
  <nav class="nav" aria-label={t('tools.tab.settings')}>
    {#each entries as entry (entry.id)}
      <button
        type="button"
        class="nav-item"
        class:current={current === entry.id}
        aria-current={current === entry.id ? 'true' : undefined}
        data-testid={`nav-${entry.id}`}
        onclick={() => {
          go(entry.id);
        }}
      >
        <Icon name={entry.icon} size={14} /><span>{entry.label}</span>
      </button>
    {/each}
  </nav>

  <div class="content" bind:this={content}>
    {#if done !== undefined}
      <p class="notice success" role="status" data-testid="set-done">
        <Icon name="pass" size={14} />{done}
      </p>
    {/if}
    {#if problem !== undefined}
      <p class="notice error" role="alert" data-testid="set-problem">
        <Icon name="error" size={14} />{problem}
      </p>
    {/if}

    {#each SECTIONS as section (section)}
      <div class="section" data-section={section}>
        <Card
          title={t(`tools.set.section.${section}`)}
          icon={section === 'connections' ? 'plug' : 'tools'}
          tone={section === 'connections' ? 'blue' : 'orange'}
        >
          <div class="buttons">
            {#each ACTIONS.filter((action) => action.section === section) as action (action.id)}
              <button
                type="button"
                class="button secondary"
                data-testid={`act-${action.id}`}
                onclick={() => {
                  void act(action.id);
                }}
              >
                <Icon name={action.icon} />{t(action.label as 'tools.set.export')}
              </button>
            {/each}
          </div>
          {#if section === 'connections'}
            <p class="muted small">{t('tools.set.noCloud')}</p>
          {/if}
        </Card>
      </div>
    {/each}

    {#each groups as group (group.id)}
      <div class="section" data-section={group.id}>
        <Card title={t(`tools.set.group.${group.id}`)} icon={GROUP_ICONS[group.id]} tone="teal">
          {#snippet actions()}
            <span class="count">{group.items.length}</span>
            <IconButton
              icon="discard"
              tone="orange"
              label={t('tools.set.reset', t(`tools.set.group.${group.id}`))}
              data-testid={`reset-${group.id}`}
              onclick={() => {
                void reset(group);
              }}
            />
          {/snippet}
          <ul class="items">
            {#each group.items as item (item.id)}
              <li data-testid={`item-${item.id}`}>
                <label class="row">
                  <span class="text">
                    <span class="label">{@render rich(item.label)}</span>
                    {#if detailOf(item.description) !== ''}
                      <span class="detail">{@render rich(detailOf(item.description))}</span>
                    {/if}
                    <code class="id"
                      >{item.id}{#if item.value !== item.default}<span
                          class="changed"
                          title={t('tools.set.changed')}
                          aria-label={t('tools.set.changed')}
                        >
                          ●</span
                        >{/if}</code
                    >
                  </span>
                  <span class="control-cell">
                    {#if item.kind === 'boolean'}
                      <input
                        type="checkbox"
                        checked={item.value === true}
                        onchange={(event) => {
                          void save(item, event.currentTarget.checked);
                        }}
                      />
                    {:else if item.kind === 'choice'}
                      <select
                        class="control"
                        value={String(item.value)}
                        onchange={(event) => {
                          void save(item, event.currentTarget.value);
                        }}
                      >
                        {#each item.choices ?? [] as choice (choice.value)}
                          <option value={choice.value}>{choice.label}</option>
                        {/each}
                      </select>
                    {:else if item.kind === 'number'}
                      <input
                        class="control"
                        type="number"
                        value={item.value}
                        min={item.min}
                        max={item.max}
                        step={item.integer === true ? 1 : 'any'}
                        onchange={(event) => {
                          commitNumber(item, event);
                        }}
                      />
                    {:else}
                      <input
                        class="control"
                        value={String(item.value)}
                        maxlength="200"
                        onchange={(event) => {
                          void save(item, event.currentTarget.value);
                        }}
                      />
                    {/if}
                  </span>
                </label>
              </li>
            {/each}
          </ul>
        </Card>
      </div>
    {/each}
    {#if loaded && groups.length === 0}
      <p class="muted">{t('tools.set.empty')}</p>
    {/if}
  </div>
</div>

<style>
  .set {
    display: grid;
    grid-template-columns: 190px minmax(0, 1fr);
    gap: 20px;
    align-items: start;
  }

  .nav {
    position: sticky;
    top: 8px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px;
    background: var(--dn-surface);
    border: 1px solid var(--dn-border);
    border-radius: 14px;
  }

  .nav-item {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 6px 10px;
    color: var(--dn-muted);
    text-align: left;
    cursor: pointer;
    background: none;
    border: 0;
    border-radius: 9px;
    transition:
      background var(--dn-duration),
      color var(--dn-duration);
  }

  .nav-item:hover {
    color: var(--vscode-foreground);
    background: var(--dn-hover);
  }

  .nav-item.current {
    color: var(--vscode-foreground);
    background: color-mix(in srgb, var(--dn-accent) 18%, transparent);
  }

  .content {
    display: flex;
    flex-direction: column;
    gap: 14px;
    width: 100%;
    max-width: 820px;
    min-width: 0;
  }

  .section {
    scroll-margin-top: 8px;
  }

  .buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .buttons .button {
    border: 1px solid var(--dn-border);
  }

  .count {
    padding: 0 7px;
    font-size: var(--dn-font-small);
    color: var(--dn-muted);
    background: var(--dn-hover);
    border-radius: 9px;
  }

  .items {
    display: flex;
    flex-direction: column;
    padding: 0;
    margin: -4px -14px;
    list-style: none;
  }

  .items li + li {
    border-top: 1px solid var(--dn-divider);
  }

  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 180px;
    gap: 16px;
    align-items: center;
    padding: 12px 14px;
    cursor: pointer;
  }

  .row:hover {
    background: var(--dn-hover);
  }

  .text {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }

  .label {
    line-height: 1.35;
  }

  .detail {
    font-size: var(--dn-font-small);
    line-height: 1.4;
    color: var(--dn-muted);
  }

  .label :global(code),
  .detail :global(code) {
    padding: 0 4px;
    font-family: var(--dn-mono);
    font-size: 0.92em;
    background: var(--dn-hover);
    border-radius: 4px;
  }

  .id {
    font-family: var(--dn-mono);
    font-size: 11px;
    color: var(--dn-muted);
    word-break: break-all;
    opacity: 0.8;
  }

  .changed {
    color: var(--dn-accent);
  }

  /* Every control sits in one right-hand column, at one width, one row on top of another. */
  .control-cell {
    display: flex;
    justify-content: flex-end;
  }

  .control-cell .control {
    width: 100%;
  }

  @media (max-width: 640px) {
    .set {
      grid-template-columns: minmax(0, 1fr);
      gap: 12px;
    }

    .nav {
      top: 0;
      z-index: 2;
      flex-direction: row;
      gap: 4px;
      padding: 4px;
      overflow-x: auto;
      white-space: nowrap;
      scrollbar-width: none;
      border-radius: 999px;
    }

    .nav-item {
      border-radius: 999px;
    }

    .row {
      grid-template-columns: minmax(0, 1fr);
      gap: 8px;
    }

    .control-cell {
      justify-content: flex-start;
    }

    .control-cell .control {
      max-width: 260px;
    }
  }
</style>

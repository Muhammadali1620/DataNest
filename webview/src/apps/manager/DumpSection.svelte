<script lang="ts">
  import { onMount } from 'svelte';
  import type {
    ManagerDumpOptions,
    ManagerDumpReport,
    ManagerProtocol,
  } from '../../../../src/shared/protocols/manager';
  import type { RpcPeer } from '../../../../src/shared/rpc';
  import { formatBytes } from '../redis-key/key-view';
  import Icon from '../../components/Icon.svelte';
  import IconButton from '../../components/IconButton.svelte';
  import type { Translate } from '../../lib/i18n';
  import { canRun, filterRelations, setTicked } from './dump-view';
  import { formatTook } from './log-view';

  interface Props {
    rpc: RpcPeer<ManagerProtocol['webview'], ManagerProtocol['host']>;
    t: Translate;
  }

  const { rpc, t }: Props = $props();

  type Content = 'all' | 'structure' | 'data';

  let options = $state<ManagerDumpOptions | undefined>(undefined);
  let database = $state<string | undefined>(undefined);
  let schema = $state<string | undefined>(undefined);
  let ticked = $state<string[]>([]);
  let filter = $state('');
  let routines = $state(true);
  let content = $state<Content>('all');
  let dropFirst = $state(true);
  let output = $state('');
  let error = $state<string | undefined>(undefined);
  let running = $state(false);
  let progress = $state<{ table?: string; rows: number; tablesDone: number; tablesTotal: number } | undefined>(undefined);
  let report = $state<ManagerDumpReport | undefined>(undefined);

  const shown = $derived(options === undefined ? [] : filterRelations(options.relations, filter));
  const allShown = $derived(shown.length > 0 && shown.every((item) => ticked.includes(item.name)));
  const runnable = $derived(canRun(ticked, routines, output) && !running);
  const percent = $derived(
    progress === undefined || progress.tablesTotal === 0
      ? 0
      : Math.min(100, Math.round((progress.tablesDone / progress.tablesTotal) * 100)),
  );

  function failure(value: unknown): string {
    return value instanceof Error ? value.message : String(value);
  }

  async function load(pick: { database?: string; schema?: string }, keepOutput: boolean): Promise<void> {
    try {
      const next = await rpc.request('dump.options', pick);
      options = next;
      database = next.database;
      schema = next.schema;
      ticked = [...next.ticked];
      if (!keepOutput || output === '') {
        output = next.output;
      }
      error = undefined;
    } catch (problem) {
      error = failure(problem);
    }
  }

  async function browse(): Promise<void> {
    try {
      const picked = await rpc.request('dump.browse', { output });
      if (picked.output !== undefined) {
        output = picked.output;
      }
    } catch (problem) {
      error = failure(problem);
    }
  }

  async function run(): Promise<void> {
    running = true;
    report = undefined;
    error = undefined;
    progress = { rows: 0, tablesDone: 0, tablesTotal: 0 };
    try {
      report = await rpc.request('dump.run', {
        ...(database === undefined ? {} : { database }),
        ...(schema === undefined ? {} : { schema }),
        relations: ticked,
        wholeScope: routines,
        content,
        dropFirst,
        output,
      });
    } catch (problem) {
      error = failure(problem);
    } finally {
      running = false;
      progress = undefined;
    }
  }

  async function reveal(how: 'open' | 'folder'): Promise<void> {
    if (report === undefined) {
      return;
    }
    try {
      await rpc.request('dump.reveal', { path: report.path, how });
    } catch (problem) {
      error = failure(problem);
    }
  }

  onMount(() => {
    const subscription = rpc.on('dump.progress', (next) => {
      progress = next;
    });
    void load({}, false);
    return () => {
      subscription.dispose();
    };
  });
</script>

<section class="dump" aria-label={t('manager.section.dump')}>
  <div class="scroll">
    <h2 class="section-head"><Icon name="export" tone="green" />{t('manager.dump.title')}</h2>
    <p class="muted small builtin">{t('manager.dump.builtin')}</p>

    {#if error !== undefined}
      <div class="notice error" role="alert"><Icon name="error" /><span class="pre">{error}</span></div>
    {/if}

    {#if options === undefined}
      {#if error === undefined}
        <p class="muted" role="status"><Icon name="loading" spin />{t('manager.loading')}</p>
      {/if}
    {:else}
      {#if options.databases.length > 0 || options.schemas.length > 0}
        <div class="row-2">
          {#if options.databases.length > 0}
            <label class="field">
              <span class="label">{t('manager.dump.database')}</span>
              <select
                class="control"
                value={database}
                disabled={running}
                onchange={(event) => {
                  void load({ database: event.currentTarget.value }, true);
                }}
              >
                {#each options.databases as name (name)}
                  <option value={name}>{name}</option>
                {/each}
              </select>
            </label>
          {/if}
          {#if options.schemas.length > 0}
            <label class="field">
              <span class="label">{t('manager.dump.schema')}</span>
              <select
                class="control"
                value={schema}
                disabled={running}
                onchange={(event) => {
                  void load(
                    { ...(database === undefined ? {} : { database }), schema: event.currentTarget.value },
                    true,
                  );
                }}
              >
                {#each options.schemas as name (name)}
                  <option value={name}>{name}</option>
                {/each}
              </select>
            </label>
          {/if}
        </div>
      {/if}

      <fieldset class="group" disabled={running}>
        <legend>{t('manager.dump.tables', ticked.length, options.relations.length)}</legend>
        <div class="tools">
          <input
            class="control"
            type="search"
            placeholder={t('manager.dump.filter')}
            aria-label={t('manager.dump.filter')}
            bind:value={filter}
          />
          <button
            type="button"
            class="button secondary"
            onclick={() => {
              ticked = setTicked(ticked, shown.map((item) => item.name), !allShown);
            }}>{allShown ? t('manager.dump.none') : t('manager.dump.all')}</button
          >
        </div>
        <ul class="relations" data-testid="dump-relations">
          {#each shown as item (item.name)}
            <li>
              <label>
                <input
                  type="checkbox"
                  checked={ticked.includes(item.name)}
                  onchange={(event) => {
                    ticked = setTicked(ticked, [item.name], event.currentTarget.checked);
                  }}
                />
                <Icon name={item.kind === 'view' ? 'eye' : 'table'} size={14} tone={item.kind === 'view' ? 'purple' : 'blue'} />
                <span>{item.name}</span>
              </label>
            </li>
          {/each}
          {#if shown.length === 0}
            <li class="muted">{t('manager.dump.nothing')}</li>
          {/if}
        </ul>
        <label class="check">
          <input type="checkbox" bind:checked={routines} />
          {t('manager.dump.routines')}
        </label>
      </fieldset>

      <fieldset class="group" disabled={running}>
        <legend>{t('manager.dump.options')}</legend>
        <div class="radios" role="radiogroup" aria-label={t('manager.dump.content')}>
          {#each ['all', 'structure', 'data'] as const as value (value)}
            <label class="check">
              <input type="radio" name="dump-content" {value} bind:group={content} />
              {t(`manager.dump.content.${value}`)}
            </label>
          {/each}
        </div>
        <label class="check" class:off={content === 'data'}>
          <input type="checkbox" bind:checked={dropFirst} disabled={content === 'data'} />
          {t('manager.dump.drop')}
        </label>
      </fieldset>

      <div class="field">
        <label class="label" for="dump-output">{t('manager.dump.output')}</label>
        <div class="output">
          <input id="dump-output" class="control" bind:value={output} disabled={running} />
          <IconButton icon="folder-opened" tone="orange" label={t('manager.dump.browse')} disabled={running} onclick={() => void browse()} />
        </div>
        <span class="muted small">{t('manager.dump.outputHint')}</span>
      </div>
    {/if}
  </div>

  <footer class="actions">
    <div class="status" aria-live="polite">
      {#if running && progress !== undefined}
        <div class="bar" aria-hidden="true"><span style="transform: scaleX({percent / 100})"></span></div>
        <span class="muted small"
          >{progress.table === undefined
            ? t('manager.dump.running')
            : t(
                'manager.dump.progress',
                progress.table,
                progress.rows,
                Math.min(progress.tablesDone + 1, progress.tablesTotal),
                progress.tablesTotal,
              )}</span
        >
      {:else if report !== undefined}
        <div class="notice success" data-testid="dump-done">
          <Icon name="check" />
          <span
            >{t('manager.dump.done', report.tables, report.views, report.rows, formatBytes(report.bytes), formatTook(report.durationMs))}
            {#if report.skipped.length > 0}<br />{t('manager.dump.skipped', report.skipped.join(', '))}{/if}</span
          >
          <button type="button" class="link-button" onclick={() => void reveal('open')}>{t('manager.dump.open')}</button>
          <button type="button" class="link-button" onclick={() => void reveal('folder')}>{t('manager.dump.folder')}</button>
        </div>
      {/if}
    </div>
    {#if running}
      <button
        type="button"
        class="button danger"
        onclick={() => {
          rpc.emit('dump.cancel', {});
        }}><Icon name="debug-stop" />{t('manager.dump.cancel')}</button
      >
    {/if}
    <button type="button" class="button" disabled={!runnable} onclick={() => void run()}>
      <Icon name={running ? 'loading' : 'play'} spin={running} />{t('manager.dump.run')}
    </button>
  </footer>
</section>

<style>
  .dump {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }

  .scroll {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--dn-gap-m);
    min-height: 0;
    padding: var(--dn-gap-m) var(--dn-gap-l);
    overflow: auto;
  }

  .builtin {
    margin: -8px 0 0;
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

  .group {
    margin: 0;
    padding: var(--dn-gap) var(--dn-gap-m);
    border: 1px solid var(--dn-border);
    border-radius: var(--dn-radius-l);
  }

  legend {
    padding: 0 6px;
    font-size: var(--dn-font-small);
    color: var(--dn-muted);
  }

  .tools {
    display: flex;
    gap: var(--dn-gap);
    margin-bottom: var(--dn-gap);
  }

  .tools input {
    flex: 1;
  }

  .relations {
    max-height: 220px;
    margin: 0 0 var(--dn-gap);
    padding: 0;
    overflow: auto;
    list-style: none;
  }

  .relations label,
  .check {
    display: flex;
    gap: 6px;
    align-items: center;
    padding: 2px 0;
  }

  .radios {
    display: flex;
    flex-wrap: wrap;
    gap: var(--dn-gap-m);
  }

  .off {
    opacity: 0.5;
  }

  .output {
    display: flex;
    gap: var(--dn-gap);
  }

  .output input {
    flex: 1;
  }

  .actions {
    display: flex;
    flex: none;
    gap: var(--dn-gap);
    align-items: center;
    padding: var(--dn-gap) var(--dn-gap-l);
    border-top: 1px solid var(--dn-divider);
    background: var(--dn-surface);
  }

  .status {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }

  .bar {
    height: 4px;
    overflow: hidden;
    background: var(--dn-border);
    border-radius: 2px;
  }

  .bar span {
    display: block;
    height: 100%;
    background: var(--dn-accent);
    transform-origin: left;
    transition: transform var(--dn-duration);
  }
</style>

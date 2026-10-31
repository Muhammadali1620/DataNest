<script lang="ts">
  import { onMount, tick } from 'svelte';
  import type {
    DesignPreview,
    TableDesignerProtocol,
    TableDesignerState,
  } from '../../../../src/shared/protocols/table-designer';
  import type { RpcPeer } from '../../../../src/shared/rpc';
  import {
    DESIGN_LIMITS,
    designProblems,
    type TableDesign,
  } from '../../../../src/shared/table-design';
  import Field from '../../components/Field.svelte';
  import Icon from '../../components/Icon.svelte';
  import type { MessageKey } from '../../l10n/en';
  import type { CodiconName } from '../../lib/codicons';
  import type { Translate } from '../../lib/i18n';
  import ColumnsEditor from './ColumnsEditor.svelte';
  import { problemPlace } from './design-model';
  import ForeignKeysEditor from './ForeignKeysEditor.svelte';
  import IndexesEditor from './IndexesEditor.svelte';

  interface Props {
    rpc: RpcPeer<TableDesignerProtocol['webview'], TableDesignerProtocol['host']>;
    t: Translate;
    /** Milliseconds between the last edit and asking the host for the SQL. */
    previewDelay?: number;
  }

  const { rpc, t, previewDelay = 250 }: Props = $props();

  type Tab = 'columns' | 'indexes' | 'keys' | 'sql';

  const TABS: readonly { readonly id: Tab; readonly label: MessageKey; readonly icon: CodiconName }[] =
    [
      { id: 'columns', label: 'designer.tabColumns', icon: 'symbol-field' },
      { id: 'indexes', label: 'designer.tabIndexes', icon: 'list-ordered' },
      { id: 'keys', label: 'designer.tabKeys', icon: 'references' },
      { id: 'sql', label: 'designer.tabSql', icon: 'code' },
    ];

  const SAVE_MODIFIER = navigator.userAgent.includes('Mac') ? '⌘' : 'Ctrl';

  interface Notice {
    kind: 'info' | 'error';
    text: string;
  }

  let designerState = $state<TableDesignerState | undefined>(undefined);
  let design = $state<TableDesign | undefined>(undefined);
  /** The design as the host sent it: what Revert goes back to. */
  let original = $state<TableDesign | undefined>(undefined);
  let notes = $state<DesignPreview['notes']>([]);
  let tab = $state<Tab>('columns');
  let statements = $state<string[]>([]);
  let previewError = $state<string | undefined>(undefined);
  let saving = $state(false);
  let notice = $state<Notice | undefined>(undefined);
  /** Empty names are not shown as errors until the first save attempt. */
  let showProblems = $state(false);
  /** Tables a foreign key can point at; asked for when the keys tab first opens. */
  let tables = $state<string[]>([]);
  let targetColumns = $state<ReadonlyMap<string, readonly string[]>>(new Map());
  /** Plain, not reactive: only remembers what was already asked for. */
  const requested: string[] = [];
  let tablesRequested = false;
  let tabList = $state<HTMLDivElement | undefined>(undefined);

  const problems = $derived(
    design === undefined || designerState === undefined
      ? []
      : designProblems(design, designerState.driver),
  );
  const tableProblems = $derived(problems.filter((problem) => !('column' in problem)));
  const shownTabs = $derived(
    TABS.filter((item) => item.id !== 'keys' || designerState?.features.foreignKeys !== false),
  );
  /** Tabs with a problem to fix, marked once problems are shown. */
  const troubled = $derived(
    new Set<string>(showProblems ? problems.map((problem) => problemPlace(problem)) : []),
  );

  onMount(() => {
    const subscription = rpc.on('state', (next) => {
      designerState = next;
      design = next.design;
      original = next.design;
      notice = undefined;
      showProblems = false;
    });
    rpc.emit('ready', {});
    return () => {
      subscription.dispose();
    };
  });

  // The SQL follows the design. The effect reads only the design and writes only
  // the preview, so it can never trigger itself.
  $effect(() => {
    const current = design;
    if (current === undefined) {
      return;
    }
    const snapshot: TableDesign = $state.snapshot(current);
    const timer = setTimeout(() => {
      void refreshPreview(snapshot);
    }, previewDelay);
    return () => {
      clearTimeout(timer);
    };
  });

  async function refreshPreview(snapshot: TableDesign): Promise<void> {
    try {
      const result = await rpc.request('preview', snapshot);
      statements = result.statements;
      notes = result.notes;
      previewError = result.error;
    } catch (error) {
      statements = [];
      previewError = messageOf(error);
    }
  }

  async function loadTables(): Promise<void> {
    if (tablesRequested) {
      return;
    }
    tablesRequested = true;
    try {
      tables = (await rpc.request('tables', {})).tables;
    } catch (error) {
      notice = { kind: 'error', text: messageOf(error) };
    }
  }

  async function loadColumns(table: string): Promise<void> {
    if (requested.includes(table)) {
      return;
    }
    requested.push(table);
    let columns: readonly string[] = [];
    try {
      columns = (await rpc.request('columns', { table })).columns;
    } catch (error) {
      notice = { kind: 'error', text: messageOf(error) };
    }
    // Recorded even when empty, so the editor does not ask again.
    targetColumns = new Map([...targetColumns, [table, columns]]);
  }

  function openTab(next: Tab): void {
    tab = next;
    if (next === 'keys') {
      void loadTables();
    }
  }

  /** Arrows, Home and End move between the tabs, as in the editor's own tab lists. */
  async function onTabKey(event: KeyboardEvent): Promise<void> {
    const at = shownTabs.findIndex((item) => item.id === tab);
    const to =
      event.key === 'ArrowRight'
        ? at + 1
        : event.key === 'ArrowLeft'
          ? at - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? shownTabs.length - 1
              : undefined;
    if (to === undefined) {
      return;
    }
    event.preventDefault();
    const next = shownTabs[(to + shownTabs.length) % shownTabs.length];
    if (next !== undefined) {
      openTab(next.id);
      await tick();
      tabList?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
    }
  }

  function countOf(id: Tab): number | undefined {
    if (design === undefined) {
      return undefined;
    }
    switch (id) {
      case 'columns':
        return design.columns.length;
      case 'indexes':
        return design.indexes.length;
      case 'keys':
        return design.foreignKeys.length;
      case 'sql':
        return undefined;
    }
  }

  function messageOf(error: unknown): string {
    return error instanceof Error && error.message !== '' ? error.message : String(error);
  }

  async function save(): Promise<void> {
    if (design === undefined || saving) {
      return;
    }
    showProblems = true;
    if (problems.length > 0) {
      notice = { kind: 'error', text: t('designer.invalid') };
      return;
    }
    saving = true;
    notice = undefined;
    try {
      const { outcome } = await rpc.request('save', $state.snapshot(design));
      if (outcome === 'invalid') {
        notice = { kind: 'error', text: t('designer.invalid') };
      } else if (outcome === 'unchanged') {
        notice = { kind: 'info', text: t('designer.unchanged') };
      }
    } catch (error) {
      notice = { kind: 'error', text: t('designer.saveFailed', messageOf(error)) };
    } finally {
      saving = false;
    }
  }

  function onKeydown(event: KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void save();
    }
  }

  function setName(value: string): void {
    if (design !== undefined) {
      design = { ...design, name: value };
    }
  }

  function setComment(value: string): void {
    if (design !== undefined) {
      design = { ...design, comment: value };
    }
  }

  function setColumns(next: TableDesign): void {
    design = next;
  }

  function revert(): void {
    design = original;
    notice = undefined;
    showProblems = false;
  }

  const editing = $derived(designerState?.mode === 'edit');

  const title = $derived.by(() => {
    if (designerState === undefined) {
      return '';
    }
    const scope = designerState.scope;
    if (designerState.mode === 'edit') {
      const name = original?.name ?? '';
      return t('designer.titleEdit', scope === '' ? name : `${scope}.${name}`);
    }
    return scope === '' ? t('designer.titleNew') : t('designer.titleNewIn', scope);
  });
  const nameError = $derived(
    showProblems && tableProblems.some((problem) => problem.kind === 'table-name')
      ? t('designer.problem.tableName')
      : undefined,
  );
</script>

<svelte:window onkeydown={onKeydown} />

{#if designerState === undefined || design === undefined}
  <div class="empty loading" role="status">
    <span class="empty-icon"><Icon name="loading" size={24} spin /></span>
    <p class="empty-title">{t('designer.loading')}</p>
  </div>
{:else}
  <main class="page">
    <header class="page-header">
      <span class="header-icon"><Icon name="table" size={20} /></span>
      <div class="header-text">
        <h1>{title}</h1>
        <p class="subtitle">{editing ? t('designer.subtitleEdit') : t('designer.subtitle')}</p>
      </div>
    </header>

    <div class="content">
      <section class="card general" aria-label={t('designer.section.table')}>
        <div class="head">
          <Field label={t('designer.name')} error={nameError}>
            <input
              class="control"
              value={design.name}
              maxlength={DESIGN_LIMITS.name}
              aria-invalid={nameError !== undefined}
              autocomplete="off"
              spellcheck="false"
              oninput={(event) => {
                setName(event.currentTarget.value);
              }}
            />
          </Field>
          {#if designerState.features.tableComment}
            <Field label={t('designer.comment')}>
              <input
                class="control"
                value={design.comment}
                maxlength={DESIGN_LIMITS.comment}
                oninput={(event) => {
                  setComment(event.currentTarget.value);
                }}
              />
            </Field>
          {/if}
        </div>

        {#if designerState.kept.columns.length > 0}
          <p class="notice info">
            <Icon name="info" /><span
              >{t('designer.keptColumns', designerState.kept.columns.join(', '))}</span
            >
          </p>
        {/if}
        {#if designerState.kept.indexes.length > 0}
          <p class="notice info">
            <Icon name="info" /><span
              >{t(
                'designer.keptIndexes',
                designerState.kept.indexes
                  .map((index) => `${index.name} ${index.description}`)
                  .join('; '),
              )}</span
            >
          </p>
        {/if}
      </section>

      <section class="card editor">
        <div
          class="tabs"
          role="tablist"
          aria-label={t('designer.section.structure')}
          tabindex="-1"
          bind:this={tabList}
          onkeydown={(event) => void onTabKey(event)}
        >
          {#each shownTabs as item (item.id)}
            {@const count = countOf(item.id)}
            <button
              type="button"
              role="tab"
              class="tab"
              class:troubled={troubled.has(item.id)}
              id="designer-tab-{item.id}"
              aria-selected={tab === item.id}
              aria-controls="designer-panel"
              tabindex={tab === item.id ? 0 : -1}
              onclick={() => {
                openTab(item.id);
              }}
            >
              <Icon name={troubled.has(item.id) ? 'error' : item.icon} /><span
                >{t(item.label)}</span
              >{#if troubled.has(item.id)}<span class="sr-only"
                  >{`, ${t('designer.tabProblems')}`}</span
                >{/if}{#if count !== undefined}<span
                  class="count"
                  aria-hidden="true"
                  data-count={count}
                ></span>{/if}
            </button>
          {/each}
        </div>

        <div
          class="panel"
          id="designer-panel"
          role="tabpanel"
          aria-labelledby="designer-tab-{tab}"
        >
          {#if tab === 'columns'}
            <ColumnsEditor
              {design}
              driver={designerState.driver}
              features={designerState.features}
              canReorder={!editing || designerState.features.reorder}
              {problems}
              {showProblems}
              {t}
              onchange={setColumns}
            />
            {#if showProblems && tableProblems.some((problem) => problem.kind === 'no-columns')}
              <p class="notice error" role="alert">
                <Icon name="error" /><span>{t('designer.problem.noColumns')}</span>
              </p>
            {/if}
          {:else if tab === 'indexes'}
            <IndexesEditor
              {design}
              unique={designerState.features.uniqueIndexes}
              {problems}
              {showProblems}
              {t}
              onchange={setColumns}
            />
          {:else if tab === 'keys'}
            <ForeignKeysEditor
              {design}
              {tables}
              {targetColumns}
              {problems}
              {showProblems}
              {t}
              onchange={setColumns}
              onneedcolumns={(table: string) => void loadColumns(table)}
            />
          {:else}
            <div class="sql">
              {#if previewError !== undefined}
                <p class="notice error" role="alert">
                  <Icon name="error" /><span>{previewError}</span>
                </p>
              {:else if statements.length === 0}
                <div class="empty">
                  <span class="empty-icon"><Icon name="code" size={24} /></span>
                  <p class="empty-title">
                    {editing && problems.length === 0
                      ? t('designer.noChanges')
                      : t('designer.sqlEmpty')}
                  </p>
                </div>
              {:else}
                {#each notes as note (note)}
                  <p class="notice warning" role="note">
                    <Icon name="warning" /><span
                      >{note === 'rebuild'
                        ? t('designer.note.rebuild')
                        : t('designer.note.orderIgnored')}</span
                    >
                  </p>
                {/each}
                <pre data-testid="sql">{statements
                    .map((statement) => `${statement};`)
                    .join('\n\n')}</pre>
                <p class="muted small sql-hint">{t('designer.sqlHint')}</p>
              {/if}
            </div>
          {/if}
        </div>
      </section>
    </div>

    <footer class="actions-bar">
      {#if notice !== undefined}
        <p
          class="notice fade-in"
          class:error={notice.kind === 'error'}
          class:info={notice.kind === 'info'}
          data-testid="notice"
          role="status"
        >
          <Icon name={notice.kind === 'error' ? 'error' : 'info'} /><span>{notice.text}</span>
        </p>
      {/if}
      {#if showProblems && problems.length > 0}
        <span class="badge danger"
          ><Icon name="error" size={12} />{t('designer.problemCount', problems.length)}</span
        >
      {/if}
      <span class="spacer"></span>
      {#if editing}
        <button type="button" class="button secondary" onclick={revert}
          ><Icon name="discard" />{t('designer.revert')}</button
        >
      {/if}
      <button
        type="button"
        class="button secondary"
        onclick={() => {
          rpc.emit('close', {});
        }}>{t('designer.cancel')}</button
      >
      <button
        type="button"
        class="button"
        disabled={saving}
        title={t('designer.saveHint', SAVE_MODIFIER)}
        onclick={() => void save()}
        ><Icon name={saving ? 'loading' : 'save'} spin={saving} />{t('designer.save')}</button
      >
    </footer>
  </main>
{/if}

<style>
  /* The page scrolls; the bar of actions stays at the bottom. */
  .page {
    display: flex;
    flex-direction: column;
    height: 100vh;
  }

  .page-header {
    display: flex;
    flex: none;
    gap: var(--dn-gap-m);
    align-items: center;
    padding: 18px var(--dn-gap-xl) 14px;
  }

  .header-icon {
    display: inline-flex;
    padding: 9px;
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
    border-radius: 10px;
  }

  .header-text {
    min-width: 0;
  }

  h1 {
    overflow-wrap: anywhere;
  }

  .subtitle {
    margin: 2px 0 0;
    color: var(--dn-muted);
  }

  .content {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--dn-gap-m);
    min-height: 0;
    padding: 4px var(--dn-gap-xl) var(--dn-gap-xl);
    overflow-y: auto;
  }

  .general {
    display: flex;
    flex-direction: column;
    gap: var(--dn-gap-m);
  }

  .general .notice {
    margin: 0;
  }

  .head {
    display: grid;
    grid-template-columns: minmax(180px, 320px) minmax(180px, 1fr);
    gap: var(--dn-gap-m);
  }

  .editor {
    padding: 0;
  }

  /* Tabs drawn like the editor's own: a line under the chosen one. */
  .tabs {
    display: flex;
    gap: var(--dn-gap-s);
    padding: 0 var(--dn-gap-m);
    overflow-x: auto;
    border-bottom: 1px solid var(--dn-divider);
  }

  .tab {
    display: inline-flex;
    flex: none;
    gap: 6px;
    align-items: center;
    height: 36px;
    padding: 0 10px;
    color: var(--dn-muted);
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    font: inherit;
    cursor: pointer;
    transition:
      color var(--dn-duration) var(--dn-ease),
      border-color var(--dn-duration) var(--dn-ease);
  }

  .tab:hover {
    color: var(--vscode-foreground);
  }

  .tab[aria-selected='true'] {
    color: var(--vscode-foreground);
    border-bottom-color: var(--vscode-panelTitle-activeBorder, var(--dn-accent));
  }

  .troubled :global(.codicon-glyph) {
    color: var(--dn-danger);
  }

  /* The count is drawn from an attribute: the tab's name stays just its word. */
  .count::before {
    content: attr(data-count);
  }

  .count {
    min-width: 18px;
    height: 16px;
    padding: 0 5px;
    color: var(--vscode-badge-foreground);
    background: var(--vscode-badge-background);
    border-radius: 8px;
    font-size: 11px;
    line-height: 16px;
    text-align: center;
  }

  .panel {
    display: flex;
    flex-direction: column;
    gap: var(--dn-gap-m);
    padding: var(--dn-gap-m) var(--dn-gap-l) var(--dn-gap-l);
  }

  .panel .notice {
    margin: 0;
  }

  .sql {
    display: flex;
    flex-direction: column;
    gap: var(--dn-gap);
  }

  .sql pre {
    margin: 0;
    padding: var(--dn-gap-m);
    overflow: auto;
    background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background));
    border: 1px solid var(--dn-border);
    border-radius: var(--dn-radius);
    font-family: var(--dn-mono);
    font-size: var(--vscode-editor-font-size);
    line-height: 1.5;
    white-space: pre-wrap;
    user-select: text;
  }

  .sql-hint {
    margin: 0;
  }

  /* Pieces the three editors share. */
  .page :global(.design-table) {
    width: 100%;
    border-collapse: collapse;
  }

  .page :global(.design-table th) {
    padding: 0 4px 6px;
    color: var(--dn-muted);
    font-size: var(--dn-font-small);
    font-weight: 600;
    text-align: left;
    white-space: nowrap;
  }

  .page :global(.scroll) {
    overflow-x: auto;
  }

  .page :global(.field-error) {
    display: flex;
    gap: 4px;
    align-items: center;
    color: var(--vscode-inputValidation-errorForeground, var(--dn-danger));
    font-size: var(--dn-font-small);
  }

  .page :global(.field-error > .codicon-glyph) {
    color: var(--dn-danger);
  }

  .page :global(.add) {
    display: flex;
  }

  /* An empty list or a page still loading: an icon in a circle and a phrase. */
  :global(.empty) {
    display: flex;
    flex-direction: column;
    gap: var(--dn-gap);
    align-items: center;
    justify-content: center;
    padding: var(--dn-gap-xl) var(--dn-gap-l) var(--dn-gap-l);
    color: var(--dn-muted);
    text-align: center;
  }

  .loading {
    height: 100vh;
  }

  :global(.empty-icon) {
    display: inline-flex;
    padding: 12px;
    color: var(--dn-muted);
    background: var(--dn-surface);
    border: 1px solid var(--dn-border);
    border-radius: 50%;
  }

  :global(.empty-title) {
    margin: 0;
    color: var(--vscode-foreground);
    font-size: 14px;
  }

  :global(.empty-hint) {
    margin: 0;
    font-size: var(--dn-font-small);
  }

  /* The bar of actions: what happened on the left, what to do on the right. */
  .actions-bar {
    display: flex;
    flex: none;
    flex-wrap: wrap;
    gap: var(--dn-gap);
    align-items: center;
    padding: 10px var(--dn-gap-xl);
    background: var(--vscode-editor-background);
    border-top: 1px solid var(--dn-divider);
  }

  .actions-bar .notice {
    margin: 0;
    padding: 4px 10px;
  }

  .spacer {
    flex: 1;
  }

  @media (max-width: 560px) {
    .head {
      grid-template-columns: 1fr;
    }

    .page-header,
    .content,
    .actions-bar {
      padding-right: var(--dn-gap-m);
      padding-left: var(--dn-gap-m);
    }

    .panel {
      padding-right: var(--dn-gap);
      padding-left: var(--dn-gap);
    }
  }
</style>

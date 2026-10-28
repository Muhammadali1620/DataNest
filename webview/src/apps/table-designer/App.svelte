<script lang="ts">
  import { onMount } from 'svelte';
  import type {
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
  import type { MessageKey } from '../../l10n/en';
  import type { Translate } from '../../lib/i18n';
  import ColumnsEditor from './ColumnsEditor.svelte';
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

  const TABS: readonly { readonly id: Tab; readonly label: MessageKey }[] = [
    { id: 'columns', label: 'designer.tabColumns' },
    { id: 'indexes', label: 'designer.tabIndexes' },
    { id: 'keys', label: 'designer.tabKeys' },
    { id: 'sql', label: 'designer.tabSql' },
  ];

  let designerState = $state<TableDesignerState | undefined>(undefined);
  let design = $state<TableDesign | undefined>(undefined);
  let tab = $state<Tab>('columns');
  let statements = $state<string[]>([]);
  let previewError = $state<string | undefined>(undefined);
  let saving = $state(false);
  let notice = $state<string | undefined>(undefined);
  /** Empty names are not shown as errors until the first save attempt. */
  let showProblems = $state(false);
  /** Tables a foreign key can point at; asked for when the keys tab first opens. */
  let tables = $state<string[]>([]);
  let targetColumns = $state<ReadonlyMap<string, readonly string[]>>(new Map());
  /** Plain, not reactive: only remembers what was already asked for. */
  const requested: string[] = [];
  let tablesRequested = false;

  const problems = $derived(
    design === undefined || designerState === undefined
      ? []
      : designProblems(design, designerState.driver),
  );
  const tableProblems = $derived(problems.filter((problem) => !('column' in problem)));

  onMount(() => {
    const subscription = rpc.on('state', (next) => {
      designerState = next;
      design = next.design;
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
      notice = messageOf(error);
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
      notice = messageOf(error);
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

  function messageOf(error: unknown): string {
    return error instanceof Error && error.message !== '' ? error.message : String(error);
  }

  async function save(): Promise<void> {
    if (design === undefined || saving) {
      return;
    }
    showProblems = true;
    if (problems.length > 0) {
      notice = t('designer.invalid');
      return;
    }
    saving = true;
    notice = undefined;
    try {
      const { outcome } = await rpc.request('save', $state.snapshot(design));
      if (outcome === 'invalid') {
        notice = t('designer.invalid');
      }
    } catch (error) {
      notice = t('designer.saveFailed', messageOf(error));
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

  const title = $derived(
    designerState === undefined || designerState.scope === ''
      ? t('designer.titleNew')
      : t('designer.titleNewIn', designerState.scope),
  );
  const nameError = $derived(
    showProblems && tableProblems.some((problem) => problem.kind === 'table-name')
      ? t('designer.problem.tableName')
      : undefined,
  );
</script>

<svelte:window onkeydown={onKeydown} />

{#if designerState === undefined || design === undefined}
  <p class="loading">{t('designer.loading')}</p>
{:else}
  <main>
    <h1>{title}</h1>
    <div class="head">
      <Field label={t('designer.name')} error={nameError}>
        <input
          class="control"
          value={design.name}
          maxlength={DESIGN_LIMITS.name}
          aria-invalid={nameError !== undefined}
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

    <div class="tabs" role="tablist">
      {#each TABS as item (item.id)}
        <button
          role="tab"
          class="tab"
          aria-selected={tab === item.id}
          onclick={() => {
            openTab(item.id);
          }}>{t(item.label)}</button
        >
      {/each}
    </div>

    {#if tab === 'columns'}
      <ColumnsEditor
        {design}
        driver={designerState.driver}
        features={designerState.features}
        {problems}
        {showProblems}
        {t}
        onchange={setColumns}
      />
      {#if showProblems && tableProblems.some((problem) => problem.kind === 'no-columns')}
        <p class="error" role="alert">{t('designer.problem.noColumns')}</p>
      {/if}
    {:else if tab === 'indexes'}
      <IndexesEditor {design} {problems} {showProblems} {t} onchange={setColumns} />
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
      <section class="sql" aria-label={t('designer.tabSql')}>
        {#if previewError !== undefined}
          <p class="error" role="alert">{previewError}</p>
        {:else if statements.length === 0}
          <p class="hint">{t('designer.sqlEmpty')}</p>
        {:else}
          <pre data-testid="sql">{statements.map((statement) => `${statement};`).join('\n\n')}</pre>
        {/if}
      </section>
    {/if}

    <footer>
      {#if showProblems && problems.length > 0}
        <span class="error">{t('designer.problemCount', problems.length)}</span>
      {/if}
      {#if notice !== undefined}
        <span class="notice" data-testid="notice" role="status">{notice}</span>
      {/if}
      <span class="spacer"></span>
      <button
        class="button secondary"
        onclick={() => {
          rpc.emit('close', {});
        }}>{t('designer.cancel')}</button
      >
      <button class="button" disabled={saving} onclick={() => void save()}
        >{t('designer.save')}</button
      >
    </footer>
  </main>
{/if}

<style>
  main {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 12px 16px;
  }

  h1 {
    margin: 0;
    font-size: 1.3em;
    font-weight: 600;
  }

  .loading {
    padding: 12px 16px;
  }

  .head {
    display: grid;
    grid-template-columns: minmax(200px, 320px) minmax(200px, 1fr);
    gap: 12px;
  }

  .tabs {
    display: flex;
    gap: 4px;
    border-bottom: 1px solid var(--vscode-panel-border, transparent);
  }

  .tab {
    padding: 4px 12px;
    color: var(--vscode-foreground);
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    font: inherit;
    cursor: pointer;
  }

  .tab[aria-selected='true'] {
    border-bottom-color: var(--vscode-focusBorder);
  }

  .sql pre {
    margin: 0;
    padding: 8px;
    overflow: auto;
    background: var(--vscode-textCodeBlock-background);
    font-family: var(--vscode-editor-font-family);
    font-size: var(--vscode-editor-font-size);
    white-space: pre-wrap;
  }

  footer {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .spacer {
    flex: 1;
  }

  .error {
    color: var(--vscode-errorForeground);
  }

  .hint {
    color: var(--vscode-descriptionForeground);
  }

  .notice {
    color: var(--vscode-descriptionForeground);
  }
</style>

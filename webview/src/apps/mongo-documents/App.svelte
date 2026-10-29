<script lang="ts">
  // The documents page of a MongoDB collection (V7.6): a query bar, a page of documents as
  // a table or as text, and the editor of one document. The host parses, reads and writes;
  // this page shows what it sends and asks for the rest.
  import { onMount } from 'svelte';
  import {
    type DocumentQueryText,
    type MongoDocumentsProtocol,
    type MongoDocumentsState,
    PAGE_SIZES,
    type TypedProblem,
  } from '../../../../src/shared/protocols/mongo-documents';
  import type { RpcPeer } from '../../../../src/shared/rpc';
  import type { Translate } from '../../lib/i18n';
  import type { MessageKey } from '../../l10n/en';
  import DocumentEditor from './DocumentEditor.svelte';
  import {
    cellClass,
    groupDigits,
    NEW_DOCUMENT,
    nextSort,
    previousSkip,
    problemText,
    rangeOf,
    sortOf,
  } from './documents-view';

  interface Props {
    rpc: RpcPeer<MongoDocumentsProtocol['webview'], MongoDocumentsProtocol['host']>;
    t: Translate;
  }

  const { rpc, t }: Props = $props();

  const BOX_LABELS: Readonly<Record<TypedProblem['box'], MessageKey>> = {
    filter: 'mongo.filter',
    sort: 'mongo.sort',
    projection: 'mongo.projection',
    document: 'mongo.document',
  };

  let page = $state<MongoDocumentsState | undefined>(undefined);
  let query = $state<DocumentQueryText>({ filter: '', sort: '', projection: '', limit: 50 });
  let view = $state<'table' | 'text'>('table');
  let busy = $state(false);
  let error = $state<string | undefined>(undefined);
  let selected = $state<number[]>([]);
  /** The open editor: a row being edited (with the host's token) or a new document. */
  let editor = $state<
    | { kind: 'edit'; row: number; token: string; text: string }
    | { kind: 'new'; text: string }
    | undefined
  >(undefined);
  let editorProblem = $state<TypedProblem | undefined>(undefined);
  /** Bumped per editor, so a new one starts from its own text. */
  let editorVersion = $state(0);

  const range = $derived(page === undefined ? { from: 0, to: 0 } : rangeOf(page.skip, page.rows.length));
  const problem = $derived(page?.error);

  onMount(() => {
    let first = true;
    const subscription = rpc.on('state', (next) => {
      page = next;
      // The boxes start from what the host runs; after that they are the user's.
      if (first) {
        query = { ...next.query };
        first = false;
      }
      selected = selected.filter((row) => row < next.rows.length);
    });
    rpc.emit('ready', {});
    return () => {
      subscription.dispose();
    };
  });

  async function act(action: () => Promise<unknown>): Promise<void> {
    if (busy) {
      return;
    }
    busy = true;
    error = undefined;
    try {
      await action();
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    } finally {
      busy = false;
    }
  }

  function runQuery(): void {
    selected = [];
    void act(() => rpc.request('run', { ...query }));
  }

  function sortBy(column: string): void {
    query = { ...query, sort: nextSort(query.sort, column) };
    runQuery();
  }

  function keydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      runQuery();
    }
  }

  function toggle(row: number): void {
    selected = selected.includes(row) ? selected.filter((one) => one !== row) : [...selected, row];
  }

  function openEditor(row: number): void {
    if (page?.editable !== true) {
      view = 'text';
      return;
    }
    void act(async () => {
      const opened = await rpc.request('edit', { row });
      editorProblem = undefined;
      editorVersion += 1;
      editor = { kind: 'edit', row, token: opened.token, text: opened.text };
    });
  }

  function openNew(): void {
    editorProblem = undefined;
    editorVersion += 1;
    editor = { kind: 'new', text: NEW_DOCUMENT };
  }

  function save(text: string): void {
    const open = editor;
    if (open === undefined) {
      return;
    }
    void act(async () => {
      const result =
        open.kind === 'edit'
          ? await rpc.request('save', { token: open.token, text })
          : await rpc.request('insert', { text });
      if (result.problem === undefined) {
        editor = undefined;
      } else {
        editorProblem = result.problem;
      }
    });
  }

  function remove(rows: number[]): void {
    void act(async () => {
      const { deleted } = await rpc.request('delete', { rows });
      if (deleted > 0) {
        selected = [];
      }
    });
  }

  function copy(rows: number[]): void {
    void act(() => rpc.request('copy', { rows }));
  }
</script>

<main>
  {#if page === undefined}
    <p class="hint">{t('mongo.loading')}</p>
  {:else}
    <header>
      <h1>{page.database}.{page.collection}</h1>
      <p class="meta" data-testid="meta">
        <span>{page.connectionName}</span>
        {#if page.collectionType !== 'collection'}
          <span class="badge">{t(page.collectionType === 'view' ? 'mongo.view' : 'mongo.timeseries')}</span>
        {/if}
        {#if page.readOnly}
          <span class="badge">{t('mongo.readOnly')}</span>
        {/if}
        {#if page.total !== undefined}
          <span data-testid="total"
            >{t(page.total.exact ? 'mongo.total' : 'mongo.totalEstimate', groupDigits(page.total.count))}</span
          >
        {/if}
        <span>{t('mongo.took', page.tookMs)}</span>
      </p>
    </header>

    <section class="query" aria-label={t('mongo.query')}>
      <input
        class="control filter"
        bind:value={query.filter}
        onkeydown={keydown}
        placeholder={'{ status: "new" }'}
        aria-label={t('mongo.filter')}
        aria-invalid={problem?.box === 'filter'}
        spellcheck="false"
      />
      <input
        class="control"
        bind:value={query.sort}
        onkeydown={keydown}
        placeholder={'{ _id: -1 }'}
        aria-label={t('mongo.sort')}
        aria-invalid={problem?.box === 'sort'}
        spellcheck="false"
      />
      <input
        class="control"
        bind:value={query.projection}
        onkeydown={keydown}
        placeholder={'{ name: 1 }'}
        aria-label={t('mongo.projection')}
        aria-invalid={problem?.box === 'projection'}
        spellcheck="false"
      />
      <select class="control size" bind:value={query.limit} aria-label={t('mongo.pageSize')}>
        {#each PAGE_SIZES as size (size)}
          <option value={size}>{size}</option>
        {/each}
      </select>
      <button type="button" class="button" disabled={busy} onclick={runQuery}>{t('mongo.run')}</button>
    </section>

    {#if problem !== undefined}
      <p class="error" role="alert" data-testid="query-problem">
        {t(BOX_LABELS[problem.box])}: {problemText(problem)}
      </p>
    {/if}
    {#if error !== undefined}
      <p class="error" role="alert" data-testid="error">{error}</p>
    {/if}

    <section class="toolbar">
      <div class="tabs" role="tablist">
        <button
          type="button"
          role="tab"
          class="tab"
          aria-selected={view === 'table'}
          onclick={() => {
            view = 'table';
          }}>{t('mongo.table')}</button
        >
        <button
          type="button"
          role="tab"
          class="tab"
          aria-selected={view === 'text'}
          onclick={() => {
            view = 'text';
          }}>{t('mongo.text')}</button
        >
      </div>
      <button
        type="button"
        class="button secondary"
        disabled={busy || page.skip === 0}
        onclick={() => void act(() => rpc.request('page', { skip: previousSkip(page?.skip ?? 0, query.limit) }))}
        aria-label={t('mongo.previous')}>‹</button
      >
      <span data-testid="range">{t('mongo.range', range.from, range.to)}</span>
      <button
        type="button"
        class="button secondary"
        disabled={busy || !page.more}
        onclick={() => void act(() => rpc.request('page', { skip: (page?.skip ?? 0) + (page?.rows.length ?? 0) }))}
        aria-label={t('mongo.next')}>›</button
      >
      {#if page.total === undefined}
        <button type="button" class="button secondary" disabled={busy} onclick={() => void act(() => rpc.request('count', {}))}
          >{t('mongo.count')}</button
        >
      {/if}
      <span class="grow"></span>
      <button type="button" class="button secondary" disabled={busy} onclick={() => void act(() => rpc.request('refresh', {}))}
        >{t('mongo.refresh')}</button
      >
      {#if selected.length > 0}
        <button type="button" class="button secondary" disabled={busy} onclick={() => { copy(selected); }}
          >{t('mongo.copy', selected.length)}</button
        >
        {#if page.editable}
          <button type="button" class="button secondary" disabled={busy} onclick={() => { remove(selected); }}
            >{t('mongo.delete', selected.length)}</button
          >
        {/if}
      {/if}
      {#if page.insertable}
        <button type="button" class="button" disabled={busy} onclick={openNew}>{t('mongo.insert')}</button>
      {/if}
    </section>

    {#if editor !== undefined}
      {#key editorVersion}
        <DocumentEditor
          title={editor.kind === 'new' ? t('mongo.newDocument') : t('mongo.editDocument', page.rows[editor.row]?.id ?? '')}
          text={editor.text}
          {t}
          {busy}
          problem={editorProblem}
          onsave={save}
          oncancel={() => {
            editor = undefined;
          }}
        />
      {/key}
    {/if}

    {#if page.rows.length === 0}
      <p class="hint" data-testid="empty">{t('mongo.empty')}</p>
    {:else if view === 'table'}
      <div class="scroll">
        <table class="documents">
          <thead>
            <tr>
              <th class="pick"></th>
              {#each page.columns as column (column)}
                <th>
                  <button type="button" class="head" onclick={() => { sortBy(column); }} title={t('mongo.sortBy', column)}>
                    {column}
                    {#if sortOf(query.sort, column) === 'asc'}▲{:else if sortOf(query.sort, column) === 'desc'}▼{/if}
                  </button>
                </th>
              {/each}
            </tr>
          </thead>
          <tbody>
            {#each page.rows as row (row.index)}
              <tr class:selected={selected.includes(row.index)} ondblclick={() => { openEditor(row.index); }}>
                <td class="pick">
                  <input
                    type="checkbox"
                    checked={selected.includes(row.index)}
                    onchange={() => { toggle(row.index); }}
                    aria-label={t('mongo.select', row.id ?? String(row.index + 1))}
                  />
                </td>
                {#each row.cells as cell, column (column)}
                  {#if cell === null}
                    <td class="missing"></td>
                  {:else}
                    <td class={cellClass(cell.type)} title={cell.text}>{cell.text}</td>
                  {/if}
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if page.editable}
        <p class="hint">{t('mongo.tableHint')}</p>
      {/if}
    {:else}
      <ol class="texts">
        {#each page.rows as row (row.index)}
          <li>
            <div class="row-actions">
              <input
                type="checkbox"
                checked={selected.includes(row.index)}
                onchange={() => { toggle(row.index); }}
                aria-label={t('mongo.select', row.id ?? String(row.index + 1))}
              />
              <span class="hint">{row.id ?? ''}</span>
              <span class="grow"></span>
              {#if page.editable && !row.truncated}
                <button type="button" class="button secondary" disabled={busy} onclick={() => { openEditor(row.index); }}
                  >{t('mongo.edit')}</button
                >
              {/if}
              <button type="button" class="button secondary" disabled={busy} onclick={() => { copy([row.index]); }}
                >{t('mongo.copyOne')}</button
              >
              {#if page.editable}
                <button type="button" class="button secondary" disabled={busy} onclick={() => { remove([row.index]); }}
                  >{t('mongo.deleteOne')}</button
                >
              {/if}
            </div>
            <pre class="code">{row.text}</pre>
            {#if row.truncated}
              <p class="hint">{t('mongo.truncated')}</p>
            {/if}
          </li>
        {/each}
      </ol>
    {/if}
  {/if}
</main>

<style>
  main {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
  }
  h1 {
    font-size: 1.3em;
    margin: 0;
    word-break: break-all;
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    color: var(--vscode-descriptionForeground);
    margin: 4px 0 0;
  }
  .badge {
    border: 1px solid var(--vscode-focusBorder);
    padding: 0 6px;
    border-radius: 3px;
    color: var(--vscode-foreground);
  }
  .query,
  .toolbar,
  .row-actions {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .query input {
    font-family: var(--vscode-editor-font-family, monospace);
    flex: 1 1 160px;
  }
  .query .filter {
    flex: 3 1 260px;
  }
  .size {
    width: 80px;
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
  }
  .tabs {
    display: flex;
  }
  .tab {
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--vscode-foreground);
    padding: 4px 10px;
    cursor: pointer;
  }
  .tab[aria-selected='true'] {
    border-bottom-color: var(--vscode-focusBorder);
  }
  .scroll {
    overflow: auto;
    max-height: calc(100vh - 220px);
  }
  .documents {
    border-collapse: collapse;
    font-family: var(--vscode-editor-font-family, monospace);
  }
  .documents th,
  .documents td {
    text-align: left;
    padding: 2px 8px;
    border-bottom: 1px solid var(--vscode-panel-border, transparent);
    max-width: 320px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .documents thead th {
    position: sticky;
    top: 0;
    background: var(--vscode-editor-background);
  }
  .head {
    background: none;
    border: none;
    color: var(--vscode-foreground);
    font-weight: bold;
    cursor: pointer;
    padding: 0;
  }
  .documents tbody tr.selected {
    background: var(--vscode-list-activeSelectionBackground);
  }
  .documents tbody tr:hover {
    background: var(--vscode-list-hoverBackground);
  }
  .pick {
    width: 24px;
  }
  .number {
    color: var(--vscode-debugTokenExpression-number, var(--vscode-foreground));
    text-align: right;
  }
  .string {
    color: var(--vscode-debugTokenExpression-string, var(--vscode-foreground));
  }
  .null,
  .missing {
    color: var(--vscode-descriptionForeground);
    font-style: italic;
  }
  .bool {
    color: var(--vscode-debugTokenExpression-boolean, var(--vscode-foreground));
  }
  .id,
  .date {
    color: var(--vscode-debugTokenExpression-name, var(--vscode-foreground));
  }
  .texts {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .code {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-editor-font-size, 13px);
    margin: 4px 0 0;
    padding: 6px 8px;
    background: var(--vscode-textCodeBlock-background);
    overflow: auto;
    max-height: 480px;
  }
</style>

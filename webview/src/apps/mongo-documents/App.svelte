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
  import Icon from '../../components/Icon.svelte';
  import IconButton from '../../components/IconButton.svelte';
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

  const allSelected = $derived(
    page !== undefined &&
      page.rows.length > 0 &&
      page.rows.every((row) => selected.includes(row.index)),
  );

  /** The box in the header: ticks every document of the page, or none. */
  function toggleAll(): void {
    selected = allSelected ? [] : (page?.rows.map((row) => row.index) ?? []);
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
  {#if busy}
    <div class="progress-bar" aria-hidden="true"></div>
  {/if}
  {#if page === undefined}
    <div class="empty">
      <span class="empty-icon"><Icon name="loading" spin size={24} /></span>
      <p class="empty-title">{t('mongo.loading')}</p>
    </div>
  {:else}
    <header class="top">
      <span class="top-icon"><Icon name={page.mode === 'result' ? 'output' : 'json'} size={18} /></span>
      <div class="top-text">
        <h1>{page.collection === '' ? page.database : `${page.database}.${page.collection}`}</h1>
        <p class="meta" data-testid="meta">
          <span class="fact"><Icon name="database" size={12} />{page.connectionName}</span>
          {#if page.collectionType !== 'collection'}
            <span class="badge outline"
              ><Icon name={page.collectionType === 'view' ? 'eye' : 'history'} size={12} />{t(
                page.collectionType === 'view' ? 'mongo.view' : 'mongo.timeseries',
              )}</span
            >
          {/if}
          {#if page.readOnly}
            <span class="badge outline"><Icon name="lock" size={12} />{t('mongo.readOnly')}</span>
          {/if}
          {#if page.total !== undefined}
            <span class="fact" data-testid="total"
              >{t(page.total.exact ? 'mongo.total' : 'mongo.totalEstimate', groupDigits(page.total.count))}</span
            >
          {/if}
          <span class="fact"><Icon name="watch" size={12} />{t('mongo.took', page.tookMs)}</span>
        </p>
      </div>
      {#if page.mode === 'collection' || page.insertable}
        <div class="toolbar">
          {#if page.mode === 'collection'}
            <IconButton
              icon="refresh"
              label={t('mongo.refresh')}
              disabled={busy}
              onclick={() => void act(() => rpc.request('refresh', {}))}
            />
          {/if}
          {#if page.insertable}
            <span class="toolbar-separator"></span>
            <button type="button" class="button" disabled={busy} onclick={openNew}
              ><Icon name="add" />{t('mongo.insert')}</button
            >
          {/if}
        </div>
      {/if}
    </header>

    {#if page.mode === 'result'}
      <div class="result">
        <pre class="code statement" data-testid="statement">{page.statement ?? ''}</pre>
        {#if page.summary !== undefined}
          <p class="notice success" data-testid="summary"><Icon name="pass" /><span>{page.summary}</span></p>
        {/if}
      </div>
    {:else}
      <section class="query" aria-label={t('mongo.query')}>
        <div class="query-field filter" class:invalid={problem?.box === 'filter'}>
          <span class="query-label" aria-hidden="true">{t('mongo.filter')}</span>
          <input
            class="control"
            bind:value={query.filter}
            onkeydown={keydown}
            placeholder={'{ status: "new" }'}
            aria-label={t('mongo.filter')}
            aria-invalid={problem?.box === 'filter'}
            spellcheck="false"
          />
        </div>
        <div class="query-field" class:invalid={problem?.box === 'sort'}>
          <span class="query-label" aria-hidden="true">{t('mongo.sort')}</span>
          <input
            class="control"
            bind:value={query.sort}
            onkeydown={keydown}
            placeholder={'{ _id: -1 }'}
            aria-label={t('mongo.sort')}
            aria-invalid={problem?.box === 'sort'}
            spellcheck="false"
          />
        </div>
        <div class="query-field" class:invalid={problem?.box === 'projection'}>
          <span class="query-label" aria-hidden="true">{t('mongo.projection')}</span>
          <input
            class="control"
            bind:value={query.projection}
            onkeydown={keydown}
            placeholder={'{ name: 1 }'}
            aria-label={t('mongo.projection')}
            aria-invalid={problem?.box === 'projection'}
            spellcheck="false"
          />
        </div>
        <div class="query-run">
          <select class="control size" bind:value={query.limit} aria-label={t('mongo.pageSize')} title={t('mongo.pageSize')}>
            {#each PAGE_SIZES as size (size)}
              <option value={size}>{size}</option>
            {/each}
          </select>
          <button type="button" class="button" disabled={busy} onclick={runQuery}
            ><Icon name="search" />{t('mongo.run')}</button
          >
        </div>
      </section>
    {/if}

    {#if problem !== undefined}
      <p class="notice error problem" role="alert" data-testid="query-problem"><Icon name="error" /><span>{t(BOX_LABELS[problem.box])}: {problemText(problem)}</span></p>
    {/if}
    {#if error !== undefined}
      <p class="notice error problem" role="alert" data-testid="error"><Icon name="error" /><span class="message">{error}</span></p>
    {/if}

    {#if page.mode !== 'result' || page.rows.length > 0}
      <div class="viewbar">
        <div class="tabs" role="tablist">
          <button
            type="button"
            role="tab"
            class="tab"
            class:active={view === 'table'}
            aria-selected={view === 'table'}
            onclick={() => {
              view = 'table';
            }}><Icon name="table" />{t('mongo.table')}</button
          >
          <button
            type="button"
            role="tab"
            class="tab"
            class:active={view === 'text'}
            aria-selected={view === 'text'}
            onclick={() => {
              view = 'text';
            }}><Icon name="json" />{t('mongo.text')}</button
          >
        </div>
        <span class="grow"></span>
        {#if selected.length > 0}
          <div class="toolbar fade-in">
            <IconButton
              icon="copy"
              label={t('mongo.copy', selected.length)}
              text={t('mongo.copy', selected.length)}
              disabled={busy}
              onclick={() => {
                copy(selected);
              }}
            />
            {#if page.editable}
              <IconButton
                icon="trash"
                label={t('mongo.delete', selected.length)}
                text={t('mongo.delete', selected.length)}
                disabled={busy}
                onclick={() => {
                  remove(selected);
                }}
              />
            {/if}
          </div>
        {/if}
      </div>
    {/if}

    <div class="body" class:editing={editor !== undefined}>
      <div class="content">
        {#if page.rows.length === 0}
          {#if page.mode !== 'result'}
            <div class="empty">
              <span class="empty-icon"><Icon name="search" size={24} /></span>
              <p class="empty-title" data-testid="empty">{t('mongo.empty')}</p>
            </div>
          {/if}
        {:else if view === 'table'}
          <div class="scroll">
            <table class="documents">
              <thead>
                <tr>
                  <th class="pick">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      {@attach (box: HTMLInputElement) => {
                        box.indeterminate = selected.length > 0 && !allSelected;
                      }}
                      onchange={toggleAll}
                      aria-label={t('mongo.selectAll')}
                    />
                  </th>
                  {#each page.columns as column (column)}
                    {@const direction = sortOf(query.sort, column)}
                    <th aria-sort={direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : undefined}>
                      <button
                        type="button"
                        class="head"
                        onclick={() => {
                          sortBy(column);
                        }}
                        title={t('mongo.sortBy', column)}
                      >
                        <span class="head-name">{column}</span>
                        {#if direction !== undefined}<span class="arrow"
                            ><Icon name={direction === 'asc' ? 'arrow-up' : 'arrow-down'} size={14} /></span
                          >{/if}
                      </button>
                    </th>
                  {/each}
                </tr>
              </thead>
              <tbody>
                {#each page.rows as row (row.index)}
                  <tr
                    class:selected={selected.includes(row.index)}
                    ondblclick={() => {
                      openEditor(row.index);
                    }}
                  >
                    <td class="pick">
                      <input
                        type="checkbox"
                        checked={selected.includes(row.index)}
                        onchange={() => {
                          toggle(row.index);
                        }}
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
        {:else}
          <ol class="texts">
            {#each page.rows as row (row.index)}
              <li class="doc" class:selected={selected.includes(row.index)}>
                <div class="doc-head">
                  <input
                    type="checkbox"
                    checked={selected.includes(row.index)}
                    onchange={() => {
                      toggle(row.index);
                    }}
                    aria-label={t('mongo.select', row.id ?? String(row.index + 1))}
                  />
                  <span class="doc-id">{row.id ?? ''}</span>
                  <span class="grow"></span>
                  <div class="toolbar">
                    {#if page.editable && !row.truncated}
                      <IconButton
                        icon="edit"
                        label={t('mongo.edit')}
                        disabled={busy}
                        onclick={() => {
                          openEditor(row.index);
                        }}
                      />
                    {/if}
                    <IconButton
                      icon="copy"
                      label={t('mongo.copyOne')}
                      disabled={busy}
                      onclick={() => {
                        copy([row.index]);
                      }}
                    />
                    {#if page.editable}
                      <IconButton
                        icon="trash"
                        label={t('mongo.deleteOne')}
                        disabled={busy}
                        onclick={() => {
                          remove([row.index]);
                        }}
                      />
                    {/if}
                  </div>
                </div>
                <pre class="doc-text">{row.text}</pre>
                {#if row.truncated}
                  <p class="notice warning truncated"><Icon name="warning" /><span>{t('mongo.truncated')}</span></p>
                {/if}
              </li>
            {/each}
          </ol>
        {/if}
      </div>

      {#if editor !== undefined}
        <aside class="panel fade-in">
          {#key editorVersion}
            <DocumentEditor
              title={editor.kind === 'new' ? t('mongo.newDocument') : t('mongo.editDocument', page.rows[editor.row]?.id ?? '')}
              text={editor.text}
              isNew={editor.kind === 'new'}
              {t}
              {busy}
              problem={editorProblem}
              onsave={save}
              oncancel={() => {
                editor = undefined;
              }}
            />
          {/key}
        </aside>
      {/if}
    </div>

    {#if page.mode !== 'result' || page.rows.length > 0}
      <footer class="status">
        <span class="hint">
          {#if page.editable && view === 'table' && page.rows.length > 0}
            <Icon name="info" size={14} />{t('mongo.tableHint')}
          {/if}
        </span>
        <div class="pager">
          <IconButton
            icon="chevron-left"
            label={t('mongo.previous')}
            disabled={busy || page.skip === 0}
            onclick={() => void act(() => rpc.request('page', { skip: previousSkip(page?.skip ?? 0, query.limit) }))}
          />
          <span class="range" data-testid="range">{t('mongo.range', range.from, range.to)}</span>
          <IconButton
            icon="chevron-right"
            label={t('mongo.next')}
            disabled={busy || !page.more}
            onclick={() => void act(() => rpc.request('page', { skip: (page?.skip ?? 0) + (page?.rows.length ?? 0) }))}
          />
          {#if page.total === undefined}
            <span class="toolbar-separator"></span>
            <IconButton
              icon="symbol-numeric"
              label={t('mongo.count')}
              text={t('mongo.count')}
              disabled={busy}
              onclick={() => void act(() => rpc.request('count', {}))}
            />
          {/if}
        </div>
      </footer>
    {/if}
  {/if}
</main>

<style>
  main {
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100vh;
  }

  .grow {
    flex: 1;
  }

  /* The collection, what it is, and its actions. */
  .top {
    display: flex;
    flex: none;
    flex-wrap: wrap;
    gap: var(--dn-gap) var(--dn-gap-m);
    align-items: center;
    padding: var(--dn-gap-m) var(--dn-gap-l);
    border-bottom: 1px solid var(--dn-divider);
  }

  .top-icon {
    display: inline-flex;
    padding: 7px;
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
    border-radius: var(--dn-radius-l);
  }

  .top-text {
    flex: 1;
    min-width: 0;
  }

  h1 {
    font-size: 14px;
    overflow-wrap: anywhere;
  }

  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: var(--dn-gap-s) var(--dn-gap-m);
    align-items: center;
    margin: 4px 0 0;
    color: var(--dn-muted);
    font-size: var(--dn-font-small);
  }

  .fact {
    display: inline-flex;
    gap: 4px;
    align-items: center;
    white-space: nowrap;
  }

  /* Filter, sort and projection in the shell's syntax, each with its name. */
  .query {
    display: flex;
    flex: none;
    flex-wrap: wrap;
    gap: var(--dn-gap);
    align-items: center;
    padding: var(--dn-gap) var(--dn-gap-l);
    background: var(--vscode-sideBar-background, var(--dn-surface));
    border-bottom: 1px solid var(--dn-divider);
  }

  .query-field {
    display: flex;
    flex: 1 1 180px;
    align-items: stretch;
    min-width: 0;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--dn-border));
    border-radius: var(--dn-radius-s);
    transition: border-color var(--dn-duration) var(--dn-ease);
  }

  .query-field.filter {
    flex: 3 1 280px;
  }

  .query-field:focus-within {
    border-color: var(--vscode-focusBorder);
  }

  .query-field.invalid {
    border-color: var(--vscode-inputValidation-errorBorder, var(--dn-danger));
  }

  .query-label {
    display: inline-flex;
    flex: none;
    align-items: center;
    padding: 0 8px;
    color: var(--dn-muted);
    font-size: 11px;
    border-right: 1px solid var(--vscode-input-border, var(--dn-border));
  }

  .query-field .control {
    flex: 1;
    min-width: 0;
    font-family: var(--dn-mono);
    border: none;
  }

  .query-run {
    display: flex;
    gap: var(--dn-gap);
  }

  .size {
    width: 72px;
  }

  .problem {
    flex: none;
    margin: var(--dn-gap) var(--dn-gap-l) 0;
  }

  .message {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .result {
    display: flex;
    flex: none;
    flex-direction: column;
    gap: var(--dn-gap);
    padding: var(--dn-gap-m) var(--dn-gap-l) 0;
  }

  .result .notice {
    margin: 0;
  }

  .code {
    max-height: 160px;
    margin: 0;
    padding: var(--dn-gap) var(--dn-gap-m);
    overflow: auto;
    font-size: var(--vscode-editor-font-size, 13px);
    background: var(--dn-surface);
    border: 1px solid var(--dn-border);
    border-radius: var(--dn-radius);
  }

  /* Table or text, and what to do with the ticked documents. */
  .viewbar {
    display: flex;
    flex: none;
    gap: var(--dn-gap);
    align-items: center;
    min-height: 34px;
    padding: 0 var(--dn-gap) 0 var(--dn-gap-s);
    border-bottom: 1px solid var(--dn-divider);
  }

  .tabs {
    display: flex;
    gap: 2px;
    align-self: stretch;
  }

  .tab {
    display: inline-flex;
    gap: 6px;
    align-items: center;
    margin-bottom: -1px;
    padding: 0 10px;
    color: var(--vscode-panelTitle-inactiveForeground, var(--dn-muted));
    background: transparent;
    border: none;
    border-bottom: 1px solid transparent;
    font-family: inherit;
    font-size: inherit;
    white-space: nowrap;
    cursor: pointer;
    transition: color var(--dn-duration) var(--dn-ease);
  }

  .tab:hover,
  .tab.active {
    color: var(--vscode-panelTitle-activeForeground, var(--vscode-foreground));
  }

  .tab.active {
    border-bottom-color: var(--vscode-panelTitle-activeBorder, var(--dn-accent));
  }

  .body {
    display: flex;
    flex: 1;
    min-height: 0;
  }

  .content {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
  }

  .panel {
    display: flex;
    flex: none;
    flex-direction: column;
    width: min(560px, 50%);
    min-height: 0;
    background: var(--vscode-sideBar-background, var(--dn-surface));
    border-left: 1px solid var(--dn-divider);
  }

  /* Narrow: the editor takes the place of the documents while it is open. */
  @media (max-width: 720px) {
    .body.editing .content {
      display: none;
    }

    .panel {
      width: 100%;
      border-left: none;
    }
  }

  /* The documents as a table, drawn as the result grid draws its rows. */
  .scroll {
    --dn-header-background: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-editor-background));
    --dn-grid-line: var(--vscode-editorGroup-border, var(--dn-divider));
    flex: 1;
    min-height: 0;
    overflow: auto;
  }

  .documents {
    border-collapse: separate;
    border-spacing: 0;
    font-family: var(--dn-mono);
    font-size: var(--dn-font-small);
  }

  .documents th,
  .documents td {
    max-width: 320px;
    height: 22px;
    padding: 2px 8px;
    overflow: hidden;
    line-height: 18px;
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
    border-right: 1px solid var(--dn-grid-line);
  }

  .documents thead th {
    position: sticky;
    top: 0;
    z-index: 1;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    background: var(--dn-header-background);
    box-shadow: 0 1px 0 var(--dn-divider);
  }

  .head {
    display: flex;
    gap: 4px;
    align-items: center;
    width: 100%;
    padding: 0;
    color: inherit;
    background: none;
    border: none;
    font: inherit;
    font-weight: 600;
    text-align: left;
    cursor: pointer;
  }

  .head-name {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .arrow {
    display: inline-flex;
    color: var(--dn-accent);
  }

  .documents tbody tr:nth-child(even) {
    background: var(--vscode-keybindingTable-rowsBackground, transparent);
  }

  .documents tbody tr:hover {
    background: var(--vscode-list-hoverBackground);
  }

  .documents tbody tr.selected {
    background: var(--vscode-list-inactiveSelectionBackground);
  }

  .pick {
    width: 30px;
    text-align: center;
  }

  .documents .pick input {
    width: 16px;
    height: 16px;
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
    color: var(--dn-muted);
    font-style: italic;
  }

  .bool {
    color: var(--vscode-debugTokenExpression-boolean, var(--vscode-foreground));
  }

  .id,
  .date {
    color: var(--vscode-debugTokenExpression-name, var(--vscode-foreground));
  }

  /* The documents as text: a card each, with its own actions. */
  .texts {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--dn-gap);
    margin: 0;
    padding: var(--dn-gap-m) var(--dn-gap-l);
    overflow: auto;
    list-style: none;
  }

  .doc {
    flex: none;
    background: var(--dn-surface);
    border: 1px solid var(--dn-border);
    border-radius: var(--dn-radius-l);
    transition: border-color var(--dn-duration) var(--dn-ease);
  }

  .doc.selected {
    border-color: var(--vscode-focusBorder);
  }

  .doc-head {
    display: flex;
    gap: var(--dn-gap);
    align-items: center;
    padding: 3px 4px 3px 10px;
    border-bottom: 1px solid var(--dn-divider);
  }

  .doc-id {
    overflow: hidden;
    color: var(--dn-muted);
    font-family: var(--dn-mono);
    font-size: var(--dn-font-small);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .doc-text {
    max-height: 480px;
    margin: 0;
    padding: var(--dn-gap) var(--dn-gap-m);
    overflow: auto;
    font-size: var(--vscode-editor-font-size, 13px);
  }

  .truncated {
    margin: 0 var(--dn-gap-m) var(--dn-gap-m);
  }

  /* The status bar: a hint on the left, the pager on the right. */
  .status {
    display: flex;
    flex: none;
    flex-wrap: wrap;
    gap: 4px 12px;
    align-items: center;
    justify-content: space-between;
    min-height: 30px;
    padding: 2px 8px 2px var(--dn-gap-l);
    color: var(--dn-muted);
    border-top: 1px solid var(--dn-divider);
    font-size: var(--dn-font-small);
  }

  .hint {
    display: inline-flex;
    gap: 6px;
    align-items: center;
  }

  .pager {
    display: flex;
    gap: 2px 4px;
    align-items: center;
  }

  .range {
    margin: 0 2px;
    white-space: nowrap;
  }

  /* Waiting and nothing found: centred. */
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

  .empty-icon {
    display: inline-flex;
    padding: 14px;
    color: var(--dn-muted);
    background: var(--dn-surface);
    border: 1px solid var(--dn-border);
    border-radius: 50%;
  }

  .empty-title {
    margin: 0;
    color: var(--vscode-foreground);
    font-size: 14px;
  }
</style>

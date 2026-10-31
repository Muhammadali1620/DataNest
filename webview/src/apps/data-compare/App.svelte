<script lang="ts">
  import type { TableAction } from '../../../../src/shared/table-actions';
  import { onMount } from 'svelte';
  import {
    type DataCompareProtocol,
    type DataCompareRow,
    type DataCompareState,
    ROWS_PAGE,
    type RowKind,
  } from '../../../../src/shared/protocols/data-compare';
  import type { RpcPeer } from '../../../../src/shared/rpc';
  import Icon from '../../components/Icon.svelte';
  import IconButton from '../../components/IconButton.svelte';
  import TableBar from '../../components/TableBar.svelte';
  import type { MessageKey } from '../../l10n/en';
  import type { CodiconName } from '../../lib/codicons';
  import type { Translate } from '../../lib/i18n';
  import { rowCounts, shownColumns } from './rows-view';

  interface Props {
    rpc: RpcPeer<DataCompareProtocol['webview'], DataCompareProtocol['host']>;
    t: Translate;
  }

  const { rpc, t }: Props = $props();

  let page = $state<DataCompareState | undefined>(undefined);
  let kind = $state<RowKind>('different');
  let rows = $state<DataCompareRow[]>([]);
  let onlyDiffering = $state(true);
  const include = $state({ insert: true, update: true, delete: false });
  let rowsError = $state<string | undefined>(undefined);
  let busy = $state(false);
  let ticket = 0;

  const result = $derived(page?.result);
  const headers = $derived(
    page === undefined ? [] : [...page.key, ...page.columns].map((pair) => pair.source),
  );
  const keyWidth = $derived(page?.key.length ?? 0);
  const columns = $derived(
    shownColumns(rows, keyWidth, headers.length, kind === 'different' && onlyDiffering),
  );
  const counts = $derived(result === undefined ? undefined : rowCounts(result, kind));

  /** Each kind of row with its sign: what the sync script does with it. */
  const KINDS: { kind: RowKind; key: MessageKey; icon: CodiconName }[] = [
    { kind: 'different', key: 'dataCompare.kind.different', icon: 'diff-modified' },
    { kind: 'onlySource', key: 'dataCompare.kind.onlySource', icon: 'diff-added' },
    { kind: 'onlyTarget', key: 'dataCompare.kind.onlyTarget', icon: 'diff-removed' },
  ];

  async function load(next: RowKind, offset = 0): Promise<void> {
    kind = next;
    const mine = ++ticket;
    rowsError = undefined;
    try {
      const answer = await rpc.request('rows', { kind: next, offset, limit: ROWS_PAGE });
      if (mine === ticket) {
        rows = offset === 0 ? answer.rows : [...rows, ...answer.rows];
      }
    } catch (error) {
      if (mine === ticket) {
        rowsError = error instanceof Error ? error.message : String(error);
      }
    }
  }

  function applyState(next: DataCompareState): void {
    const hadResult = page?.result !== undefined;
    page = next;
    if (next.result === undefined) {
      rows = [];
    } else if (!hadResult) {
      // The first kind with rows, so the page opens on something to see.
      const first = KINDS.find((entry) => next.result !== undefined && next.result[entry.kind] > 0);
      void load(first?.kind ?? 'different');
    }
  }

  async function openScript(): Promise<void> {
    busy = true;
    try {
      await rpc.request('openScript', { ...include });
    } finally {
      busy = false;
    }
  }

  onMount(() => {
    const subscription = rpc.on('state', (next) => {
      applyState(next);
    });
    rpc.emit('ready', {});
    return () => {
      subscription.dispose();
    };
  });

  const nothingToSync = $derived(
    result === undefined ||
      !(
        (include.insert && result.onlySource > 0) ||
        (include.update && result.different > 0) ||
        (include.delete && result.onlyTarget > 0)
      ),
  );
</script>

<main>
  {#if page?.tableBar !== undefined}
    <TableBar
      {t}
      active="compare"
      isView={page.tableBar.isView}
      onAction={(action: TableAction) => {
        rpc.emit('tableNav', { action, dirty: false });
      }}
    />
  {/if}
  {#if page?.progress !== undefined}
    <div class="progress-bar" aria-hidden="true"></div>
  {/if}
  <header class="top">
    <span class="top-icon"><Icon name="table" size={18} /></span>
    <div class="top-text">
      <h1>{t('dataCompare.title')}</h1>
      {#if page !== undefined}
        <p class="sides">
          <span class="side">{page.source}</span>
          <Icon name="arrow-right" size={14} />
          <span class="side">{page.target}</span>
        </p>
      {/if}
    </div>
    {#if page !== undefined}
      <div class="toolbar">
        {#if page.progress !== undefined}
          <IconButton
            icon="debug-stop"
            label={t('dataCompare.stop')}
            text={t('dataCompare.stop')}
            onclick={() => {
              rpc.emit('cancel', {});
            }}
          />
        {:else}
          <IconButton
            icon="refresh"
            label={t('dataCompare.again')}
            onclick={() => {
              rpc.emit('refresh', {});
            }}
          />
        {/if}
      </div>
    {/if}
  </header>

  {#if page === undefined}
    <div class="empty">
      <span class="empty-icon"><Icon name="loading" spin size={24} /></span>
      <p class="empty-title">{t('form.loading')}</p>
    </div>
  {:else}
    <p class="facts">
      <span class="fact"><Icon name="key" size={14} /><span>{t('dataCompare.key', page.key.map((pair) => pair.source).join(', '))}</span></span>
      <span class="fact"><Icon name="symbol-field" size={14} /><span>{t('dataCompare.columns', page.columns.length)}</span></span>
      {#if page.sourceOnly.length > 0}<span class="fact"><Icon name="warning" size={14} /><span>{t('dataCompare.sourceOnly', page.sourceOnly.join(', '))}</span></span>{/if}
      {#if page.targetOnly.length > 0}<span class="fact"><Icon name="warning" size={14} /><span>{t('dataCompare.targetOnly', page.targetOnly.join(', '))}</span></span>{/if}
    </p>
    {#if page.error !== undefined}
      <div class="notice error problem" role="alert"><Icon name="error" /><span class="message">{page.error}</span></div>
    {/if}
    {#if page.progress !== undefined}
      <div class="empty">
        <span class="empty-icon"><Icon name="loading" spin size={24} /></span>
        <p class="empty-title" role="status">
          {page.progress.phase === 'target'
            ? t('dataCompare.readingTarget', page.progress.rows)
            : page.progress.phase === 'source'
              ? t('dataCompare.readingSource', page.progress.rows)
              : t('dataCompare.collecting')}
        </p>
      </div>
    {/if}
    {#if result !== undefined}
      <div class="bar">
        <div class="tabs" role="tablist">
          {#each KINDS as entry (entry.kind)}
            <button
              type="button"
              role="tab"
              class="tab {entry.kind}"
              class:active={kind === entry.kind}
              aria-selected={kind === entry.kind}
              onclick={() => void load(entry.kind)}
              ><Icon name={entry.icon} />{t(entry.key, result[entry.kind])}</button
            >
          {/each}
        </div>
        <span class="grow"></span>
        {#if kind === 'different'}
          <span class="legend"
            ><span class="swatch before"></span><Icon name="arrow-small-right" size={14} /><span
              class="swatch after"
            ></span><span>{t('dataCompare.legend')}</span></span
          >
          <IconButton
            icon="filter"
            label={t('dataCompare.onlyDiffering')}
            pressed={onlyDiffering}
            onclick={() => {
              onlyDiffering = !onlyDiffering;
            }}
          />
        {/if}
      </div>
      {#if rowsError !== undefined}
        <div class="notice error problem" role="alert"><Icon name="error" /><span class="message">{rowsError}</span></div>
      {:else if counts?.total === 0}
        <div class="empty">
          <span class="empty-icon"><Icon name="pass" size={24} /></span>
          <p class="empty-title">{t('dataCompare.none')}</p>
        </div>
      {:else}
        <div class="table">
          <table>
            <thead>
              <tr>
                {#each columns as index (index)}
                  <th class:key={index < keyWidth}>
                    {#if index < keyWidth}<Icon name="key" size={12} />{/if}{headers[index]}
                  </th>
                {/each}
              </tr>
            </thead>
            <tbody>
              {#each rows as row, at (at)}
                <tr>
                  {#each columns as index (index)}
                    {@const value = row.cells[index]}
                    <td class:differs={row.differs?.[index] === true} class:key={index < keyWidth}>
                      {#if row.differs?.[index] === true}
                        <del class="before" class:null={(row.target?.[index] ?? null) === null}
                          >{row.target?.[index] ?? 'NULL'}</del
                        ><span class="to"><Icon name="arrow-small-right" size={14} /></span><ins
                          class="after"
                          class:null={(value ?? null) === null}>{value ?? 'NULL'}</ins
                        >
                      {:else if (value ?? null) === null}
                        <span class="null">NULL</span>
                      {:else}
                        {value}
                      {/if}
                    </td>
                  {/each}
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
      <footer class="actions">
        <div class="shown">
          {#if counts !== undefined && rowsError === undefined && counts.total > 0}
            <span>{t('dataCompare.shown', rows.length, counts.total)}</span>
            {#if rows.length < counts.kept}
              <button type="button" class="link-button" onclick={() => void load(kind, rows.length)}
                >{t('dataCompare.more')}</button
              >
            {:else if counts.kept < counts.total}
              <span class="kept"><Icon name="warning" size={14} />{t('dataCompare.kept', counts.kept)}</span>
            {/if}
          {/if}
          <span class="badge outline"><Icon name="check" size={12} />{t('dataCompare.same', result.same)}</span>
          <span class="duration">{t('dataCompare.duration', Math.round(result.durationMs))}</span>
        </div>
        <div class="sync">
          <label class="check insert"
            ><input type="checkbox" bind:checked={include.insert} /><Icon name="diff-added" size={14} />{t(
              'dataCompare.include.insert',
              result.onlySource,
            )}</label
          >
          <label class="check update"
            ><input type="checkbox" bind:checked={include.update} /><Icon name="diff-modified" size={14} />{t(
              'dataCompare.include.update',
              result.different,
            )}</label
          >
          <label class="check delete"
            ><input type="checkbox" bind:checked={include.delete} /><Icon name="diff-removed" size={14} />{t(
              'dataCompare.include.delete',
              result.onlyTarget,
            )}</label
          >
          <button type="button" class="button" disabled={busy || nothingToSync} onclick={() => void openScript()}
            ><Icon name="go-to-file" />{t('dataCompare.openScript')}</button
          >
        </div>
      </footer>
    {/if}
  {/if}
</main>

<style>
  main {
    /* Diff colours of the theme: rows the script inserts, deletes and updates. */
    --dn-added: var(--vscode-gitDecoration-addedResourceForeground, var(--dn-success));
    --dn-removed: var(--vscode-gitDecoration-deletedResourceForeground, var(--dn-danger));
    --dn-changed: var(--vscode-gitDecoration-modifiedResourceForeground, var(--dn-warning));
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100vh;
  }

  .grow {
    flex: 1;
  }

  /* The page's title, what is compared, and its actions. */
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
  }

  .sides {
    display: flex;
    flex-wrap: wrap;
    gap: var(--dn-gap-s) var(--dn-gap);
    align-items: center;
    margin: 2px 0 0;
    color: var(--dn-muted);
    font-size: var(--dn-font-small);
  }

  .side {
    color: var(--vscode-foreground);
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  /* How rows are matched and which columns take part. */
  .facts {
    display: flex;
    flex: none;
    flex-wrap: wrap;
    gap: var(--dn-gap-s) var(--dn-gap-l);
    margin: 0;
    padding: var(--dn-gap) var(--dn-gap-l) 0;
    color: var(--dn-muted);
    font-size: var(--dn-font-small);
  }

  .fact {
    display: inline-flex;
    gap: 6px;
    align-items: center;
  }

  .problem {
    flex: none;
    margin: var(--dn-gap) var(--dn-gap-l) 0;
  }

  .message {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  /* The kinds of rows as tabs, and how the changed cells read. */
  .bar {
    display: flex;
    flex: none;
    flex-wrap: wrap;
    gap: var(--dn-gap-s) var(--dn-gap);
    align-items: center;
    padding: var(--dn-gap-s) var(--dn-gap) 0 var(--dn-gap-s);
    border-bottom: 1px solid var(--dn-divider);
  }

  .tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 2px;
    align-self: stretch;
  }

  .tab {
    display: inline-flex;
    gap: 6px;
    align-items: center;
    height: 32px;
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

  .tab.different :global(.codicon-glyph) {
    color: var(--dn-changed);
  }

  .tab.onlySource :global(.codicon-glyph) {
    color: var(--dn-added);
  }

  .tab.onlyTarget :global(.codicon-glyph) {
    color: var(--dn-removed);
  }

  .legend {
    display: inline-flex;
    gap: 4px;
    align-items: center;
    color: var(--dn-muted);
    font-size: var(--dn-font-small);
  }

  .legend > span:last-child {
    margin-left: 4px;
  }

  .swatch {
    width: 12px;
    height: 12px;
    border: 1px solid var(--dn-border);
    border-radius: var(--dn-radius-s);
  }

  .swatch.before {
    background: var(--vscode-diffEditor-removedTextBackground, transparent);
    border-color: var(--dn-removed);
  }

  .swatch.after {
    background: var(--vscode-diffEditor-insertedTextBackground, transparent);
    border-color: var(--dn-added);
  }

  /* The rows, drawn as the result grid draws them. */
  .table {
    --dn-header-background: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-editor-background));
    --dn-grid-line: var(--vscode-editorGroup-border, var(--dn-divider));
    flex: 1;
    min-height: 0;
    overflow: auto;
  }

  table {
    border-collapse: separate;
    border-spacing: 0;
  }

  th,
  td {
    max-width: 420px;
    height: 22px;
    padding: 2px 8px;
    overflow: hidden;
    line-height: 18px;
    text-align: left;
    text-overflow: ellipsis;
    white-space: pre;
    border-right: 1px solid var(--dn-grid-line);
    user-select: text;
  }

  th {
    position: sticky;
    top: 0;
    z-index: 1;
    font-weight: 600;
    background: var(--dn-header-background);
    box-shadow: 0 1px 0 var(--dn-divider);
  }

  th.key :global(.codicon-glyph) {
    margin-right: 4px;
    color: var(--dn-muted);
    vertical-align: -1px;
  }

  tbody tr:nth-child(even) {
    background: var(--vscode-keybindingTable-rowsBackground, transparent);
  }

  tbody tr:hover {
    background: var(--vscode-list-hoverBackground);
  }

  td.key {
    font-weight: 600;
  }

  td.differs {
    box-shadow: inset 2px 0 var(--dn-changed);
  }

  /* Target first and struck out, source after: the change reads without colour too. */
  .before,
  .after {
    padding: 0 3px;
    border-radius: var(--dn-radius-s);
  }

  .before {
    background: var(--vscode-diffEditor-removedTextBackground, transparent);
    text-decoration-color: var(--dn-removed);
  }

  .after {
    background: var(--vscode-diffEditor-insertedTextBackground, transparent);
    text-decoration: none;
  }

  .to {
    display: inline-flex;
    margin: 0 3px;
    color: var(--dn-muted);
    vertical-align: -3px;
  }

  .null {
    color: var(--dn-muted);
    font-style: italic;
  }

  /* What is shown, and what the sync script does: pinned at the bottom. */
  .actions {
    display: flex;
    flex: none;
    flex-wrap: wrap;
    gap: var(--dn-gap) var(--dn-gap-l);
    align-items: center;
    justify-content: space-between;
    padding: var(--dn-gap) var(--dn-gap-l);
    background: var(--vscode-sideBar-background, var(--dn-surface));
    border-top: 1px solid var(--dn-divider);
  }

  .shown {
    display: flex;
    flex-wrap: wrap;
    gap: var(--dn-gap-s) var(--dn-gap-m);
    align-items: center;
    color: var(--dn-muted);
    font-size: var(--dn-font-small);
  }

  .kept {
    display: inline-flex;
    gap: 4px;
    align-items: center;
    color: var(--dn-warning);
  }

  .sync {
    display: flex;
    flex-wrap: wrap;
    gap: var(--dn-gap) var(--dn-gap-l);
    align-items: center;
  }

  .check {
    display: inline-flex;
    gap: 6px;
    align-items: center;
    cursor: pointer;
  }

  .check.insert :global(.codicon-glyph) {
    color: var(--dn-added);
  }

  .check.update :global(.codicon-glyph) {
    color: var(--dn-changed);
  }

  .check.delete :global(.codicon-glyph) {
    color: var(--dn-removed);
  }

  /* Waiting and nothing to show: centred. */
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

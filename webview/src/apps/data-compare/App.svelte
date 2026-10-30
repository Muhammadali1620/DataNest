<script lang="ts">
  import { onMount } from 'svelte';
  import {
    type DataCompareProtocol,
    type DataCompareRow,
    type DataCompareState,
    ROWS_PAGE,
    type RowKind,
  } from '../../../../src/shared/protocols/data-compare';
  import type { RpcPeer } from '../../../../src/shared/rpc';
  import type { MessageKey } from '../../l10n/en';
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

  const KINDS: { kind: RowKind; key: MessageKey }[] = [
    { kind: 'different', key: 'dataCompare.kind.different' },
    { kind: 'onlySource', key: 'dataCompare.kind.onlySource' },
    { kind: 'onlyTarget', key: 'dataCompare.kind.onlyTarget' },
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
  <header class="bar">
    <h1>{t('dataCompare.title')}</h1>
    {#if page !== undefined}
      <span class="sides"><b>{page.source}</b> → <b>{page.target}</b></span>
      <span class="grow"></span>
      {#if page.progress !== undefined}
        <button
          type="button"
          class="button secondary"
          onclick={() => {
            rpc.emit('cancel', {});
          }}>{t('dataCompare.stop')}</button
        >
      {:else}
        <button
          type="button"
          class="button secondary"
          onclick={() => {
            rpc.emit('refresh', {});
          }}>{t('dataCompare.again')}</button
        >
      {/if}
    {/if}
  </header>

  {#if page === undefined}
    <p class="hint">{t('form.loading')}</p>
  {:else}
    <p class="hint">
      {t('dataCompare.key', page.key.map((pair) => pair.source).join(', '))}
      {t('dataCompare.columns', page.columns.length)}
      {#if page.sourceOnly.length > 0}{t('dataCompare.sourceOnly', page.sourceOnly.join(', '))}{/if}
      {#if page.targetOnly.length > 0}{t('dataCompare.targetOnly', page.targetOnly.join(', '))}{/if}
    </p>
    {#if page.progress !== undefined}
      <p class="hint" role="status">
        {page.progress.phase === 'target'
          ? t('dataCompare.readingTarget', page.progress.rows)
          : page.progress.phase === 'source'
            ? t('dataCompare.readingSource', page.progress.rows)
            : t('dataCompare.collecting')}
      </p>
    {/if}
    {#if page.error !== undefined}
      <p class="error" role="alert">{page.error}</p>
    {/if}
    {#if result !== undefined}
      <div class="summary">
        <span class="same">{t('dataCompare.same', result.same)}</span>
        <span class="hint">{t('dataCompare.duration', Math.round(result.durationMs))}</span>
      </div>
      <div class="sync">
        <label><input type="checkbox" bind:checked={include.insert} /> {t('dataCompare.include.insert', result.onlySource)}</label>
        <label><input type="checkbox" bind:checked={include.update} /> {t('dataCompare.include.update', result.different)}</label>
        <label><input type="checkbox" bind:checked={include.delete} /> {t('dataCompare.include.delete', result.onlyTarget)}</label>
        <button type="button" class="button" disabled={busy || nothingToSync} onclick={() => void openScript()}
          >{t('dataCompare.openScript')}</button
        >
      </div>
      <div class="tabs" role="tablist">
        {#each KINDS as entry (entry.kind)}
          <button
            type="button"
            role="tab"
            class="tab"
            aria-selected={kind === entry.kind}
            onclick={() => void load(entry.kind)}>{t(entry.key, result[entry.kind])}</button
          >
        {/each}
        <span class="grow"></span>
        {#if kind === 'different'}
          <span class="hint">{t('dataCompare.legend')}</span>
          <label class="inline"><input type="checkbox" bind:checked={onlyDiffering} /> {t('dataCompare.onlyDiffering')}</label>
        {/if}
      </div>
      {#if rowsError !== undefined}
        <p class="error" role="alert">{rowsError}</p>
      {:else if counts?.total === 0}
        <p class="hint">{t('dataCompare.none')}</p>
      {:else}
        <div class="table">
          <table>
            <thead>
              <tr>
                {#each columns as index (index)}
                  <th class:key={index < keyWidth}>{headers[index]}</th>
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
                        <span class="before">{row.target?.[index] ?? 'NULL'}</span>
                        <span class="arrow">→</span>
                        <span class="after">{value ?? 'NULL'}</span>
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
        {#if counts !== undefined}
          <p class="hint">
            {t('dataCompare.shown', rows.length, counts.total)}
            {#if rows.length < counts.kept}
              <button type="button" class="link" onclick={() => void load(kind, rows.length)}
                >{t('dataCompare.more')}</button
              >
            {:else if counts.kept < counts.total}
              {t('dataCompare.kept', counts.kept)}
            {/if}
          </p>
        {/if}
      {/if}
    {/if}
  {/if}
</main>

<style>
  main {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 12px;
    height: 100vh;
  }
  .bar,
  .summary,
  .sync,
  .tabs {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
  }
  h1 {
    font-size: 1.2em;
    margin: 0;
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
  .sync label,
  .inline {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .tab {
    font: inherit;
    background: transparent;
    color: var(--vscode-foreground);
    border: none;
    border-bottom: 2px solid transparent;
    padding: 2px 6px;
    cursor: pointer;
  }
  .tab[aria-selected='true'] {
    border-bottom-color: var(--vscode-focusBorder);
  }
  .link {
    font: inherit;
    background: none;
    border: none;
    padding: 0;
    color: var(--vscode-textLink-foreground);
    cursor: pointer;
  }
  .table {
    flex: 1;
    min-height: 0;
    overflow: auto;
    border: 1px solid var(--vscode-panel-border, transparent);
  }
  table {
    border-collapse: collapse;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.9em;
  }
  th,
  td {
    text-align: left;
    padding: 2px 8px;
    border-bottom: 1px solid var(--vscode-panel-border, transparent);
    white-space: pre;
    max-width: 420px;
    overflow: hidden;
    text-overflow: ellipsis;
    user-select: text;
  }
  th {
    position: sticky;
    top: 0;
    background: var(--vscode-editor-background);
    color: var(--vscode-descriptionForeground);
  }
  .key {
    font-weight: 600;
  }
  td.differs {
    background: var(--vscode-diffEditor-insertedLineBackground, rgba(155, 185, 85, 0.15));
  }
  .before {
    color: var(--vscode-gitDecoration-deletedResourceForeground, #c74e39);
  }
  .after {
    color: var(--vscode-gitDecoration-addedResourceForeground, #81b88b);
  }
  .arrow,
  .null {
    color: var(--vscode-descriptionForeground);
  }
</style>

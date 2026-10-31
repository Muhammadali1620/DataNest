<script lang="ts">
  import { onMount } from 'svelte';
  import {
    type DataImportProtocol,
    IMPORT_DELIMITERS,
    type ImportMapping,
    type ImportOptions,
    type ImportPageProgress,
    type ImportPageReport,
    type ImportPageState,
    type ImportPreviewRow,
    type ImportSourceView,
  } from '../../../../src/shared/protocols/data-import';
  import type { RpcPeer } from '../../../../src/shared/rpc';
  import { formatSize } from '../../../../src/shared/byte-size';
  import Field from '../../components/Field.svelte';
  import Icon from '../../components/Icon.svelte';
  import type { Translate } from '../../lib/i18n';
  import { DELIMITER_LABELS, failureText, problemText, reportText } from './import-view';

  interface Props {
    rpc: RpcPeer<DataImportProtocol['webview'], DataImportProtocol['host']>;
    t: Translate;
    /** Milliseconds between the last change and asking for a new preview. */
    previewDelay?: number;
  }

  const { rpc, t, previewDelay = 150 }: Props = $props();

  let page = $state<ImportPageState | undefined>(undefined);
  let options = $state<ImportOptions | undefined>(undefined);
  let source = $state<ImportSourceView | undefined>(undefined);
  let mapping = $state<ImportMapping>([]);
  let preview = $state<ImportPreviewRow[]>([]);
  let mode = $state<'all' | 'skip'>('all');
  let progress = $state<ImportPageProgress | undefined>(undefined);
  let report = $state<ImportPageReport | undefined>(undefined);
  let error = $state<string | undefined>(undefined);
  let starting = $state(false);
  let content = $state<HTMLDivElement | undefined>(undefined);

  const running = $derived(progress !== undefined || starting);
  const mapped = $derived(mapping.filter((index) => index !== null).length);
  const problems = $derived(
    preview.reduce(
      (count, row) =>
        count +
        (row.error === undefined ? 0 : 1) +
        row.cells.filter((cell) => 'problem' in cell).length,
      0,
    ),
  );

  // A finished import shows its result at the top of the page: bring it into view.
  // The effect reads the report and the scroller and writes neither.
  $effect(() => {
    if (report !== undefined && content !== undefined) {
      content.scrollTop = 0;
    }
  });

  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  /** Answers to older requests are dropped: only the latest change counts. */
  let previewTicket = 0;

  function schedulePreview(): void {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => void refreshPreview(), previewDelay);
  }

  async function refreshPreview(): Promise<void> {
    if (options === undefined) {
      return;
    }
    const ticket = ++previewTicket;
    try {
      const answer = await rpc.request('preview', { options, mapping });
      if (ticket === previewTicket) {
        preview = answer.rows;
        error = undefined;
      }
    } catch (failure) {
      if (ticket === previewTicket) {
        error = failure instanceof Error ? failure.message : String(failure);
      }
    }
  }

  async function changeOptions(next: ImportOptions): Promise<void> {
    options = next;
    try {
      const loaded = await rpc.request('load', next);
      source = loaded.source;
      mapping = loaded.mapping;
      error = undefined;
      await refreshPreview();
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
  }

  function setOption<K extends keyof ImportOptions>(key: K, value: ImportOptions[K]): void {
    if (options !== undefined) {
      void changeOptions({ ...options, [key]: value });
    }
  }

  function setMapping(column: number, value: string): void {
    mapping = mapping.map((current, index) =>
      index === column ? (value === '' ? null : Number(value)) : current,
    );
    schedulePreview();
  }

  async function start(): Promise<void> {
    if (options === undefined) {
      return;
    }
    starting = true;
    report = undefined;
    try {
      const answer = await rpc.request('start', { options, mapping, mode });
      if (answer.started) {
        progress = { read: 0, inserted: 0, failed: 0, percent: 0 };
      }
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    } finally {
      starting = false;
    }
  }

  onMount(() => {
    const subscriptions = [
      rpc.on('state', (next) => {
        page = next;
        options = next.options;
        source = next.source;
        mapping = next.mapping;
        progress = next.progress;
        report = next.report;
        void refreshPreview();
      }),
      rpc.on('progress', (next) => {
        progress = next;
      }),
      rpc.on('finished', (next) => {
        progress = undefined;
        report = next;
      }),
    ];
    rpc.emit('ready', {});
    return () => {
      clearTimeout(previewTimer);
      for (const subscription of subscriptions) {
        subscription.dispose();
      }
    };
  });
</script>

{#if page === undefined || options === undefined || source === undefined}
  <div class="empty loading" role="status">
    <span class="empty-icon"><Icon name="loading" size={24} spin /></span>
    <p class="empty-title">{t('form.loading')}</p>
  </div>
{:else}
  <main class="page">
    <header class="page-header">
      <span class="header-icon tile tone-teal"><Icon name="insert" size={20} /></span>
      <div class="header-text">
        <h1>{t('import.title', page.file, page.table)}</h1>
        <p class="subtitle">
          <span class="badge outline">{formatSize(page.size)}</span><span
            >{t('import.subtitle')}</span
          >
        </p>
      </div>
    </header>

    <div class="content" bind:this={content}>
      {#if report !== undefined}
        {@const clean = report.failedCount === 0 && report.outcome === 'done'}
        <section
          class="notice report fade-in"
          class:success={clean}
          class:warning={!clean}
          aria-label={t('import.report')}
          data-testid="report"
        >
          <Icon name={clean ? 'pass' : 'warning'} />
          <div class="report-body">
            <p class="report-title">{reportText(report, t)}</p>
            {#if report.failures.length > 0}
              <ul class="failures">
                {#each report.failures as failure, index (index)}
                  <li>{failureText(failure, t)}</li>
                {/each}
              </ul>
              {#if report.failedCount > report.failures.length}
                <p class="muted small">
                  {t('import.moreFailures', report.failedCount - report.failures.length)}
                </p>
              {/if}
            {/if}
          </div>
        </section>
      {/if}

      <section class="card" aria-label={t('import.options')}>
        <h2 class="section-title"><Icon name="file" />{t('import.options')}</h2>
        <div class="options">
          <Field label={t('import.format')}>
            <select
              class="control"
              value={options.format}
              disabled={running}
              onchange={(event) => {
                setOption('format', event.currentTarget.value === 'json' ? 'json' : 'csv');
              }}
            >
              <option value="csv">CSV</option>
              <option value="json">JSON</option>
            </select>
          </Field>
          {#if options.format === 'csv'}
            <Field label={t('import.delimiter')}>
              <select
                class="control"
                value={options.delimiter}
                disabled={running}
                onchange={(event) => {
                  const value = IMPORT_DELIMITERS.find((d) => d === event.currentTarget.value);
                  if (value !== undefined) {
                    setOption('delimiter', value);
                  }
                }}
              >
                {#each IMPORT_DELIMITERS as delimiter (delimiter)}
                  <option value={delimiter}
                    >{t(DELIMITER_LABELS[delimiter] ?? 'import.delimiter.comma')}</option
                  >
                {/each}
              </select>
            </Field>
            <Field label={t('import.nullText')} hint={t('import.nullTextHint')}>
              <input
                class="control"
                value={options.nullText}
                maxlength="100"
                disabled={running}
                autocomplete="off"
                spellcheck="false"
                onchange={(event) => {
                  setOption('nullText', event.currentTarget.value);
                }}
              />
            </Field>
          {/if}
        </div>
        {#if options.format === 'csv'}
          <div class="checks">
            <label class="check">
              <input
                type="checkbox"
                checked={options.header}
                disabled={running}
                onchange={(event) => {
                  setOption('header', event.currentTarget.checked);
                }}
              />
              {t('import.header')}
            </label>
            <label class="check">
              <input
                type="checkbox"
                checked={options.emptyIsNull}
                disabled={running}
                onchange={(event) => {
                  setOption('emptyIsNull', event.currentTarget.checked);
                }}
              />
              {t('import.emptyIsNull')}
            </label>
          </div>
        {/if}
      </section>

      <section class="card" aria-label={t('import.columns')}>
        <div class="section-head">
          <h2 class="section-title"><Icon name="symbol-field" />{t('import.columns')}</h2>
          <span class="muted small">{t('import.mapped', mapped, page.columns.length)}</span>
        </div>
        {#if source.columns.length === 0}
          <p class="notice warning">
            <Icon name="warning" /><span>{t('import.noSourceColumns')}</span>
          </p>
        {/if}
        <div class="scroll">
          <table class="grid mapping">
            <thead>
              <tr>
                <th>{t('import.column')}</th>
                <th>{t('import.type')}</th>
                <th>{t('import.from')}</th>
              </tr>
            </thead>
            <tbody>
              {#each page.columns as column, index (column.name)}
                <tr>
                  <td class="name">{column.name}</td>
                  <td class="muted type">{column.dataType}</td>
                  <td class="from">
                    {#if column.generated}
                      <span class="muted locked"
                        ><Icon name="lock" size={14} /><span>{t('import.generated')}</span></span
                      >
                    {:else}
                      <select
                        class="control"
                        class:skipped={mapping[index] === null || mapping[index] === undefined}
                        aria-label={t('import.fromFor', column.name)}
                        value={mapping[index] === null || mapping[index] === undefined
                          ? ''
                          : String(mapping[index])}
                        disabled={running}
                        onchange={(event) => {
                          setMapping(index, event.currentTarget.value);
                        }}
                      >
                        <option value=""
                          >{column.hasDefault || column.nullable
                            ? t('import.skip')
                            : t('import.skipRequired')}</option
                        >
                        {#each source.columns as name, sourceIndex (sourceIndex)}
                          <option value={String(sourceIndex)}>{name}</option>
                        {/each}
                      </select>
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </section>

      <section class="card" aria-label={t('import.preview')}>
        <h2 class="section-title"><Icon name="preview" />{t('import.preview')}</h2>
        {#if preview.length === 0}
          <p class="muted placeholder">{t('import.previewEmpty')}</p>
        {:else}
          <div class="scroll">
            <table class="grid preview" data-testid="preview">
              <thead>
                <tr>
                  <th class="line">{t('import.line')}</th>
                  {#each page.columns as column (column.name)}
                    <th>{column.name}</th>
                  {/each}
                </tr>
              </thead>
              <tbody>
                {#each preview as row (row.line)}
                  <tr>
                    <td class="line muted">{row.line}</td>
                    {#if row.error !== undefined}
                      <td class="bad" colspan={page.columns.length}
                        ><span class="bad-value"
                          ><Icon name="error" size={14} /><span>{row.error}</span></span
                        ></td
                      >
                    {:else}
                      {#each row.cells as cell, index (index)}
                        {#if 'problem' in cell}
                          <td class="bad" title={problemText(cell.problem, t)}
                            ><span class="bad-value"
                              ><Icon name="error" size={14} /><span
                                >{problemText(cell.problem, t)}</span
                              ></span
                            ></td
                          >
                        {:else if 'fill' in cell}
                          <td class="muted fill">{t('import.default')}</td>
                        {:else}
                          <td>{cell.text}</td>
                        {/if}
                      {/each}
                    {/if}
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          {#if problems > 0}
            <p class="notice warning" role="status">
              <Icon name="warning" /><span>{t('import.previewProblems', problems)}</span>
            </p>
          {/if}
        {/if}
      </section>

      <section class="card" aria-label={t('import.mode')}>
        <h2 class="section-title"><Icon name="shield" />{t('import.mode')}</h2>
        <div class="modes">
          <label class="check">
            <input type="radio" name="mode" value="all" bind:group={mode} disabled={running} />
            {t(page.transactional ? 'import.modeAll' : 'import.modeStop')}
          </label>
          <label class="check">
            <input type="radio" name="mode" value="skip" bind:group={mode} disabled={running} />
            {t('import.modeSkip')}
          </label>
        </div>
      </section>
    </div>

    <footer class="actions-bar">
      {#if error !== undefined}
        <p class="notice error fade-in" role="alert">
          <Icon name="error" /><span>{error}</span>
        </p>
      {/if}
      {#if progress !== undefined}
        <div class="progress" role="status" data-testid="progress">
          <span
            class="meter"
            role="progressbar"
            aria-label={t('import.progressLabel')}
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuenow={progress.percent}
            ><span class="meter-fill" style="transform: scaleX({progress.percent / 100})"
            ></span></span
          >
          <span class="small">{t('import.progress', progress.read, progress.inserted, progress.failed)}</span>
          <button
            type="button"
            class="button secondary"
            onclick={() => {
              rpc.emit('cancel', {});
            }}><Icon name="debug-stop" />{t('import.stop')}</button
          >
        </div>
      {/if}
      <span class="spacer"></span>
      <button
        type="button"
        class="button secondary"
        onclick={() => {
          rpc.emit('close', {});
        }}>{t('import.close')}</button
      >
      <button
        type="button"
        class="button"
        disabled={running || mapped === 0}
        onclick={() => void start()}
        ><Icon name={running ? 'loading' : 'insert'} spin={running} />{t('import.start')}</button
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


  .header-text {
    min-width: 0;
  }

  h1 {
    overflow-wrap: anywhere;
  }

  .subtitle {
    display: flex;
    flex-wrap: wrap;
    gap: var(--dn-gap);
    align-items: center;
    margin: 4px 0 0;
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

  .card {
    display: flex;
    flex-direction: column;
    gap: var(--dn-gap-m);
    min-width: 0;
  }

  .card .notice {
    margin: 0;
  }

  .section-head {
    display: flex;
    flex-wrap: wrap;
    gap: var(--dn-gap-s) var(--dn-gap-m);
    align-items: center;
    justify-content: space-between;
  }

  .section-title {
    display: flex;
    gap: var(--dn-gap);
    align-items: center;
  }

  .section-title :global(.codicon-glyph) {
    color: var(--dn-muted);
  }

  .options {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    max-width: 760px;
    gap: var(--dn-gap-m);
    align-items: start;
  }

  .checks,
  .modes {
    display: flex;
    flex-direction: column;
    gap: var(--dn-gap);
  }

  .check {
    display: flex;
    gap: var(--dn-gap);
    align-items: center;
    cursor: pointer;
  }

  .scroll {
    overflow-x: auto;
  }

  .grid {
    border-collapse: collapse;
  }

  .mapping {
    width: 100%;
  }

  th {
    padding: 0 10px 6px;
    color: var(--dn-muted);
    font-size: var(--dn-font-small);
    font-weight: 600;
    text-align: left;
    white-space: nowrap;
    border-bottom: 1px solid var(--dn-divider);
  }

  td {
    padding: 5px 10px;
    text-align: left;
    white-space: nowrap;
    border-bottom: 1px solid var(--dn-divider);
  }

  tbody tr:last-child td {
    border-bottom: none;
  }

  .mapping td {
    padding-top: 3px;
    padding-bottom: 3px;
  }

  .name {
    font-weight: 600;
  }

  .type {
    font-family: var(--dn-mono);
    font-size: var(--dn-font-small);
  }

  .from {
    width: 45%;
  }

  .from select {
    width: 100%;
    max-width: 360px;
    min-width: 150px;
  }

  .from select.skipped {
    color: var(--dn-muted);
  }

  .locked {
    display: inline-flex;
    gap: var(--dn-gap-s);
    align-items: center;
    font-style: italic;
  }

  .preview td {
    max-width: 240px;
    overflow: hidden;
    font-family: var(--dn-mono);
    font-size: var(--dn-font-small);
    text-overflow: ellipsis;
    user-select: text;
  }

  .line {
    width: 1%;
    text-align: right;
  }

  .fill {
    font-style: italic;
  }

  .bad-value {
    display: inline-flex;
    gap: var(--dn-gap-s);
    align-items: center;
    color: var(--vscode-inputValidation-errorForeground, var(--dn-danger));
    font-family: var(--vscode-font-family);
  }

  .bad-value > :global(.codicon-glyph) {
    color: var(--dn-danger);
  }

  .placeholder {
    margin: 0;
  }

  .report {
    margin: 0;
  }

  .report-body {
    display: flex;
    flex-direction: column;
    gap: var(--dn-gap-s);
    min-width: 0;
  }

  .report-title {
    margin: 0;
    font-weight: 600;
  }

  .failures {
    margin: 0;
    padding-left: 18px;
    user-select: text;
  }

  .report p.muted {
    margin: 0;
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

  .progress {
    display: flex;
    flex-wrap: wrap;
    gap: var(--dn-gap-m);
    align-items: center;
  }

  .meter {
    display: block;
    width: 140px;
    height: 4px;
    overflow: hidden;
    background: var(--dn-divider);
    border-radius: 2px;
  }

  .meter-fill {
    display: block;
    width: 100%;
    height: 100%;
    background: var(--vscode-progressBar-background, var(--dn-accent));
    transform-origin: left;
    transition: transform var(--dn-duration) var(--dn-ease);
  }

  .spacer {
    flex: 1;
  }

  .empty {
    display: flex;
    flex-direction: column;
    gap: var(--dn-gap);
    align-items: center;
    justify-content: center;
    height: 100vh;
    color: var(--dn-muted);
  }

  .empty-icon {
    display: inline-flex;
    padding: 12px;
    background: var(--dn-surface);
    border: 1px solid var(--dn-border);
    border-radius: 50%;
  }

  .empty-title {
    margin: 0;
    color: var(--vscode-foreground);
    font-size: 14px;
  }

  @media (max-width: 560px) {
    .page-header,
    .content,
    .actions-bar {
      padding-right: var(--dn-gap-m);
      padding-left: var(--dn-gap-m);
    }

    .from {
      width: auto;
    }
  }
</style>

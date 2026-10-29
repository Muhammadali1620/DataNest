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
  <p class="loading">{t('form.loading')}</p>
{:else}
  <main>
    <h1>{t('import.title', page.file, page.table)}</h1>
    <p class="hint">{formatSize(page.size)}</p>

    <section class="options" aria-label={t('import.options')}>
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
              <option value={delimiter}>{t(DELIMITER_LABELS[delimiter] ?? 'import.delimiter.comma')}</option>
            {/each}
          </select>
        </Field>
        <Field label={t('import.nullText')} hint={t('import.nullTextHint')}>
          <input
            class="control"
            value={options.nullText}
            maxlength="100"
            disabled={running}
            onchange={(event) => {
              setOption('nullText', event.currentTarget.value);
            }}
          />
        </Field>
        <div class="checks">
          <label>
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
          <label>
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

    <section aria-label={t('import.columns')}>
      <h2>{t('import.columns')}</h2>
      {#if source.columns.length === 0}
        <p class="hint">{t('import.noSourceColumns')}</p>
      {/if}
      <table class="mapping">
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
              <td>{column.name}</td>
              <td class="dim">{column.dataType}</td>
              <td>
                {#if column.generated}
                  <span class="dim">{t('import.generated')}</span>
                {:else}
                  <select
                    class="control"
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
    </section>

    <section aria-label={t('import.preview')}>
      <h2>{t('import.preview')}</h2>
      {#if preview.length === 0}
        <p class="hint">{t('import.previewEmpty')}</p>
      {:else}
        <div class="scroll">
          <table class="preview" data-testid="preview">
            <thead>
              <tr>
                <th>{t('import.line')}</th>
                {#each page.columns as column (column.name)}
                  <th>{column.name}</th>
                {/each}
              </tr>
            </thead>
            <tbody>
              {#each preview as row (row.line)}
                <tr>
                  <td class="dim">{row.line}</td>
                  {#if row.error !== undefined}
                    <td class="bad" colspan={page.columns.length}>{row.error}</td>
                  {:else}
                    {#each row.cells as cell, index (index)}
                      {#if 'problem' in cell}
                        <td class="bad" title={problemText(cell.problem, t)}
                          >{problemText(cell.problem, t)}</td
                        >
                      {:else if 'fill' in cell}
                        <td class="dim">{t('import.default')}</td>
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
          <p class="warn" role="status">{t('import.previewProblems', problems)}</p>
        {/if}
      {/if}
    </section>

    <section class="modes" aria-label={t('import.mode')}>
      <label>
        <input type="radio" name="mode" value="all" bind:group={mode} disabled={running} />
        {t(page.transactional ? 'import.modeAll' : 'import.modeStop')}
      </label>
      <label>
        <input type="radio" name="mode" value="skip" bind:group={mode} disabled={running} />
        {t('import.modeSkip')}
      </label>
    </section>

    {#if error !== undefined}
      <p class="bad" role="alert">{error}</p>
    {/if}

    {#if progress !== undefined}
      <div class="progress" role="status" data-testid="progress">
        <progress max="100" value={progress.percent}></progress>
        <span
          >{t('import.progress', progress.read, progress.inserted, progress.failed)}</span
        >
        <button
          class="button secondary"
          onclick={() => {
            rpc.emit('cancel', {});
          }}>{t('import.stop')}</button
        >
      </div>
    {/if}

    {#if report !== undefined}
      <section class="report" aria-label={t('import.report')} data-testid="report">
        <p class={report.failedCount === 0 && report.outcome === 'done' ? 'good' : 'warn'}>
          {reportText(report, t)}
        </p>
        {#if report.failures.length > 0}
          <ul>
            {#each report.failures as failure, index (index)}
              <li>{failureText(failure, t)}</li>
            {/each}
          </ul>
          {#if report.failedCount > report.failures.length}
            <p class="hint">{t('import.moreFailures', report.failedCount - report.failures.length)}</p>
          {/if}
        {/if}
      </section>
    {/if}

    <footer>
      <span class="hint">{t('import.mapped', mapped, page.columns.length)}</span>
      <span class="spacer"></span>
      <button
        class="button secondary"
        onclick={() => {
          rpc.emit('close', {});
        }}>{t('import.close')}</button
      >
      <button class="button" disabled={running || mapped === 0} onclick={() => void start()}
        >{t('import.start')}</button
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

  h2 {
    margin: 0 0 6px;
    font-size: 1.05em;
    font-weight: 600;
  }

  .loading {
    padding: 12px 16px;
  }

  .options {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 12px;
  }

  .checks,
  .modes {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  table {
    border-collapse: collapse;
  }

  th,
  td {
    padding: 3px 8px;
    text-align: left;
    border-bottom: 1px solid var(--vscode-panel-border, transparent);
    white-space: nowrap;
  }

  .preview td {
    max-width: 240px;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .scroll {
    overflow-x: auto;
  }

  .dim,
  .hint {
    color: var(--vscode-descriptionForeground);
  }

  .bad {
    color: var(--vscode-errorForeground);
  }

  .warn {
    color: var(--vscode-editorWarning-foreground, var(--vscode-foreground));
  }

  .good {
    color: var(--vscode-testing-iconPassed, var(--vscode-foreground));
  }

  .progress {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  footer {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .spacer {
    flex: 1;
  }
</style>

<script lang="ts">
  import type { TableAction } from '../../../../src/shared/table-actions';
  import { onMount } from 'svelte';
  import {
    GENERATOR_IDS,
    MAX_GENERATED_ROWS,
    type TestDataChoice,
    type TestDataProtocol,
    type TestDataReport,
    type TestDataState,
  } from '../../../../src/shared/protocols/test-data';
  import type { RpcPeer } from '../../../../src/shared/rpc';
  import Field from '../../components/Field.svelte';
  import Icon from '../../components/Icon.svelte';
  import TableBar from '../../components/TableBar.svelte';
  import BootBar from '../../components/BootBar.svelte';
  import type { Translate } from '../../lib/i18n';
  import { generatorLabel, problemLabel, reportLabel } from './generator-view';

  interface Props {
    rpc: RpcPeer<TestDataProtocol['webview'], TestDataProtocol['host']>;
    t: Translate;
    /** Milliseconds between the last change and asking for a new preview. */
    previewDelay?: number;
  }

  const { rpc, t, previewDelay = 150 }: Props = $props();

  let page = $state<TestDataState | undefined>(undefined);
  let choices = $state<TestDataChoice[]>([]);
  let count = $state(100);
  let seed = $state(1);
  let rows = $state<(string | null)[][]>([]);
  let problems = $state<{ column: string; problem: string }[]>([]);
  let progress = $state<{ done: number; total: number } | undefined>(undefined);
  let report = $state<TestDataReport | undefined>(undefined);
  let error = $state<string | undefined>(undefined);
  let busy = $state(false);

  const running = $derived(progress !== undefined || busy);
  const countValid = $derived(Number.isInteger(count) && count >= 1 && count <= MAX_GENERATED_ROWS);
  const filled = $derived(choices.filter((choice) => choice.generator !== 'default').length);

  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  let previewTicket = 0;

  function schedulePreview(): void {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => void refreshPreview(), previewDelay);
  }

  async function refreshPreview(): Promise<void> {
    const ticket = ++previewTicket;
    try {
      const answer = await rpc.request('preview', { choices, seed });
      if (ticket === previewTicket) {
        rows = answer.rows;
        problems = answer.problems;
        error = undefined;
      }
    } catch (failure) {
      if (ticket === previewTicket) {
        error = failure instanceof Error ? failure.message : String(failure);
      }
    }
  }

  function setChoice(index: number, change: Partial<TestDataChoice>): void {
    choices = choices.map((choice, at) => (at === index ? { ...choice, ...change } : choice));
    schedulePreview();
  }

  function reseed(): void {
    seed = Math.floor(Math.random() * 0xffffffff);
    schedulePreview();
  }

  async function insert(): Promise<void> {
    busy = true;
    report = undefined;
    try {
      const answer = await rpc.request('insert', { choices, count, seed });
      if (answer.started) {
        progress = { done: 0, total: count };
      }
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    } finally {
      busy = false;
    }
  }

  async function openSql(): Promise<void> {
    busy = true;
    try {
      await rpc.request('openSql', { choices, count, seed });
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    } finally {
      busy = false;
    }
  }

  onMount(() => {
    const subscriptions = [
      rpc.on('state', (next) => {
        page = next;
        choices = next.choices;
        count = next.count;
        seed = next.seed;
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

{#if page === undefined}
  <main class="page">
  <BootBar {t} />
  <div class="empty" role="status">
    <span class="empty-icon"><Icon name="loading" size={24} spin /></span>
    <p class="empty-title">{t('form.loading')}</p>
  </div>
  </main>
{:else}
  <main class="page">
    {#if page.tableBar !== undefined}
      <TableBar
        {t}
        active="generate"
        isView={page.tableBar.isView}
        onAction={(action: TableAction) => {
          // Leaving while rows are going in would stop the run.
          rpc.emit('tableNav', { action, dirty: running });
        }}
      />
    {/if}
    <header class="page-header">
      <span class="header-icon tile tone-yellow"><Icon name="beaker" size={20} /></span>
      <div class="header-text">
        <h1>{t('testData.title', page.table)}</h1>
        <p class="subtitle">{t('testData.subtitle')}</p>
      </div>
    </header>

    <div class="content">
      <section class="card" aria-label={t('testData.section.rows')}>
        <h2 class="section-title"><Icon name="list-ordered" />{t('testData.section.rows')}</h2>
        <div class="options">
          <Field
            label={t('testData.count')}
            error={countValid ? undefined : t('testData.countInvalid', MAX_GENERATED_ROWS)}
          >
            <input
              class="control"
              type="number"
              min="1"
              max={MAX_GENERATED_ROWS}
              bind:value={count}
              aria-invalid={!countValid}
              disabled={running}
            />
          </Field>
          <Field label={t('testData.seed')} hint={t('testData.seedHint')}>
            <span class="seed">
              <input
                class="control"
                type="number"
                min="0"
                max="4294967295"
                value={seed}
                disabled={running}
                onchange={(event) => {
                  const next = Number(event.currentTarget.value);
                  if (Number.isInteger(next) && next >= 0 && next <= 0xffffffff) {
                    seed = next;
                    schedulePreview();
                  }
                }}
              />
              <button
                type="button"
                class="button secondary"
                title={t('testData.newSeedHint')}
                disabled={running}
                onclick={reseed}><Icon name="refresh" />{t('testData.newSeed')}</button
              >
            </span>
          </Field>
        </div>
      </section>

      <section class="card" aria-label={t('import.columns')}>
        <div class="section-head">
          <h2 class="section-title"><Icon name="symbol-field" />{t('import.columns')}</h2>
          <span class="muted small">{t('testData.filled', filled, page.columns.length)}</span>
        </div>
        <div class="scroll">
          <table class="grid columns">
            <thead>
              <tr>
                <th>{t('import.column')}</th>
                <th>{t('import.type')}</th>
                <th>{t('testData.generator')}</th>
                <th class="nulls">{t('testData.nulls')}</th>
              </tr>
            </thead>
            <tbody>
              {#each page.columns as column, index (column.name)}
                {@const choice = choices[index]}
                {@const problem = problems.find((item) => item.column === column.name)}
                <tr>
                  <td>
                    <span class="name">{column.name}</span>
                    {#if column.unique}<span class="badge outline">{t('testData.unique')}</span>{/if}
                  </td>
                  <td class="muted">
                    <span class="type">{column.dataType}</span>
                    {#if column.reference !== undefined}
                      <span class="reference"
                        ><Icon name="arrow-right" size={12} /><span>{column.reference}</span></span
                      >
                    {/if}
                  </td>
                  <td class="generator">
                    {#if column.locked !== undefined}
                      <span class="muted locked"
                        ><Icon name="lock" size={14} /><span
                          >{column.locked === 'auto'
                            ? t('testData.auto')
                            : t('import.generated')}</span
                        ></span
                      >
                    {:else if choice !== undefined}
                      <select
                        class="control"
                        class:skipped={choice.generator === 'default'}
                        aria-label={t('testData.generatorFor', column.name)}
                        aria-invalid={problem !== undefined}
                        value={choice.generator}
                        disabled={running}
                        onchange={(event) => {
                          const id = GENERATOR_IDS.find((g) => g === event.currentTarget.value);
                          if (id !== undefined) {
                            setChoice(index, { generator: id });
                          }
                        }}
                      >
                        {#each GENERATOR_IDS as id (id)}
                          <option value={id}>{generatorLabel(id, t)}</option>
                        {/each}
                      </select>
                      {#if problem !== undefined}
                        <span class="field-error" role="alert"
                          ><Icon name="error" size={14} /><span
                            >{problemLabel(problem.problem, t)}</span
                          ></span
                        >
                      {/if}
                    {/if}
                  </td>
                  <td class="nulls">
                    {#if column.nullable && column.locked === undefined && choice !== undefined}
                      <input
                        class="control percent"
                        type="number"
                        min="0"
                        max="100"
                        aria-label={t('testData.nullsFor', column.name)}
                        value={choice.nullPercent}
                        disabled={running}
                        onchange={(event) => {
                          const next = Math.round(Number(event.currentTarget.value));
                          if (Number.isFinite(next)) {
                            setChoice(index, { nullPercent: Math.min(100, Math.max(0, next)) });
                          }
                        }}
                      />
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
        <div class="scroll">
          <table class="grid preview" data-testid="preview">
            <thead>
              <tr>
                {#each page.columns as column (column.name)}
                  <th>{column.name}</th>
                {/each}
              </tr>
            </thead>
            <tbody>
              {#each rows as row, rowIndex (rowIndex)}
                <tr>
                  {#each row as value, index (index)}
                    {#if value === null}
                      <td class="muted special"
                        >{choices[index]?.generator === 'default' ? t('import.default') : 'NULL'}</td
                      >
                    {:else}
                      <td>{value}</td>
                    {/if}
                  {/each}
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </section>
    </div>

    <footer class="actions-bar">
      {#if error !== undefined}
        <p class="notice error fade-in" role="alert"><Icon name="error" /><span>{error}</span></p>
      {/if}
      {#if progress !== undefined}
        <div class="progress" role="status" data-testid="progress">
          <span
            class="meter"
            role="progressbar"
            aria-label={t('testData.progressLabel')}
            aria-valuemin="0"
            aria-valuemax={progress.total}
            aria-valuenow={progress.done}
            ><span
              class="meter-fill"
              style="transform: scaleX({progress.total === 0 ? 0 : progress.done / progress.total})"
            ></span></span
          >
          <span class="small">{t('testData.progress', progress.done, progress.total)}</span>
          <button
            type="button"
            class="button secondary"
            onclick={() => {
              rpc.emit('cancel', {});
            }}><Icon name="debug-stop" />{t('import.stop')}</button
          >
        </div>
      {/if}
      {#if report !== undefined}
        <p
          class="notice fade-in"
          class:success={report.outcome === 'done'}
          class:warning={report.outcome !== 'done'}
          role="status"
          data-testid="report"
        >
          <Icon name={report.outcome === 'done' ? 'pass' : 'warning'} /><span
            >{reportLabel(report, t)}</span
          >
        </p>
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
        class="button secondary"
        disabled={running || !countValid || filled === 0}
        onclick={() => void openSql()}><Icon name="go-to-file" />{t('testData.openSql')}</button
      >
      <button
        type="button"
        class="button"
        disabled={running || !countValid || filled === 0 || problems.length > 0}
        onclick={() => void insert()}
        ><Icon name={running ? 'loading' : 'play'} spin={running} />{t('testData.insert')}</button
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

  .card {
    display: flex;
    flex-direction: column;
    gap: var(--dn-gap-m);
    min-width: 0;
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
    grid-template-columns: minmax(140px, 200px) minmax(220px, 360px);
    gap: var(--dn-gap-m);
    align-items: start;
  }

  .seed {
    display: flex;
    gap: var(--dn-gap-s);
  }

  .seed input {
    flex: 1;
    min-width: 0;
  }

  .scroll {
    overflow-x: auto;
  }

  .grid {
    border-collapse: collapse;
  }

  .columns {
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

  .columns td {
    padding-top: 3px;
    padding-bottom: 3px;
  }

  .name {
    margin-right: var(--dn-gap-s);
    font-weight: 600;
  }

  .type {
    font-family: var(--dn-mono);
    font-size: var(--dn-font-small);
  }

  .reference {
    display: inline-flex;
    gap: 2px;
    align-items: center;
    margin-left: var(--dn-gap-s);
    font-family: var(--dn-mono);
    font-size: var(--dn-font-small);
  }

  .generator {
    width: 40%;
  }

  .generator select {
    width: 100%;
    max-width: 320px;
    min-width: 150px;
  }

  .generator select.skipped {
    color: var(--dn-muted);
  }

  .locked {
    display: inline-flex;
    gap: var(--dn-gap-s);
    align-items: center;
    font-style: italic;
  }

  .field-error {
    display: flex;
    gap: 4px;
    align-items: center;
    margin-top: 2px;
    color: var(--vscode-inputValidation-errorForeground, var(--dn-danger));
    font-size: var(--dn-font-small);
  }

  .field-error > :global(.codicon-glyph) {
    color: var(--dn-danger);
  }

  .nulls {
    width: 1%;
  }

  .percent {
    width: 6em;
  }

  .preview td {
    max-width: 220px;
    overflow: hidden;
    font-family: var(--dn-mono);
    font-size: var(--dn-font-small);
    text-overflow: ellipsis;
    user-select: text;
  }

  .special {
    font-style: italic;
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

    .options {
      grid-template-columns: 1fr;
    }

    .generator {
      width: auto;
    }
  }
</style>

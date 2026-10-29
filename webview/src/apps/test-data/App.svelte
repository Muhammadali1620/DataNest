<script lang="ts">
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
  <p class="loading">{t('form.loading')}</p>
{:else}
  <main>
    <h1>{t('testData.title', page.table)}</h1>

    <section class="options">
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
          <button class="button secondary" disabled={running} onclick={reseed}
            >{t('testData.newSeed')}</button
          >
        </span>
      </Field>
    </section>

    <table class="columns">
      <thead>
        <tr>
          <th>{t('import.column')}</th>
          <th>{t('import.type')}</th>
          <th>{t('testData.generator')}</th>
          <th>{t('testData.nulls')}</th>
        </tr>
      </thead>
      <tbody>
        {#each page.columns as column, index (column.name)}
          {@const choice = choices[index]}
          {@const problem = problems.find((item) => item.column === column.name)}
          <tr>
            <td>
              {column.name}
              {#if column.unique}<span class="tag">{t('testData.unique')}</span>{/if}
            </td>
            <td class="dim">
              {column.dataType}
              {#if column.reference !== undefined}<span class="dim"> → {column.reference}</span>{/if}
            </td>
            <td>
              {#if column.locked !== undefined}
                <span class="dim"
                  >{column.locked === 'auto' ? t('testData.auto') : t('import.generated')}</span
                >
              {:else if choice !== undefined}
                <select
                  class="control"
                  aria-label={t('testData.generatorFor', column.name)}
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
                  <span class="bad" role="alert">{problemLabel(problem.problem, t)}</span>
                {/if}
              {/if}
            </td>
            <td>
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

    <section aria-label={t('import.preview')}>
      <h2>{t('import.preview')}</h2>
      <div class="scroll">
        <table class="preview" data-testid="preview">
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
                    <td class="dim"
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

    {#if error !== undefined}
      <p class="bad" role="alert">{error}</p>
    {/if}

    {#if progress !== undefined}
      <div class="progress" role="status" data-testid="progress">
        <progress max={progress.total} value={progress.done}></progress>
        <span>{t('testData.progress', progress.done, progress.total)}</span>
        <button
          class="button secondary"
          onclick={() => {
            rpc.emit('cancel', {});
          }}>{t('import.stop')}</button
        >
      </div>
    {/if}

    {#if report !== undefined}
      <p class={report.outcome === 'done' ? 'good' : 'warn'} role="status" data-testid="report">
        {reportLabel(report, t)}
      </p>
    {/if}

    <footer>
      <span class="hint">{t('testData.filled', filled, page.columns.length)}</span>
      <span class="spacer"></span>
      <button
        class="button secondary"
        onclick={() => {
          rpc.emit('close', {});
        }}>{t('import.close')}</button
      >
      <button
        class="button secondary"
        disabled={running || !countValid || filled === 0}
        onclick={() => void openSql()}>{t('testData.openSql')}</button
      >
      <button
        class="button"
        disabled={running || !countValid || filled === 0 || problems.length > 0}
        onclick={() => void insert()}>{t('testData.insert')}</button
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
    gap: 12px;
  }

  .seed {
    display: flex;
    gap: 6px;
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
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .percent {
    width: 5em;
  }

  .scroll {
    overflow-x: auto;
  }

  .tag {
    margin-left: 6px;
    padding: 0 4px;
    font-size: 0.85em;
    border: 1px solid var(--vscode-panel-border, currentColor);
    border-radius: 2px;
  }

  .dim,
  .hint {
    color: var(--vscode-descriptionForeground);
  }

  .bad {
    display: block;
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

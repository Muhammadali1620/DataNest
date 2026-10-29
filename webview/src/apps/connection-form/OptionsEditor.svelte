<script lang="ts">
  import { OPTION_LIMITS, optionSupport } from '../../../../src/shared/connection';
  import Field from '../../components/Field.svelte';
  import type { Translate } from '../../lib/i18n';
  import type { FormFields } from './form-model';

  interface Props {
    /** The form's state: editing it here updates the form. */
    fields: FormFields;
    t: Translate;
    /** The error to show under a field, or undefined while it is fine. */
    errorFor: (
      problem:
        | 'connect-timeout-invalid'
        | 'query-timeout-invalid'
        | 'keep-alive-invalid'
        | 'time-zone-invalid'
        | 'charset-invalid'
        | 'init-sql-too-long',
    ) => string | undefined;
  }

  const { fields, t, errorFor }: Props = $props();

  const support = $derived(optionSupport(fields.driver));
</script>

<div class="grid">
  {#if support.connectTimeout}
    <Field
      label={t('form.options.connectTimeout')}
      error={errorFor('connect-timeout-invalid')}
      hint={t('form.options.connectTimeoutHint')}
    >
      <input
        class="control"
        bind:value={fields.connectTimeout}
        inputmode="numeric"
        maxlength={3}
        placeholder="10"
        aria-invalid={errorFor('connect-timeout-invalid') !== undefined}
        aria-label={t('form.options.connectTimeout')}
        autocomplete="off"
      />
    </Field>
  {/if}
  <Field
    label={t('form.options.queryTimeout')}
    error={errorFor('query-timeout-invalid')}
    hint={t('form.options.queryTimeoutHint')}
  >
    <input
      class="control"
      bind:value={fields.queryTimeout}
      inputmode="numeric"
      maxlength={5}
      aria-invalid={errorFor('query-timeout-invalid') !== undefined}
      aria-label={t('form.options.queryTimeout')}
      autocomplete="off"
    />
  </Field>
  {#if support.keepAlive}
    <Field
      label={t('form.options.keepAlive')}
      error={errorFor('keep-alive-invalid')}
      hint={t('form.options.keepAliveHint')}
    >
      <input
        class="control"
        bind:value={fields.keepAlive}
        inputmode="numeric"
        maxlength={4}
        aria-invalid={errorFor('keep-alive-invalid') !== undefined}
        aria-label={t('form.options.keepAlive')}
        autocomplete="off"
      />
    </Field>
  {/if}
  {#if support.timeZone}
    <Field
      label={t('form.options.timeZone')}
      error={errorFor('time-zone-invalid')}
      hint={t('form.options.timeZoneHint')}
    >
      <input
        class="control"
        bind:value={fields.timeZone}
        maxlength={OPTION_LIMITS.timeZone}
        placeholder="UTC"
        aria-invalid={errorFor('time-zone-invalid') !== undefined}
        aria-label={t('form.options.timeZone')}
        autocomplete="off"
        spellcheck="false"
      />
    </Field>
  {/if}
  {#if support.charset}
    <Field
      label={t('form.options.charset')}
      error={errorFor('charset-invalid')}
      hint={t('form.options.charsetHint')}
    >
      <input
        class="control"
        bind:value={fields.charset}
        maxlength={OPTION_LIMITS.charset}
        placeholder="utf8mb4"
        aria-invalid={errorFor('charset-invalid') !== undefined}
        aria-label={t('form.options.charset')}
        autocomplete="off"
        spellcheck="false"
      />
    </Field>
  {/if}
</div>

<Field
  label={t('form.options.initSql')}
  error={errorFor('init-sql-too-long')}
  hint={t('form.options.initSqlHint')}
>
  <textarea
    class="control code"
    bind:value={fields.initSql}
    rows={3}
    maxlength={OPTION_LIMITS.initSql}
    placeholder={fields.driver === 'postgres'
      ? 'SET search_path = app, public;'
      : fields.driver === 'sqlite'
        ? 'PRAGMA foreign_keys = ON;'
        : fields.driver === 'mssql'
          ? 'SET DATEFORMAT ymd;'
          : "SET SESSION sql_mode = 'STRICT_ALL_TABLES';"}
    aria-invalid={errorFor('init-sql-too-long') !== undefined}
    aria-label={t('form.options.initSql')}
    spellcheck="false"
  ></textarea>
</Field>

<style>
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
    gap: 12px;
  }

  .code {
    font-family: var(--vscode-editor-font-family, monospace);
    resize: vertical;
  }
</style>

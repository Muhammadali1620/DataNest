<script lang="ts">
  import { CONNECTION_LIMITS, SSL_MODES } from '../../../../src/shared/connection';
  import Field from '../../components/Field.svelte';
  import type { MessageKey } from '../../l10n/en';
  import type { Translate } from '../../lib/i18n';
  import type { FormFields } from './form-model';

  type FileField = 'sslCa' | 'sslCert' | 'sslKey';

  interface Props {
    /** The form's state: editing it here updates the form. */
    fields: FormFields;
    t: Translate;
    /** The error under the certificate or key box, when it is the one missing. */
    certError: string | undefined;
    keyError: string | undefined;
    onBrowse: (field: FileField) => void;
  }

  const { fields, t, certError, keyError, onBrowse }: Props = $props();

  const MODE_LABELS: Readonly<Record<(typeof SSL_MODES)[number] | 'off', MessageKey>> = {
    off: 'form.ssl.mode.off',
    require: 'form.ssl.mode.require',
    'verify-ca': 'form.ssl.mode.verify-ca',
    'verify-full': 'form.ssl.mode.verify-full',
  };

  const files: readonly {
    field: FileField;
    label: MessageKey;
    hint?: MessageKey;
    error: () => string | undefined;
  }[] = [
    { field: 'sslCa', label: 'form.ssl.ca', hint: 'form.ssl.caHint', error: () => undefined },
    { field: 'sslCert', label: 'form.ssl.cert', error: () => certError },
    { field: 'sslKey', label: 'form.ssl.key', hint: 'form.ssl.clientHint', error: () => keyError },
  ];
</script>

<Field label={t('form.ssl.mode')}>
  <select class="control" bind:value={fields.sslMode} aria-label={t('form.ssl.mode')}>
    {#each ['off', ...SSL_MODES] as const as mode (mode)}
      <option value={mode}>{t(MODE_LABELS[mode])}</option>
    {/each}
  </select>
</Field>

{#if fields.sslMode !== 'off'}
  {#each files as file (file.field)}
    <Field
      label={t(file.label)}
      error={file.error()}
      hint={file.hint === undefined ? undefined : t(file.hint)}
    >
      <span class="row">
        <input
          class="control grow"
          bind:value={fields[file.field]}
          maxlength={CONNECTION_LIMITS.file}
          aria-invalid={file.error() !== undefined}
          aria-label={t(file.label)}
          autocomplete="off"
        />
        <button
          type="button"
          class="button secondary"
          aria-label={`${t(file.label)}: ${t('form.browse')}`}
          onclick={() => {
            onBrowse(file.field);
          }}
        >
          {t('form.browse')}
        </button>
      </span>
    </Field>
  {/each}
{/if}

<style>
  .row {
    display: flex;
    gap: 6px;
  }

  .grow {
    flex: 1;
    min-width: 0;
  }
</style>

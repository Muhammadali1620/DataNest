<script lang="ts">
  import { onMount } from 'svelte';
  import { CONNECTION_LIMITS, isFileDriver } from '../../../../src/shared/connection';
  import type {
    ConnectionFormProtocol,
    ConnectionFormState,
  } from '../../../../src/shared/protocols/connection-form';
  import { PASSWORD_MAX_LENGTH } from '../../../../src/shared/protocols/connection-form';
  import type { RpcPeer } from '../../../../src/shared/rpc';
  import Field from '../../components/Field.svelte';
  import type { MessageKey } from '../../l10n/en';
  import type { Translate } from '../../lib/i18n';
  import {
    fieldsFrom,
    type FormFields,
    problemMessage,
    problemsOf,
    toDraft,
  } from './form-model';

  interface Props {
    rpc: RpcPeer<ConnectionFormProtocol['webview'], ConnectionFormProtocol['host']>;
    t: Translate;
  }

  const { rpc, t }: Props = $props();

  interface Notice {
    kind: 'ok' | 'error';
    text: string;
  }

  // The generic form keeps the declared type: `= $state(undefined)` would narrow it.
  let formState = $state<ConnectionFormState | undefined>(undefined);
  let fields = $state<FormFields | undefined>(undefined);
  let busy = $state<'test' | 'save' | undefined>(undefined);
  let notice = $state<Notice | undefined>(undefined);
  /** Problems are shown only after the first attempt, so a new form is not all red. */
  let showProblems = $state(false);

  const DRIVER_LABELS: Readonly<Record<string, MessageKey>> = {
    mysql: 'form.driver.mysql',
    postgres: 'form.driver.postgres',
    sqlite: 'form.driver.sqlite',
  };

  const problems = $derived(fields === undefined ? [] : problemsOf(fields));
  const isFile = $derived(fields !== undefined && isFileDriver(fields.driver));
  const defaultPort = $derived(
    formState?.drivers.find((driver) => driver.id === fields?.driver)?.defaultPort,
  );

  function errorFor(problem: Parameters<typeof problemMessage>[1]): string | undefined {
    if (!showProblems) {
      return undefined;
    }
    const key = problemMessage(problems, problem);
    return key === undefined ? undefined : t(key);
  }

  onMount(() => {
    const subscription = rpc.on('state', (next) => {
      formState = next;
      // The host is the source of truth: a fresh state replaces what is on screen (D21).
      fields = fieldsFrom(next);
      notice = undefined;
      showProblems = false;
    });
    rpc.emit('ready', {});
    return () => {
      subscription.dispose();
    };
  });

  function driverChanged(): void {
    if (!fields) {
      return;
    }
    // Moving between drivers offers the new default port instead of the old one.
    const next = formState?.drivers.find((driver) => driver.id === fields?.driver);
    fields.port = next?.defaultPort === undefined ? '' : String(next.defaultPort);
    notice = undefined;
  }

  function messageOf(error: unknown): string {
    return error instanceof Error && error.message !== '' ? error.message : t('form.unknownError');
  }

  async function run(action: 'test' | 'save'): Promise<void> {
    if (!fields || busy !== undefined) {
      return;
    }
    showProblems = true;
    if (problems.length > 0) {
      notice = { kind: 'error', text: t('form.fixProblems') };
      return;
    }
    busy = action;
    notice = undefined;
    try {
      const draft = toDraft(fields);
      if (action === 'test') {
        await rpc.request('test', draft);
        notice = { kind: 'ok', text: t('form.testOk') };
      } else {
        await rpc.request('save', draft);
        notice = { kind: 'ok', text: t('form.saved') };
      }
    } catch (error) {
      notice = { kind: 'error', text: messageOf(error) };
    } finally {
      busy = undefined;
    }
  }

  async function browse(create: boolean): Promise<void> {
    if (!fields) {
      return;
    }
    try {
      const { file } = await rpc.request('pickFile', { create });
      if (file !== undefined) {
        fields.file = file;
        notice = undefined;
      }
    } catch (error) {
      notice = { kind: 'error', text: messageOf(error) };
    }
  }
</script>

<main>
  {#if fields === undefined}
    <p class="loading">{t('form.loading')}</p>
  {:else}
    <h1>{formState?.connectionId === undefined ? t('form.titleNew') : t('form.titleEdit')}</h1>

    <form
      onsubmit={(event) => {
        event.preventDefault();
        void run('save');
      }}
    >
      <Field label={t('form.name')} error={errorFor('name-empty')}>
        <input
          class="control"
          bind:value={fields.name}
          maxlength={CONNECTION_LIMITS.name}
          aria-invalid={errorFor('name-empty') !== undefined}
          aria-label={t('form.name')}
          autocomplete="off"
        />
      </Field>

      <Field label={t('form.driver')}>
        <select
          class="control"
          bind:value={fields.driver}
          onchange={driverChanged}
          aria-label={t('form.driver')}
        >
          {#each formState?.drivers ?? [] as driver (driver.id)}
            <option value={driver.id}>{t(DRIVER_LABELS[driver.id] ?? 'form.driver')}</option>
          {/each}
        </select>
      </Field>

      {#if isFile}
        <Field label={t('form.file')} error={errorFor('file-empty')}>
          <span class="row">
            <input
              class="control grow"
              bind:value={fields.file}
              maxlength={CONNECTION_LIMITS.file}
              aria-invalid={errorFor('file-empty') !== undefined}
              aria-label={t('form.file')}
              autocomplete="off"
            />
            <button type="button" class="button secondary" onclick={() => void browse(false)}>
              {t('form.browse')}
            </button>
            <button type="button" class="button secondary" onclick={() => void browse(true)}>
              {t('form.createFile')}
            </button>
          </span>
        </Field>
      {:else}
        <div class="pair">
          <Field label={t('form.host')} error={errorFor('host-empty')}>
            <input
              class="control"
              bind:value={fields.host}
              maxlength={CONNECTION_LIMITS.field}
              aria-invalid={errorFor('host-empty') !== undefined}
              aria-label={t('form.host')}
              autocomplete="off"
            />
          </Field>
          <Field
            label={t('form.port')}
            error={errorFor('port-invalid')}
            hint={defaultPort === undefined ? undefined : t('form.portHint', defaultPort)}
          >
            <input
              class="control"
              bind:value={fields.port}
              inputmode="numeric"
              maxlength={5}
              aria-invalid={errorFor('port-invalid') !== undefined}
              aria-label={t('form.port')}
              autocomplete="off"
            />
          </Field>
        </div>

        <div class="pair">
          <Field label={t('form.user')}>
            <input
              class="control"
              bind:value={fields.user}
              maxlength={CONNECTION_LIMITS.field}
              aria-label={t('form.user')}
              autocomplete="off"
            />
          </Field>
          <Field
            label={t('form.password')}
            hint={formState?.hasStoredPassword && !fields.passwordTouched
              ? t('form.passwordStored')
              : undefined}
          >
            <input
              class="control"
              type="password"
              bind:value={fields.password}
              oninput={() => {
                if (fields) {
                  fields.passwordTouched = true;
                }
              }}
              maxlength={PASSWORD_MAX_LENGTH}
              disabled={fields.erasePassword}
              aria-label={t('form.password')}
              autocomplete="off"
            />
          </Field>
        </div>

        {#if formState?.hasStoredPassword}
          <label class="check">
            <input type="checkbox" bind:checked={fields.erasePassword} />
            {t('form.erasePassword')}
          </label>
        {/if}

        <Field label={t('form.database')} hint={t('form.databaseHint')}>
          <input
            class="control"
            bind:value={fields.database}
            maxlength={CONNECTION_LIMITS.field}
            aria-label={t('form.database')}
            autocomplete="off"
          />
        </Field>
      {/if}

      {#if notice}
        <p class="notice" class:error={notice.kind === 'error'} role="status" data-testid="notice">
          {notice.text}
        </p>
      {/if}

      <div class="actions">
        <button type="submit" class="button" disabled={busy !== undefined}>
          {busy === 'save' ? t('form.saving') : t('form.save')}
        </button>
        <button
          type="button"
          class="button secondary"
          disabled={busy !== undefined}
          onclick={() => void run('test')}
        >
          {busy === 'test' ? t('form.testing') : t('form.test')}
        </button>
        <button
          type="button"
          class="button secondary"
          onclick={() => {
            rpc.emit('close', {});
          }}
        >
          {t('form.cancel')}
        </button>
      </div>
    </form>
  {/if}
</main>

<style>
  main {
    max-width: 640px;
    padding: 16px;
  }

  h1 {
    margin: 0 0 16px;
    font-size: 1.3em;
    font-weight: 600;
  }

  form {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .pair {
    display: grid;
    grid-template-columns: 2fr 1fr;
    gap: 12px;
  }

  .row {
    display: flex;
    gap: 6px;
  }

  .grow {
    flex: 1;
    min-width: 0;
  }

  .check {
    display: flex;
    gap: 6px;
    align-items: center;
  }

  .actions {
    display: flex;
    gap: 8px;
    margin-top: 4px;
  }

  .notice {
    margin: 0;
    padding: 6px 8px;
    border-radius: 2px;
    background: var(--vscode-editorWidget-background);
  }

  .notice.error {
    color: var(--vscode-inputValidation-errorForeground, var(--vscode-errorForeground));
    background: var(--vscode-inputValidation-errorBackground, transparent);
  }

  .loading {
    color: var(--vscode-descriptionForeground);
  }
</style>

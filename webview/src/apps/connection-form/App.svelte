<script lang="ts">
  import { onMount } from 'svelte';
  import {
    CONNECTION_COLORS,
    CONNECTION_LIMITS,
    isFileDriver,
    MAX_SSH_JUMPS,
  } from '../../../../src/shared/connection';
  import type {
    ConnectionFormProtocol,
    ConnectionFormState,
  } from '../../../../src/shared/protocols/connection-form';
  import { PASSWORD_MAX_LENGTH } from '../../../../src/shared/protocols/connection-form';
  import type { RpcPeer } from '../../../../src/shared/rpc';
  import Field from '../../components/Field.svelte';
  import SshHopEditor from './SshHopEditor.svelte';
  import TlsEditor from './TlsEditor.svelte';
  import type { MessageKey } from '../../l10n/en';
  import type { Translate } from '../../lib/i18n';
  import { parseConnectionUrl } from '../../../../src/shared/connection-url';
  import {
    applyUrl,
    fieldsFrom,
    type FormFields,
    moveJump,
    newHopFields,
    problemMessage,
    problemsOf,
    toDraft,
    URL_PROBLEM_MESSAGES,
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
  let urlText = $state('');
  let urlError = $state<string | undefined>(undefined);

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

  /** What is saved for a hop: flags only, the values stay in the host. */
  function storedFor(hopId: string): { password: boolean; passphrase: boolean } {
    const found = formState?.storedSsh.find((entry) => entry.hopId === hopId);
    return { password: found?.password ?? false, passphrase: found?.passphrase ?? false };
  }

  function fillFromUrl(): void {
    if (!fields || urlText.trim() === '') {
      return;
    }
    const parsed = parseConnectionUrl(urlText);
    if (!parsed.ok) {
      urlError = t(URL_PROBLEM_MESSAGES[parsed.problem]);
      return;
    }
    applyUrl(fields, parsed.value);
    urlError = undefined;
    urlText = '';
    notice = { kind: 'ok', text: t('form.url.filled') };
  }

  function addJump(): void {
    fields?.jumps.push(newHopFields());
  }

  function removeJump(index: number): void {
    fields?.jumps.splice(index, 1);
  }

  function move(index: number, by: -1 | 1): void {
    if (fields) {
      moveJump(fields.jumps, index, by);
    }
  }

  type TlsFile = 'sslCa' | 'sslCert' | 'sslKey';

  async function browseTls(field: TlsFile): Promise<void> {
    try {
      const { file } = await rpc.request('pickTlsFile', {});
      if (file !== undefined && fields) {
        fields[field] = file;
        notice = undefined;
      }
    } catch (error) {
      notice = { kind: 'error', text: messageOf(error) };
    }
  }

  async function browseKey(hop: { keyFile: string }): Promise<void> {
    try {
      const { file } = await rpc.request('pickKeyFile', {});
      if (file !== undefined) {
        hop.keyFile = file;
        notice = undefined;
      }
    } catch (error) {
      notice = { kind: 'error', text: messageOf(error) };
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
      <Field label={t('form.url')} error={urlError} hint={t('form.url.hint')}>
        <span class="row">
          <input
            class="control grow"
            bind:value={urlText}
            aria-invalid={urlError !== undefined}
            aria-label={t('form.url')}
            placeholder="postgres://user@host:5432/db"
            autocomplete="off"
            spellcheck="false"
            onkeydown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                fillFromUrl();
              }
            }}
          />
          <button type="button" class="button secondary" onclick={fillFromUrl}>
            {t('form.url.fill')}
          </button>
        </span>
      </Field>

      {#if formState?.project !== undefined}
        <p class="place" data-testid="project-note">
          {t('form.place.inProject', formState.project.name)}
        </p>
      {:else if formState?.connectionId === undefined && (formState?.projects ?? []).length > 0}
        <Field label={t('form.place')} hint={t('form.place.hint')}>
          <select class="control" bind:value={fields.project} aria-label={t('form.place')}>
            <option value="">{t('form.place.mine')}</option>
            {#each formState?.projects ?? [] as project (project.key)}
              <option value={project.key}>{t('form.place.project', project.name)}</option>
            {/each}
          </select>
        </Field>
      {/if}

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

      <div class="pair">
        {#if fields.project === ''}
          <Field label={t('form.folder')} hint={t('form.folderHint')}>
            <input
              class="control"
              bind:value={fields.folder}
              list="datanest-folders"
              maxlength={CONNECTION_LIMITS.folder}
              aria-label={t('form.folder')}
              autocomplete="off"
            />
            <datalist id="datanest-folders">
              {#each formState?.folders ?? [] as folder (folder)}
                <option value={folder}></option>
              {/each}
            </datalist>
          </Field>
        {:else}
          <span></span>
        {/if}
        <Field label={t('form.color')}>
          <select class="control" bind:value={fields.color} aria-label={t('form.color')}>
            <option value="">{t('form.color.none')}</option>
            {#each CONNECTION_COLORS as color (color)}
              <option value={color}>{t(`form.color.${color}`)}</option>
            {/each}
          </select>
        </Field>
      </div>

      <div class="flags">
        <div>
          <label class="check">
            <input
              type="checkbox"
              bind:checked={fields.production}
              aria-describedby="production-hint"
            />
            {t('form.production')}
          </label>
          <span class="hint" id="production-hint">{t('form.productionHint')}</span>
        </div>
        <div>
          <label class="check">
            <input type="checkbox" bind:checked={fields.readOnly} aria-describedby="read-only-hint" />
            {t('form.readOnly')}
          </label>
          <span class="hint" id="read-only-hint">{t('form.readOnlyHint')}</span>
        </div>
      </div>

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
            hint={fields.passwordTouched
              ? undefined
              : formState?.hasStoredPassword
                ? t('form.passwordStored')
                : formState?.importedPassword === true
                  ? t('form.passwordImported')
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

        <fieldset class="section">
          <TlsEditor
            {fields}
            {t}
            certError={errorFor('ssl-key-without-cert')}
            keyError={errorFor('ssl-cert-without-key')}
            onBrowse={(field: TlsFile) => void browseTls(field)}
          />
        </fieldset>

        <fieldset class="section">
          <legend>
            <label class="check">
              <input type="checkbox" bind:checked={fields.useSsh} />
              {t('form.ssh.use')}
            </label>
          </legend>
          {#if fields.useSsh}
            <SshHopEditor
              hop={fields.ssh}
              stored={storedFor(fields.ssh.id)}
              {showProblems}
              {t}
              onBrowseKey={() => {
                if (fields) {
                  void browseKey(fields.ssh);
                }
              }}
            />

            <div class="jumps">
              <span class="label">{t('form.ssh.jumps')}</span>
              <span class="hint">{t('form.ssh.jumpsHint')}</span>
              {#each fields.jumps as jump, index (jump.id)}
                {@const name = t('form.ssh.jump', index + 1)}
                <fieldset class="section jump">
                  <legend>{name}</legend>
                  <SshHopEditor
                    hop={jump}
                    stored={storedFor(jump.id)}
                    {showProblems}
                    label={name}
                    {t}
                    onBrowseKey={() => void browseKey(jump)}
                  />
                  <div class="row">
                    <button
                      type="button"
                      class="button secondary"
                      disabled={index === 0}
                      aria-label={`${name}: ${t('form.ssh.moveUp')}`}
                      onclick={() => {
                        move(index, -1);
                      }}
                    >
                      {t('form.ssh.moveUp')}
                    </button>
                    <button
                      type="button"
                      class="button secondary"
                      disabled={index === fields.jumps.length - 1}
                      aria-label={`${name}: ${t('form.ssh.moveDown')}`}
                      onclick={() => {
                        move(index, 1);
                      }}
                    >
                      {t('form.ssh.moveDown')}
                    </button>
                    <button
                      type="button"
                      class="button secondary"
                      aria-label={`${name}: ${t('form.ssh.removeJump')}`}
                      onclick={() => {
                        removeJump(index);
                      }}
                    >
                      {t('form.ssh.removeJump')}
                    </button>
                  </div>
                </fieldset>
              {/each}
              {#if fields.jumps.length < MAX_SSH_JUMPS}
                <span>
                  <button type="button" class="button secondary" onclick={addJump}>
                    {t('form.ssh.addJump')}
                  </button>
                </span>
              {/if}
            </div>
          {/if}
        </fieldset>
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

  .section {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin: 0;
    padding: 8px 12px 12px;
    border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border, transparent));
    border-radius: 2px;
  }

  .section legend {
    padding: 0 4px;
  }

  .place {
    margin: 0;
    padding: 6px 8px;
    border-left: 2px solid var(--vscode-focusBorder);
    background: var(--vscode-textBlockQuote-background, transparent);
  }

  .flags {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .flags .hint {
    display: block;
    margin-left: 22px;
    color: var(--vscode-descriptionForeground);
    font-size: 0.9em;
  }

  .jumps {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .jumps .hint {
    color: var(--vscode-descriptionForeground);
    font-size: 0.9em;
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

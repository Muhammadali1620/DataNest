<script lang="ts">
  import { onMount } from 'svelte';
  import SecretInput from '../../components/SecretInput.svelte';
  import {
    CONNECTION_COLORS,
    CONNECTION_LIMITS,
    DEFAULT_PROXY_PORTS,
    MAX_SSH_JUMPS,
  } from '../../../../src/shared/connection';
  import {
    PASSWORD_MAX_LENGTH,
  } from '../../../../src/shared/protocols/connection-form';
  import type {
    ServerFormProtocol,
    ServerFormState,
  } from '../../../../src/shared/protocols/server-form';
  import type { RpcPeer } from '../../../../src/shared/rpc';
  import { SERVER_LIMITS, type ServerProblem } from '../../../../src/shared/ssh-server';
  import Field from '../../components/Field.svelte';
  import Icon from '../../components/Icon.svelte';
  import type { Translate } from '../../lib/i18n';
  import SshHopEditor from '../connection-form/SshHopEditor.svelte';
  import {
    fieldsFrom,
    moveJump,
    newHopFields,
    problemsOf,
    type ServerFields,
    SERVER_PROBLEM_MESSAGES,
    toDraft,
  } from './form-model';

  interface Props {
    rpc: RpcPeer<ServerFormProtocol['webview'], ServerFormProtocol['host']>;
    t: Translate;
  }

  const { rpc, t }: Props = $props();

  interface Notice {
    kind: 'ok' | 'error';
    text: string;
  }

  // The generic form keeps the declared type: `= $state(undefined)` would narrow it.
  let formState = $state<ServerFormState | undefined>(undefined);
  let fields = $state<ServerFields | undefined>(undefined);
  let busy = $state<'test' | 'save' | undefined>(undefined);
  let notice = $state<Notice | undefined>(undefined);
  /** Problems are shown only after the first attempt, so a new form is not all red. */
  let showProblems = $state(false);

  const problems = $derived(fields === undefined ? [] : problemsOf(fields));

  function errorFor(problem: ServerProblem): string | undefined {
    return showProblems && problems.includes(problem)
      ? t(SERVER_PROBLEM_MESSAGES[problem])
      : undefined;
  }

  onMount(() => {
    const subscription = rpc.on('state', (next) => {
      formState = next;
      // The host is the source of truth: a fresh state replaces what is on screen (D21).
      fields = fieldsFrom(next);
      showProblems = false;
      notice = undefined;
    });
    rpc.emit('ready', {});
    return () => {
      subscription.dispose();
    };
  });

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
        const { home, hops } = await rpc.request('test', draft);
        notice = {
          kind: 'ok',
          text:
            hops > 1
              ? t('serverForm.testOkJumps', home, hops - 1)
              : t('serverForm.testOk', home),
        };
      } else {
        await rpc.request('save', draft);
        notice = { kind: 'ok', text: t('serverForm.saved') };
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
</script>

<main>
  {#if fields === undefined}
    <p class="loading">{t('form.loading')}</p>
  {:else}
    <form
      class="page"
      onsubmit={(event) => {
        event.preventDefault();
        void run('save');
      }}
    >
      <header class="page-header">
        <span class="header-icon tile tone-blue"><Icon name="server" size={20} /></span>
        <div class="header-text">
          <h1>
            {formState?.serverId === undefined ? t('serverForm.titleNew') : t('serverForm.titleEdit')}
          </h1>
          <p class="subtitle">{t('serverForm.subtitle')}</p>
        </div>
      </header>

      <div class="content">
        <section class="card">
          <h2 class="section-title">
            <Icon name="tag" tone="orange" />{t('serverForm.section.general')}
          </h2>
          <Field label={t('form.name')} error={errorFor('name-empty') ?? errorFor('too-long')} required>
            <input
              class="control"
              bind:value={fields.name}
              maxlength={SERVER_LIMITS.name}
              aria-invalid={errorFor('name-empty') !== undefined}
              aria-label={t('form.name')}
              autocomplete="off"
              data-testid="server-name"
            />
          </Field>
          <div class="pair">
            <Field label={t('serverForm.startPath')} hint={t('serverForm.startPathHint')}>
              <input
                class="control"
                bind:value={fields.startPath}
                maxlength={SERVER_LIMITS.path}
                placeholder="/var/www"
                aria-label={t('serverForm.startPath')}
                autocomplete="off"
                spellcheck="false"
              />
            </Field>
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
            <label class="check">
              <input
                type="checkbox"
                bind:checked={fields.readOnly}
                aria-describedby="server-read-only-hint"
              />
              {t('serverForm.readOnly')}
            </label>
            <span class="hint" id="server-read-only-hint">{t('serverForm.readOnlyHint')}</span>
          </div>
        </section>

        <section class="card">
          <h2 class="section-title">
            <Icon name="plug" tone="green" />{t('serverForm.section.login')}
          </h2>
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
        </section>

        <h2 class="group-title">
          <Icon name="shield" tone="red" />{t('serverForm.section.route')}
        </h2>

        <div class="jumps">
          <span class="legend-title"
            ><Icon name="terminal" tone="teal" />{t('form.ssh.jumps')}</span
          >
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
              <button type="button" class="button secondary" onclick={addJump} data-testid="add-jump">
                <Icon name="add" />{t('form.ssh.addJump')}
              </button>
            </span>
          {/if}
        </div>

        <fieldset class="section">
          <legend>
            <label class="check">
              <input type="checkbox" bind:checked={fields.useProxy} data-testid="use-proxy" />
              <Icon name="globe" tone="orange" />{t('form.proxy.use')}
            </label>
          </legend>
          {#if fields.useProxy}
            <p class="hint">{t('serverForm.proxyHint')}</p>
            <Field label={t('form.proxy.kind')}>
              <select class="control" bind:value={fields.proxyKind} aria-label={t('form.proxy.kind')}>
                <option value="socks5">SOCKS5</option>
                <option value="http">HTTP (CONNECT)</option>
              </select>
            </Field>
            <div class="pair">
              <Field label={t('form.proxy.host')} error={errorFor('proxy-host-empty')} required>
                <input
                  class="control"
                  bind:value={fields.proxyHost}
                  maxlength={CONNECTION_LIMITS.field}
                  aria-invalid={errorFor('proxy-host-empty') !== undefined}
                  aria-label={t('form.proxy.host')}
                  data-testid="proxy-host"
                  autocomplete="off"
                />
              </Field>
              <Field
                label={t('form.proxy.port')}
                error={errorFor('proxy-port-invalid')}
                hint={t('form.portHint', DEFAULT_PROXY_PORTS[fields.proxyKind])}
              >
                <input
                  class="control"
                  bind:value={fields.proxyPort}
                  inputmode="numeric"
                  maxlength={5}
                  aria-invalid={errorFor('proxy-port-invalid') !== undefined}
                  aria-label={t('form.proxy.port')}
                  autocomplete="off"
                />
              </Field>
            </div>
            <div class="pair">
              <Field label={t('form.proxy.user')}>
                <input
                  class="control"
                  bind:value={fields.proxyUser}
                  maxlength={CONNECTION_LIMITS.field}
                  aria-label={t('form.proxy.user')}
                  autocomplete="off"
                />
              </Field>
              <Field
                label={t('form.proxy.password')}
                hint={formState?.hasStoredProxyPassword && !fields.proxyPassword.touched
                  ? t('form.passwordStored')
                  : undefined}
              >
                <SecretInput
                  bind:value={fields.proxyPassword.value}
                  oninput={() => {
                    if (fields) {
                      fields.proxyPassword.touched = true;
                    }
                  }}
                  maxlength={PASSWORD_MAX_LENGTH}
                  disabled={fields.proxyPassword.erase}
                  label={t('form.proxy.password')}
                  showLabel={t('form.showSecret')}
                  hideLabel={t('form.hideSecret')}
                />
              </Field>
            </div>
            {#if formState?.hasStoredProxyPassword}
              <label class="check">
                <input type="checkbox" bind:checked={fields.proxyPassword.erase} />
                {t('form.erasePassword')}
              </label>
            {/if}
          {/if}
        </fieldset>
      </div>

      <footer class="actions-bar">
        {#if notice}
          <p
            class="notice fade-in"
            class:error={notice.kind === 'error'}
            class:success={notice.kind === 'ok'}
            role="status"
            data-testid="notice"
          >
            <Icon name={notice.kind === 'error' ? 'error' : 'pass'} /><span>{notice.text}</span>
          </p>
        {/if}
        <span class="spacer"></span>
        <button
          type="button"
          class="button secondary"
          onclick={() => {
            rpc.emit('close', {});
          }}
        >
          {t('form.cancel')}
        </button>
        <button
          type="button"
          class="button secondary"
          disabled={busy !== undefined}
          onclick={() => void run('test')}
          data-testid="test"
        >
          <Icon name={busy === 'test' ? 'loading' : 'plug'} spin={busy === 'test'} />
          {busy === 'test' ? t('form.testing') : t('form.test')}
        </button>
        <button type="submit" class="button" disabled={busy !== undefined} data-testid="save">
          <Icon name={busy === 'save' ? 'loading' : 'save'} spin={busy === 'save'} />
          {busy === 'save' ? t('form.saving') : t('form.save')}
        </button>
      </footer>
    </form>
  {/if}
</main>

<style>
  main {
    height: 100vh;
  }

  .loading {
    padding: 16px;
    color: var(--dn-muted);
  }

  /* The page scrolls; the bar of actions stays at the bottom. */
  .page {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .page-header {
    display: flex;
    flex: none;
    gap: 12px;
    align-items: center;
    padding: 18px 24px 14px;
  }

  .subtitle {
    margin: 2px 0 0;
    color: var(--dn-muted);
  }

  .content {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 12px;
    min-height: 0;
    padding: 4px 24px 24px;
    overflow-y: auto;
  }

  .content > :global(*) {
    width: 100%;
    max-width: 760px;
  }

  .card {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .section-title {
    display: flex;
    gap: 8px;
    align-items: center;
    margin: 0 0 2px;
  }

  .group-title {
    display: flex;
    gap: 8px;
    align-items: center;
    margin: 8px 0 -4px;
    color: var(--dn-muted);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .pair {
    display: grid;
    grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
    gap: 12px;
  }

  .row {
    display: flex;
    gap: 6px;
  }

  .check {
    display: flex;
    gap: 8px;
    align-items: center;
    cursor: pointer;
  }

  /* Jump hosts and the proxy: framed groups, as in the form of a connection. */
  .section {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin: 0;
    padding: 12px 16px;
    background: var(--dn-surface);
    border: 1px solid var(--dn-border);
    border-radius: var(--dn-radius-l);
  }

  .section legend {
    float: left;
    width: 100%;
    padding: 0;
    font-weight: 600;
  }

  .section legend + :global(*) {
    clear: both;
  }

  .jumps {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .legend-title {
    display: flex;
    gap: 8px;
    align-items: center;
    font-weight: 600;
  }

  .flags {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .flags .hint {
    margin: 0 0 0 26px;
  }

  .hint {
    margin: 0;
    color: var(--dn-muted);
    font-size: var(--dn-font-small);
  }

  /* The bar of actions: what happened on the left, what to do on the right. */
  .actions-bar {
    display: flex;
    flex: none;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    padding: 10px 24px;
    background: var(--vscode-editor-background);
    border-top: 1px solid var(--dn-divider);
  }

  .actions-bar .notice {
    margin: 0;
    padding: 4px 10px;
  }

  .spacer {
    flex: 1;
  }

  @media (max-width: 520px) {
    .pair {
      grid-template-columns: 1fr;
    }

    .page-header,
    .content,
    .actions-bar {
      padding-right: 12px;
      padding-left: 12px;
    }
  }
</style>

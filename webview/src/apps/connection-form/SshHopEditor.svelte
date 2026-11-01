<script lang="ts">
  import SecretInput from '../../components/SecretInput.svelte';
  import { CONNECTION_LIMITS, DEFAULT_SSH_PORT } from '../../../../src/shared/connection';
  import { PASSWORD_MAX_LENGTH } from '../../../../src/shared/protocols/connection-form';
  import Field from '../../components/Field.svelte';
  import type { MessageKey } from '../../l10n/en';
  import type { Translate } from '../../lib/i18n';
  import {
    algorithmProblems,
    legacyAlgorithms,
    SSH_ALGORITHM_KINDS,
    SSH_ALGORITHM_RULE_MAX,
    SSH_ALGORITHMS,
    type SshAlgorithmKind,
  } from '../../../../src/shared/ssh-algorithms';
  import { hopProblemsOf, type HopFields, PROBLEM_MESSAGES } from './form-model';

  interface Props {
    hop: HopFields;
    /** What is saved for this hop; values never reach the page. */
    stored: { password: boolean; passphrase: boolean };
    showProblems: boolean;
    /** Prefixes labels, so several hops on one page stay distinguishable. */
    label?: string;
    t: Translate;
    onBrowseKey: () => void;
  }

  // `hop` is the parent's state: editing its fields here updates the form.
  const { hop, stored, showProblems, label = '', t, onBrowseKey }: Props = $props();

  const problems = $derived(hopProblemsOf(hop));

  function errorFor(problem: (typeof problems)[number]): string | undefined {
    return showProblems && problems.includes(problem) ? t(PROBLEM_MESSAGES[problem]) : undefined;
  }

  const ALGORITHM_LABELS: Readonly<Record<SshAlgorithmKind, MessageKey>> = {
    kex: 'form.ssh.alg.kex',
    serverHostKey: 'form.ssh.alg.serverHostKey',
    cipher: 'form.ssh.alg.cipher',
    hmac: 'form.ssh.alg.hmac',
    compress: 'form.ssh.alg.compress',
  };

  // A hop id is unique within the form, so the lists of two hops never collide.
  const listId = (kind: SshAlgorithmKind): string => `ssh-alg-${hop.id}-${kind}`;

  const algorithmIssues = $derived(algorithmProblems(hop.algorithms));
  const hasAlgorithms = $derived(
    SSH_ALGORITHM_KINDS.some((kind) => hop.algorithms[kind].trim() !== ''),
  );

  function algorithmError(kind: SshAlgorithmKind): string | undefined {
    const found = algorithmIssues.find((issue) => issue.kind === kind);
    if (found === undefined) {
      return undefined;
    }
    return found.problem.kind === 'empty'
      ? t('form.ssh.alg.empty')
      : t('form.ssh.alg.unknown', found.problem.names.join(', '));
  }

  /** The weak methods a rule lets in; said out loud under the field, never silently. */
  function algorithmLegacy(kind: SshAlgorithmKind): string | undefined {
    const names = legacyAlgorithms(kind, hop.algorithms[kind]);
    return names.length === 0 ? undefined : t('form.ssh.alg.legacy', names.join(', '));
  }

  function name(key: MessageKey): string {
    return label === '' ? t(key) : `${label}: ${t(key)}`;
  }
</script>

<div class="hop">
  <div class="pair">
    <Field label={name('form.ssh.host')} error={errorFor('ssh-host-empty')} required>
      <input
        class="control"
        bind:value={hop.host}
        maxlength={CONNECTION_LIMITS.field}
        aria-invalid={errorFor('ssh-host-empty') !== undefined}
        aria-label={name('form.ssh.host')}
        autocomplete="off"
      />
    </Field>
    <Field
      label={name('form.ssh.port')}
      error={errorFor('ssh-port-invalid')}
      hint={t('form.portHint', DEFAULT_SSH_PORT)}
    >
      <input
        class="control"
        bind:value={hop.port}
        inputmode="numeric"
        maxlength={5}
        aria-invalid={errorFor('ssh-port-invalid') !== undefined}
        aria-label={name('form.ssh.port')}
        autocomplete="off"
      />
    </Field>
  </div>

  <div class="pair">
    <Field label={name('form.ssh.user')} error={errorFor('ssh-user-empty')} required>
      <input
        class="control"
        bind:value={hop.user}
        maxlength={CONNECTION_LIMITS.field}
        aria-invalid={errorFor('ssh-user-empty') !== undefined}
        aria-label={name('form.ssh.user')}
        autocomplete="off"
      />
    </Field>
    <Field label={name('form.ssh.auth')}>
      <select class="control" bind:value={hop.auth} aria-label={name('form.ssh.auth')}>
        <option value="password">{t('form.ssh.auth.password')}</option>
        <option value="key">{t('form.ssh.auth.key')}</option>
        <option value="agent">{t('form.ssh.auth.agent')}</option>
      </select>
    </Field>
  </div>

  {#if hop.auth === 'password'}
    <Field
      label={name('form.ssh.password')}
      hint={stored.password && !hop.password.touched ? t('form.passwordStored') : undefined}
    >
      <SecretInput
        bind:value={hop.password.value}
        oninput={() => {
          hop.password.touched = true;
        }}
        maxlength={PASSWORD_MAX_LENGTH}
        disabled={hop.password.erase}
        label={name('form.ssh.password')}
        showLabel={t('form.showSecret')}
        hideLabel={t('form.hideSecret')}
      />
    </Field>
    {#if stored.password}
      <label class="check">
        <input type="checkbox" bind:checked={hop.password.erase} />
        {t('form.erasePassword')}
      </label>
    {/if}
  {:else if hop.auth === 'key'}
    <Field label={name('form.ssh.keyFile')} error={errorFor('ssh-key-empty')} required>
      <span class="row">
        <input
          class="control grow"
          bind:value={hop.keyFile}
          maxlength={CONNECTION_LIMITS.file}
          aria-invalid={errorFor('ssh-key-empty') !== undefined}
          aria-label={name('form.ssh.keyFile')}
          placeholder="~/.ssh/id_ed25519"
          autocomplete="off"
        />
        <button type="button" class="button secondary" onclick={onBrowseKey}>
          {t('form.browse')}
        </button>
      </span>
    </Field>
    <Field
      label={name('form.ssh.passphrase')}
      hint={stored.passphrase && !hop.passphrase.touched
        ? t('form.ssh.passphraseStored')
        : t('form.ssh.passphraseHint')}
    >
      <SecretInput
        bind:value={hop.passphrase.value}
        oninput={() => {
          hop.passphrase.touched = true;
        }}
        maxlength={PASSWORD_MAX_LENGTH}
        disabled={hop.passphrase.erase}
        label={name('form.ssh.passphrase')}
        showLabel={t('form.showSecret')}
        hideLabel={t('form.hideSecret')}
      />
    </Field>
    {#if stored.passphrase}
      <label class="check">
        <input type="checkbox" bind:checked={hop.passphrase.erase} />
        {t('form.ssh.erasePassphrase')}
      </label>
    {/if}
  {:else}
    <Field label={name('form.ssh.agentSocket')} hint={t('form.ssh.agentHint')}>
      <input
        class="control"
        bind:value={hop.agentSocket}
        maxlength={CONNECTION_LIMITS.file}
        aria-label={name('form.ssh.agentSocket')}
        autocomplete="off"
      />
    </Field>
  {/if}

  <details class="algorithms" open={hasAlgorithms}>
    <summary>{name('form.ssh.algorithms')}</summary>
    <div class="algorithms-body">
    <p class="note">{t('form.ssh.algorithmsHint')}</p>
    {#each SSH_ALGORITHM_KINDS as kind (kind)}
      <Field label={name(ALGORITHM_LABELS[kind])} error={algorithmError(kind)}>
        <input
          class="control"
          bind:value={hop.algorithms[kind]}
          list={listId(kind)}
          maxlength={SSH_ALGORITHM_RULE_MAX}
          aria-invalid={algorithmError(kind) !== undefined}
          aria-label={name(ALGORITHM_LABELS[kind])}
          placeholder={t('form.ssh.alg.default')}
          autocomplete="off"
          spellcheck="false"
        />
        <datalist id={listId(kind)}>
          {#each SSH_ALGORITHMS[kind].supported as supported (supported)}
            <option value={supported}></option>
          {/each}
        </datalist>
      </Field>
      {#if algorithmLegacy(kind) !== undefined}
        <p class="legacy" role="note">
          <span class="codicon codicon-warning" aria-hidden="true"></span>
          {algorithmLegacy(kind)}
        </p>
      {/if}
    {/each}
    </div>
  </details>
</div>

<style>
  .hop {
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

  .algorithms {
    border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, transparent));
    border-radius: var(--dn-radius-l, 10px);
    padding: 0 12px;
  }

  .algorithms[open] {
    padding-bottom: 14px;
  }

  .algorithms-body {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .algorithms summary {
    padding: 8px 0;
    font-weight: 600;
    cursor: pointer;
    list-style: none;
  }

  .algorithms summary::-webkit-details-marker {
    display: none;
  }

  .algorithms summary::before {
    /* The icon font's chevron-right, turned when open. */
    content: '\eab6';
    font: normal normal normal 16px/1 codicon;
    display: inline-block;
    margin-right: 6px;
    vertical-align: middle;
    color: var(--dn-muted);
    transition: transform var(--dn-duration) var(--dn-ease);
  }

  .algorithms[open] summary::before {
    transform: rotate(90deg);
  }

  .note {
    margin: 0 0 2px;
    color: var(--vscode-descriptionForeground);
  }

  .legacy {
    display: flex;
    gap: 6px;
    align-items: flex-start;
    margin: -6px 0 0;
    color: var(--vscode-editorWarning-foreground, #cca700);
  }

  .check {
    display: flex;
    gap: 6px;
    align-items: center;
  }
</style>

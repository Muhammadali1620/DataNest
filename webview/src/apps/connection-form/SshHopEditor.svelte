<script lang="ts">
  import { CONNECTION_LIMITS, DEFAULT_SSH_PORT } from '../../../../src/shared/connection';
  import { PASSWORD_MAX_LENGTH } from '../../../../src/shared/protocols/connection-form';
  import Field from '../../components/Field.svelte';
  import type { MessageKey } from '../../l10n/en';
  import type { Translate } from '../../lib/i18n';
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

  function name(key: MessageKey): string {
    return label === '' ? t(key) : `${label}: ${t(key)}`;
  }
</script>

<div class="hop">
  <div class="pair">
    <Field label={name('form.ssh.host')} error={errorFor('ssh-host-empty')}>
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
    <Field label={name('form.ssh.user')} error={errorFor('ssh-user-empty')}>
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
      <input
        class="control"
        type="password"
        bind:value={hop.password.value}
        oninput={() => {
          hop.password.touched = true;
        }}
        maxlength={PASSWORD_MAX_LENGTH}
        disabled={hop.password.erase}
        aria-label={name('form.ssh.password')}
        autocomplete="off"
      />
    </Field>
    {#if stored.password}
      <label class="check">
        <input type="checkbox" bind:checked={hop.password.erase} />
        {t('form.erasePassword')}
      </label>
    {/if}
  {:else if hop.auth === 'key'}
    <Field label={name('form.ssh.keyFile')} error={errorFor('ssh-key-empty')}>
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
      <input
        class="control"
        type="password"
        bind:value={hop.passphrase.value}
        oninput={() => {
          hop.passphrase.touched = true;
        }}
        maxlength={PASSWORD_MAX_LENGTH}
        disabled={hop.passphrase.erase}
        aria-label={name('form.ssh.passphrase')}
        autocomplete="off"
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

  .check {
    display: flex;
    gap: 6px;
    align-items: center;
  }
</style>

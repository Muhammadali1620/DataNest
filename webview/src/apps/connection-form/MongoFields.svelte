<script lang="ts">
  // The MongoDB part of the connection form (V7.5): how the servers are found and how the
  // user signs in. The fields live in the form's state, edited here in place.
  import {
    CONNECTION_LIMITS,
    MONGO_AUTH_MECHANISMS,
    MONGO_MODES,
    type MongoAuthMechanism,
    type MongoMode,
  } from '../../../../src/shared/connection';
  import Field from '../../components/Field.svelte';
  import type { Translate } from '../../lib/i18n';
  import type { MessageKey } from '../../l10n/en';
  import { changeMongoMode, type FormFields } from './form-model';

  interface Props {
    fields: FormFields;
    t: Translate;
    errorFor: (
      problem: 'mongo-node-invalid' | 'mongo-too-many-nodes' | 'mongo-name-invalid',
    ) => string | undefined;
  }

  const { fields, t, errorFor }: Props = $props();

  const MODE_LABELS: Readonly<Record<MongoMode, MessageKey>> = {
    direct: 'form.mongo.mode.direct',
    replicaSet: 'form.mongo.mode.replicaSet',
    srv: 'form.mongo.mode.srv',
  };

  const MODE_HINTS: Readonly<Record<MongoMode, MessageKey>> = {
    direct: 'form.mongo.mode.directHint',
    replicaSet: 'form.mongo.mode.replicaSetHint',
    srv: 'form.mongo.mode.srvHint',
  };

  const MECHANISM_LABELS: Readonly<Record<MongoAuthMechanism, MessageKey>> = {
    'SCRAM-SHA-256': 'form.mongo.mechanism.scram256',
    'SCRAM-SHA-1': 'form.mongo.mechanism.scram1',
    PLAIN: 'form.mongo.mechanism.plain',
    'MONGODB-X509': 'form.mongo.mechanism.x509',
  };
</script>

<Field label={t('form.mongo.mode')} hint={t(MODE_HINTS[fields.mongoMode])}>
  <select
    class="control"
    value={fields.mongoMode}
    onchange={(event) => {
      changeMongoMode(fields, event.currentTarget.value as MongoMode);
    }}
    aria-label={t('form.mongo.mode')}
  >
    {#each MONGO_MODES as mode (mode)}
      <option value={mode}>{t(MODE_LABELS[mode])}</option>
    {/each}
  </select>
</Field>

{#if fields.mongoMode === 'replicaSet'}
  <div class="pair">
    <Field label={t('form.mongo.replicaSet')} hint={t('form.mongo.replicaSetHint')}>
      <input
        class="control"
        bind:value={fields.replicaSet}
        maxlength={CONNECTION_LIMITS.field}
        placeholder="rs0"
        aria-invalid={errorFor('mongo-name-invalid') !== undefined}
        aria-label={t('form.mongo.replicaSet')}
        autocomplete="off"
        spellcheck="false"
      />
    </Field>
    <Field
      label={t('form.mongo.nodes')}
      error={errorFor('mongo-node-invalid') ?? errorFor('mongo-too-many-nodes')}
      hint={t('form.redis.nodesHint')}
    >
      <input
        class="control"
        bind:value={fields.mongoNodes}
        aria-invalid={errorFor('mongo-node-invalid') !== undefined}
        aria-label={t('form.mongo.nodes')}
        placeholder="db2.example.com:27017, db3.example.com"
        autocomplete="off"
        spellcheck="false"
      />
    </Field>
  </div>
{/if}

<div class="pair">
  <Field
    label={t('form.mongo.authSource')}
    hint={t('form.mongo.authSourceHint')}
    error={errorFor('mongo-name-invalid')}
  >
    <input
      class="control"
      bind:value={fields.authSource}
      maxlength={CONNECTION_LIMITS.field}
      placeholder="admin"
      aria-label={t('form.mongo.authSource')}
      autocomplete="off"
      spellcheck="false"
    />
  </Field>
  <Field label={t('form.mongo.mechanism')}>
    <select class="control" bind:value={fields.authMechanism} aria-label={t('form.mongo.mechanism')}>
      <option value="">{t('form.mongo.mechanism.default')}</option>
      {#each MONGO_AUTH_MECHANISMS as mechanism (mechanism)}
        <option value={mechanism}>{t(MECHANISM_LABELS[mechanism])}</option>
      {/each}
    </select>
  </Field>
</div>

<style>
  .pair {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 12px;
  }
</style>

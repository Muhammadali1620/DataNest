<script lang="ts">
  import { onMount } from 'svelte';
  import SecretInput from '../../components/SecretInput.svelte';
  import {
    CONNECTION_COLORS,
    CONNECTION_LIMITS,
    filterSupport,
    isFileDriver,
    MAX_SSH_JUMPS,
    optionSupport,
    REDIS_MODES,
  } from '../../../../src/shared/connection';
  import {
    DEFAULT_PROXY_PORTS,
    type DriverId,
    type RedisMode,
    supportsSocket,
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
  import OptionsEditor from './OptionsEditor.svelte';
  import MongoFields from './MongoFields.svelte';
  import type { MessageKey } from '../../l10n/en';
  import type { Translate } from '../../lib/i18n';
  import { parseConnectionUrl } from '../../../../src/shared/connection-url';
  import {
    SERVER_PRESETS,
    serverPreset,
    type ServerPresetId,
  } from '../../../../src/shared/server-presets';
  import {
    applyPreset,
    applyUrl,
    changeRedisMode,
    sshAllowed,
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
  /** What the Database list shows: a driver id, or `preset:<id>` for a compatible server. */
  let choice = $state('');
  let busy = $state<'test' | 'save' | undefined>(undefined);
  let notice = $state<Notice | undefined>(undefined);
  /** Problems are shown only after the first attempt, so a new form is not all red. */
  let showProblems = $state(false);
  let urlText = $state('');
  let urlError = $state<string | undefined>(undefined);

  const DRIVER_LABELS: Readonly<Record<DriverId, MessageKey>> = {
    mysql: 'form.driver.mysql',
    postgres: 'form.driver.postgres',
    sqlite: 'form.driver.sqlite',
    mssql: 'form.driver.mssql',
    clickhouse: 'form.driver.clickhouse',
    oracle: 'form.driver.oracle',
    redis: 'form.driver.redis',
    mongodb: 'form.driver.mongodb',
    elasticsearch: 'form.driver.elasticsearch',
  };

  const REDIS_MODE_LABELS: Readonly<Record<RedisMode, MessageKey>> = {
    standalone: 'form.redis.mode.standalone',
    sentinel: 'form.redis.mode.sentinel',
    cluster: 'form.redis.mode.cluster',
  };

  const problems = $derived(fields === undefined ? [] : problemsOf(fields));
  /** The session section starts open when the connection already sets something there. */
  const hasOptions = $derived(formState?.input.options !== undefined);
  const filters = $derived(
    fields === undefined ? { databases: false, schemas: false } : filterSupport(fields.driver),
  );
  const isFile = $derived(fields !== undefined && isFileDriver(fields.driver));
  const isRedis = $derived(fields?.driver === 'redis');
  const isMongo = $derived(fields?.driver === 'mongodb');
  const isElastic = $derived(fields?.driver === 'elasticsearch');
  const withApiKey = $derived(isElastic && fields?.elasticAuth === 'apiKey');
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
      choice = fields.driver;
      notice = undefined;
      showProblems = false;
    });
    rpc.emit('ready', {});
    return () => {
      subscription.dispose();
    };
  });

  const PRESET_LABELS: Readonly<Record<ServerPresetId, MessageKey>> = {
    tidb: 'form.preset.tidb',
    'aurora-mysql': 'form.preset.auroraMysql',
    cockroachdb: 'form.preset.cockroachdb',
    yugabytedb: 'form.preset.yugabytedb',
    'aurora-postgres': 'form.preset.auroraPostgres',
  };

  /** Compatible servers whose driver the host offers. */
  const presets = $derived(
    SERVER_PRESETS.filter((preset) =>
      (formState?.drivers ?? []).some((driver) => driver.id === preset.driver),
    ),
  );
  const chosenPreset = $derived(
    choice.startsWith('preset:') ? serverPreset(choice.slice('preset:'.length)) : undefined,
  );

  function choiceChanged(): void {
    if (!fields) {
      return;
    }
    notice = undefined;
    const preset = choice.startsWith('preset:')
      ? serverPreset(choice.slice('preset:'.length))
      : undefined;
    if (preset !== undefined) {
      applyPreset(fields, preset);
      return;
    }
    fields.driver = choice as DriverId;
    // Moving between drivers offers the new default port instead of the old one.
    const next = formState?.drivers.find((driver) => driver.id === fields?.driver);
    fields.port = next?.defaultPort === undefined ? '' : String(next.defaultPort);
    if (fields.driver === 'redis') {
      changeRedisMode(fields, fields.redisMode);
    }
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
    choice = fields.driver;
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

      <Field
        label={t('form.driver')}
        hint={chosenPreset === undefined
          ? undefined
          : t('form.presetHint', t(DRIVER_LABELS[chosenPreset.driver]))}
      >
        <select
          class="control"
          bind:value={choice}
          onchange={choiceChanged}
          aria-label={t('form.driver')}
        >
          {#each formState?.drivers ?? [] as driver (driver.id)}
            <option value={driver.id}>{t(DRIVER_LABELS[driver.id])}</option>
          {/each}
          {#if presets.length > 0}
            <optgroup label={t('form.compatible')}>
              {#each presets as preset (preset.id)}
                <option value={`preset:${preset.id}`}>{t(PRESET_LABELS[preset.id])}</option>
              {/each}
            </optgroup>
          {/if}
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
          <Field
            label={t('form.host')}
            error={errorFor('host-empty')}
            hint={isMongo
              ? fields.mongoMode === 'srv'
                ? t('form.mongo.hostSrv')
                : fields.mongoMode === 'replicaSet'
                  ? t('form.mongo.hostReplicaSet')
                  : undefined
              : !isRedis
                ? undefined
                : fields.redisMode === 'sentinel'
                  ? t('form.redis.hostSentinel')
                  : fields.redisMode === 'cluster'
                    ? t('form.redis.hostCluster')
                    : undefined}
          >
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

        {#if supportsSocket(fields.driver) && !(isRedis && fields.redisMode !== 'standalone')}
          <Field
            label={t('form.socket')}
            error={errorFor('socket-with-tunnel')}
            hint={t(isRedis ? 'form.socket.hintRedis' : fields.driver === 'postgres' ? 'form.socket.hintPostgres' : 'form.socket.hintMysql')}
          >
            <input
              class="control"
              bind:value={fields.socket}
              maxlength={CONNECTION_LIMITS.file}
              aria-label={t('form.socket')}
              data-testid="socket"
              autocomplete="off"
            />
          </Field>
        {/if}

        {#if isRedis}
          <Field label={t('form.redis.mode')}>
            <select
              class="control"
              value={fields.redisMode}
              onchange={(event) => {
                if (fields) {
                  changeRedisMode(fields, event.currentTarget.value as RedisMode);
                }
              }}
              aria-label={t('form.redis.mode')}
            >
              {#each REDIS_MODES as mode (mode)}
                <option value={mode}>{t(REDIS_MODE_LABELS[mode])}</option>
              {/each}
            </select>
          </Field>
          {#if fields.redisMode === 'sentinel'}
            <Field
              label={t('form.redis.masterName')}
              error={errorFor('redis-master-empty')}
              hint={t('form.redis.masterNameHint')}
            >
              <input
                class="control"
                bind:value={fields.masterName}
                maxlength={CONNECTION_LIMITS.field}
                aria-invalid={errorFor('redis-master-empty') !== undefined}
                aria-label={t('form.redis.masterName')}
                autocomplete="off"
                spellcheck="false"
              />
            </Field>
          {/if}
          {#if fields.redisMode !== 'standalone'}
            <Field
              label={fields.redisMode === 'sentinel'
                ? t('form.redis.nodesSentinel')
                : t('form.redis.nodesCluster')}
              error={errorFor('redis-node-invalid') ?? errorFor('redis-too-many-nodes')}
              hint={t('form.redis.nodesHint')}
            >
              <input
                class="control"
                bind:value={fields.redisNodes}
                aria-invalid={errorFor('redis-node-invalid') !== undefined}
                aria-label={fields.redisMode === 'sentinel'
                  ? t('form.redis.nodesSentinel')
                  : t('form.redis.nodesCluster')}
                placeholder="10.0.0.2:26379, 10.0.0.3"
                autocomplete="off"
                spellcheck="false"
              />
            </Field>
          {/if}
        {/if}

        {#if isMongo}
          <MongoFields {fields} {t} {errorFor} />
        {/if}
        {#if isElastic}
          <div class="pair">
            <Field label={t('form.elastic.auth')}>
              <select class="control" bind:value={fields.elasticAuth} aria-label={t('form.elastic.auth')}>
                <option value="basic">{t('form.elastic.auth.basic')}</option>
                <option value="apiKey">{t('form.elastic.auth.apiKey')}</option>
              </select>
            </Field>
            <Field
              label={t('form.elastic.pathPrefix')}
              hint={t('form.elastic.pathPrefixHint')}
              error={errorFor('elastic-prefix-invalid')}
            >
              <input
                class="control"
                bind:value={fields.elasticPrefix}
                maxlength={CONNECTION_LIMITS.field}
                placeholder="/es"
                aria-invalid={errorFor('elastic-prefix-invalid') !== undefined}
                aria-label={t('form.elastic.pathPrefix')}
                autocomplete="off"
                spellcheck="false"
              />
            </Field>
          </div>
        {/if}

        <div class="pair">
          {#if !withApiKey}
          <Field label={t('form.user')} hint={isRedis ? t('form.redis.userHint') : undefined}>
            <input
              class="control"
              bind:value={fields.user}
              maxlength={CONNECTION_LIMITS.field}
              aria-label={t('form.user')}
              autocomplete="off"
            />
          </Field>
          {/if}
          <Field
            label={withApiKey ? t('form.elastic.apiKey') : t('form.password')}
            hint={fields.passwordTouched
              ? withApiKey
                ? t('form.elastic.apiKeyHint')
                : undefined
              : formState?.hasStoredPassword
                ? t('form.passwordStored')
                : formState?.importedPassword === true
                  ? t('form.passwordImported')
                  : undefined}
          >
            <SecretInput
              bind:value={fields.password}
              oninput={() => {
                if (fields) {
                  fields.passwordTouched = true;
                }
              }}
              maxlength={PASSWORD_MAX_LENGTH}
              disabled={fields.erasePassword}
              label={withApiKey ? t('form.elastic.apiKey') : t('form.password')}
              showLabel={t('form.showSecret')}
              hideLabel={t('form.hideSecret')}
              testid="password"
            />
          </Field>
        </div>

        {#if formState?.hasStoredPassword}
          <label class="check">
            <input type="checkbox" bind:checked={fields.erasePassword} />
            {t('form.erasePassword')}
          </label>
        {/if}

        {#if isRedis && fields.redisMode === 'sentinel'}
          <div class="pair">
            <Field label={t('form.redis.sentinelUser')}>
              <input
                class="control"
                bind:value={fields.sentinelUser}
                maxlength={CONNECTION_LIMITS.field}
                aria-label={t('form.redis.sentinelUser')}
                autocomplete="off"
              />
            </Field>
            <Field
              label={t('form.redis.sentinelPassword')}
              hint={fields.sentinelPassword.touched
                ? undefined
                : formState?.hasStoredSentinelPassword
                  ? t('form.redis.sentinelPasswordStored')
                  : t('form.redis.sentinelPasswordHint')}
            >
              <SecretInput
                bind:value={fields.sentinelPassword.value}
                oninput={() => {
                  if (fields) {
                    fields.sentinelPassword.touched = true;
                  }
                }}
                maxlength={PASSWORD_MAX_LENGTH}
                disabled={fields.sentinelPassword.erase}
                label={t('form.redis.sentinelPassword')}
                showLabel={t('form.showSecret')}
                hideLabel={t('form.hideSecret')}
              />
            </Field>
          </div>
          {#if formState?.hasStoredSentinelPassword}
            <label class="check">
              <input type="checkbox" bind:checked={fields.sentinelPassword.erase} />
              {t('form.redis.eraseSentinelPassword')}
            </label>
          {/if}
        {/if}

        {#if !isElastic}
        <Field
          label={isRedis ? t('form.redis.database') : t('form.database')}
          hint={isRedis
            ? t('form.redis.databaseHint')
            : isMongo
              ? t('form.mongo.databaseHint')
              : t('form.databaseHint')}
          error={isRedis
            ? (errorFor('redis-database-invalid') ?? errorFor('redis-cluster-database'))
            : undefined}
        >
          <input
            class="control"
            bind:value={fields.database}
            maxlength={CONNECTION_LIMITS.field}
            inputmode={isRedis ? 'numeric' : undefined}
            placeholder={isRedis ? '0' : undefined}
            aria-label={isRedis ? t('form.redis.database') : t('form.database')}
            autocomplete="off"
          />
        </Field>
        {/if}

        {#if optionSupport(fields.driver).tls}
        <fieldset class="section">
          <TlsEditor
            {fields}
            {t}
            certError={errorFor('ssl-key-without-cert')}
            keyError={errorFor('ssl-cert-without-key')}
            onBrowse={(field: TlsFile) => void browseTls(field)}
          />
        </fieldset>
        {/if}

        {#if !sshAllowed(fields)}
          <p class="hint" data-testid="redis-ssh-note">
            {isMongo ? t('form.mongo.sshNote') : t('form.redis.sshNote')}
          </p>
        {:else}
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

        <fieldset class="section">
          <legend>
            <label class="check">
              <input type="checkbox" bind:checked={fields.useProxy} data-testid="use-proxy" />
              {t('form.proxy.use')}
            </label>
          </legend>
          {#if fields.useProxy}
            <p class="hint">{t('form.proxy.hint')}</p>
            <Field label={t('form.proxy.kind')}>
              <select class="control" bind:value={fields.proxyKind} aria-label={t('form.proxy.kind')}>
                <option value="socks5">SOCKS5</option>
                <option value="http">HTTP (CONNECT)</option>
              </select>
            </Field>
            <div class="pair">
              <Field label={t('form.proxy.host')} error={errorFor('proxy-host-empty')}>
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
        {/if}
      {/if}

      <details class="section options" open={hasOptions}>
        <summary>{t('form.options')}</summary>
        <OptionsEditor {fields} {t} {errorFor} />
      </details>

      <!-- Oracle filters only schemas: its database is the one service the connection names. -->
      {#if filters.databases || filters.schemas}
        <details class="section options" open={formState?.input.filter !== undefined}>
          <summary>{t('form.filter')}</summary>
          {#if filters.databases}
            <Field
              label={t('form.filter.databases')}
              error={errorFor('filter-too-long')}
              hint={t('form.filter.hint')}
            >
              <input
                class="control"
                bind:value={fields.filterDatabases}
                placeholder="app_*, !app_test"
                aria-label={t('form.filter.databases')}
                autocomplete="off"
                spellcheck="false"
              />
            </Field>
          {/if}
          {#if filters.schemas}
            <Field
              label={t('form.filter.schemas')}
              error={filters.databases ? undefined : errorFor('filter-too-long')}
              hint={filters.databases ? t('form.filter.schemasHint') : t('form.filter.hint')}
            >
              <input
                class="control"
                bind:value={fields.filterSchemas}
                placeholder="public, app_*"
                aria-label={t('form.filter.schemas')}
                autocomplete="off"
                spellcheck="false"
              />
            </Field>
          {/if}
        </details>
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

  .options summary {
    cursor: pointer;
  }

  .options[open] summary {
    margin-bottom: 4px;
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

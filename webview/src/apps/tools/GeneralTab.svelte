<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import type { ToolsProtocol } from '../../../../src/shared/protocols/tools';
  import type { RpcPeer } from '../../../../src/shared/rpc';
  import { formatSize } from '../../../../src/shared/byte-size';
  import {
    decode,
    ENCODING_KINDS,
    encode,
    type EncodingKind,
  } from '../../../../src/shared/tools/encoding';
  import {
    DEFAULT_PASSWORD,
    MAX_PASSWORD_LENGTH,
    MIN_PASSWORD_LENGTH,
    password,
    personName,
    uuidV4,
  } from '../../../../src/shared/tools/random-values';
  import {
    formatIso,
    formatLocal,
    parseDate,
    parseUnix,
  } from '../../../../src/shared/tools/timestamps';
  import Icon from '../../components/Icon.svelte';
  import IconButton from '../../components/IconButton.svelte';
  import type { Translate } from '../../lib/i18n';
  import Card from './Card.svelte';

  interface Props {
    rpc: RpcPeer<ToolsProtocol['webview'], ToolsProtocol['host']>;
    t: Translate;
    copy: (text: string) => void;
  }

  const { rpc, t, copy }: Props = $props();

  // ---- Source text and its hashes
  let source = $state('');
  let hashes = $state({ md5: '', sha1: '', sha256: '' });
  let bytes = $state(0);
  let hashTimer: ReturnType<typeof setTimeout> | undefined;
  /** Grows with every question, so a slow answer about older text is dropped. */
  let asked = 0;

  function onSource(): void {
    clearTimeout(hashTimer);
    hashTimer = setTimeout(() => {
      void refreshHashes();
    }, 150);
  }

  async function refreshHashes(): Promise<void> {
    const mine = (asked += 1);
    const answer = await rpc.request('hash', { text: source });
    if (mine === asked) {
      hashes = { md5: answer.md5, sha1: answer.sha1, sha256: answer.sha256 };
      bytes = answer.bytes;
    }
  }

  // ---- Encode / decode: either side can be edited
  let kind = $state<EncodingKind>('base64');
  let plain = $state('');
  let encoded = $state('');
  let decodeFailed = $state(false);

  function fromPlain(): void {
    encoded = encode(kind, plain);
    decodeFailed = false;
  }

  function fromEncoded(): void {
    const result = decode(kind, encoded);
    decodeFailed = result === undefined;
    if (result !== undefined) {
      plain = result;
    }
  }

  // ---- Random values
  let name = $state('');
  let secret = $state('');
  let uuid = $state('');
  const options = $state({ ...DEFAULT_PASSWORD });
  const noKind = $derived(!options.lower && !options.upper && !options.digits && !options.symbols);

  function generate(): void {
    name = personName();
    secret = password(options) ?? '';
    uuid = uuidV4();
  }

  // ---- Timestamps
  let unix = $state('');
  let local = $state('');
  let unixFailed = $state(false);
  let localFailed = $state(false);

  const iso = $derived.by(() => {
    const ms = parseUnix(unix);
    return ms === undefined ? '' : (formatIso(ms) ?? '');
  });

  function fromUnix(): void {
    const ms = parseUnix(unix);
    unixFailed = unix.trim() !== '' && ms === undefined;
    localFailed = false;
    if (ms !== undefined) {
      local = formatLocal(ms) ?? '';
    }
  }

  function fromLocal(): void {
    const ms = parseDate(local);
    localFailed = local.trim() !== '' && ms === undefined;
    unixFailed = false;
    if (ms !== undefined) {
      unix = String(ms);
    }
  }

  function now(): void {
    unix = String(Date.now());
    fromUnix();
  }

  onMount(() => {
    generate();
    now();
  });

  onDestroy(() => {
    clearTimeout(hashTimer);
  });
</script>

<div class="tl-grid wide">
  <Card title={t('tools.input')} icon="file" tone="blue">
    <div>
      <label class="tl-label" for="tools-source">{t('tools.sourceText')}</label>
      <textarea
        id="tools-source"
        class="control tl-area tl-mono"
        rows="6"
        spellcheck="false"
        bind:value={source}
        oninput={onSource}
        data-testid="source"
      ></textarea>
    </div>
    <div class="tl-result">
      <span class="badge" data-testid="size">
        <Icon name="symbol-ruler" size={12} />{formatSize(bytes)}
      </span>
      <span class="muted small">{t('tools.bytes', bytes)}</span>
    </div>
  </Card>

  <Card title={t('tools.hash')} icon="key" tone="orange">
    {#each [['MD5', 'md5'], ['SHA-1', 'sha1'], ['SHA-256', 'sha256']] as const as [label, id] (id)}
      <div>
        <label class="tl-label" for={`tools-${id}`}>{label}</label>
        <div class="tl-line">
          <textarea
            id={`tools-${id}`}
            class="control tl-mono tl-wrap"
            rows={id === 'md5' ? 1 : 2}
            readonly
            value={hashes[id]}
            data-testid={id}
          ></textarea>
          <IconButton
            icon="copy"
            tone="blue"
            label={t('tools.copyNamed', label)}
            disabled={hashes[id] === ''}
            onclick={() => {
              copy(hashes[id]);
            }}
          />
        </div>
      </div>
    {/each}
  </Card>

  <Card title={t('tools.encode')} icon="arrow-both" tone="purple">
    <div class="seg" role="group" aria-label={t('tools.encodeKind')}>
      {#each ENCODING_KINDS as item (item)}
        <button
          type="button"
          aria-pressed={kind === item}
          data-testid={`kind-${item}`}
          onclick={() => {
            kind = item;
            fromPlain();
          }}
        >
          {t(`tools.kind.${item}`)}
        </button>
      {/each}
    </div>
    <div>
      <label class="tl-label" for="tools-plain">{t('tools.plain')}</label>
      <textarea
        id="tools-plain"
        class="control tl-area tl-mono"
        rows="3"
        spellcheck="false"
        bind:value={plain}
        oninput={fromPlain}
        data-testid="plain"
      ></textarea>
    </div>
    <div>
      <div class="tl-line head-line">
        <label class="tl-label" for="tools-encoded">{t('tools.encoded')}</label>
        <span class="grow"></span>
        <IconButton
          icon="copy"
          tone="blue"
          label={t('tools.copyNamed', t('tools.encoded'))}
          disabled={encoded === ''}
          onclick={() => {
            copy(encoded);
          }}
        />
      </div>
      <textarea
        id="tools-encoded"
        class="control tl-area tl-mono"
        rows="3"
        spellcheck="false"
        aria-invalid={decodeFailed}
        bind:value={encoded}
        oninput={fromEncoded}
        data-testid="encoded"
      ></textarea>
    </div>
    {#if decodeFailed}
      <p class="tl-problem" role="alert" data-testid="decode-problem">
        <Icon name="error" size={14} />{t(`tools.invalid.${kind}`)}
      </p>
    {/if}
  </Card>

  <Card title={t('tools.random')} icon="sparkle" tone="green">
    {#snippet actions()}
      <button type="button" class="button" data-testid="generate" onclick={generate}>
        <Icon name="refresh" />{t('tools.generate')}
      </button>
    {/snippet}
    {#each [[t('tools.name'), 'name'], [t('tools.password'), 'secret'], ['UUID', 'uuid']] as const as [label, id] (id)}
      {@const value = id === 'name' ? name : id === 'secret' ? secret : uuid}
      <div>
        <label class="tl-label" for={`tools-${id}`}>{label}</label>
        <div class="tl-line">
          <input id={`tools-${id}`} class="control tl-mono" readonly {value} data-testid={id} />
          <IconButton
            icon="copy"
            tone="blue"
            label={t('tools.copyNamed', label)}
            disabled={value === ''}
            onclick={() => {
              copy(value);
            }}
          />
        </div>
      </div>
    {/each}
    <div class="tl-row">
      <label class="len">
        <span class="tl-label">{t('tools.length')}</span>
        <input
          class="control"
          type="number"
          min={MIN_PASSWORD_LENGTH}
          max={MAX_PASSWORD_LENGTH}
          bind:value={options.length}
          onchange={generate}
          data-testid="length"
        />
      </label>
      {#each [['lower', 'a–z'], ['upper', 'A–Z'], ['digits', '0–9'], ['symbols', '#$%']] as const as [id, label] (id)}
        <label class="tl-check">
          <input
            type="checkbox"
            bind:checked={options[id]}
            onchange={generate}
            data-testid={`pw-${id}`}
          />{label}
        </label>
      {/each}
    </div>
    {#if noKind}
      <p class="tl-problem" role="alert"><Icon name="warning" size={14} />{t('tools.noKind')}</p>
    {/if}
  </Card>

  <Card title={t('tools.timestamp')} icon="calendar" tone="teal">
    {#snippet actions()}
      <button type="button" class="button secondary" data-testid="now" onclick={now}>
        <Icon name="watch" />{t('tools.now')}
      </button>
    {/snippet}
    <div>
      <label class="tl-label" for="tools-unix">{t('tools.unix')}</label>
      <div class="tl-line">
        <input
          id="tools-unix"
          class="control tl-mono"
          aria-invalid={unixFailed}
          bind:value={unix}
          oninput={fromUnix}
          data-testid="unix"
        />
        <IconButton
          icon="copy"
          tone="blue"
          label={t('tools.copyNamed', t('tools.unix'))}
          disabled={unix === ''}
          onclick={() => {
            copy(unix);
          }}
        />
      </div>
    </div>
    <div>
      <label class="tl-label" for="tools-local">{t('tools.localDate')}</label>
      <div class="tl-line">
        <input
          id="tools-local"
          class="control tl-mono"
          placeholder="2026-10-31 13:53:33"
          aria-invalid={localFailed}
          bind:value={local}
          oninput={fromLocal}
          data-testid="local"
        />
        <IconButton
          icon="copy"
          tone="blue"
          label={t('tools.copyNamed', t('tools.localDate'))}
          disabled={local === ''}
          onclick={() => {
            copy(local);
          }}
        />
      </div>
    </div>
    <div>
      <label class="tl-label" for="tools-iso">ISO 8601</label>
      <input id="tools-iso" class="control tl-mono" readonly value={iso} data-testid="iso" />
    </div>
    {#if unixFailed || localFailed}
      <p class="tl-problem" role="alert" data-testid="time-problem">
        <Icon name="error" size={14} />{unixFailed ? t('tools.badUnix') : t('tools.badDate')}
      </p>
    {/if}
  </Card>
</div>

<style>
  .head-line {
    align-items: flex-end;
  }

  .grow {
    flex: 1;
  }

  .len {
    width: 90px;
  }
</style>

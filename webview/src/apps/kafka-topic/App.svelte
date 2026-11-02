<script lang="ts">
  import { onMount } from 'svelte';
  import type {
    KafkaMessageView,
    KafkaReadMode,
    KafkaTopicProtocol,
    KafkaTopicState,
  } from '../../../../src/shared/protocols/kafka-topic';
  import type { RedisValue } from '../../../../src/shared/redis-value';
  import type { RpcPeer } from '../../../../src/shared/rpc';
  import Icon from '../../components/Icon.svelte';
  import IconButton from '../../components/IconButton.svelte';
  import type { Translate } from '../../lib/i18n';
  import ValueEditor from '../redis-key/ValueEditor.svelte';
  import { cellText } from '../redis-key/key-view';
  import {
    fillPercent,
    isOffset,
    parseHeaders,
    partitionSize,
    timeText,
    totalMessages,
  } from './message-view';

  interface Props {
    rpc: RpcPeer<KafkaTopicProtocol['webview'], KafkaTopicProtocol['host']>;
    t: Translate;
  }

  const { rpc, t }: Props = $props();

  let topic = $state<KafkaTopicState | undefined>(undefined);
  let busy = $state(false);
  let error = $state<string | undefined>(undefined);

  // What the user asks for; the host's state only seeds it on the first load.
  let partition = $state(0);
  let mode = $state<KafkaReadMode>('last');
  let count = $state(50);
  let offsetText = $state('0');
  let timeTextInput = $state('');
  let seeded = false;

  let selected = $state<number | undefined>(undefined);

  // The form that sends a message.
  let producing = $state(false);
  let sendPartition = $state<'auto' | number>('auto');
  let sendKey = $state('');
  let sendHeaders = $state('');
  let sendValue = $state<RedisValue>({ text: '' });
  let tombstone = $state(false);
  /** Bumped to make the editor start again from an empty value. */
  let sendVersion = $state(0);

  const total = $derived(topic === undefined ? 0n : totalMessages(topic.partitions));
  const chosen = $derived(
    selected === undefined ? undefined : topic?.messages.find((one) => one.offset === String(selected)),
  );
  const offsetBad = $derived(mode === 'offset' && !isOffset(offsetText));
  const timeBad = $derived(mode === 'time' && Number.isNaN(Date.parse(timeTextInput.trim())) && !/^\d{9,}$/u.test(timeTextInput.trim()));

  onMount(() => {
    const subscription = rpc.on('state', (next) => {
      topic = next;
      if (!seeded) {
        seeded = true;
        partition = next.partition;
        mode = next.mode;
        count = next.count;
      }
      if (selected !== undefined && !next.messages.some((one) => one.offset === String(selected))) {
        selected = undefined;
      }
    });
    rpc.emit('ready', {});
    return () => {
      subscription.dispose();
    };
  });

  async function run(action: () => Promise<unknown>, after?: () => void): Promise<void> {
    if (busy) {
      return;
    }
    busy = true;
    error = undefined;
    try {
      await action();
      after?.();
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    } finally {
      busy = false;
    }
  }

  function read(): void {
    if (offsetBad || timeBad) {
      return;
    }
    void run(() =>
      rpc.request('read', {
        partition,
        mode,
        count,
        ...(mode === 'offset' ? { offset: offsetText.trim() } : {}),
        ...(mode === 'time' ? { time: timeTextInput.trim() } : {}),
      }),
    );
  }

  function follow(): void {
    const on = topic?.tailing !== true;
    void run(() => rpc.request('tail', { partition, on }));
  }

  function send(): void {
    void run(
      () =>
        rpc.request('produce', {
          ...(sendPartition === 'auto' ? {} : { partition: sendPartition }),
          ...(sendKey === '' ? {} : { key: { text: sendKey } }),
          value: tombstone ? null : sendValue,
          headers: parseHeaders(sendHeaders),
        }),
      () => {
        sendKey = '';
        sendHeaders = '';
        sendValue = { text: '' };
        sendVersion += 1;
        tombstone = false;
      },
    );
  }

  function pickPartition(next: number): void {
    partition = next;
  }

  function show(message: KafkaMessageView): void {
    selected = Number(message.offset);
  }
</script>

<main>
  {#if busy}
    <div class="progress-bar" aria-hidden="true"></div>
  {/if}
  {#if topic === undefined}
    <div class="empty">
      <span class="empty-icon"><Icon name="loading" spin size={24} /></span>
      <p class="empty-title">{t('kafka.loading')}</p>
    </div>
  {:else}
    <header class="top">
      <span class="top-icon"><Icon name="comment-discussion" size={18} /></span>
      <div class="top-text">
        <h1 title={topic.topic}>{topic.topic}</h1>
        <p class="meta" data-testid="meta">
          <span class="badge"><Icon name="layers" size={12} />{t('kafka.partitions', topic.partitions.length)}</span>
          <span class="badge outline"><Icon name="list-ordered" size={12} />{t('kafka.messagesTotal', total.toString())}</span>
          {#if topic.internal}
            <span class="badge outline"><Icon name="lock" size={12} />{t('kafka.internal')}</span>
          {/if}
          {#if topic.readOnly}
            <span class="badge outline"><Icon name="lock" size={12} />{t('redis.readOnly')}</span>
          {/if}
          <span class="fact"><Icon name="server" size={12} />{topic.connectionName}</span>
        </p>
      </div>
      <div class="toolbar">
        {#if !topic.readOnly}
          <button
            type="button"
            class="button"
            aria-pressed={producing}
            disabled={busy}
            onclick={() => {
              producing = !producing;
            }}><Icon name="send" />{t('kafka.send')}</button
          >
        {/if}
        <IconButton
          icon="copy"
          label={t('kafka.copyName')}
          disabled={busy}
          onclick={() => {
            const text = topic?.topic ?? '';
            void run(() => rpc.request('copyText', { text }));
          }}
        />
        <IconButton
          icon="refresh"
          label={t('redis.refresh')}
          disabled={busy}
          onclick={() => void run(() => rpc.request('refresh', {}))}
        />
        {#if !topic.readOnly}
          <IconButton
            icon="trash"
            label={t('kafka.deleteTopic')}
            disabled={busy}
            onclick={() => void run(() => rpc.request('deleteTopic', {}))}
          />
        {/if}
      </div>
    </header>

    {#if error !== undefined}
      <div class="notice error problem" role="alert" data-testid="error"><Icon name="error" /><span class="message">{error}</span></div>
    {/if}

    <div class="scroll">
      <section class="block" aria-label={t('kafka.partitionsTitle')}>
        <table class="partitions" data-testid="partitions">
          <thead>
            <tr>
              <th>{t('kafka.col.partition')}</th>
              <th>{t('kafka.col.messages')}</th>
              <th>{t('kafka.col.offsets')}</th>
              <th>{t('kafka.col.leader')}</th>
              <th>{t('kafka.col.replicas')}</th>
            </tr>
          </thead>
          <tbody>
            {#each topic.partitions as one (one.partition)}
              <tr
                class:current={one.partition === partition}
                onclick={() => {
                  pickPartition(one.partition);
                }}
              >
                <td class="mono">{one.partition}</td>
                <td>
                  <span class="fill" aria-hidden="true"><span style="width: {fillPercent(one, topic.partitions)}%"></span></span>
                  <span class="mono">{partitionSize(one).toString()}</span>
                </td>
                <td class="mono">{one.low} – {one.high}</td>
                <td class="mono">{one.leader < 0 ? '—' : one.leader}</td>
                <td>
                  <span class="badge {one.inSync < one.replicas ? 'warning' : 'success'}">{one.inSync}/{one.replicas}</span>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </section>

      {#if producing && !topic.readOnly}
        <section class="block produce" data-testid="produce">
          <h2 class="section"><Icon name="send" tone="orange" />{t('kafka.sendTitle')}</h2>
          <div class="row">
            <label class="field">
              <span>{t('kafka.col.partition')}</span>
              <select class="control" bind:value={sendPartition} aria-label={t('kafka.col.partition')}>
                <option value="auto">{t('kafka.auto')}</option>
                {#each topic.partitions as one (one.partition)}
                  <option value={one.partition}>{one.partition}</option>
                {/each}
              </select>
            </label>
            <label class="field grow">
              <span>{t('kafka.key')}</span>
              <input class="control mono" bind:value={sendKey} aria-label={t('kafka.key')} autocomplete="off" spellcheck="false" />
            </label>
            <label class="check">
              <input type="checkbox" bind:checked={tombstone} />
              {t('kafka.tombstone')}
            </label>
          </div>
          {#if !tombstone}
            {#key sendVersion}
              <ValueEditor
                value={sendValue}
                label={t('kafka.value')}
                {t}
                rows={6}
                onchange={(next: RedisValue | undefined) => {
                  if (next !== undefined) {
                    sendValue = next;
                  }
                }}
              />
            {/key}
          {/if}
          <label class="field">
            <span>{t('kafka.headers')}</span>
            <textarea class="control mono" rows="2" bind:value={sendHeaders} placeholder="trace-id: 42" aria-label={t('kafka.headers')} spellcheck="false"></textarea>
          </label>
          <div class="actions">
            <button type="button" class="button" disabled={busy} onclick={send}
              ><Icon name="send" />{t('kafka.sendNow')}</button
            >
          </div>
        </section>
      {/if}

      <section class="block read" data-testid="reader">
        <div class="row">
          <label class="field">
            <span>{t('kafka.col.partition')}</span>
            <select class="control" bind:value={partition} aria-label={t('kafka.col.partition')}>
              {#each topic.partitions as one (one.partition)}
                <option value={one.partition}>{one.partition}</option>
              {/each}
            </select>
          </label>
          <span class="modes" role="group" aria-label={t('kafka.mode')}>
            {#each ['last', 'offset', 'time'] as const as option (option)}
              <button
                type="button"
                class="mode"
                aria-pressed={mode === option}
                onclick={() => {
                  mode = option;
                }}>{t(`kafka.mode.${option}`)}</button
              >
            {/each}
          </span>
          {#if mode === 'offset'}
            <label class="field">
              <span>{t('kafka.col.offset')}</span>
              <input class="control mono" bind:value={offsetText} aria-invalid={offsetBad} aria-label={t('kafka.col.offset')} inputmode="numeric" autocomplete="off" />
            </label>
          {:else if mode === 'time'}
            <label class="field">
              <span>{t('kafka.time')}</span>
              <input class="control mono" bind:value={timeTextInput} aria-invalid={timeBad} placeholder="2026-11-01 12:00" aria-label={t('kafka.time')} autocomplete="off" />
            </label>
          {/if}
          <label class="field narrow">
            <span>{t('kafka.count')}</span>
            <input class="control" type="number" min="1" max="500" bind:value={count} aria-label={t('kafka.count')} />
          </label>
          <button type="button" class="button" disabled={busy || offsetBad || timeBad || topic.partitions.length === 0} onclick={read}
            ><Icon name="play" />{t('kafka.read')}</button
          >
          <button
            type="button"
            class="button"
            class:live={topic.tailing === true}
            aria-pressed={topic.tailing === true}
            data-testid="live"
            disabled={busy || topic.partitions.length === 0}
            onclick={follow}
            ><Icon name={topic.tailing === true ? 'debug-stop' : 'broadcast'} />{topic.tailing === true
              ? t('kafka.liveStop')
              : t('kafka.live')}</button
          >
        </div>
        <p class="hint">{t('kafka.readHint')}</p>
      </section>

      {#if topic.read}
        {#if topic.tailing === true}
          <p class="notice info problem" data-testid="live-note">
            <Icon name="broadcast" /><span
              >{topic.messages.length === 0 ? t('kafka.liveWaiting') : t('kafka.liveOn')}</span
            >
          </p>
        {/if}
        {#if topic.notice !== undefined}
          <p class="notice info problem" data-testid="notice"><Icon name="info" /><span>{topic.notice}</span></p>
        {/if}
        {#if topic.messages.length > 0}
          <section class="block" aria-label={t('kafka.messagesTitle')}>
            <table class="messages" data-testid="messages">
              <thead>
                <tr>
                  <th>{t('kafka.col.offset')}</th>
                  <th>{t('kafka.col.time')}</th>
                  <th>{t('kafka.key')}</th>
                  <th>{t('kafka.value')}</th>
                </tr>
              </thead>
              <tbody>
                {#each topic.messages as message (message.offset)}
                  <tr
                    class:current={String(selected) === message.offset}
                    onclick={() => {
                      show(message);
                    }}
                  >
                    <td class="mono">{message.offset}</td>
                    <td class="time">{timeText(message.timestamp)}</td>
                    <td class="mono clip">{message.key === null ? '—' : cellText(message.key, 60)}</td>
                    <td class="mono clip">
                      {#if message.value === null}<span class="badge outline">{t('kafka.tombstoneBadge')}</span>{:else}{cellText(message.value, 160)}{/if}
                      {#if message.schema !== undefined}<span class="badge outline" title={t('kafka.schemaTitle', message.schema.id)}>{message.schema.format}</span>{/if}
                      {#if message.headers.length > 0}<span class="badge outline" title={t('kafka.headers')}>{message.headers.length}</span>{/if}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </section>
        {/if}
        {#if chosen !== undefined}
          {#key chosen.offset}
            <section class="block detail" data-testid="detail">
              <h2 class="section"><Icon name="eye" tone="blue" />{t('kafka.messageTitle', chosen.partition, chosen.offset)}</h2>
              {#if chosen.schema !== undefined}
                <p class="notice info problem" data-testid="schema-note"><Icon name="info" /><span>{t('kafka.schemaNote', chosen.schema.format, chosen.schema.id)}</span></p>
              {/if}
              {#if chosen.key !== null}
                <ValueEditor value={chosen.key} label={t('kafka.key')} {t} readonly rows={2} onchange={() => undefined} />
              {/if}
              {#if chosen.value === null}
                <p class="notice info problem"><Icon name="info" /><span>{t('kafka.tombstoneNote')}</span></p>
              {:else}
                <ValueEditor value={chosen.value} label={t('kafka.value')} {t} readonly rows={8} onchange={() => undefined} />
              {/if}
              {#if chosen.headers.length > 0}
                <table class="headers">
                  <thead><tr><th>{t('kafka.headerName')}</th><th>{t('kafka.value')}</th></tr></thead>
                  <tbody>
                    {#each chosen.headers as header, index (index)}
                      <tr><td class="mono">{header.name}</td><td class="mono clip">{cellText(header.value, 300)}</td></tr>
                    {/each}
                  </tbody>
                </table>
              {/if}
            </section>
          {/key}
        {/if}
      {/if}
    </div>
  {/if}
</main>

<style>
  main {
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100vh;
  }

  .mono {
    font-family: var(--dn-mono);
  }

  .top {
    display: flex;
    flex: none;
    flex-wrap: wrap;
    gap: var(--dn-gap) var(--dn-gap-m);
    align-items: center;
    padding: var(--dn-gap-m) var(--dn-gap-l);
    border-bottom: 1px solid var(--dn-divider);
  }

  .top-icon {
    display: inline-flex;
    padding: 7px;
    color: #fff;
    background: linear-gradient(135deg, #fb923c, #ea580c);
    border-radius: var(--dn-radius-l);
  }

  .top-text {
    flex: 1;
    min-width: 0;
  }

  h1 {
    overflow: hidden;
    font-family: var(--dn-mono);
    font-size: 14px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .toolbar {
    display: inline-flex;
    gap: var(--dn-gap-s);
    align-items: center;
  }

  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: var(--dn-gap-s) var(--dn-gap-m);
    align-items: center;
    margin: 4px 0 0;
    color: var(--dn-muted);
    font-size: var(--dn-font-small);
  }

  .fact {
    display: inline-flex;
    gap: 4px;
    align-items: center;
    white-space: nowrap;
  }

  .problem {
    flex: none;
    margin: var(--dn-gap-m) var(--dn-gap-l) 0;
  }

  .message {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .scroll {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }

  .block {
    padding: var(--dn-gap-m) var(--dn-gap-l);
    border-bottom: 1px solid var(--dn-divider);
  }

  .section {
    display: flex;
    gap: var(--dn-gap-s);
    align-items: center;
    margin: 0 0 var(--dn-gap);
    font-size: 13px;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--dn-font-small);
  }

  th {
    padding: 4px 8px;
    color: var(--dn-muted);
    font-weight: 600;
    text-align: left;
    border-bottom: 1px solid var(--dn-divider);
  }

  td {
    padding: 4px 8px;
    border-bottom: 1px solid var(--dn-divider);
  }

  tbody tr {
    cursor: pointer;
  }

  tbody tr:hover,
  tr.current {
    background: var(--vscode-list-hoverBackground);
  }

  tr.current {
    background: var(--vscode-list-activeSelectionBackground, var(--vscode-list-hoverBackground));
  }

  .headers tbody tr {
    cursor: default;
  }

  .clip {
    max-width: 420px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .time {
    white-space: nowrap;
  }

  /* How full a partition is next to the fullest. */
  .fill {
    display: inline-block;
    width: 64px;
    height: 6px;
    margin-right: 8px;
    vertical-align: middle;
    background: var(--dn-surface);
    border-radius: 3px;
  }

  .fill > span {
    display: block;
    height: 100%;
    background: linear-gradient(90deg, #fb923c, #ea580c);
    border-radius: 3px;
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--dn-gap) var(--dn-gap-m);
    align-items: flex-end;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 2px;
    color: var(--dn-muted);
    font-size: var(--dn-font-small);
  }

  .field.grow {
    flex: 1;
    min-width: 160px;
  }

  .field.narrow .control {
    width: 72px;
  }

  .check {
    display: inline-flex;
    gap: 6px;
    align-items: center;
    padding-bottom: 4px;
  }

  .modes {
    display: inline-flex;
    overflow: hidden;
    border: 1px solid var(--dn-border);
    border-radius: var(--dn-radius);
  }

  .mode {
    padding: 4px 10px;
    color: var(--vscode-foreground);
    background: transparent;
    border: none;
    cursor: pointer;
  }

  .button.live {
    color: #fff;
    background: #16a34a;
  }

  .mode[aria-pressed='true'] {
    color: #fff;
    background: #ea580c;
  }

  .hint {
    margin: var(--dn-gap) 0 0;
    color: var(--dn-muted);
    font-size: var(--dn-font-small);
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    margin-top: var(--dn-gap);
  }

  .produce,
  .detail {
    display: flex;
    flex-direction: column;
    gap: var(--dn-gap);
  }

  .empty {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--dn-gap);
    align-items: center;
    justify-content: center;
    padding: var(--dn-gap-xl);
    color: var(--dn-muted);
    text-align: center;
  }

  .empty-icon {
    display: inline-flex;
    padding: 14px;
    color: var(--dn-muted);
    background: var(--dn-surface);
    border: 1px solid var(--dn-border);
    border-radius: 50%;
  }

  .empty-title {
    margin: 0;
    color: var(--vscode-foreground);
    font-size: 14px;
  }
</style>

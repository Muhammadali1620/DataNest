<script lang="ts">
  import { onMount } from 'svelte';
  import type {
    RabbitBindingDirection,
    RabbitMessageView,
    RabbitObjectProtocol,
    RabbitObjectState,
  } from '../../../../src/shared/protocols/rabbitmq-object';
  import type { RedisValue } from '../../../../src/shared/redis-value';
  import type { RpcPeer } from '../../../../src/shared/rpc';
  import Icon from '../../components/Icon.svelte';
  import IconButton from '../../components/IconButton.svelte';
  import LineChart, { type ChartSeries } from '../../components/LineChart.svelte';
  import type { Translate } from '../../lib/i18n';
  import ValueEditor from '../redis-key/ValueEditor.svelte';
  import AdminView from './AdminView.svelte';
  import { cellText } from '../redis-key/key-view';
  import { displayName, parseHeaders, sharePercent, stateTone } from './object-view';

  interface Props {
    rpc: RpcPeer<RabbitObjectProtocol['webview'], RabbitObjectProtocol['host']>;
    t: Translate;
  }

  const { rpc, t }: Props = $props();

  let object = $state<RabbitObjectState | undefined>(undefined);
  let busy = $state(false);
  let error = $state<string | undefined>(undefined);

  // What the user asks for; the host's state only seeds it on the first load.
  let count = $state(10);
  let seeded = false;
  let selected = $state<number | undefined>(undefined);

  // The form that publishes a message.
  let publishing = $state(false);
  let routingKey = $state('');
  let contentType = $state('');
  let persistent = $state(true);
  let sendHeaders = $state('');
  let payload = $state<RedisValue>({ text: '' });
  /** Bumped to make the editor start again from an empty payload. */
  let payloadVersion = $state(0);

  // The form that binds this queue or exchange to another.
  let binding = $state(false);
  let bindingDirection = $state<RabbitBindingDirection>('fromExchange');
  let bindingPeer = $state('');
  let bindingKey = $state('');
  let bindingArgs = $state('');

  const isQueue = $derived(object?.kind === 'queue');
  const isVhost = $derived(object?.kind === 'vhost');
  const shownName = $derived(object === undefined ? '' : displayName(object.name, t('rabbit.default')));
  const chosen = $derived(
    selected === undefined || object === undefined ? undefined : object.messages[selected],
  );

  onMount(() => {
    const subscription = rpc.on('state', (next) => {
      object = next;
      if (!seeded) {
        seeded = true;
        count = next.count;
      }
      if (selected !== undefined && selected >= next.messages.length) {
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

  function peek(): void {
    void run(() => rpc.request('peek', { count }));
  }

  function publish(): void {
    void run(
      () =>
        rpc.request('publish', {
          routingKey,
          payload,
          ...(contentType.trim() === '' ? {} : { contentType: contentType.trim() }),
          persistent,
          headers: parseHeaders(sendHeaders),
        }),
      () => {
        sendHeaders = '';
        payload = { text: '' };
        payloadVersion += 1;
      },
    );
  }

  function bind(): void {
    void run(
      () =>
        rpc.request('addBinding', {
          direction: isQueue ? 'fromExchange' : bindingDirection,
          peer: bindingPeer,
          routingKey: bindingKey,
          arguments: bindingArgs,
        }),
      () => {
        bindingPeer = '';
        bindingKey = '';
        bindingArgs = '';
      },
    );
  }

  /** The theme's chart colours, with a fallback for a theme that has none. */
  const COLORS = {
    ready: 'var(--vscode-charts-blue, #3794ff)',
    unacked: 'var(--vscode-charts-orange, #d18616)',
    publish: 'var(--vscode-charts-purple, #b180d7)',
    deliver: 'var(--vscode-charts-green, #89d185)',
    ack: 'var(--vscode-charts-yellow, #cca700)',
  } as const;

  /** The graphs keep ten minutes of readings, one every few seconds. */
  const LIVE_WINDOW_MS = 600_000;

  const samples = $derived(object?.live?.samples ?? []);
  const live = $derived(object?.live?.on === true);
  const countSeries = $derived<ChartSeries[]>([
    { key: 'ready', label: t('rabbit.ready'), color: COLORS.ready, values: samples.map((one) => one.ready) },
    { key: 'unacked', label: t('rabbit.unacked'), color: COLORS.unacked, values: samples.map((one) => one.unacked) },
  ]);
  const rateSeries = $derived<ChartSeries[]>([
    { key: 'publish', label: t('rabbit.live.publish'), color: COLORS.publish, values: samples.map((one) => one.publish) },
    { key: 'deliver', label: t('rabbit.live.deliver'), color: COLORS.deliver, values: samples.map((one) => one.deliver) },
    { key: 'ack', label: t('rabbit.live.ack'), color: COLORS.ack, values: samples.map((one) => one.ack) },
  ]);
  const times = $derived(samples.map((one) => one.at));

  /** Counts and rates as whole numbers when large, with one decimal when small. */
  function figure(value: number): string {
    return value >= 10 ? Math.round(value).toLocaleString() : Number(value.toFixed(1)).toString();
  }

  function toggleLive(): void {
    void run(() => rpc.request('setLive', { on: !live }));
  }

  function show(index: number): void {
    selected = index;
  }

  function sizeText(message: RabbitMessageView): string {
    return message.payloadBytes === 1 ? t('rabbit.oneByte') : t('rabbit.bytes', message.payloadBytes);
  }
</script>

<main>
  {#if busy}
    <div class="progress-bar" aria-hidden="true"></div>
  {/if}
  {#if object === undefined}
    <div class="empty">
      <span class="empty-icon"><Icon name="loading" spin size={24} /></span>
      <p class="empty-title">{t('rabbit.loading')}</p>
    </div>
  {:else}
    <header class="top">
      <span class="top-icon"><Icon name={isVhost ? 'shield' : isQueue ? 'mail' : 'git-merge'} size={18} /></span>
      <div class="top-text">
        <h1 title={shownName}>{shownName}</h1>
        <p class="meta" data-testid="meta">
          <span class="badge"><Icon name={isVhost ? 'shield' : isQueue ? 'list-unordered' : 'git-merge'} size={12} />{isVhost ? t('rabbit.kind.vhost') : isQueue ? t('rabbit.kind.queue') : t('rabbit.kind.exchange')}</span>
          {#if object.type !== ''}
            <span class="badge outline">{object.type}</span>
          {/if}
          {#if isQueue && object.state !== ''}
            <span class="badge {stateTone(object.state)}" data-testid="state">{object.state}</span>
          {/if}
          {#if object.readOnly}
            <span class="badge outline"><Icon name="lock" size={12} />{t('redis.readOnly')}</span>
          {/if}
          <span class="fact"><Icon name="server" size={12} />{object.vhost}</span>
          <span class="fact"><Icon name="plug" size={12} />{object.connectionName}</span>
        </p>
      </div>
      <div class="toolbar">
        {#if !object.readOnly && !isVhost}
          <button
            type="button"
            class="button"
            aria-pressed={publishing}
            disabled={busy}
            onclick={() => {
              publishing = !publishing;
            }}><Icon name="send" />{t('rabbit.publish')}</button
          >
        {/if}
        <IconButton
          icon="copy"
          label={t('rabbit.copyName')}
          disabled={busy || object.name === ''}
          onclick={() => {
            const text = object?.name ?? '';
            void run(() => rpc.request('copyText', { text }));
          }}
        />
        <IconButton
          icon="refresh"
          label={t('redis.refresh')}
          disabled={busy}
          onclick={() => void run(() => rpc.request('refresh', {}))}
        />
        {#if !object.readOnly && isQueue}
          <IconButton
            icon="clear-all"
            label={t('rabbit.purge')}
            disabled={busy}
            onclick={() => void run(() => rpc.request('purge', {}))}
          />
        {/if}
        {#if !object.readOnly && !isVhost && object.name !== '' && !object.name.startsWith('amq.')}
          <IconButton
            icon="trash"
            label={isQueue ? t('rabbit.deleteQueue') : t('rabbit.deleteExchange')}
            disabled={busy}
            onclick={() => void run(() => rpc.request('deleteObject', {}))}
          />
        {/if}
      </div>
    </header>

    {#if error !== undefined}
      <div class="notice error problem" role="alert" data-testid="error"><Icon name="error" /><span class="message">{error}</span></div>
    {/if}

    <div class="scroll">
      {#if isQueue}
        <section class="block" aria-label={t('rabbit.counts')}>
          <div class="cards" data-testid="counts">
            <div class="card ready">
              <span class="card-label">{t('rabbit.ready')}</span>
              <span class="card-value mono">{object.ready}</span>
            </div>
            <div class="card unacked">
              <span class="card-label">{t('rabbit.unacked')}</span>
              <span class="card-value mono">{object.unacked}</span>
            </div>
            <div class="card total">
              <span class="card-label">{t('rabbit.total')}</span>
              <span class="card-value mono">{object.total}</span>
            </div>
            <div class="card consumers">
              <span class="card-label">{t('rabbit.consumers')}</span>
              <span class="card-value mono">{object.consumers}</span>
            </div>
          </div>
          <span class="bar" aria-hidden="true">
            <span class="bar-ready" style="width: {sharePercent(object.ready, object.total)}%"></span>
            <span class="bar-unacked" style="width: {sharePercent(object.unacked, object.total)}%"></span>
          </span>
        </section>
      {/if}

      {#if isQueue}
        <section class="block" aria-label={t('rabbit.live.title')} data-testid="live">
          <div class="heading">
            <h2 class="section"><Icon name="graph-line" tone="purple" />{t('rabbit.live.title')}</h2>
            <button type="button" class="button" aria-pressed={live} disabled={busy} onclick={toggleLive}
              ><Icon name={live ? 'debug-stop' : 'debug-start'} />{live ? t('rabbit.live.stop') : t('rabbit.live.start')}</button
            >
          </div>
          {#if samples.length === 0}
            <p class="hint">{t('rabbit.live.hint')}</p>
          {:else}
            <div class="charts">
              <LineChart
                title={t('rabbit.live.counts')}
                icon="mail"
                {times}
                series={countSeries}
                format={figure}
                {t}
                windowMs={LIVE_WINDOW_MS}
                height={170}
              />
              <LineChart
                title={t('rabbit.live.rates')}
                icon="pulse"
                {times}
                series={rateSeries}
                format={figure}
                {t}
                windowMs={LIVE_WINDOW_MS}
                height={170}
              />
            </div>
            <p class="hint">{live ? t('rabbit.live.running') : t('rabbit.live.stopped')}</p>
          {/if}
        </section>
      {/if}

      {#if isQueue}
        <section class="block" aria-label={t('rabbit.consumersTitle')} data-testid="consumers">
          <h2 class="section"><Icon name="plug" tone="green" />{t('rabbit.consumersTitle')}</h2>
          {#if object.consumersList.length === 0}
            <p class="hint">{t('rabbit.noConsumers')}</p>
          {:else}
            <table class="list static">
              <thead>
                <tr>
                  <th>{t('rabbit.col.tag')}</th>
                  <th>{t('rabbit.col.connection')}</th>
                  <th>{t('rabbit.admin.user')}</th>
                  <th>{t('rabbit.col.prefetch')}</th>
                  <th>{t('rabbit.col.ack')}</th>
                  <th>{t('rabbit.admin.state')}</th>
                </tr>
              </thead>
              <tbody>
                {#each object.consumersList as consumer (consumer.tag + consumer.channel)}
                  <tr>
                    <td class="mono clip" title={consumer.tag}>{consumer.tag}</td>
                    <td class="mono clip" title={consumer.channel}>{consumer.connection}</td>
                    <td class="mono">{consumer.user}</td>
                    <td class="mono">{consumer.prefetch === 0 ? '∞' : consumer.prefetch}</td>
                    <td>{consumer.ackRequired ? t('rabbit.yes') : t('rabbit.no')}</td>
                    <td>
                      <span class="badge {consumer.active ? 'success' : 'outline'}">{consumer.active ? t('rabbit.active') : t('rabbit.idle')}</span>
                      {#if consumer.exclusive}<span class="badge outline">{t('rabbit.exclusive')}</span>{/if}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {/if}
        </section>
      {/if}

      <section class="block two" aria-label={t('rabbit.facts')}>
        <div>
          <h2 class="section"><Icon name="info" tone="blue" />{t('rabbit.facts')}</h2>
          <table class="plain" data-testid="facts">
            <tbody>
              {#each object.facts as fact (fact.key)}
                <tr><th scope="row">{fact.key}</th><td class="mono">{fact.value}</td></tr>
              {/each}
            </tbody>
          </table>
        </div>
        {#if !isVhost}
        <div>
          <h2 class="section"><Icon name="symbol-parameter" tone="purple" />{t('rabbit.arguments')}</h2>
          {#if object.arguments.length === 0}
            <p class="hint">{t('rabbit.noArguments')}</p>
          {:else}
            <table class="plain" data-testid="arguments">
              <tbody>
                {#each object.arguments as argument (argument.key)}
                  <tr><th scope="row" class="mono">{argument.key}</th><td class="mono">{argument.value}</td></tr>
                {/each}
              </tbody>
            </table>
          {/if}
        </div>
        {/if}
      </section>

      {#if isVhost && object.admin !== undefined}
        <AdminView admin={object.admin} readOnly={object.readOnly} {rpc} {busy} {t} {run} />
      {/if}

      {#if !isVhost}
      <section class="block" aria-label={t('rabbit.bindings')}>
        <h2 class="section"><Icon name="git-merge" tone="orange" />{t('rabbit.bindings')}</h2>
        {#if object.bindings.length === 0}
          <p class="hint" data-testid="no-bindings">{t('rabbit.noBindings')}</p>
        {:else}
          <table class="list" data-testid="bindings">
            <thead>
              <tr>
                <th>{t('rabbit.col.from')}</th>
                <th>{t('rabbit.col.to')}</th>
                <th>{t('rabbit.col.routingKey')}</th>
                <th>{t('rabbit.arguments')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {#each object.bindings as item, index (index)}
                <tr>
                  <td class="mono">{displayName(item.source, t('rabbit.default'))}</td>
                  <td class="mono">
                    <Icon name={item.destinationType === 'queue' ? 'mail' : 'git-merge'} size={12} />
                    {item.destination}
                  </td>
                  <td class="mono">{item.routingKey === '' ? '—' : item.routingKey}</td>
                  <td class="mono clip">{item.arguments === '' ? '—' : item.arguments}</td>
                  <td class="actions-cell">
                    {#if !object.readOnly && item.source !== ''}
                      <IconButton
                        icon="trash"
                        tone="red"
                        label={t('rabbit.removeBinding')}
                        disabled={busy}
                        onclick={() => void run(() => rpc.request('removeBinding', { index }))}
                      />
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
          {#if object.bindingsCut}
            <p class="hint">{t('rabbit.bindingsCut')}</p>
          {/if}
        {/if}
        {#if !object.readOnly && !(object.kind === 'exchange' && object.name === '')}
          <div class="actions start">
            <button
              type="button"
              class="button secondary"
              aria-pressed={binding}
              disabled={busy}
              onclick={() => {
                binding = !binding;
              }}><Icon name="add" />{t('rabbit.addBinding')}</button
            >
          </div>
          {#if binding}
            <div class="row bind" data-testid="bind">
              {#if !isQueue}
                <label class="field">
                  <span>{t('rabbit.binding.direction')}</span>
                  <select class="control" bind:value={bindingDirection} aria-label={t('rabbit.binding.direction')}>
                    <option value="toQueue">{t('rabbit.binding.toQueue')}</option>
                    <option value="toExchange">{t('rabbit.binding.toExchange')}</option>
                    <option value="fromExchange">{t('rabbit.binding.fromExchange')}</option>
                  </select>
                </label>
              {/if}
              <label class="field grow">
                <span>{isQueue || bindingDirection === 'fromExchange' ? t('rabbit.binding.exchange') : t('rabbit.binding.destination')}</span>
                <input class="control mono" bind:value={bindingPeer} aria-label={t('rabbit.binding.peer')} autocomplete="off" spellcheck="false" />
              </label>
              <label class="field grow">
                <span>{t('rabbit.col.routingKey')}</span>
                <input class="control mono" bind:value={bindingKey} aria-label={t('rabbit.col.routingKey')} autocomplete="off" spellcheck="false" />
              </label>
              <label class="field grow">
                <span>{t('rabbit.arguments')}</span>
                <input class="control mono" bind:value={bindingArgs} placeholder={'{"x-match": "all"}'} aria-label={t('rabbit.arguments')} autocomplete="off" spellcheck="false" />
              </label>
              <button type="button" class="button" disabled={busy} onclick={bind}><Icon name="check" />{t('rabbit.binding.make')}</button>
            </div>
          {/if}
        {/if}
      </section>
      {/if}

      {#if publishing && !object.readOnly && !isVhost}
        <section class="block produce" data-testid="publish">
          <h2 class="section"><Icon name="send" tone="orange" />{t('rabbit.publishTitle')}</h2>
          <div class="row">
            {#if isQueue}
              <p class="hint grow">{t('rabbit.publishToQueue')}</p>
            {:else}
              <label class="field grow">
                <span>{t('rabbit.col.routingKey')}</span>
                <input class="control mono" bind:value={routingKey} aria-label={t('rabbit.col.routingKey')} autocomplete="off" spellcheck="false" />
              </label>
            {/if}
            <label class="field">
              <span>{t('rabbit.contentType')}</span>
              <input class="control mono" bind:value={contentType} placeholder="application/json" aria-label={t('rabbit.contentType')} autocomplete="off" />
            </label>
            <label class="check">
              <input type="checkbox" bind:checked={persistent} />
              {t('rabbit.persistent')}
            </label>
          </div>
          {#key payloadVersion}
            <ValueEditor
              value={payload}
              label={t('rabbit.payload')}
              {t}
              rows={6}
              onchange={(next: RedisValue | undefined) => {
                if (next !== undefined) {
                  payload = next;
                }
              }}
            />
          {/key}
          <label class="field">
            <span>{t('rabbit.headers')}</span>
            <textarea class="control mono" rows="2" bind:value={sendHeaders} placeholder="trace-id: 42" aria-label={t('rabbit.headers')} spellcheck="false"></textarea>
          </label>
          <div class="actions">
            <button type="button" class="button" disabled={busy} onclick={publish}
              ><Icon name="send" />{t('rabbit.publishNow')}</button
            >
          </div>
        </section>
      {/if}

      {#if isQueue}
        <section class="block read" data-testid="peeker">
          <div class="row">
            <label class="field narrow">
              <span>{t('rabbit.count')}</span>
              <input class="control" type="number" min="1" max="100" bind:value={count} aria-label={t('rabbit.count')} />
            </label>
            <button type="button" class="button" disabled={busy} onclick={peek}
              ><Icon name="eye" />{t('rabbit.peek')}</button
            >
          </div>
          <p class="hint">{t('rabbit.peekHint')}</p>
        </section>

        {#if object.peeked}
          {#if object.notice !== undefined}
            <p class="notice info problem" data-testid="notice"><Icon name="info" /><span>{object.notice}</span></p>
          {/if}
          {#if object.messages.length > 0}
            <section class="block" aria-label={t('rabbit.messagesTitle')}>
              <table class="list" data-testid="messages">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>{t('rabbit.col.routingKey')}</th>
                    <th>{t('rabbit.payload')}</th>
                    <th>{t('rabbit.col.size')}</th>
                  </tr>
                </thead>
                <tbody>
                  {#each object.messages as message, index (index)}
                    <tr
                      class:current={selected === index}
                      onclick={() => {
                        show(index);
                      }}
                    >
                      <td class="mono">{index + 1}</td>
                      <td class="mono clip">{message.routingKey === '' ? '—' : message.routingKey}</td>
                      <td class="mono clip">
                        {cellText(message.payload, 160)}
                        {#if message.redelivered}<span class="badge outline" title={t('rabbit.redeliveredHint')}>{t('rabbit.redelivered')}</span>{/if}
                      </td>
                      <td class="size">{sizeText(message)}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </section>
          {/if}
          {#if chosen !== undefined}
            {#key selected}
              <section class="block detail" data-testid="detail">
                <h2 class="section"><Icon name="eye" tone="blue" />{t('rabbit.messageTitle', (selected ?? 0) + 1)}</h2>
                <ValueEditor value={chosen.payload} label={t('rabbit.payload')} {t} readonly rows={8} onchange={() => undefined} />
                <p class="hint">
                  {t('rabbit.publishedTo')}
                  <span class="mono">{displayName(chosen.exchange, t('rabbit.default'))}</span>
                  {#if chosen.routingKey !== ''}
                    · <span class="mono">{chosen.routingKey}</span>
                  {/if}
                </p>
                <pre class="properties mono" data-testid="properties">{chosen.properties}</pre>
              </section>
            {/key}
          {/if}
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
    background: linear-gradient(135deg, #fb7185, #e11d48);
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

  .two {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: var(--dn-gap-l);
  }

  .section {
    display: flex;
    gap: var(--dn-gap-s);
    align-items: center;
    margin: 0 0 var(--dn-gap);
    font-size: 13px;
  }

  .heading {
    display: flex;
    gap: var(--dn-gap-m);
    align-items: center;
    justify-content: space-between;
  }

  /* The two graphs of the live view, side by side while there is room. */
  .charts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
    gap: var(--dn-gap);
  }

  /* The four figures of a queue, each in its own colour. */
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
    gap: var(--dn-gap-m);
  }

  .card {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--dn-gap-m);
    background: var(--dn-surface);
    border: 1px solid var(--dn-border);
    border-left-width: 4px;
    border-radius: var(--dn-radius-l);
  }

  .card.ready {
    border-left-color: #f97316;
  }

  .card.unacked {
    border-left-color: #eab308;
  }

  .card.total {
    border-left-color: #3b82f6;
  }

  .card.consumers {
    border-left-color: #22c55e;
  }

  .card-label {
    color: var(--dn-muted);
    font-size: var(--dn-font-small);
  }

  .card-value {
    font-size: 22px;
    font-weight: 600;
  }

  /* How much of the queue is waiting and how much is out for delivery. */
  .bar {
    display: flex;
    height: 6px;
    margin-top: var(--dn-gap-m);
    overflow: hidden;
    background: var(--dn-surface);
    border-radius: 3px;
  }

  .bar-ready {
    background: linear-gradient(90deg, #fb923c, #f97316);
  }

  .bar-unacked {
    background: linear-gradient(90deg, #facc15, #eab308);
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

  .plain th {
    width: 38%;
    font-weight: 500;
  }

  td {
    padding: 4px 8px;
    border-bottom: 1px solid var(--dn-divider);
    overflow-wrap: anywhere;
  }

  .list tbody tr {
    cursor: pointer;
  }

  .list tbody tr:hover,
  tr.current {
    background: var(--vscode-list-hoverBackground);
  }

  tr.current {
    background: var(--vscode-list-activeSelectionBackground, var(--vscode-list-hoverBackground));
  }

  .actions-cell {
    text-align: right;
    white-space: nowrap;
  }

  .actions.start {
    justify-content: flex-start;
  }

  .bind {
    margin-top: var(--dn-gap-m);
  }

  .list.static tbody tr {
    cursor: default;
  }

  .clip {
    max-width: 420px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .size {
    white-space: nowrap;
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

  .grow {
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

  .properties {
    max-height: 180px;
    margin: 0;
    padding: var(--dn-gap);
    overflow: auto;
    font-size: var(--dn-font-small);
    background: var(--dn-surface);
    border: 1px solid var(--dn-border);
    border-radius: var(--dn-radius);
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

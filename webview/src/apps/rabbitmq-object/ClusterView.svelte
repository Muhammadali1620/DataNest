<script lang="ts">
  import type { RabbitClusterView } from '../../../../src/shared/protocols/rabbitmq-object';
  import { formatSize } from '../../../../src/shared/byte-size';
  import Icon from '../../components/Icon.svelte';
  import type { Translate } from '../../lib/i18n';
  import { listenerAddress, meterTone, usedPercent } from './cluster-view';

  interface Props {
    cluster: RabbitClusterView;
    t: Translate;
  }

  const { cluster, t }: Props = $props();

  const totals = $derived([
    { key: 'queues', label: t('rabbit.cluster.queues'), value: cluster.queues },
    { key: 'exchanges', label: t('rabbit.cluster.exchanges'), value: cluster.exchanges },
    { key: 'connections', label: t('rabbit.cluster.connections'), value: cluster.connections },
    { key: 'channels', label: t('rabbit.cluster.channels'), value: cluster.channels },
    { key: 'consumers', label: t('rabbit.cluster.consumers'), value: cluster.consumers },
    { key: 'ready', label: t('rabbit.ready'), value: cluster.ready },
    { key: 'unacked', label: t('rabbit.unacked'), value: cluster.unacked },
  ]);
</script>

<section class="block" aria-label={t('rabbit.cluster.totals')} data-testid="cluster-totals">
  <h2 class="section"><Icon name="dashboard" tone="blue" />{t('rabbit.cluster.totals')}</h2>
  <div class="cards">
    {#each totals as total (total.key)}
      <div class="card {total.key}">
        <span class="card-label">{total.label}</span>
        <span class="card-value mono">{total.value}</span>
      </div>
    {/each}
  </div>
</section>

<section class="block" aria-label={t('rabbit.cluster.nodes')} data-testid="cluster-nodes">
  <h2 class="section"><Icon name="server-environment" tone="green" />{t('rabbit.cluster.nodes')}</h2>
  <div class="nodes">
    {#each cluster.nodes as node (node.name)}
      {@const mem = usedPercent(node.memUsed, node.memLimit)}
      {@const fds = usedPercent(node.fdUsed, node.fdTotal)}
      {@const sockets = usedPercent(node.socketsUsed, node.socketsTotal)}
      {@const procs = usedPercent(node.procUsed, node.procTotal)}
      <article class="node" class:down={!node.running} data-testid="node">
        <header>
          <Icon name="vm" tone={node.running ? 'green' : 'red'} />
          <h3 class="mono" title={node.name}>{node.name}</h3>
          <span class="badge {node.running ? 'success' : 'error'}">{node.running ? t('rabbit.cluster.running') : t('rabbit.cluster.stopped')}</span>
          {#if node.name === cluster.node}
            <span class="badge outline">{t('rabbit.cluster.connected')}</span>
          {/if}
          {#if node.type !== ''}
            <span class="badge outline">{node.type}</span>
          {/if}
          {#if node.draining}
            <span class="badge warning">{t('rabbit.cluster.draining')}</span>
          {/if}
          {#if node.memAlarm}
            <span class="badge error" data-testid="mem-alarm"><Icon name="warning" size={12} />{t('rabbit.cluster.memAlarm')}</span>
          {/if}
          {#if node.diskAlarm}
            <span class="badge error" data-testid="disk-alarm"><Icon name="warning" size={12} />{t('rabbit.cluster.diskAlarm')}</span>
          {/if}
          {#if node.partitions.length > 0}
            <span class="badge error" data-testid="partition" title={node.partitions.join(', ')}><Icon name="warning" size={12} />{t('rabbit.cluster.partition', node.partitions.length)}</span>
          {/if}
        </header>
        {#if node.running}
          <p class="meta">
            {#if node.uptime !== ''}<span class="fact"><Icon name="history" size={12} />{t('rabbit.cluster.uptime', node.uptime)}</span>{/if}
            {#if node.processors > 0}<span class="fact"><Icon name="server" size={12} />{t('rabbit.cluster.processors', node.processors)}</span>{/if}
          </p>
          <dl class="meters">
            <div class="meter-row" data-testid="meter-memory">
              <dt>{t('rabbit.cluster.memory')}</dt>
              <dd>
                <span class="meter" role="meter" aria-label={t('rabbit.cluster.memory')} aria-valuemin="0" aria-valuemax="100" aria-valuenow={mem}>
                  <span class="fill {meterTone(mem, node.memAlarm)}" style="width: {mem}%"></span>
                </span>
                <span class="figure mono">{formatSize(node.memUsed)}{node.memLimit > 0 ? ` / ${formatSize(node.memLimit)}` : ''}</span>
              </dd>
            </div>
            <div class="meter-row" data-testid="meter-disk">
              <dt>{t('rabbit.cluster.disk')}</dt>
              <dd>
                <span class="figure wide mono">{t('rabbit.cluster.diskFree', formatSize(node.diskFree), formatSize(node.diskFreeLimit))}</span>
              </dd>
            </div>
            <div class="meter-row" data-testid="meter-fd">
              <dt>{t('rabbit.cluster.fds')}</dt>
              <dd>
                <span class="meter" role="meter" aria-label={t('rabbit.cluster.fds')} aria-valuemin="0" aria-valuemax="100" aria-valuenow={fds}>
                  <span class="fill {meterTone(fds)}" style="width: {fds}%"></span>
                </span>
                <span class="figure mono">{node.fdUsed} / {node.fdTotal}</span>
              </dd>
            </div>
            <div class="meter-row" data-testid="meter-sockets">
              <dt>{t('rabbit.cluster.sockets')}</dt>
              <dd>
                <span class="meter" role="meter" aria-label={t('rabbit.cluster.sockets')} aria-valuemin="0" aria-valuemax="100" aria-valuenow={sockets}>
                  <span class="fill {meterTone(sockets)}" style="width: {sockets}%"></span>
                </span>
                <span class="figure mono">{node.socketsUsed} / {node.socketsTotal}</span>
              </dd>
            </div>
            <div class="meter-row" data-testid="meter-procs">
              <dt>{t('rabbit.cluster.procs')}</dt>
              <dd>
                <span class="meter" role="meter" aria-label={t('rabbit.cluster.procs')} aria-valuemin="0" aria-valuemax="100" aria-valuenow={procs}>
                  <span class="fill {meterTone(procs)}" style="width: {procs}%"></span>
                </span>
                <span class="figure mono">{node.procUsed} / {node.procTotal}</span>
              </dd>
            </div>
          </dl>
        {/if}
      </article>
    {/each}
  </div>
</section>

<section class="block" aria-label={t('rabbit.cluster.listeners')} data-testid="cluster-listeners">
  <h2 class="section"><Icon name="plug" tone="orange" />{t('rabbit.cluster.listeners')}</h2>
  {#if cluster.listeners.length === 0}
    <p class="hint">{t('rabbit.cluster.noListeners')}</p>
  {:else}
    <table class="list static">
      <thead>
        <tr>
          <th>{t('rabbit.cluster.protocol')}</th>
          <th>{t('rabbit.cluster.address')}</th>
          <th>{t('rabbit.cluster.node')}</th>
        </tr>
      </thead>
      <tbody>
        {#each cluster.listeners as listener, index (index)}
          <tr>
            <td><span class="badge outline">{listener.protocol}</span></td>
            <td class="mono">{listenerAddress(listener.ip, listener.port)}</td>
            <td class="mono">{listener.node}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</section>

<section class="block" aria-label={t('rabbit.cluster.parameters')} data-testid="cluster-parameters">
  <h2 class="section"><Icon name="symbol-parameter" tone="purple" />{t('rabbit.cluster.parameters')}</h2>
  {#if cluster.parametersError !== undefined}
    <p class="notice error" role="alert"><Icon name="error" /><span>{cluster.parametersError}</span></p>
  {:else if cluster.parameters.length === 0}
    <p class="hint">{t('rabbit.cluster.noParameters')}</p>
  {:else}
    <table class="plain">
      <tbody>
        {#each cluster.parameters as parameter (parameter.key)}
          <tr><th scope="row" class="mono">{parameter.key}</th><td class="mono">{parameter.value}</td></tr>
        {/each}
      </tbody>
    </table>
  {/if}
</section>

<style>
  .mono {
    font-family: var(--dn-mono);
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

  /* The totals of the broker, each in its own colour like the figures of a queue. */
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
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

  .card.queues {
    border-left-color: var(--vscode-charts-blue, #3794ff);
  }

  .card.exchanges {
    border-left-color: var(--vscode-charts-purple, #b180d7);
  }

  .card.connections {
    border-left-color: var(--dn-success, #89d185);
  }

  .card.channels {
    border-left-color: var(--vscode-terminal-ansiCyan, #29b8db);
  }

  .card.consumers {
    border-left-color: var(--vscode-terminal-ansiBrightCyan, #29b8db);
  }

  .card.ready {
    border-left-color: var(--vscode-charts-orange, #d18616);
  }

  .card.unacked {
    border-left-color: var(--vscode-charts-yellow, #cca700);
  }

  .card-label {
    overflow: hidden;
    color: var(--dn-muted);
    font-size: var(--dn-font-small);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .card-value {
    font-size: 22px;
    font-weight: 600;
  }

  .nodes {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(340px, 100%), 1fr));
    gap: var(--dn-gap-m);
  }

  .node {
    display: flex;
    flex-direction: column;
    gap: var(--dn-gap);
    padding: var(--dn-gap-m);
    background: var(--dn-surface);
    border: 1px solid var(--dn-border);
    border-top: 3px solid var(--dn-success, #89d185);
    border-radius: var(--dn-radius-l);
  }

  .node.down {
    border-top-color: var(--vscode-charts-red, #f14c4c);
  }

  .node header {
    display: flex;
    flex-wrap: wrap;
    gap: var(--dn-gap-s) var(--dn-gap);
    align-items: center;
  }

  .node h3 {
    flex: 1;
    min-width: 120px;
    margin: 0;
    overflow: hidden;
    font-size: 13px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .meta {
    display: flex;
    gap: var(--dn-gap-m);
    margin: 0;
    color: var(--dn-muted);
    font-size: var(--dn-font-small);
  }

  .fact {
    display: inline-flex;
    gap: 4px;
    align-items: center;
  }

  .meters {
    display: flex;
    flex-direction: column;
    gap: var(--dn-gap);
    margin: 0;
  }

  .meter-row {
    display: grid;
    grid-template-columns: 110px 1fr;
    gap: var(--dn-gap);
    align-items: center;
    font-size: var(--dn-font-small);
  }

  .meter-row dt {
    color: var(--dn-muted);
  }

  .meter-row dd {
    display: flex;
    gap: var(--dn-gap);
    align-items: center;
    margin: 0;
  }

  .meter {
    display: block;
    flex: 1;
    min-width: 60px;
    height: 8px;
    overflow: hidden;
    background: var(--dn-border);
    border-radius: var(--dn-radius);
  }

  .fill {
    display: block;
    height: 100%;
    border-radius: var(--dn-radius);
  }

  .fill.ok {
    background: var(--dn-success, #89d185);
  }

  .fill.warn {
    background: var(--vscode-charts-yellow, #cca700);
  }

  .fill.bad {
    background: var(--vscode-charts-red, #f14c4c);
  }

  .figure {
    min-width: 96px;
    text-align: right;
    white-space: nowrap;
  }

  /* A line of words, not a pair of figures: it may wrap, and starts at the left like the meters do. */
  .figure.wide {
    text-align: left;
    white-space: normal;
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
    overflow-wrap: anywhere;
  }

  .plain th {
    width: 38%;
    font-weight: 500;
  }

  .hint {
    margin: var(--dn-gap) 0 0;
    color: var(--dn-muted);
    font-size: var(--dn-font-small);
  }
</style>

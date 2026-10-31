<script lang="ts">
  import type { ManagerProtocol } from '../../../../src/shared/protocols/manager';
  import type { ServerMonitorProtocol } from '../../../../src/shared/protocols/server-monitor';
  import type { RpcPeer } from '../../../../src/shared/rpc';
  import type { Translate } from '../../lib/i18n';
  import { scopedRpc } from '../../lib/scoped-rpc';
  import MonitorApp from '../server-monitor/App.svelte';

  interface Props {
    rpc: RpcPeer<ManagerProtocol['webview'], ManagerProtocol['host']>;
    t: Translate;
    /** Dashboard shows the status tab, ProcessList the processes. */
    only: 'processes' | 'status';
  }

  const { rpc, t, only }: Props = $props();

  const monitor = $derived(
    scopedRpc<ServerMonitorProtocol['webview'], ServerMonitorProtocol['host']>(rpc, 'monitor'),
  );
</script>

<div class="monitor"><MonitorApp rpc={monitor} {t} {only} /></div>

<style>
  .monitor {
    height: 100%;
    min-height: 0;
  }
</style>

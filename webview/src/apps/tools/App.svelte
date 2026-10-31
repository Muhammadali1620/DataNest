<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import type { ToolsProtocol } from '../../../../src/shared/protocols/tools';
  import type { RpcPeer } from '../../../../src/shared/rpc';
  import Icon from '../../components/Icon.svelte';
  import type { CodiconName } from '../../lib/codicons';
  import type { Translate } from '../../lib/i18n';
  import ColorsTab from './ColorsTab.svelte';
  import GeneralTab from './GeneralTab.svelte';
  import ImageTab from './ImageTab.svelte';
  import { browserImageApi, type ImageApi } from './image-api';
  import NetworkTab from './NetworkTab.svelte';

  interface Props {
    rpc: RpcPeer<ToolsProtocol['webview'], ToolsProtocol['host']>;
    t: Translate;
    /** The browser's image machinery; tests give a fake. */
    images?: ImageApi;
  }

  const { rpc, t, images = browserImageApi }: Props = $props();

  type TabId = 'general' | 'network' | 'colors' | 'image';
  const TABS: readonly { id: TabId; icon: CodiconName }[] = [
    { id: 'general', icon: 'symbol-misc' },
    { id: 'network', icon: 'globe' },
    { id: 'colors', icon: 'symbol-color' },
    { id: 'image', icon: 'file-media' },
  ];

  let tab = $state<TabId>('general');
  let copied = $state(false);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;

  /** Copying goes through the host: a webview may not write the clipboard itself. */
  function copy(text: string): void {
    rpc.emit('copyText', { text });
    copied = true;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      copied = false;
    }, 1500);
  }

  function onTabKey(event: KeyboardEvent): void {
    const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (!keys.includes(event.key)) {
      return;
    }
    event.preventDefault();
    const index = TABS.findIndex((item) => item.id === tab);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? TABS.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length;
    const target = TABS[next];
    if (target !== undefined) {
      tab = target.id;
      document.getElementById(`tools-tab-${target.id}`)?.focus();
    }
  }

  onMount(() => {
    rpc.emit('ready', {});
  });

  onDestroy(() => {
    clearTimeout(copiedTimer);
  });
</script>

<main>
  <header class="head">
    <span class="logo"><Icon name="tools" size={22} /></span>
    <div>
      <h1>{t('tools.title')}</h1>
      <p class="sub">{t('tools.subtitle')}</p>
    </div>
  </header>

  <div class="tabs" role="tablist" aria-label={t('tools.title')} tabindex="-1" onkeydown={onTabKey}>
    {#each TABS as item (item.id)}
      <button
        type="button"
        role="tab"
        id={`tools-tab-${item.id}`}
        class="tab"
        class:active={tab === item.id}
        aria-selected={tab === item.id}
        aria-controls={`tools-panel-${item.id}`}
        tabindex={tab === item.id ? 0 : -1}
        onclick={() => {
          tab = item.id;
        }}
      >
        <Icon name={item.icon} size={15} />{t(`tools.tab.${item.id}`)}
      </button>
    {/each}
  </div>

  <div class="content" role="tabpanel" id={`tools-panel-${tab}`} aria-labelledby={`tools-tab-${tab}`}>
    {#if tab === 'general'}
      <GeneralTab {rpc} {t} {copy} />
    {:else if tab === 'network'}
      <NetworkTab {rpc} {t} />
    {:else if tab === 'colors'}
      <ColorsTab {t} {copy} />
    {:else}
      <ImageTab {rpc} {t} {copy} {images} />
    {/if}
  </div>

  {#if copied}
    <div class="toast fade-in" role="status" data-testid="copied">
      <Icon name="check" size={14} />{t('tools.copied')}
    </div>
  {/if}
</main>

<style>
  main {
    max-width: 1240px;
    min-height: 100vh;
    margin: 0 auto;
    padding: 20px 24px 40px;
  }

  .head {
    display: flex;
    gap: 14px;
    align-items: center;
    margin-bottom: 16px;
  }

  .logo {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    color: var(--vscode-charts-orange, var(--dn-warning));
    background: color-mix(in srgb, var(--vscode-charts-orange, var(--dn-warning)) 16%, transparent);
    border-radius: 14px;
  }

  .sub {
    margin: 2px 0 0;
    color: var(--dn-muted);
  }

  .tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding-bottom: 14px;
    margin-bottom: 16px;
    border-bottom: 1px solid var(--dn-divider);
  }

  .tab {
    display: inline-flex;
    gap: 7px;
    align-items: center;
    height: 32px;
    padding: 0 14px;
    color: var(--dn-muted);
    background: transparent;
    border: 1px solid transparent;
    border-radius: 16px;
    font-family: inherit;
    font-size: inherit;
    cursor: pointer;
    transition:
      color var(--dn-duration) var(--dn-ease),
      background-color var(--dn-duration) var(--dn-ease);
  }

  .tab:hover {
    color: var(--vscode-foreground);
    background: var(--dn-hover);
  }

  .tab.active {
    color: var(--vscode-foreground);
    background: color-mix(in srgb, var(--dn-accent) 18%, transparent);
    border-color: color-mix(in srgb, var(--dn-accent) 55%, transparent);
  }

  .tab:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: 1px;
  }

  .toast {
    position: fixed;
    right: 20px;
    bottom: 20px;
    display: inline-flex;
    gap: 6px;
    align-items: center;
    padding: 8px 14px;
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
    border-radius: 18px;
    box-shadow: var(--dn-shadow);
  }
</style>

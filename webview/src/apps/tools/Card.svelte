<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from '../../components/Icon.svelte';
  import type { CodiconName } from '../../lib/codicons';
  import type { Tone } from '../../components/tone';

  interface Props {
    title: string;
    icon: CodiconName;
    tone?: Tone;
    /** Buttons on the right of the header. */
    actions?: Snippet;
    children: Snippet;
  }

  const { title, icon, tone = 'blue', actions, children }: Props = $props();
</script>

<section class="card tool-card" aria-label={title}>
  <header>
    <span class="head-icon tone-{tone}"><Icon name={icon} size={16} /></span>
    <h2>{title}</h2>
    <span class="grow"></span>
    {#if actions}{@render actions()}{/if}
  </header>
  <div class="body">{@render children()}</div>
</section>

<style>
  .tool-card {
    padding: 0;
    overflow: hidden;
    border-radius: 14px;
  }

  header {
    display: flex;
    gap: 10px;
    align-items: center;
    padding: 10px 14px;
    border-bottom: 1px solid var(--dn-divider);
  }

  .head-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    color: var(--tone);
    background: color-mix(in srgb, var(--tone) 16%, transparent);
    border-radius: 8px;
  }

  h2 {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
  }

  .grow {
    flex: 1;
  }

  .body {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 14px;
  }
</style>

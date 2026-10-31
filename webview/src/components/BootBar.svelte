<script lang="ts">
  import { readBootBar } from '../lib/boot-bar';
  import type { Translate } from '../lib/i18n';
  import TableBar from './TableBar.svelte';

  interface Props {
    t: Translate;
  }

  const { t }: Props = $props();

  const boot = readBootBar();
</script>

<!-- The bar while the page loads: the same one the loaded page shows, with no action yet. -->
{#if boot !== undefined}
  <TableBar {t} active={boot.page} isView={boot.isView} onAction={() => undefined} />
{/if}

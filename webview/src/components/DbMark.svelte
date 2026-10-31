<script lang="ts">
  import type { DriverId } from '../../../src/shared/connection';
  import { dbMarkSvg } from '../../../src/shared/db-marks';

  interface Props {
    driver: DriverId;
    /** Pixels, square. */
    size?: number;
  }

  const { driver, size = 24 }: Props = $props();
</script>

<!-- Decorative: the name of the database is always written next to its mark. -->
<span class="db-mark" aria-hidden="true" data-driver={driver}>
  <!-- eslint-disable-next-line svelte/no-at-html-tags -- our own constant drawing, no input -->
  {@html dbMarkSvg(driver, size)}
</span>

<style>
  .db-mark {
    display: inline-flex;
    flex: none;
    line-height: 0;
  }
</style>

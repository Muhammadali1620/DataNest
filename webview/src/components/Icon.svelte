<script lang="ts">
  import { CODICONS, type CodiconName } from '../lib/codicons';
  import type { Tone } from './tone';

  interface Props {
    name: CodiconName;
    /** Glyph size in pixels; the editor draws its icons at 16. */
    size?: number;
    /** Turns the icon, for a loading or syncing state. */
    spin?: boolean;
    /** Draws the glyph in a colour of the theme's chart palette. */
    tone?: Tone | undefined;
  }

  const { name, size = 16, spin = false, tone }: Props = $props();
</script>

<!--
  Decorative: the button or text next to it carries the name for screen readers. The
  glyph is drawn from an attribute, so it is not part of the text that is copied or read.
-->
<span
  class="codicon-glyph {tone === undefined ? '' : `tone-${tone}`}"
  class:spin
  aria-hidden="true"
  data-glyph={String.fromCodePoint(CODICONS[name])}
  style="font-size: {size}px; width: {size}px; height: {size}px;"
></span>

<style>
  .codicon-glyph {
    display: inline-block;
    flex: none;
    font-family: codicon;
    font-style: normal;
    font-weight: normal;
    line-height: 1;
    text-align: center;
    text-decoration: none;
    text-rendering: auto;
    user-select: none;
    -webkit-font-smoothing: antialiased;
  }

  .codicon-glyph[class*='tone-'] {
    color: var(--tone);
  }

  .codicon-glyph::before {
    content: attr(data-glyph);
  }

  .spin {
    animation: spin 1.5s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .spin {
      animation: none;
    }
  }
</style>

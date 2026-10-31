<script lang="ts">
  import Icon from '../../components/Icon.svelte';
  import type { Translate } from '../../lib/i18n';
  import type { ImageApi, LoadedImage } from './image-api';

  interface Props {
    images: ImageApi;
    /** The image that was read; the picker also shows its name. */
    current: LoadedImage | undefined;
    onLoad: (image: LoadedImage) => void;
    t: Translate;
  }

  const { images, current, onLoad, t }: Props = $props();

  let problem = $state<string | undefined>(undefined);
  let over = $state(false);
  let input = $state<HTMLInputElement | undefined>(undefined);

  async function take(file: Blob | null | undefined, name: string): Promise<void> {
    if (file === null || file === undefined) {
      return;
    }
    const image = await images.load(file, name);
    if (image === undefined) {
      problem = t('tools.img.notImage');
      return;
    }
    problem = undefined;
    onLoad(image);
  }

  function onPaste(event: ClipboardEvent): void {
    const item = [...(event.clipboardData?.items ?? [])].find((entry) => entry.type.startsWith('image/'));
    if (item !== undefined) {
      event.preventDefault();
      void take(item.getAsFile(), t('tools.img.pasted'));
    }
  }
</script>

<svelte:window onpaste={onPaste} />

<div class="picker">
  <button
    type="button"
    class="drop"
    class:over
    data-testid="drop"
    onclick={() => {
      input?.click();
    }}
    ondragover={(event) => {
      event.preventDefault();
      over = true;
    }}
    ondragleave={() => {
      over = false;
    }}
    ondrop={(event) => {
      event.preventDefault();
      over = false;
      const file = event.dataTransfer?.files[0];
      void take(file, file?.name ?? '');
    }}
  >
    <Icon name="cloud-upload" size={26} />
    <span>{t('tools.img.drop')}</span>
    {#if current !== undefined}
      <span class="muted small" data-testid="loaded">{current.name} · {current.width}×{current.height}</span>
    {/if}
  </button>
  <input
    bind:this={input}
    class="sr-only"
    type="file"
    accept="image/*"
    tabindex="-1"
    aria-label={t('tools.img.choose')}
    data-testid="file"
    onchange={(event) => {
      const file = event.currentTarget.files?.[0];
      void take(file, file?.name ?? '');
      event.currentTarget.value = '';
    }}
  />
  {#if problem !== undefined}
    <p class="tl-problem" role="alert" data-testid="img-problem"><Icon name="error" size={14} />{problem}</p>
  {/if}
</div>

<style>
  .picker {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .drop {
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: center;
    justify-content: center;
    min-height: 150px;
    padding: 16px;
    color: var(--dn-muted);
    background: color-mix(in srgb, var(--vscode-foreground) 5%, transparent);
    border: 1px dashed var(--dn-border);
    border-radius: 14px;
    font-family: inherit;
    font-size: inherit;
    cursor: pointer;
    transition: background-color var(--dn-duration) var(--dn-ease);
  }

  .drop:hover,
  .drop.over {
    color: var(--vscode-foreground);
    background: color-mix(in srgb, var(--dn-accent) 12%, transparent);
    border-color: var(--dn-accent);
  }
</style>

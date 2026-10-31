<script lang="ts">
  import {
    derive,
    parseHex,
    parseRgb,
    type Rgb,
    rgbToHsl,
    SWATCHES,
    textOn,
    toHex,
    toRgbString,
  } from '../../../../src/shared/tools/colors';
  import Icon from '../../components/Icon.svelte';
  import IconButton from '../../components/IconButton.svelte';
  import type { Translate } from '../../lib/i18n';
  import Card from './Card.svelte';

  interface Props {
    t: Translate;
    copy: (text: string) => void;
  }

  const { t, copy }: Props = $props();

  let color = $state<Rgb>({ r: 52, g: 120, b: 198 });
  let hexText = $state('#3478C6');
  let rgbText = $state('rgb(52, 120, 198)');
  let hexFailed = $state(false);
  let rgbFailed = $state(false);

  const hex = $derived(toHex(color));
  const hsl = $derived(rgbToHsl(color));
  const shades = $derived(derive(color));
  const DERIVED = [
    ['hover', 'hover'],
    ['active', 'active'],
    ['light', 'light'],
    ['textOnColor', 'textOnColor'],
    ['softBackground', 'softBackground'],
    ['softHover', 'softHover'],
    ['border', 'border'],
  ] as const;

  function set(next: Rgb): void {
    color = next;
    hexText = toHex(next);
    rgbText = toRgbString(next);
    hexFailed = false;
    rgbFailed = false;
  }

  function fromHex(): void {
    const parsed = parseHex(hexText);
    hexFailed = hexText.trim() !== '' && parsed === undefined;
    if (parsed !== undefined) {
      color = parsed;
      rgbText = toRgbString(parsed);
      rgbFailed = false;
    }
  }

  function fromRgb(): void {
    const parsed = parseRgb(rgbText);
    rgbFailed = rgbText.trim() !== '' && parsed === undefined;
    if (parsed !== undefined) {
      color = parsed;
      hexText = toHex(parsed);
      hexFailed = false;
    }
  }

  const css = (value: Rgb): string => toRgbString(value);
</script>

<div class="tl-grid">
  <div class="tl-stack">
    <Card title={t('tools.color')} icon="paintcan" tone="pink">
      <div class="pick">
        <label class="chip" style="background: {css(color)};">
          <span class="sr-only">{t('tools.pickColor')}</span>
          <input
            type="color"
            value={hex.toLowerCase()}
            data-testid="picker"
            oninput={(event) => {
              set(parseHex(event.currentTarget.value) ?? color);
            }}
          />
        </label>
        <div class="fields">
          <div>
            <label class="tl-label" for="tools-hex">HEX</label>
            <div class="tl-line">
              <input id="tools-hex" class="control tl-mono" aria-invalid={hexFailed} bind:value={hexText} oninput={fromHex} data-testid="hex" />
              <IconButton icon="copy" tone="blue" label={t('tools.copyNamed', 'HEX')} onclick={() => { copy(hex); }} />
            </div>
          </div>
          <div>
            <label class="tl-label" for="tools-rgb">RGB</label>
            <div class="tl-line">
              <input id="tools-rgb" class="control tl-mono" aria-invalid={rgbFailed} bind:value={rgbText} oninput={fromRgb} data-testid="rgb" />
              <IconButton icon="copy" tone="blue" label={t('tools.copyNamed', 'RGB')} onclick={() => { copy(toRgbString(color)); }} />
            </div>
          </div>
        </div>
      </div>
      <p class="muted small" data-testid="hsl">
        HSL {Math.round(hsl.h)}°, {Math.round(hsl.s)}%, {Math.round(hsl.l)}%
      </p>
      {#if hexFailed || rgbFailed}
        <p class="tl-problem" role="alert" data-testid="color-problem"><Icon name="error" size={14} />{t('tools.badColor')}</p>
      {/if}
      <div class="swatches" role="group" aria-label={t('tools.swatches')}>
        {#each SWATCHES as swatch (swatch)}
          <button
            type="button"
            class="swatch"
            class:on={swatch.toUpperCase() === hex}
            style="background: {swatch};"
            title={swatch}
            aria-label={swatch}
            aria-pressed={swatch.toUpperCase() === hex}
            onclick={() => {
              set(parseHex(swatch) ?? color);
            }}
          ></button>
        {/each}
      </div>
    </Card>

    <Card title={t('tools.derived')} icon="symbol-color" tone="orange">
      {#each DERIVED as [key, label] (key)}
        {@const value = shades[key]}
        <div class="derived" data-testid={`derived-${key}`}>
          <span class="dot" style="background: {css(value)};"></span>
          <span class="name">{t(`tools.shade.${label}`)}</span>
          <input class="control tl-mono" readonly value={toHex(value)} aria-label={t(`tools.shade.${label}`)} />
          <IconButton icon="copy" tone="blue" label={t('tools.copyNamed', t(`tools.shade.${label}`))} onclick={() => { copy(toHex(value)); }} />
        </div>
      {/each}
    </Card>
  </div>

  <Card title={t('tools.preview')} icon="eye" tone="teal">
    <div
      class="preview"
      data-testid="preview"
      style="--c: {css(color)}; --h: {css(shades.hover)}; --a: {css(shades.active)}; --l: {css(shades.light)}; --t: {css(textOn(color))}; --s: {css(shades.softBackground)}; --sh: {css(shades.softHover)}; --b: {css(shades.border)};"
    >
      <div class="cell">
        <span class="tl-label">{t('tools.pv.button')}</span>
        <span class="pv-button">{t('tools.pv.primary')}</span>
      </div>
      <div class="cell">
        <span class="tl-label">{t('tools.pv.outline')}</span>
        <span class="pv-outline">{t('tools.pv.secondary')}</span>
      </div>
      <div class="cell">
        <span class="tl-label">{t('tools.pv.tag')}</span>
        <span class="pv-tag">{t('tools.pv.tagText')}</span>
      </div>
      <div class="cell">
        <span class="tl-label">{t('tools.pv.tab')}</span>
        <span class="pv-tab">{t('tools.pv.active')}</span>
      </div>
      <div class="cell">
        <span class="tl-label">{t('tools.pv.switch')}</span>
        <span class="pv-switch"><span class="knob"></span></span>
      </div>
      <div class="cell">
        <span class="tl-label">{t('tools.pv.soft')}</span>
        <span class="pv-soft">{t('tools.pv.tint')}</span>
      </div>
    </div>
  </Card>
</div>

<style>
  .pick {
    display: flex;
    gap: 14px;
    align-items: flex-start;
  }

  .chip {
    position: relative;
    flex: none;
    width: 64px;
    height: 64px;
    overflow: hidden;
    border: 1px solid var(--dn-border);
    border-radius: 16px;
    cursor: pointer;
  }

  .chip input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    padding: 0;
    cursor: pointer;
    opacity: 0;
  }

  .fields {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }

  .swatches {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .swatch {
    width: 26px;
    height: 26px;
    padding: 0;
    cursor: pointer;
    border: 2px solid transparent;
    border-radius: 50%;
    transition: transform var(--dn-duration) var(--dn-ease);
  }

  .swatch:hover {
    transform: scale(1.12);
  }

  .swatch.on {
    border-color: var(--vscode-foreground);
  }

  .derived {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .derived .dot {
    flex: none;
    width: 22px;
    height: 22px;
    border: 1px solid var(--dn-border);
    border-radius: 7px;
  }

  .derived .name {
    flex: none;
    width: 120px;
    color: var(--dn-muted);
    font-size: var(--dn-font-small);
  }

  .derived .control {
    flex: 1;
    min-width: 0;
  }

  .preview {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 10px;
  }

  .cell {
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: flex-start;
    min-height: 84px;
    padding: 12px;
    border: 1px solid var(--dn-divider);
    border-radius: 12px;
  }

  .pv-button {
    padding: 6px 14px;
    color: var(--t);
    background: var(--c);
    border-radius: 8px;
  }

  .pv-outline {
    padding: 5px 13px;
    color: var(--c);
    border: 1px solid var(--c);
    border-radius: 8px;
  }

  .pv-tag {
    padding: 2px 10px;
    color: var(--l);
    background: var(--s);
    border: 1px solid var(--b);
    border-radius: 12px;
    font-size: var(--dn-font-small);
  }

  .pv-tab {
    padding: 4px 2px;
    color: var(--l);
    border-bottom: 2px solid var(--c);
  }

  .pv-switch {
    display: inline-flex;
    width: 38px;
    height: 22px;
    padding: 3px;
    background: var(--c);
    border-radius: 11px;
  }

  .pv-switch .knob {
    width: 16px;
    height: 16px;
    margin-left: auto;
    background: var(--t);
    border-radius: 50%;
  }

  .pv-soft {
    padding: 8px 12px;
    color: var(--l);
    background: var(--s);
    border-left: 3px solid var(--c);
    border-radius: 8px;
  }
</style>

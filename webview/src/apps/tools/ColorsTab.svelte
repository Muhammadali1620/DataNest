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

  /** What the preview shows, in this order; each has `tools.pv.<name>` as its caption. */
  const SAMPLES = [
    'button',
    'outline',
    'disabled',
    'link',
    'tag',
    'border',
    'background',
    'icon',
    'tab',
    'list',
    'badge',
    'switch',
    'input',
    'checks',
    'progress',
    'alert',
    'tooltip',
    'card',
    'row',
    'code',
  ] as const;

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
      {#each SAMPLES as sample (sample)}
        <div class="cell" data-testid={`pv-${sample}`}>
          <span class="tl-label">{t(`tools.pv.${sample}` as 'tools.pv.button')}</span>
          {#if sample === 'button'}
            <span class="pv-button">{t('tools.pv.primary')}</span>
          {:else if sample === 'outline'}
            <span class="pv-outline">{t('tools.pv.secondary')}</span>
          {:else if sample === 'disabled'}
            <span class="pv-disabled">{t('tools.pv.disabledText')}</span>
          {:else if sample === 'link'}
            <span class="pv-link">{t('tools.pv.linkText')}</span>
          {:else if sample === 'tag'}
            <span class="pv-tag">{t('tools.pv.tagText')}</span>
          {:else if sample === 'border'}
            <span class="pv-border">{t('tools.pv.focusBorder')}</span>
          {:else if sample === 'background'}
            <span class="pv-soft">{t('tools.pv.tint')}</span>
          {:else if sample === 'icon'}
            <span class="pv-icon"><Icon name="database" size={15} />{t('tools.pv.iconText')}</span>
          {:else if sample === 'tab'}
            <span class="pv-tab">{t('tools.pv.active')}</span>
          {:else if sample === 'list'}
            <span class="pv-list">{t('tools.pv.listItem')}</span>
          {:else if sample === 'badge'}
            <span class="pv-badge"><span class="dot"></span>{t('tools.pv.statusBadge')}</span>
          {:else if sample === 'switch'}
            <span class="pv-switches">
              <span class="pv-switch"><span class="knob"></span></span>
              <span class="pv-switch off"><span class="knob"></span></span>
            </span>
          {:else if sample === 'input'}
            <span class="pv-input">{t('tools.pv.inputText')}</span>
          {:else if sample === 'checks'}
            <span class="pv-checks"><span class="box"><Icon name="check" size={11} /></span><span class="radio"></span></span>
          {:else if sample === 'progress'}
            <span class="pv-progress"><span class="bar"></span></span>
          {:else if sample === 'alert'}
            <span class="pv-alert"><Icon name="info" size={14} />{t('tools.pv.alertText')}</span>
          {:else if sample === 'tooltip'}
            <span class="pv-tooltip">{t('tools.pv.tooltipText')}</span>
          {:else if sample === 'card'}
            <span class="pv-card"><strong>{t('tools.pv.cardTitle')}</strong><span class="line"></span></span>
          {:else if sample === 'row'}
            <span class="pv-row"><span>{t('tools.pv.rowText')}</span><span class="pv-tag">12</span></span>
          {:else}
            <span class="pv-code">{toHex(color)}</span>
          {/if}
        </div>
      {/each}
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

  .pv-disabled {
    padding: 6px 14px;
    color: var(--t);
    background: var(--c);
    border-radius: 8px;
    opacity: 0.4;
  }

  .pv-link {
    color: var(--l);
    text-decoration: underline;
  }

  .pv-tag {
    padding: 2px 10px;
    color: var(--l);
    background: var(--s);
    border: 1px solid var(--b);
    border-radius: 12px;
    font-size: var(--dn-font-small);
  }

  .pv-border {
    padding: 6px 12px;
    border: 2px solid var(--c);
    border-radius: 8px;
    box-shadow: 0 0 0 3px var(--b);
  }

  .pv-soft {
    padding: 8px 12px;
    color: var(--l);
    background: var(--s);
    border-left: 3px solid var(--c);
    border-radius: 8px;
  }

  .pv-icon {
    display: inline-flex;
    gap: 6px;
    align-items: center;
    color: var(--l);
  }

  .pv-tab {
    padding: 4px 2px;
    color: var(--l);
    border-bottom: 2px solid var(--c);
  }

  .pv-list {
    color: var(--l);
    width: 100%;
    padding: 6px 10px;
    background: var(--sh);
    border-left: 3px solid var(--c);
    border-radius: 6px;
  }

  .pv-badge {
    color: var(--l);
    display: inline-flex;
    gap: 6px;
    align-items: center;
    padding: 2px 10px;
    background: var(--s);
    border-radius: 12px;
    font-size: var(--dn-font-small);
  }

  .pv-badge .dot {
    width: 8px;
    height: 8px;
    background: var(--c);
    border-radius: 50%;
  }

  .pv-switches {
    display: inline-flex;
    gap: 8px;
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

  .pv-switch.off {
    background: var(--sh);
    border: 1px solid var(--b);
  }

  .pv-switch.off .knob {
    margin-left: 0;
    background: var(--l);
  }

  .pv-input {
    width: 100%;
    padding: 5px 10px;
    color: var(--l);
    background: var(--s);
    border: 1px solid var(--c);
    border-radius: 8px;
  }

  .pv-checks {
    display: inline-flex;
    gap: 12px;
    align-items: center;
  }

  .pv-checks .box {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    color: var(--t);
    background: var(--c);
    border-radius: 5px;
  }

  .pv-checks .radio {
    width: 18px;
    height: 18px;
    background: radial-gradient(circle, var(--c) 0 38%, transparent 42%);
    border: 2px solid var(--c);
    border-radius: 50%;
  }

  .pv-progress {
    display: block;
    width: 100%;
    height: 8px;
    overflow: hidden;
    background: var(--sh);
    border-radius: 4px;
  }

  .pv-progress .bar {
    display: block;
    width: 62%;
    height: 100%;
    background: linear-gradient(90deg, var(--a), var(--c));
    border-radius: 4px;
  }

  .pv-alert {
    display: flex;
    gap: 8px;
    align-items: center;
    width: 100%;
    padding: 8px 10px;
    color: var(--l);
    background: var(--s);
    border: 1px solid var(--b);
    border-radius: 8px;
    font-size: var(--dn-font-small);
  }

  .pv-tooltip {
    padding: 4px 9px;
    color: var(--t);
    background: var(--a);
    border-radius: 6px;
    font-size: var(--dn-font-small);
  }

  .pv-card {
    color: var(--l);
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 100%;
    padding: 8px 10px;
    background: var(--s);
    border: 1px solid var(--b);
    border-top: 3px solid var(--c);
    border-radius: 8px;
  }

  .pv-card .line {
    display: block;
    width: 70%;
    height: 6px;
    background: var(--sh);
    border-radius: 3px;
  }

  .pv-row {
    display: flex;
    gap: 8px;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 4px 8px;
    border-bottom: 1px solid var(--b);
  }

  .pv-code {
    padding: 2px 8px;
    color: var(--l);
    background: var(--s);
    border-radius: 6px;
    font-family: var(--dn-mono);
    font-size: var(--dn-font-small);
  }
</style>

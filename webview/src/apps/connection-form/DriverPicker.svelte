<script lang="ts">
  import { tick } from 'svelte';
  import type { DriverChoice } from './driver-choices';

  interface Props {
    /** The databases, then the compatible servers, each with its own value. */
    choices: readonly DriverChoice[];
    /** The chosen value: a driver id or `preset:<id>`. */
    value: string;
    /** Names the group for screen readers. */
    label: string;
    /** Heading of the compatible servers. */
    compatibleLabel: string;
    onChange: (value: string) => void;
  }

  const { choices, value, label, compatibleLabel, onChange }: Props = $props();

  let group = $state<HTMLDivElement | undefined>(undefined);

  const drivers = $derived(choices.filter((choice) => !choice.compatible));
  const compatible = $derived(choices.filter((choice) => choice.compatible));
  /** The chosen card is the one Tab stops at; with none chosen, the first. */
  const tabStop = $derived(
    choices.some((choice) => choice.value === value) ? value : (choices[0]?.value ?? ''),
  );

  async function select(next: string): Promise<void> {
    if (next !== value) {
      onChange(next);
    }
    await tick();
    group?.querySelector<HTMLElement>(`[data-value="${CSS.escape(next)}"]`)?.focus();
  }

  /** Arrows move the choice like any radio group; Home and End go to the ends. */
  function onKey(event: KeyboardEvent): void {
    const index = choices.findIndex((choice) => choice.value === value);
    const step: Readonly<Record<string, number>> = {
      ArrowRight: 1,
      ArrowDown: 1,
      ArrowLeft: -1,
      ArrowUp: -1,
    };
    let next: number | undefined;
    if (event.key in step) {
      next = (Math.max(index, 0) + (step[event.key] ?? 0) + choices.length) % choices.length;
    } else if (event.key === 'Home') {
      next = 0;
    } else if (event.key === 'End') {
      next = choices.length - 1;
    }
    const choice = next === undefined ? undefined : choices[next];
    if (choice !== undefined) {
      event.preventDefault();
      void select(choice.value);
    }
  }
</script>

{#snippet card(choice: DriverChoice)}
  <button
    type="button"
    role="radio"
    class="card-choice"
    class:compatible={choice.compatible}
    aria-checked={choice.value === value}
    tabindex={choice.value === tabStop ? 0 : -1}
    data-value={choice.value}
    title={choice.hint}
    onclick={() => {
      void select(choice.value);
    }}
  >
    <!-- The mark is drawn from an attribute, so the card's name is the database alone. -->
    <span class="mark {choice.tone}" aria-hidden="true" data-mark={choice.mark}></span>
    <span class="name">{choice.label}</span>
  </button>
{/snippet}

<div bind:this={group} class="picker" role="radiogroup" aria-label={label} tabindex="-1" onkeydown={onKey}>
  <div class="cards">
    {#each drivers as choice (choice.value)}
      {@render card(choice)}
    {/each}
  </div>
  {#if compatible.length > 0}
    <p class="group-label" aria-hidden="true">{compatibleLabel}</p>
    <div class="cards small">
      {#each compatible as choice (choice.value)}
        {@render card(choice)}
      {/each}
    </div>
  {/if}
</div>

<style>
  .picker {
    display: flex;
    flex-direction: column;
    gap: 8px;
    outline: none;
  }

  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(172px, 1fr));
    gap: 6px;
  }

  .cards.small {
    grid-template-columns: repeat(auto-fill, minmax(172px, 1fr));
  }

  .group-label {
    margin: 4px 0 0;
    color: var(--dn-muted);
    font-size: var(--dn-font-small);
  }

  .card-choice {
    display: flex;
    gap: 8px;
    align-items: center;
    min-width: 0;
    height: 38px;
    padding: 0 10px 0 6px;
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    border: 1px solid var(--dn-border);
    border-radius: var(--dn-radius-l);
    font-family: inherit;
    font-size: inherit;
    text-align: left;
    cursor: pointer;
    transition:
      border-color var(--dn-duration) var(--dn-ease),
      background-color var(--dn-duration) var(--dn-ease);
  }

  .card-choice.compatible {
    height: 32px;
  }

  .card-choice:hover {
    background: var(--vscode-list-hoverBackground);
  }

  .card-choice[aria-checked='true'] {
    background: var(--vscode-list-inactiveSelectionBackground, var(--dn-hover));
    border-color: var(--vscode-focusBorder);
    box-shadow: inset 0 0 0 1px var(--vscode-focusBorder);
  }

  .card-choice:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: 1px;
  }

  .mark {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    color: var(--tone);
    background: color-mix(in srgb, var(--tone) 16%, transparent);
    border-radius: 5px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: -0.2px;
  }

  .mark::before {
    content: attr(data-mark);
  }

  .compatible .mark {
    width: 22px;
    height: 22px;
    font-size: 10px;
  }

  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .blue {
    --tone: var(--vscode-charts-blue, #3794ff);
  }

  .green {
    --tone: var(--vscode-charts-green, #89d185);
  }

  .orange {
    --tone: var(--vscode-charts-orange, #d18616);
  }

  .red {
    --tone: var(--vscode-charts-red, #f14c4c);
  }

  .yellow {
    --tone: var(--vscode-charts-yellow, #cca700);
  }

  .purple {
    --tone: var(--vscode-charts-purple, #b180d7);
  }
</style>

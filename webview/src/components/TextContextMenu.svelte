<script lang="ts">
  import type { Translate } from '../lib/i18n';
  import ContextMenu from './ContextMenu.svelte';
  import type { ContextEntry } from './menu';
  import {
    copyableOf,
    isEditable,
    isTextBox,
    runCopyAction,
    runTextAction,
    selectedText,
    type TextAction,
    type TextBox,
  } from './text-menu';

  interface Props {
    /** Puts text on the clipboard (the host does it). */
    onCopy: (text: string) => void;
    /** Reads the clipboard (the host does it); undefined when it cannot. */
    readClipboard: () => Promise<string | undefined>;
    t: Translate;
  }

  const { onCopy, readClipboard, t }: Props = $props();

  /** Where the menu is and what it works on: a text box, or a block of read-only text. */
  let shown = $state<
    { x: number; y: number; box: TextBox; node?: undefined } | { x: number; y: number; node: HTMLElement; box?: undefined } | undefined
  >(undefined);

  function onContext(event: MouseEvent): void {
    if (isTextBox(event.target)) {
      event.preventDefault();
      shown = { x: event.clientX, y: event.clientY, box: event.target };
      return;
    }
    const node = copyableOf(event.target);
    if (node !== undefined) {
      event.preventDefault();
      shown = { x: event.clientX, y: event.clientY, node };
    }
  }

  const items = $derived.by((): ContextEntry<TextAction>[] => {
    if (shown === undefined) {
      return [];
    }
    const { box, node } = shown;
    if (box === undefined) {
      return [
        { id: 'copy', label: t('menu.copy'), icon: 'copy', tone: 'blue', keys: 'Ctrl+C' },
        {
          id: 'selectAll',
          label: t('menu.selectAll'),
          icon: 'list-selection',
          tone: 'purple',
          keys: 'Ctrl+A',
          separated: true,
          disabled: node.textContent === '',
        },
      ];
    }
    const editable = isEditable(box);
    const selection = selectedText(box) !== '';
    return [
      { id: 'cut', label: t('menu.cut'), icon: 'remove', tone: 'orange', keys: 'Ctrl+X', disabled: !editable || !selection },
      { id: 'copy', label: t('menu.copy'), icon: 'copy', tone: 'blue', keys: 'Ctrl+C', disabled: !selection },
      { id: 'paste', label: t('menu.paste'), icon: 'clippy', tone: 'green', keys: 'Ctrl+V', disabled: !editable },
      { id: 'selectAll', label: t('menu.selectAll'), icon: 'list-selection', tone: 'purple', keys: 'Ctrl+A', separated: true, disabled: box.value === '' },
      { id: 'undo', label: t('menu.undo'), icon: 'discard', tone: 'teal', keys: 'Ctrl+Z', separated: true, disabled: !editable },
      { id: 'redo', label: t('menu.redo'), icon: 'redo', tone: 'teal', keys: 'Ctrl+Y', disabled: !editable },
    ];
  });

  async function choose(action: TextAction): Promise<void> {
    const node = shown?.node;
    if (node !== undefined) {
      if (action === 'copy' || action === 'selectAll') {
        runCopyAction(node, action, { copy: onCopy });
      }
      return;
    }
    const box = shown?.box;
    if (box === undefined) {
      return;
    }
    const clipboard = action === 'paste' ? await readClipboard() : undefined;
    runTextAction(box, action, { copy: onCopy, clipboard });
  }
</script>

<svelte:document oncontextmenu={onContext} />

{#if shown !== undefined}
  <ContextMenu
    x={shown.x}
    y={shown.y}
    {items}
    label={t('menu.text')}
    focusFirst={false}
    onSelect={(action: TextAction) => {
      void choose(action);
    }}
    onClose={() => {
      const box = shown?.box;
      shown = undefined;
      box?.focus();
    }}
  />
{/if}

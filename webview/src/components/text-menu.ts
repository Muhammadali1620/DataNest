// What the right-click menu of a text box does: cut, copy, paste, select all, undo and
// redo. The browser's own menu is replaced so the page can draw icons and use the
// host's clipboard, which a webview may not read itself.

// `document.execCommand` is deprecated but is the only way to edit a box so that the browser's
// undo stack and the `input` event both keep working; every use has a plain fallback.
/* eslint-disable @typescript-eslint/no-deprecated */

export type TextAction = 'cut' | 'copy' | 'paste' | 'selectAll' | 'undo' | 'redo';

export type TextBox = HTMLInputElement | HTMLTextAreaElement;

/** Input kinds that hold text a person types; a colour or a check box has no such menu. */
const TEXT_KINDS = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'number', '']);

export function isTextBox(target: EventTarget | null): target is TextBox {
  if (target instanceof HTMLTextAreaElement) {
    return true;
  }
  return target instanceof HTMLInputElement && TEXT_KINDS.has(target.type);
}

/** The selected text of a box; empty when nothing is selected. */
export function selectedText(box: TextBox): string {
  const start = box.selectionStart ?? 0;
  const end = box.selectionEnd ?? 0;
  return box.value.slice(Math.min(start, end), Math.max(start, end));
}

export function isEditable(box: TextBox): boolean {
  return !box.readOnly && !box.disabled;
}

/** Puts text where the caret is, through the editor so undo still works. */
function insert(box: TextBox, text: string): void {
  box.focus();
  // `insertText` keeps the browser's undo stack and fires the `input` event bindings listen to.
  if (
    typeof document.execCommand === 'function' &&
    document.execCommand('insertText', false, text)
  ) {
    return;
  }
  const start = box.selectionStart ?? box.value.length;
  const end = box.selectionEnd ?? start;
  box.setRangeText(text, start, end, 'end');
  box.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * Runs an action on a box. `copy` is how text reaches the clipboard (through the host);
 * `clipboard` is what to paste.
 */
export function runTextAction(
  box: TextBox,
  action: TextAction,
  io: { copy: (text: string) => void; clipboard?: string | undefined },
): void {
  box.focus();
  switch (action) {
    case 'copy':
      io.copy(selectedText(box));
      break;
    case 'cut': {
      const text = selectedText(box);
      if (text !== '' && isEditable(box)) {
        io.copy(text);
        insert(box, '');
      }
      break;
    }
    case 'paste':
      if (io.clipboard !== undefined && io.clipboard !== '' && isEditable(box)) {
        insert(box, io.clipboard);
      }
      break;
    case 'selectAll':
      box.select();
      break;
    case 'undo':
    case 'redo':
      if (typeof document.execCommand === 'function') {
        document.execCommand(action);
      }
      break;
  }
}

/** Attribute that marks read-only text (a value shown in a `<pre>`) as having the copy menu. */
export const COPY_MENU_ATTRIBUTE = 'data-copy-menu';

/** The read-only text block a right click landed in, if it is one that has the copy menu. */
export function copyableOf(target: EventTarget | null): HTMLElement | undefined {
  if (!(target instanceof Element)) {
    return undefined;
  }
  const found = target.closest(`[${COPY_MENU_ATTRIBUTE}]`);
  return found instanceof HTMLElement ? found : undefined;
}

/** The part of a text block the person selected; empty when the selection is elsewhere. */
export function selectedIn(node: HTMLElement): string {
  const selection = document.getSelection();
  if (selection === null || selection.isCollapsed || !node.contains(selection.anchorNode)) {
    return '';
  }
  return selection.toString();
}

/** Copy takes the selection, or the whole text when nothing is selected; select-all marks it. */
export function runCopyAction(
  node: HTMLElement,
  action: 'copy' | 'selectAll',
  io: { copy: (text: string) => void },
): void {
  if (action === 'copy') {
    const selected = selectedIn(node);
    io.copy(selected === '' ? node.textContent : selected);
    return;
  }
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

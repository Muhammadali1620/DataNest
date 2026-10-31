// Puts a popover under the element it belongs to without letting it leave the page: a
// panel wider than the room beside its button used to be cut off by the page's edge.

export interface Box {
  readonly left: number;
  readonly right: number;
  readonly bottom: number;
}

export interface Placement {
  readonly left: number;
  readonly top: number;
  readonly maxHeight: number;
}

const MARGIN = 8;
const GAP = 6;

/** Where a popover of `width` goes: right-aligned with its anchor, kept inside the viewport. */
export function placePopover(
  anchor: Box,
  width: number,
  viewport: { readonly width: number; readonly height: number },
): Placement {
  const widest = Math.max(0, viewport.width - 2 * MARGIN);
  const used = Math.min(width, widest);
  const left = Math.max(MARGIN, Math.min(anchor.right - used, viewport.width - used - MARGIN));
  const top = anchor.bottom + GAP;
  return { left, top, maxHeight: Math.max(120, viewport.height - top - MARGIN) };
}

/** Svelte action: fixes the node under its parent and keeps it there on resize. */
export function anchorBelow(node: HTMLElement): { destroy: () => void } {
  const place = (): void => {
    const parent = node.parentElement;
    if (parent === null) {
      return;
    }
    const rect = parent.getBoundingClientRect();
    const spot = placePopover(rect, node.offsetWidth, {
      width: window.innerWidth,
      height: window.innerHeight,
    });
    node.style.position = 'fixed';
    node.style.left = `${spot.left}px`;
    node.style.top = `${spot.top}px`;
    node.style.right = 'auto';
    node.style.maxHeight = `${spot.maxHeight}px`;
  };
  place();
  window.addEventListener('resize', place);
  return {
    destroy: () => {
      window.removeEventListener('resize', place);
    },
  };
}

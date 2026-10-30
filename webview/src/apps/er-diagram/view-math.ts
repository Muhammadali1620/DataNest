// Panning and zooming the ER diagram (V8.1): the picture is drawn at `zoom` and
// shifted by `x`, `y` screen pixels.

export interface View {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export const ZOOM_LIMITS = { min: 0.1, max: 3 } as const;

const MARGIN = 20;

export function clampZoom(view: View): View {
  return { ...view, zoom: Math.min(ZOOM_LIMITS.max, Math.max(ZOOM_LIMITS.min, view.zoom)) };
}

/** Zooms keeping the point under the cursor (`cx`, `cy` on screen) where it is. */
export function zoomAt(view: View, zoom: number, cx: number, cy: number): View {
  const next = clampZoom({ ...view, zoom }).zoom;
  const worldX = (cx - view.x) / view.zoom;
  const worldY = (cy - view.y) / view.zoom;
  return { x: cx - worldX * next, y: cy - worldY * next, zoom: next };
}

/** Shows all of `bounds` in a screen of `width` × `height`, never larger than life. */
export function fitView(
  bounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  },
  width: number,
  height: number,
): View {
  if (width <= MARGIN * 2 || height <= MARGIN * 2 || bounds.width <= 0 || bounds.height <= 0) {
    return { x: MARGIN - bounds.x, y: MARGIN - bounds.y, zoom: 1 };
  }
  const zoom = clampZoom({
    x: 0,
    y: 0,
    zoom: Math.min(1, (width - MARGIN * 2) / bounds.width, (height - MARGIN * 2) / bounds.height),
  }).zoom;
  return {
    x: (width - bounds.width * zoom) / 2 - bounds.x * zoom,
    y: Math.max(MARGIN, (height - bounds.height * zoom) / 2) - bounds.y * zoom,
    zoom,
  };
}

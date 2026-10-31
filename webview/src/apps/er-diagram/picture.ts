// Turns the exported SVG into a PNG in the page (V8.1): the browser draws the SVG on
// a canvas, so no image library is needed. Canvases have a size limit, so a huge
// diagram is drawn at a smaller scale rather than failing.

/** Chromium refuses canvases with a side longer than this. */
const MAX_SIDE = 16_000;
/** …or with more pixels than this. */
const MAX_PIXELS = 120_000_000;

/** The scale that fits a picture of this size into a canvas, at most `wanted`. */
export function pngScale(width: number, height: number, wanted = 2): number {
  if (width <= 0 || height <= 0) {
    return wanted;
  }
  const bySide = MAX_SIDE / Math.max(width, height);
  const byArea = Math.sqrt(MAX_PIXELS / (width * height));
  return Math.min(wanted, bySide, byArea);
}

/** A PNG of the SVG as base64, without the `data:` prefix. */
export async function svgToPng(svg: string, width: number, height: number): Promise<string> {
  const scale = pngScale(width, height);
  const image = new Image();
  const loaded = new Promise<void>((resolve, reject) => {
    image.onload = () => {
      resolve();
    };
    image.onerror = () => {
      reject(new Error('The diagram could not be drawn as a picture'));
    };
  });
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await loaded;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext('2d');
  if (context === null) {
    throw new Error('The diagram could not be drawn as a picture');
  }
  context.scale(scale, scale);
  context.drawImage(image, 0, 0, width, height);
  return canvas.toDataURL('image/png').replace(/^data:[^,]*,/u, '');
}

/** Text width with the editor font; results are kept, because boxes repeat type names. */
export function canvasMeasure(font: string): (text: string, bold?: boolean) => number {
  const context = document.createElement('canvas').getContext('2d');
  const cache = new Map<string, number>();
  return (text, bold = false) => {
    const key = `${bold ? 'b' : 'n'}${text}`;
    const known = cache.get(key);
    if (known !== undefined) {
      return known;
    }
    let width = text.length * (bold ? 7.8 : 7.2);
    if (context !== null) {
      context.font = `${bold ? 'bold ' : ''}12px ${font}`;
      width = context.measureText(text).width;
    }
    cache.set(key, width);
    return width;
  };
}

/**
 * A CSS colour (a theme variable, a `color-mix()`) as plain `rgb()`, so a saved picture
 * needs no variables and any viewer draws it. The browser resolves the colour on a
 * hidden element inside `host` (whose own variables it sees) and paints one pixel with
 * it; `fallback` stands in where it cannot.
 */
export function cssColor(css: string, fallback: string, host: Element = document.body): string {
  const probe = document.createElement('span');
  probe.style.display = 'none';
  probe.style.color = css;
  host.append(probe);
  const computed = getComputedStyle(probe).color;
  probe.remove();
  if (probe.style.color === '' || computed === '') {
    return fallback;
  }
  const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (context === null) {
    return computed;
  }
  context.clearRect(0, 0, 1, 1);
  context.fillStyle = computed;
  context.fillRect(0, 0, 1, 1);
  const [red = 0, green = 0, blue = 0, alpha = 255] = context.getImageData(0, 0, 1, 1).data;
  return alpha === 255
    ? `rgb(${red}, ${green}, ${blue})`
    : `rgba(${red}, ${green}, ${blue}, ${Math.round((alpha / 255) * 1000) / 1000})`;
}

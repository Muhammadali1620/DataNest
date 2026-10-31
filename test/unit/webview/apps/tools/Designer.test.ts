import { cleanup, fireEvent, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flush } from '../../../../helpers/rpc';
import { fakeImages, field, openTools, pointer } from '../../../../helpers/webview/tools-page';

afterEach(cleanup);

interface Designer {
  readonly canvas: HTMLElement;
  readonly copied: ReturnType<typeof vi.fn>;
  readonly saveFile: ReturnType<typeof vi.fn>;
}

async function openDesigner(over: Parameters<typeof openTools>[0] = {}): Promise<Designer> {
  const opened = await openTools({ tab: 'Image', ...over });
  await fireEvent.click(screen.getByTestId('mode-designer'));
  const canvas = screen.getByTestId('des-canvas');
  // jsdom lays nothing out: the canvas is 480 × 320 at the top left, one pixel a unit.
  Object.defineProperty(canvas, 'getBoundingClientRect', {
    value: () => ({
      left: 0,
      top: 0,
      width: 480,
      height: 320,
      right: 480,
      bottom: 320,
      x: 0,
      y: 0,
    }),
  });
  return { canvas, copied: opened.copied, saveFile: opened.saveFile };
}

async function tool(name: string): Promise<void> {
  await fireEvent.click(screen.getByTestId(`des-tool-${name}`));
}

async function drag(
  target: Element,
  from: [number, number],
  to: [number, number],
  init: { shiftKey?: boolean } = {},
): Promise<void> {
  await fireEvent(target, pointer('pointerdown', { clientX: from[0], clientY: from[1], ...init }));
  await fireEvent(target, pointer('pointermove', { clientX: to[0], clientY: to[1], ...init }));
  await fireEvent(target, pointer('pointerup', { clientX: to[0], clientY: to[1], ...init }));
}

async function click(target: Element, at: [number, number]): Promise<void> {
  await fireEvent(target, pointer('pointerdown', { clientX: at[0], clientY: at[1] }));
  await fireEvent(target, pointer('pointerup', { clientX: at[0], clientY: at[1] }));
}

/** The drawing as SVG text, the way "Copy SVG" hands it out. */
async function drawing(copied: ReturnType<typeof vi.fn>): Promise<string> {
  await fireEvent.click(screen.getByTestId('des-copy'));
  await flush();
  return (copied.mock.calls.at(-1)?.[0] as { text: string }).text;
}

const layers = (): string[] =>
  [...screen.queryAllByTestId(/^des-layer-/u)].map((layer) => layer.textContent.trim());

async function drawRect(
  canvas: HTMLElement,
  from: [number, number] = [10, 20],
  to: [number, number] = [110, 70],
): Promise<void> {
  await tool('rect');
  await drag(canvas, from, to);
}

describe('Designer', () => {
  it('opens empty on the select tool', async () => {
    await openDesigner();
    expect(screen.getByTestId('des-tool-select').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('Nothing drawn yet')).toBeTruthy();
    expect(screen.getByTestId<HTMLButtonElement>('des-undo').disabled).toBe(true);
    expect(screen.getByTestId<HTMLButtonElement>('des-delete').disabled).toBe(true);
    expect(screen.getByTestId('des-canvas').getAttribute('aria-describedby')).toBe(
      'tools-des-help',
    );
  });

  it('draws a rectangle by dragging, selects it and goes back to selecting', async () => {
    const { canvas, copied } = await openDesigner();
    await drawRect(canvas);
    expect(layers()).toEqual(['Rectangle 1']);
    expect(screen.getByTestId('des-layer-s1').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('des-tool-select').getAttribute('aria-pressed')).toBe('true');
    expect(await drawing(copied)).toContain('<rect id="s1" x="10" y="20" width="100" height="50"');
    expect(screen.getByTestId('des-handle-se')).toBeTruthy();
  });

  it('draws in any direction, and a square with Shift', async () => {
    const { canvas, copied } = await openDesigner();
    await tool('rect');
    await drag(canvas, [110, 70], [10, 20]);
    expect(await drawing(copied)).toContain('x="10" y="20" width="100" height="50"');
    await tool('rect');
    await drag(canvas, [200, 100], [260, 110], { shiftKey: true });
    expect(await drawing(copied)).toContain('x="200" y="100" width="60" height="60"');
  });

  it('draws circles, ellipses and lines', async () => {
    const { canvas, copied } = await openDesigner();
    await tool('circle');
    await drag(canvas, [50, 50], [90, 70]);
    await tool('ellipse');
    await drag(canvas, [100, 50], [160, 90]);
    await tool('line');
    await drag(canvas, [10, 200], [200, 220]);
    const svg = await drawing(copied);
    expect(svg).toContain('<circle id="s1" cx="70" cy="60" r="20"');
    expect(svg).toContain('<ellipse id="s2" cx="130" cy="70" rx="30" ry="20"');
    expect(svg).toContain('<line id="s3" x1="10" y1="200" x2="200" y2="220"');
    expect(layers()).toEqual(['Line 3', 'Ellipse 2', 'Circle 1']);
  });

  it('draws nothing for a click without a drag', async () => {
    const { canvas } = await openDesigner();
    await tool('rect');
    await click(canvas, [40, 40]);
    expect(layers()).toEqual([]);
    expect(screen.getByTestId('des-tool-select').getAttribute('aria-pressed')).toBe('true');
  });

  it('adds text with a click and edits its words and size', async () => {
    const { canvas, copied } = await openDesigner();
    await tool('text');
    await fireEvent(canvas, pointer('pointerdown', { clientX: 50, clientY: 60 }));
    expect(layers()).toEqual(['Text “Text”']);
    await fireEvent.input(field('des-text'), { target: { value: 'Hello <b>' } });
    await fireEvent.input(field('des-font'), { target: { value: '40' } });
    const svg = await drawing(copied);
    expect(svg).toContain('>Hello &lt;b&gt;</text>');
    expect(svg).toContain('font-size="40"');
    expect(layers()).toEqual(['Text “Hello <b>”']);
  });

  it('draws a path with the pen: Enter finishes a line, Shift+Enter a polygon, a click on the first point closes it', async () => {
    const { canvas, copied } = await openDesigner();
    await tool('path');
    await click(canvas, [10, 10]);
    await click(canvas, [100, 10]);
    await fireEvent.keyDown(canvas, { key: 'Enter' });
    expect(await drawing(copied)).toContain('<polyline id="s1" points="10,10 100,10"');
    await tool('path');
    for (const at of [
      [10, 100],
      [100, 100],
      [100, 200],
    ] as [number, number][]) {
      await click(canvas, at);
    }
    await fireEvent.keyDown(canvas, { key: 'Enter', shiftKey: true });
    expect(await drawing(copied)).toContain('<polygon id="s2" points="10,100 100,100 100,200"');
    await tool('path');
    for (const at of [
      [200, 10],
      [300, 10],
      [300, 100],
      [202, 12],
    ] as [number, number][]) {
      await click(canvas, at);
    }
    expect(await drawing(copied)).toContain('<polygon id="s3" points="200,10 300,10 300,100"');
    await tool('path');
    for (const at of [
      [300, 200],
      [350, 200],
      [350, 250],
    ] as [number, number][]) {
      await click(canvas, at);
    }
    await fireEvent.dblClick(canvas);
    expect(await drawing(copied)).toContain('<polyline id="s4"');
  });

  it('drops a path that has fewer than two points, and Escape cancels one', async () => {
    const { canvas } = await openDesigner();
    await tool('path');
    await click(canvas, [10, 10]);
    await fireEvent.keyDown(canvas, { key: 'Enter' });
    expect(layers()).toEqual([]);
    await tool('path');
    await click(canvas, [10, 10]);
    await click(canvas, [50, 50]);
    await fireEvent.keyDown(canvas, { key: 'Escape' });
    expect(layers()).toEqual([]);
    expect(screen.getByTestId('des-tool-select').getAttribute('aria-pressed')).toBe('true');
  });

  it('selects with a click, adds with Shift and clears on empty space', async () => {
    const { canvas } = await openDesigner();
    await drawRect(canvas, [10, 10], [60, 60]);
    await drawRect(canvas, [200, 10], [260, 60]);
    await click(canvas, [30, 30]);
    expect(screen.getByTestId('des-layer-s1').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('des-layer-s2').getAttribute('aria-pressed')).toBe('false');
    await fireEvent(canvas, pointer('pointerdown', { clientX: 230, clientY: 30, shiftKey: true }));
    await fireEvent(canvas, pointer('pointerup', { clientX: 230, clientY: 30 }));
    expect(screen.getByTestId('des-layer-s2').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('des-layer-s1').getAttribute('aria-pressed')).toBe('true');
    await fireEvent(canvas, pointer('pointerdown', { clientX: 30, clientY: 30, shiftKey: true }));
    await fireEvent(canvas, pointer('pointerup', { clientX: 30, clientY: 30 }));
    expect(screen.getByTestId('des-layer-s1').getAttribute('aria-pressed')).toBe('false');
    await click(canvas, [400, 300]);
    expect(screen.getByTestId('des-layer-s2').getAttribute('aria-pressed')).toBe('false');
    // no handles without exactly one selected shape
    expect(screen.queryByTestId('des-handle-se')).toBeNull();
  });

  it('moves the selection by dragging it, as one step', async () => {
    const { canvas, copied } = await openDesigner();
    await drawRect(canvas, [10, 10], [60, 60]);
    await drag(canvas, [30, 30], [80, 50]);
    expect(await drawing(copied)).toContain('x="60" y="30" width="50" height="50"');
    await fireEvent.click(screen.getByTestId('des-undo'));
    expect(await drawing(copied)).toContain('x="10" y="10"');
  });

  it('moves the selection with the arrow keys, ten at a time with Shift', async () => {
    const { canvas, copied } = await openDesigner();
    await drawRect(canvas, [10, 10], [60, 60]);
    await fireEvent.keyDown(canvas, { key: 'ArrowRight' });
    await fireEvent.keyDown(canvas, { key: 'ArrowRight' });
    await fireEvent.keyDown(canvas, { key: 'ArrowDown', shiftKey: true });
    expect(await drawing(copied)).toContain('x="12" y="20"');
    expect(screen.getByTestId('des-announce').textContent).toContain('0, 10');
    await fireEvent.keyDown(canvas, { key: 'ArrowLeft' });
    // nudges in a row are one undo step
    await fireEvent.click(screen.getByTestId('des-undo'));
    expect(await drawing(copied)).toContain('x="10" y="10"');
  });

  it('resizes with a handle', async () => {
    const { canvas, copied } = await openDesigner();
    await drawRect(canvas, [10, 10], [110, 60]);
    await drag(screen.getByTestId('des-handle-se'), [110, 60], [140, 70]);
    expect(await drawing(copied)).toContain('x="10" y="10" width="130" height="60"');
    await drag(screen.getByTestId('des-handle-w'), [10, 40], [30, 40]);
    expect(await drawing(copied)).toContain('x="30" y="10" width="110" height="60"');
    await drag(screen.getByTestId('des-handle-n'), [80, 10], [80, 30]);
    expect(await drawing(copied)).toContain('y="30" width="110" height="40"');
  });

  it('keeps the proportions when Shift is held on a corner', async () => {
    const { canvas, copied } = await openDesigner();
    await drawRect(canvas, [10, 10], [110, 60]);
    await drag(screen.getByTestId('des-handle-se'), [110, 60], [210, 60], { shiftKey: true });
    expect(await drawing(copied)).toContain('width="200" height="100"');
  });

  it('rotates with the rotate handle, in steps of 15° with Shift', async () => {
    const { canvas, copied } = await openDesigner();
    await drawRect(canvas, [100, 100], [200, 200]);
    // the middle is (150,150); straight right of it is 90°
    await drag(screen.getByTestId('des-handle-rotate'), [150, 70], [300, 150]);
    expect(await drawing(copied)).toContain('transform="rotate(90 150 150)"');
    expect(field('des-rotation').value).toBe('90');
    await drag(screen.getByTestId('des-handle-rotate'), [150, 70], [300, 190], { shiftKey: true });
    expect(await drawing(copied)).toMatch(/rotate\((?:105|120) 150 150\)/u);
  });

  it('undoes and redoes with the buttons and the keys', async () => {
    const { canvas } = await openDesigner();
    await drawRect(canvas);
    expect(layers()).toHaveLength(1);
    await fireEvent.click(screen.getByTestId('des-undo'));
    expect(layers()).toHaveLength(0);
    await fireEvent.click(screen.getByTestId('des-redo'));
    expect(layers()).toHaveLength(1);
    await fireEvent.keyDown(canvas, { key: 'z', ctrlKey: true });
    expect(layers()).toHaveLength(0);
    await fireEvent.keyDown(canvas, { key: 'y', ctrlKey: true });
    expect(layers()).toHaveLength(1);
    await fireEvent.keyDown(canvas, { key: 'z', ctrlKey: true });
    await fireEvent.keyDown(canvas, { key: 'Z', ctrlKey: true, shiftKey: true });
    expect(layers()).toHaveLength(1);
  });

  it('duplicates, selects all and deletes', async () => {
    const { canvas } = await openDesigner();
    await drawRect(canvas, [10, 10], [60, 60]);
    await fireEvent.click(screen.getByTestId('des-duplicate'));
    expect(layers()).toHaveLength(2);
    expect(screen.getByTestId('des-layer-s2').getAttribute('aria-pressed')).toBe('true');
    await fireEvent.keyDown(canvas, { key: 'd', ctrlKey: true });
    expect(layers()).toHaveLength(3);
    await fireEvent.keyDown(canvas, { key: 'a', ctrlKey: true });
    expect(
      ['s1', 's2', 's3'].every(
        (id) => screen.getByTestId(`des-layer-${id}`).getAttribute('aria-pressed') === 'true',
      ),
    ).toBe(true);
    await fireEvent.keyDown(canvas, { key: 'Delete' });
    expect(layers()).toHaveLength(0);
    await fireEvent.keyDown(canvas, { key: 'Delete' });
    await fireEvent.keyDown(canvas, { key: 'd', ctrlKey: true });
    expect(layers()).toHaveLength(0);
  });

  it('removes the selection with the button, and Escape clears it', async () => {
    const { canvas } = await openDesigner();
    await drawRect(canvas);
    await fireEvent.keyDown(canvas, { key: 'Escape' });
    expect(screen.getByTestId('des-layer-s1').getAttribute('aria-pressed')).toBe('false');
    await fireEvent.click(screen.getByTestId('des-layer-s1'));
    await fireEvent.click(screen.getByTestId('des-delete'));
    expect(layers()).toEqual([]);
  });

  it('reorders layers', async () => {
    const { canvas } = await openDesigner();
    await drawRect(canvas, [10, 10], [60, 60]);
    await drawRect(canvas, [100, 10], [160, 60]);
    await drawRect(canvas, [200, 10], [260, 60]);
    expect(layers()).toEqual(['Rectangle 3', 'Rectangle 2', 'Rectangle 1']);
    await fireEvent.click(screen.getByTestId('des-layer-s1'));
    await fireEvent.click(screen.getByTestId('des-order-front'));
    expect(layers().map((name) => name.replace(/\d/u, ''))).toHaveLength(3);
    const order = (): string[] =>
      screen.queryAllByTestId(/^des-layer-/u).map((el) => el.getAttribute('data-testid') ?? '');
    expect(order()).toEqual(['des-layer-s1', 'des-layer-s3', 'des-layer-s2']);
    await fireEvent.click(screen.getByTestId('des-order-back'));
    expect(order()).toEqual(['des-layer-s3', 'des-layer-s2', 'des-layer-s1']);
    await fireEvent.click(screen.getByTestId('des-order-forward'));
    expect(order()).toEqual(['des-layer-s3', 'des-layer-s1', 'des-layer-s2']);
    await fireEvent.click(screen.getByTestId('des-order-backward'));
    expect(order()).toEqual(['des-layer-s3', 'des-layer-s2', 'des-layer-s1']);
  });

  it('picks layers from the list, with Shift to add', async () => {
    const { canvas } = await openDesigner();
    await drawRect(canvas, [10, 10], [60, 60]);
    await drawRect(canvas, [100, 10], [160, 60]);
    await fireEvent.click(screen.getByTestId('des-layer-s1'));
    expect(screen.getByTestId('des-layer-s2').getAttribute('aria-pressed')).toBe('false');
    await fireEvent.click(screen.getByTestId('des-layer-s2'), { shiftKey: true });
    expect(screen.getByTestId('des-layer-s1').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('des-layer-s2').getAttribute('aria-pressed')).toBe('true');
    await fireEvent.click(screen.getByTestId('des-layer-s2'), { shiftKey: true });
    expect(screen.getByTestId('des-layer-s2').getAttribute('aria-pressed')).toBe('false');
  });

  it('restyles the selection, and what is drawn next', async () => {
    const { canvas, copied } = await openDesigner();
    await drawRect(canvas, [10, 10], [60, 60]);
    await fireEvent.input(field('des-fill'), { target: { value: '#ff0000' } });
    await fireEvent.input(field('des-stroke'), { target: { value: '#00ff00' } });
    await fireEvent.input(field('des-width'), { target: { value: '6' } });
    await fireEvent.input(field('des-opacity'), { target: { value: '50' } });
    let svg = await drawing(copied);
    expect(svg).toContain('fill="#ff0000" stroke="#00ff00" stroke-width="6" opacity="0.5"');
    // a colour dragged is one step, so one undo takes the four changes back
    await fireEvent.click(screen.getByTestId('des-nofill'));
    expect(await drawing(copied)).toContain('fill="none"');
    await fireEvent.click(screen.getByTestId('des-nostroke'));
    svg = await drawing(copied);
    expect(svg).not.toContain('stroke=');
    await fireEvent.click(screen.getByTestId('des-nofill'));
    await fireEvent.click(screen.getByTestId('des-nostroke'));
    await fireEvent.keyDown(canvas, { key: 'Escape' });
    await drawRect(canvas, [200, 10], [260, 60]);
    expect(await drawing(copied)).toMatch(
      /<rect id="s2"[^>]*fill="#ff0000" stroke="#00ff00" stroke-width="6" opacity="0.5"/u,
    );
  });

  it('joins fast changes of one kind into one undo step', async () => {
    const { canvas, copied } = await openDesigner();
    await drawRect(canvas, [10, 10], [60, 60]);
    for (const colour of ['#111111', '#222222', '#333333']) {
      await fireEvent.input(field('des-fill'), { target: { value: colour } });
    }
    expect(await drawing(copied)).toContain('fill="#333333"');
    await fireEvent.click(screen.getByTestId('des-undo'));
    expect(await drawing(copied)).toContain('fill="#409eff"');
  });

  it('edits the box, the angle and the corners of the selected shape', async () => {
    const { canvas, copied } = await openDesigner();
    await drawRect(canvas, [10, 10], [60, 60]);
    await fireEvent.input(field('des-box-x'), { target: { value: '100' } });
    await fireEvent.input(field('des-box-y'), { target: { value: '120' } });
    expect(await drawing(copied)).toContain('x="100" y="120" width="50" height="50"');
    await fireEvent.input(field('des-box-w'), { target: { value: '80' } });
    await fireEvent.input(field('des-box-h'), { target: { value: '30' } });
    expect(await drawing(copied)).toContain('width="80" height="30"');
    await fireEvent.input(field('des-radius'), { target: { value: '10' } });
    expect(await drawing(copied)).toContain('rx="10"');
    await fireEvent.input(field('des-rotation'), { target: { value: '-90' } });
    expect(await drawing(copied)).toContain('rotate(270 ');
    await fireEvent.input(field('des-box-w'), { target: { value: '' } });
    expect(await drawing(copied)).toContain('width="80"');
  });

  it('snaps to the grid when asked', async () => {
    const { canvas, copied } = await openDesigner();
    await fireEvent.click(screen.getByTestId('des-snap'));
    expect(field('des-grid').value).toBe('10');
    await drawRect(canvas, [13, 17], [88, 52]);
    expect(await drawing(copied)).toContain('x="10" y="20" width="80" height="30"');
    await drag(canvas, [30, 30], [47, 52]);
    expect(await drawing(copied)).toMatch(/x="(?:20|30|40)" y="(?:40|50)"/u);
  });

  it('sets the size and the background of the canvas', async () => {
    const { copied } = await openDesigner();
    await fireEvent.input(field('des-w'), { target: { value: '800' } });
    await fireEvent.input(field('des-h'), { target: { value: '600' } });
    let svg = await drawing(copied);
    expect(svg).toContain('width="800" height="600" viewBox="0 0 800 600"');
    expect(svg).toContain('id="background"');
    await fireEvent.input(field('des-bg'), { target: { value: '#112233' } });
    expect(await drawing(copied)).toContain('fill="#112233"');
    await fireEvent.click(screen.getByTestId('des-nobg'));
    svg = await drawing(copied);
    expect(svg).not.toContain('id="background"');
    await fireEvent.click(screen.getByTestId('des-nobg'));
    expect(await drawing(copied)).toContain('id="background"');
  });

  it('zooms the canvas', async () => {
    await openDesigner();
    expect(screen.getByTestId('des-zoom').textContent).toBe('100%');
    await fireEvent.click(screen.getByTestId('des-zoom-in'));
    expect(screen.getByTestId('des-zoom').textContent).toBe('150%');
    expect(screen.getByTestId('des-canvas').getAttribute('width')).toBe('720');
    await fireEvent.click(screen.getByTestId('des-zoom-out'));
    await fireEvent.click(screen.getByTestId('des-zoom-out'));
    expect(screen.getByTestId('des-zoom').textContent).toBe('75%');
    for (let i = 0; i < 8; i++) {
      await fireEvent.click(screen.getByTestId('des-zoom-out'));
    }
    expect(screen.getByTestId('des-zoom').textContent).toBe('25%');
    for (let i = 0; i < 12; i++) {
      await fireEvent.click(screen.getByTestId('des-zoom-in'));
    }
    expect(screen.getByTestId('des-zoom').textContent).toBe('400%');
  });

  it('opens the drawing of the SVG editor, and sends its own back there', async () => {
    await openDesigner();
    await fireEvent.click(screen.getByTestId('des-from-editor'));
    expect(layers()).toEqual(['Rectangle 1']);
    expect((await screen.findByTestId('des-note')).textContent).toContain('opened');
    await fireEvent.click(screen.getByTestId('des-to-editor'));
    await waitFor(() => {
      expect(field('svg-text').value).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
    });
    expect(screen.getByTestId('mode-svg').getAttribute('aria-pressed')).toBe('true');
  });

  it('opens an SVG file, and says what it left out or that it is not an SVG', async () => {
    await openDesigner();
    const open = async (text: string): Promise<void> => {
      const file = new File([text], 'a.svg', { type: 'image/svg+xml' });
      await fireEvent.change(screen.getByTestId('des-file'), { target: { files: [file] } });
      await flush();
    };
    await open(
      '<svg width="50" height="50"><rect width="10" height="10"/><path d="M0 0 C 1 1 2 2 3 3"/></svg>',
    );
    expect((await screen.findByTestId('des-note')).textContent).toContain('1 elements');
    expect(layers()).toEqual(['Rectangle 1']);
    await open('this is not svg');
    expect((await screen.findByTestId('des-problem')).textContent).toContain('not an SVG');
  });

  it('saves the SVG through the host', async () => {
    const { canvas, saveFile } = await openDesigner();
    await drawRect(canvas);
    await fireEvent.click(screen.getByTestId('des-save-svg'));
    await flush();
    const sent = saveFile.mock.calls.at(-1)?.[0] as {
      suggestedName: string;
      extension: string;
      base64: string;
    };
    expect(sent.suggestedName).toBe('drawing');
    expect(sent.extension).toBe('svg');
    expect(atob(sent.base64)).toContain('<rect id="s1"');
    expect(
      (await screen.findByTestId('img-note').catch(() => screen.getByTestId('des-note')))
        .textContent,
    ).toContain('saved');
  });

  it('saves a PNG of the drawing, drawn at its own size', async () => {
    const render = vi.fn((_url: string, _options: unknown) =>
      Promise.resolve('data:image/png;base64,QUJD'),
    );
    const { canvas, saveFile } = await openDesigner({ images: fakeImages({ render }) });
    await drawRect(canvas);
    await fireEvent.click(screen.getByTestId('des-save-png'));
    await flush();
    expect(render).toHaveBeenCalledWith(expect.stringMatching(/^data:image\/svg\+xml/u), {
      width: 480,
      height: 320,
      format: 'png',
      quality: 1,
    });
    expect(saveFile).toHaveBeenLastCalledWith({
      suggestedName: 'drawing',
      extension: 'png',
      base64: 'QUJD',
    });
  });

  it('says so when the PNG cannot be written', async () => {
    await openDesigner({ images: fakeImages({ render: () => Promise.resolve(undefined) }) });
    await fireEvent.click(screen.getByTestId('des-save-png'));
    expect((await screen.findByTestId('des-problem')).textContent).toContain('cannot write PNG');
  });

  it('ignores the keys of a canvas that has nothing selected, and other mouse buttons', async () => {
    const { canvas } = await openDesigner();
    await fireEvent.keyDown(canvas, { key: 'ArrowLeft' });
    await fireEvent.keyDown(canvas, { key: 'Backspace' });
    await fireEvent.keyDown(canvas, { key: 'x' });
    await fireEvent(
      canvas,
      new MouseEvent('pointerdown', { bubbles: true, button: 2, clientX: 10, clientY: 10 }),
    );
    await fireEvent.wheel(canvas, { ctrlKey: true });
    expect(layers()).toEqual([]);
  });
});

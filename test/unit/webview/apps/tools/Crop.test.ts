import { cleanup, fireEvent, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flush } from '../../../../helpers/rpc';
import {
  chooseFile,
  fakeCanvas,
  fakeImages,
  field,
  openTools,
  pointer,
} from '../../../../helpers/webview/tools-page';

afterEach(cleanup);

async function openCrop(
  over: Parameters<typeof openTools>[0] = {},
  type = 'image/png',
): Promise<Awaited<ReturnType<typeof openTools>>> {
  const opened = await openTools({ tab: 'Image', ...over });
  await fireEvent.click(screen.getByTestId('mode-crop'));
  await chooseFile('photo.png', type);
  return opened;
}

const box = (): { x: number; y: number; w: number; h: number } => ({
  x: Number(field('crop-x').value),
  y: Number(field('crop-y').value),
  w: Number(field('crop-w').value),
  h: Number(field('crop-h').value),
});

async function type(testId: string, value: number): Promise<void> {
  await fireEvent.input(field(testId), { target: { value: String(value) } });
}

describe('Crop', () => {
  it('opens first in the Image tab and asks for a picture', async () => {
    await openTools({ tab: 'Image' });
    expect(screen.getByTestId('mode-crop').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('Choose an image first')).toBeTruthy();
  });

  it('starts with the whole picture selected', async () => {
    await openCrop();
    expect(box()).toEqual({ x: 0, y: 0, w: 200, h: 100 });
    const style = screen.getByTestId('crop-box').getAttribute('style') ?? '';
    expect(style).toContain('left: 0%');
    expect(style).toContain('width: 100%');
    expect(style).toContain('height: 100%');
  });

  it('follows the numbers typed in and keeps the box inside the picture', async () => {
    await openCrop();
    await type('crop-w', 100);
    await type('crop-h', 50);
    expect(box()).toEqual({ x: 0, y: 0, w: 100, h: 50 });
    await type('crop-x', 80);
    expect(box().x).toBe(80);
    await type('crop-x', 500);
    expect(box().x).toBe(100);
    await type('crop-w', 9999);
    expect(box().w).toBe(200);
    expect(screen.getByTestId('crop-announce').textContent).toContain('size');
  });

  it('keeps an aspect ratio, from a preset and from a custom one', async () => {
    await openCrop();
    await fireEvent.click(screen.getByTestId('crop-ratio-1:1'));
    expect(box()).toEqual({ x: 50, y: 0, w: 100, h: 100 });
    await type('crop-w', 60);
    expect(box().h).toBe(60);
    await fireEvent.click(screen.getByTestId('crop-ratio-16:9'));
    expect(box().w / box().h).toBeCloseTo(16 / 9, 1);
    await fireEvent.click(screen.getByTestId('crop-ratio-custom'));
    await fireEvent.input(field('crop-custom'), { target: { value: '2:1' } });
    await fireEvent.change(field('crop-custom'));
    expect(box().w / box().h).toBeCloseTo(2, 1);
    await fireEvent.click(screen.getByTestId('crop-ratio-free'));
    await type('crop-w', 50);
    expect(box().w).toBe(50);
  });

  it('says so when the custom ratio is not a ratio', async () => {
    await openCrop();
    await fireEvent.click(screen.getByTestId('crop-ratio-custom'));
    await fireEvent.input(field('crop-custom'), { target: { value: 'wide' } });
    expect((await screen.findByTestId('crop-ratio-problem')).textContent).toContain('16:9');
    expect(field('crop-custom').getAttribute('aria-invalid')).toBe('true');
  });

  it('moves, grows and shrinks with the keyboard, and goes back to the whole picture', async () => {
    await openCrop();
    await type('crop-w', 100);
    await type('crop-h', 50);
    const target = screen.getByTestId('crop-box');
    await fireEvent.keyDown(target, { key: 'ArrowRight' });
    expect(box().x).toBe(1);
    await fireEvent.keyDown(target, { key: 'ArrowRight', shiftKey: true });
    expect(box().x).toBe(11);
    await fireEvent.keyDown(target, { key: 'ArrowDown' });
    expect(box().y).toBe(1);
    await fireEvent.keyDown(target, { key: 'ArrowLeft', shiftKey: true });
    await fireEvent.keyDown(target, { key: 'ArrowLeft', shiftKey: true });
    expect(box().x).toBe(0);
    await fireEvent.keyDown(target, { key: 'ArrowRight', altKey: true });
    expect(box().w).toBe(101);
    await fireEvent.keyDown(target, { key: 'ArrowDown', altKey: true });
    expect(box().h).toBe(51);
    await fireEvent.keyDown(target, { key: '+' });
    expect(box().w).toBeGreaterThan(101);
    const wide = box().w;
    await fireEvent.keyDown(target, { key: '-' });
    expect(box().w).toBeLessThan(wide);
    await fireEvent.keyDown(target, { key: 'Escape' });
    expect(box()).toEqual({ x: 0, y: 0, w: 200, h: 100 });
    await fireEvent.keyDown(target, { key: 'q' });
    expect(box().w).toBe(200);
  });

  it('resizes from a handle with the keyboard', async () => {
    await openCrop();
    await type('crop-w', 100);
    await fireEvent.keyDown(screen.getByTestId('crop-handle-e'), {
      key: 'ArrowRight',
      shiftKey: true,
    });
    expect(box().w).toBe(110);
    await fireEvent.keyDown(screen.getByTestId('crop-handle-w'), { key: 'ArrowRight' });
    expect(box()).toMatchObject({ x: 1, w: 109 });
    await fireEvent.keyDown(screen.getByTestId('crop-handle-n'), {
      key: 'ArrowDown',
      shiftKey: true,
    });
    expect(box()).toMatchObject({ y: 10, h: 90 });
    await fireEvent.keyDown(screen.getByTestId('crop-handle-s'), { key: 'x' });
    expect(box().h).toBe(90);
  });

  it('moves and resizes with the pointer, in picture pixels whatever the picture is shown at', async () => {
    await openCrop();
    // Shown at 400 px for a picture 200 px wide: a screen pixel is half a picture pixel.
    Object.defineProperty(screen.getByTestId('crop-stage'), 'getBoundingClientRect', {
      value: () => ({
        left: 0,
        top: 0,
        width: 400,
        height: 200,
        right: 400,
        bottom: 200,
        x: 0,
        y: 0,
      }),
    });
    await type('crop-w', 100);
    await type('crop-h', 50);
    const target = screen.getByTestId('crop-box');
    await fireEvent(target, pointer('pointerdown', { clientX: 100, clientY: 50 }));
    await fireEvent(target, pointer('pointermove', { clientX: 140, clientY: 70 }));
    expect(box()).toMatchObject({ x: 20, y: 10 });
    await fireEvent(target, pointer('pointerup'));
    await fireEvent(target, pointer('pointermove', { clientX: 300, clientY: 300 }));
    expect(box()).toMatchObject({ x: 20, y: 10 });
    const handle = screen.getByTestId('crop-handle-se');
    await fireEvent(handle, pointer('pointerdown', { clientX: 0, clientY: 0 }));
    await fireEvent(handle, pointer('pointermove', { clientX: 20, clientY: 20 }));
    expect(box()).toMatchObject({ x: 20, y: 10, w: 110, h: 60 });
    await fireEvent(handle, pointer('pointercancel'));
    await fireEvent(handle, pointer('pointermove', { clientX: 400, clientY: 400 }));
    expect(box().w).toBe(110);
  });

  it('crops the box in the chosen format and shows the result with its size', async () => {
    const crop = vi.fn((_url: string, _rect: unknown, options: { format: string }) =>
      Promise.resolve(`data:image/${options.format};base64,Q1JPUA==`),
    );
    await openCrop({ canvas: fakeCanvas({ crop }) });
    await type('crop-w', 100);
    await type('crop-h', 50);
    await fireEvent.click(screen.getByTestId('crop-format-jpeg'));
    await fireEvent.input(field('crop-quality'), { target: { value: '70' } });
    await fireEvent.click(screen.getByTestId('crop-render'));
    await waitFor(() => {
      expect(screen.getByTestId('crop-result')).toBeTruthy();
    });
    expect(crop).toHaveBeenCalledWith(
      expect.stringContaining('data:image/png'),
      { x: 0, y: 0, w: 100, h: 50 },
      { format: 'jpeg', quality: 0.7, background: '#ffffff' },
    );
    expect(screen.getByTestId('crop-size').textContent).toContain('100×50');
    expect(screen.getByTestId<HTMLImageElement>('crop-result').src).toContain('image/jpeg');
  });

  it('forgets a result when the box changes', async () => {
    await openCrop();
    await fireEvent.click(screen.getByTestId('crop-render'));
    await screen.findByTestId('crop-result');
    await type('crop-w', 50);
    expect(screen.queryByTestId('crop-result')).toBeNull();
  });

  it('starts in the format of the picture', async () => {
    await openCrop({}, 'image/jpeg');
    expect(screen.getByTestId('crop-format-jpeg').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('crop-quality')).toBeTruthy();
    await fireEvent.click(screen.getByTestId('crop-format-png'));
    expect(screen.queryByTestId('crop-quality')).toBeNull();
  });

  it('says so when the format cannot be written', async () => {
    await openCrop({ canvas: fakeCanvas({ crop: () => Promise.resolve(undefined) }) });
    await fireEvent.click(screen.getByTestId('crop-render'));
    expect((await screen.findByTestId('crop-problem')).textContent).toContain('cannot write PNG');
    expect(screen.queryByTestId('crop-result')).toBeNull();
  });

  it('saves the result through the host with a name from the picture', async () => {
    const { saveFile } = await openCrop();
    await fireEvent.click(screen.getByTestId('crop-render'));
    await fireEvent.click(await screen.findByTestId('crop-save'));
    await flush();
    expect(saveFile).toHaveBeenCalledWith({
      suggestedName: 'photo.png',
      extension: 'png',
      base64: 'Q1JPUA==',
    });
    expect((await screen.findByTestId('img-note')).textContent).toContain('saved');
  });

  it('copies the result, or says the editor would not let it', async () => {
    const copyImage = vi.fn(() => Promise.resolve(false));
    await openCrop({ canvas: fakeCanvas({ copyImage }) });
    await fireEvent.click(screen.getByTestId('crop-render'));
    await fireEvent.click(await screen.findByTestId('crop-copy'));
    expect((await screen.findByTestId('crop-problem')).textContent).toContain(
      'did not let the page',
    );
    copyImage.mockReturnValueOnce(Promise.resolve(true));
    await fireEvent.click(screen.getByTestId('crop-copy'));
    await waitFor(() => {
      expect(screen.queryByTestId('crop-problem')).toBeNull();
    });
  });

  it('starts again with the whole of a new picture', async () => {
    await openCrop({ images: fakeImages({}, { width: 300, height: 120 }) });
    expect(box()).toEqual({ x: 0, y: 0, w: 300, h: 120 });
    await type('crop-w', 10);
    await chooseFile('other.png');
    expect(box()).toEqual({ x: 0, y: 0, w: 300, h: 120 });
  });

  it('ignores a number field that is empty', async () => {
    await openCrop();
    await fireEvent.input(field('crop-w'), { target: { value: '' } });
    expect(screen.getByTestId('crop-box').getAttribute('style')).toContain('width: 100%');
  });
});

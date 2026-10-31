// A Tools page with a linked fake host, for the tests of the picture and QR tools.

import { fireEvent, render, screen } from '@testing-library/svelte';
import { vi } from 'vitest';
import { toolsProtocol, type ToolsProtocol } from '../../../src/shared/protocols/tools';
import { RpcPeer } from '../../../src/shared/rpc';
import App from '../../../webview/src/apps/tools/App.svelte';
import type { CanvasApi } from '../../../webview/src/apps/tools/canvas-api';
import type { ImageApi, LoadedImage } from '../../../webview/src/apps/tools/image-api';
import { createToolsState } from '../../../webview/src/apps/tools/state';
import { createTranslator } from '../../../webview/src/lib/i18n';
import { createLinkedTransports, flush } from '../rpc';

export type HostPeer = RpcPeer<ToolsProtocol['host'], ToolsProtocol['webview']>;

export const PIXEL = 'data:image/png;base64,iVBORw0KGgo=';

export function fakeImages(
  over: Partial<ImageApi> = {},
  size = { width: 200, height: 100 },
): ImageApi {
  return {
    load: (file, name) =>
      Promise.resolve(
        file.type.startsWith('image/')
          ? ({
              dataUrl: PIXEL,
              ...size,
              name,
              bytes: file.size,
              mime: file.type,
            } satisfies LoadedImage)
          : undefined,
      ),
    render: (_url, options) => Promise.resolve(`data:image/${options.format};base64,QUJD`),
    ...over,
  };
}

export function fakeCanvas(over: Partial<CanvasApi> = {}): CanvasApi {
  return {
    pixels: () => Promise.resolve(undefined),
    crop: (_url, _rect, options) => Promise.resolve(`data:image/${options.format};base64,Q1JPUA==`),
    fromPixels: (_pixels, options) => Promise.resolve(`data:image/${options.format};base64,UElY`),
    deflate: (bytes) => Promise.resolve(bytes),
    copyImage: () => Promise.resolve(true),
    ...over,
  };
}

export interface OpenedTools {
  readonly host: HostPeer;
  readonly copied: ReturnType<typeof vi.fn>;
  readonly saveFile: ReturnType<typeof vi.fn>;
}

/** Opens the page on a tab; `handlers` add or replace what the fake host answers. */
export async function openTools(
  options: {
    images?: ImageApi;
    canvas?: CanvasApi;
    tab?: string;
    handle?: (host: HostPeer) => void;
  } = {},
): Promise<OpenedTools> {
  const transports = createLinkedTransports();
  const host: HostPeer = new RpcPeer({
    local: toolsProtocol.host,
    remote: toolsProtocol.webview,
    transport: transports.host,
  });
  const rpc = new RpcPeer({
    local: toolsProtocol.webview,
    remote: toolsProtocol.host,
    transport: transports.webview,
  });
  const copied = vi.fn();
  const saveFile = vi.fn((_: unknown): { ok: boolean; error?: 'cancelled' | 'failed' } => ({
    ok: true,
  }));
  host.on('ready', () => undefined);
  host.on('copyText', copied);
  host.handle('saveFile', saveFile);
  if (options.handle === undefined) {
    host.handle('tinyStatus', () => ({ saved: false }));
  }
  host.handle('hash', () => ({ md5: '', sha1: '', sha256: '', bytes: 0 }));
  options.handle?.(host);
  render(App, {
    props: {
      rpc,
      t: createTranslator('en'),
      images: options.images ?? fakeImages(),
      canvas: options.canvas ?? fakeCanvas(),
      state: createToolsState({ getState: () => undefined, setState: () => undefined }),
    },
  });
  await flush();
  if (options.tab !== undefined) {
    await fireEvent.click(screen.getByRole('tab', { name: options.tab }));
    await flush();
  }
  return { host, copied, saveFile };
}

export const field = (testId: string): HTMLInputElement | HTMLTextAreaElement =>
  screen.getByTestId<HTMLInputElement | HTMLTextAreaElement>(testId);

/** A pointer event the way jsdom can send one: a mouse event of a pointer type. */
export function pointer(
  type: string,
  init: { clientX?: number; clientY?: number; shiftKey?: boolean } = {},
): MouseEvent {
  return new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init });
}

export async function chooseFile(name = 'photo.png', type = 'image/png'): Promise<void> {
  const file = new File(['x'], name, { type });
  await fireEvent.change(screen.getByTestId('file'), { target: { files: [file] } });
  await flush();
}

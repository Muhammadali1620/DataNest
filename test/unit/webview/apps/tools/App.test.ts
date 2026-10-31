import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import { toolsProtocol, type ToolsProtocol } from '../../../../../src/shared/protocols/tools';
import { RpcPeer } from '../../../../../src/shared/rpc';
import App from '../../../../../webview/src/apps/tools/App.svelte';
import type { ImageApi, LoadedImage } from '../../../../../webview/src/apps/tools/image-api';
import { createTranslator } from '../../../../../webview/src/lib/i18n';
import { createLinkedTransports, flush } from '../../../../helpers/rpc';

type HostPeer = RpcPeer<ToolsProtocol['host'], ToolsProtocol['webview']>;

const PIXEL = 'data:image/png;base64,iVBORw0KGgo=';

function fakeImages(over: Partial<ImageApi> = {}): ImageApi {
  return {
    load: (file, name) =>
      Promise.resolve(
        file.type.startsWith('image/')
          ? ({
              dataUrl: PIXEL,
              width: 200,
              height: 100,
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

async function open(images: ImageApi = fakeImages()) {
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
  const ready = vi.fn();
  const copied = vi.fn();
  host.on('ready', ready);
  host.on('copyText', copied);
  const hash = vi.fn(({ text }: { text: string }) => ({
    md5: `md5:${text}`,
    sha1: `sha1:${text}`,
    sha256: `sha256:${text}`,
    bytes: new TextEncoder().encode(text).length,
  }));
  const interfaces = vi.fn(() => ({
    items: [
      { name: 'eth0', address: '192.168.1.5', family: 'IPv4' as const, mac: 'aa', internal: false },
      { name: 'lo', address: '127.0.0.1', family: 'IPv4' as const, mac: '00', internal: true },
    ],
  }));
  const portCheck = vi.fn((_: unknown): { open: boolean; ms?: number; error?: 'refused' } => ({
    open: true,
    ms: 1.5,
  }));
  const dnsLookup = vi.fn(
    (_: unknown): { addresses: { address: string; family: 4 | 6 }[]; error?: 'not-found' } => ({
      addresses: [
        { address: '127.0.0.1', family: 4 },
        { address: '::1', family: 6 },
      ],
    }),
  );
  const tcpPing = vi.fn((_: unknown) => ({
    attempts: [
      { ok: true, ms: 2 },
      { ok: true, ms: 4 },
      { ok: false, error: 'timeout' as const },
    ],
  }));
  const saveFile = vi.fn((_: unknown): { ok: boolean; error?: 'cancelled' | 'failed' } => ({
    ok: true,
  }));
  host.handle('hash', hash);
  host.handle('interfaces', interfaces);
  host.handle('portCheck', portCheck);
  host.handle('dnsLookup', dnsLookup);
  host.handle('tcpPing', tcpPing);
  host.handle('saveFile', saveFile);
  render(App, { props: { rpc, t: createTranslator('en'), images } });
  await flush();
  return { host, ready, copied, hash, interfaces, portCheck, dnsLookup, tcpPing, saveFile };
}

const input = (testId: string): HTMLInputElement | HTMLTextAreaElement =>
  screen.getByTestId<HTMLInputElement | HTMLTextAreaElement>(testId);

async function goTo(tab: string): Promise<void> {
  await fireEvent.click(screen.getByRole('tab', { name: tab }));
}

describe('the page', () => {
  it('tells the host it is ready and shows four tabs, General first', async () => {
    const { ready } = await open();
    expect(ready).toHaveBeenCalledOnce();
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent.trim())).toEqual([
      'General',
      'Network',
      'Colors',
      'Image',
    ]);
    expect(screen.getByRole('tab', { name: 'General' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel')).toBeTruthy();
  });

  it('switches tabs by click and by the arrow keys', async () => {
    await open();
    await goTo('Colors');
    expect(screen.getByTestId('hex')).toBeTruthy();
    await fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Image' }).getAttribute('aria-selected')).toBe('true');
    await fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'General' }).getAttribute('aria-selected')).toBe('true');
    await fireEvent.keyDown(screen.getByRole('tablist'), { key: 'End' });
    expect(screen.getByRole('tab', { name: 'Image' }).getAttribute('aria-selected')).toBe('true');
    await fireEvent.keyDown(screen.getByRole('tablist'), { key: 'Home' });
    expect(screen.getByRole('tab', { name: 'General' }).getAttribute('aria-selected')).toBe('true');
    await fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowLeft' });
    expect(screen.getByRole('tab', { name: 'Image' }).getAttribute('aria-selected')).toBe('true');
  });

  it('only the selected tab is in the tab order', async () => {
    await open();
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.getAttribute('tabindex'))).toEqual(['0', '-1', '-1', '-1']);
  });
});

describe('General: hashes', () => {
  it('asks the host for the hashes of what is typed and shows them with the size', async () => {
    const { hash } = await open();
    await fireEvent.input(input('source'), { target: { value: 'héllo' } });
    await waitFor(() => {
      expect(hash).toHaveBeenCalledWith({ text: 'héllo' });
    });
    await waitFor(() => {
      expect(input('md5').value).toBe('md5:héllo');
    });
    expect(input('sha1').value).toBe('sha1:héllo');
    expect(input('sha256').value).toBe('sha256:héllo');
    expect(screen.getByTestId('size').textContent).toContain('6 B');
  });

  it('copies a hash through the host and says so', async () => {
    const { copied } = await open();
    await fireEvent.input(input('source'), { target: { value: 'a' } });
    await waitFor(() => {
      expect(input('md5').value).toBe('md5:a');
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Copy MD5' }));
    await waitFor(() => {
      expect(copied).toHaveBeenCalledWith({ text: 'md5:a' });
    });
    expect(await screen.findByTestId('copied')).toBeTruthy();
  });

  it('keeps the copy buttons off until there is something to copy', async () => {
    await open();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Copy MD5' }).disabled).toBe(true);
  });
});

describe('General: encode / decode', () => {
  it('encodes the plain text as Base64 and decodes edits of the other side', async () => {
    await open();
    await fireEvent.input(input('plain'), { target: { value: 'hello' } });
    expect(input('encoded').value).toBe('aGVsbG8=');
    await fireEvent.input(input('encoded'), { target: { value: 'aGk=' } });
    expect(input('plain').value).toBe('hi');
    expect(screen.queryByTestId('decode-problem')).toBeNull();
  });

  it('switches to URL and Unicode and re-encodes', async () => {
    await open();
    await fireEvent.input(input('plain'), { target: { value: 'a b&é' } });
    await fireEvent.click(screen.getByTestId('kind-url'));
    expect(input('encoded').value).toBe('a%20b%26%C3%A9');
    await fireEvent.click(screen.getByTestId('kind-unicode'));
    expect(input('encoded').value).toBe('a b&\\u00e9');
  });

  it('says what is wrong with text that does not decode, and keeps the plain side', async () => {
    await open();
    await fireEvent.input(input('plain'), { target: { value: 'keep' } });
    await fireEvent.input(input('encoded'), { target: { value: '***' } });
    expect((await screen.findByTestId('decode-problem')).textContent).toContain('not valid Base64');
    expect(input('plain').value).toBe('keep');
    expect(input('encoded').getAttribute('aria-invalid')).toBe('true');
    await fireEvent.click(screen.getByTestId('kind-url'));
    await fireEvent.input(input('encoded'), { target: { value: '%E0%A4%A' } });
    expect((await screen.findByTestId('decode-problem')).textContent).toContain('URL');
  });
});

describe('General: random values', () => {
  it('shows a name, a password and a UUID at once', async () => {
    await open();
    expect(input('name').value).toMatch(/^\S+ \S+$/u);
    expect(input('secret').value).toHaveLength(16);
    expect(input('uuid').value).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('makes new ones with Generate', async () => {
    await open();
    const before = input('uuid').value;
    await fireEvent.click(screen.getByTestId('generate'));
    expect(input('uuid').value).not.toBe(before);
  });

  it('follows the length and the kinds of characters', async () => {
    await open();
    const length = input('length');
    await fireEvent.input(length, { target: { value: '30' } });
    await fireEvent.change(length);
    expect(input('secret').value).toHaveLength(30);
    for (const kind of ['lower', 'upper', 'symbols']) {
      await fireEvent.click(screen.getByTestId(`pw-${kind}`));
    }
    expect(input('secret').value).toMatch(/^[2-9]{30}$/u);
  });

  it('warns when no kind of characters is left', async () => {
    await open();
    for (const kind of ['lower', 'upper', 'digits', 'symbols']) {
      await fireEvent.click(screen.getByTestId(`pw-${kind}`));
    }
    expect((await screen.findAllByRole('alert'))[0]?.textContent).toContain('at least one kind');
    expect(input('secret').value).toBe('');
  });
});

describe('General: timestamps', () => {
  it('starts at the current time and agrees with itself', async () => {
    await open();
    expect(input('unix').value).toMatch(/^\d{13}$/u);
    expect(input('local').value).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u);
    expect(input('iso').value).toMatch(/Z$/u);
  });

  it('converts a Unix time to dates, in seconds or milliseconds', async () => {
    await open();
    await fireEvent.input(input('unix'), { target: { value: '0' } });
    expect(input('iso').value).toBe('1970-01-01T00:00:00.000Z');
    await fireEvent.input(input('unix'), { target: { value: '1793436813005' } });
    expect(input('iso').value).toBe(new Date(1_793_436_813_005).toISOString());
    expect(input('local').value).toBe(
      (() => {
        const date = new Date(1_793_436_813_005);
        const pad = (n: number): string => String(n).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
      })(),
    );
  });

  it('converts a local date back to milliseconds', async () => {
    await open();
    await fireEvent.input(input('local'), { target: { value: '2026-01-02 03:04:05' } });
    expect(input('unix').value).toBe(String(new Date(2026, 0, 2, 3, 4, 5).getTime()));
  });

  it('says what is wrong with either field', async () => {
    await open();
    await fireEvent.input(input('unix'), { target: { value: 'abc' } });
    expect((await screen.findByTestId('time-problem')).textContent).toContain('Unix time');
    await fireEvent.input(input('local'), { target: { value: '2026-02-30' } });
    expect((await screen.findByTestId('time-problem')).textContent).toContain('YYYY-MM-DD');
  });

  it('goes back to now', async () => {
    await open();
    await fireEvent.input(input('unix'), { target: { value: '5' } });
    await fireEvent.click(screen.getByTestId('now'));
    expect(input('unix').value).toMatch(/^\d{13}$/u);
    expect(screen.queryByTestId('time-problem')).toBeNull();
  });
});

describe('Network', () => {
  it('lists the interfaces, marking the loopback', async () => {
    const { interfaces } = await open();
    await goTo('Network');
    await waitFor(() => {
      expect(interfaces).toHaveBeenCalled();
    });
    const table = await screen.findByTestId('interfaces');
    expect(within(table).getByText('192.168.1.5')).toBeTruthy();
    expect(within(table).getByText('loopback')).toBeTruthy();
  });

  it('says so when there are no interfaces', async () => {
    const { interfaces } = await open();
    interfaces.mockReturnValueOnce({ items: [] });
    await goTo('Network');
    expect(await screen.findByTestId('no-interfaces')).toBeTruthy();
  });

  it('checks a port and shows it open with its time', async () => {
    const { portCheck } = await open();
    await goTo('Network');
    await fireEvent.input(screen.getByTestId('port-host'), { target: { value: ' db.local ' } });
    await fireEvent.click(screen.getByTestId('port-run'));
    await waitFor(() => {
      expect(portCheck).toHaveBeenCalledWith({ host: 'db.local', port: 3306, timeoutMs: 3000 });
    });
    expect((await screen.findByTestId('port-result')).textContent).toContain('Open');
    expect(screen.getByTestId('port-result').textContent).toContain('1.5 ms');
  });

  it('shows why a port is closed', async () => {
    const { portCheck } = await open();
    portCheck.mockReturnValueOnce({ open: false, error: 'refused' });
    await goTo('Network');
    await fireEvent.click(screen.getByTestId('port-run'));
    const result = await screen.findByTestId('port-result');
    expect(result.textContent).toContain('Closed');
    expect(result.textContent).toContain('Connection refused');
  });

  it('refuses a bad host or port without asking the host', async () => {
    const { portCheck } = await open();
    await goTo('Network');
    await fireEvent.input(screen.getByTestId('port-host'), { target: { value: 'bad host' } });
    await fireEvent.click(screen.getByTestId('port-run'));
    expect((await screen.findByTestId('port-problem')).textContent).toContain('not a valid host');
    await fireEvent.input(screen.getByTestId('port-host'), { target: { value: 'ok.test' } });
    await fireEvent.input(screen.getByTestId('port-number'), { target: { value: '70000' } });
    await fireEvent.click(screen.getByTestId('port-run'));
    expect((await screen.findByTestId('port-problem')).textContent).toContain('1 to 65535');
    await fireEvent.input(screen.getByTestId('port-number'), { target: { value: '' } });
    await fireEvent.click(screen.getByTestId('port-run'));
    expect((await screen.findByTestId('port-problem')).textContent).toContain('Enter a port');
    await fireEvent.input(screen.getByTestId('port-host'), { target: { value: '' } });
    await fireEvent.click(screen.getByTestId('port-run'));
    expect((await screen.findByTestId('port-problem')).textContent).toContain('Enter a host');
    expect(portCheck).not.toHaveBeenCalled();
  });

  it('looks a name up and lists A and AAAA records', async () => {
    const { dnsLookup } = await open();
    await goTo('Network');
    await fireEvent.click(screen.getByTestId('dns-run'));
    await waitFor(() => {
      expect(dnsLookup).toHaveBeenCalledWith({ host: 'localhost' });
    });
    const result = await screen.findByTestId('dns-result');
    expect(result.textContent).toContain('127.0.0.1');
    expect(result.textContent).toContain('AAAA');
  });

  it('says when a name is not found, and refuses an empty host', async () => {
    const { dnsLookup } = await open();
    dnsLookup.mockReturnValueOnce({ addresses: [], error: 'not-found' });
    await goTo('Network');
    await fireEvent.click(screen.getByTestId('dns-run'));
    expect((await screen.findByTestId('dns-result')).textContent).toContain('not found');
    await fireEvent.input(screen.getByTestId('dns-host'), { target: { value: '' } });
    await fireEvent.click(screen.getByTestId('dns-run'));
    expect((await screen.findByTestId('dns-problem')).textContent).toContain('Enter a host');
  });

  it('pings and summarizes: received, loss, min, avg, max and each attempt', async () => {
    const { tcpPing } = await open();
    await goTo('Network');
    await fireEvent.click(screen.getByTestId('ping-run'));
    await waitFor(() => {
      expect(tcpPing).toHaveBeenCalledWith({
        host: '127.0.0.1',
        port: 3306,
        count: 4,
        timeoutMs: 2000,
      });
    });
    const result = await screen.findByTestId('ping-result');
    expect(result.textContent).toContain('2 of 3 connected');
    expect(result.textContent).toContain('33.3% lost');
    expect(screen.getByTestId('ping-stats').textContent).toContain('min 2 / avg 3 / max 4 ms');
    expect(result.textContent).toContain('No answer in time');
  });

  it('shows an error of the whole series, and refuses bad input', async () => {
    const { tcpPing } = await open();
    (tcpPing as unknown as { mockReturnValueOnce: (value: unknown) => void }).mockReturnValueOnce({
      attempts: [],
      error: 'invalid-host',
    });
    await goTo('Network');
    await fireEvent.click(screen.getByTestId('ping-run'));
    await waitFor(() => {
      expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
    });
    tcpPing.mockClear();
    await fireEvent.input(screen.getByTestId('ping-port'), { target: { value: 'x' } });
    await fireEvent.click(screen.getByTestId('ping-run'));
    expect((await screen.findByTestId('ping-problem')).textContent).toContain('1 to 65535');
    expect(tcpPing).not.toHaveBeenCalled();
  });
});

describe('Colors', () => {
  it('starts with a colour and shows its HEX, RGB and HSL', async () => {
    await open();
    await goTo('Colors');
    expect(input('hex').value).toBe('#3478C6');
    expect(input('rgb').value).toBe('rgb(52, 120, 198)');
    expect(screen.getByTestId('hsl').textContent).toContain('HSL 212°');
  });

  it('follows the HEX field and the RGB field', async () => {
    await open();
    await goTo('Colors');
    await fireEvent.input(input('hex'), { target: { value: '#ff0000' } });
    expect(input('rgb').value).toBe('rgb(255, 0, 0)');
    await fireEvent.input(input('rgb'), { target: { value: '0, 255, 0' } });
    expect(input('hex').value).toBe('#00FF00');
  });

  it('flags text that is not a colour and keeps the colour', async () => {
    await open();
    await goTo('Colors');
    await fireEvent.input(input('hex'), { target: { value: '#12' } });
    expect((await screen.findByTestId('color-problem')).textContent).toContain('#RRGGBB');
    expect(input('rgb').value).toBe('rgb(52, 120, 198)');
    await fireEvent.input(input('hex'), { target: { value: '#00ff00' } });
    expect(screen.queryByTestId('color-problem')).toBeNull();
    await fireEvent.input(input('rgb'), { target: { value: '999, 0, 0' } });
    expect(await screen.findByTestId('color-problem')).toBeTruthy();
  });

  it('takes a colour from the picker and from a swatch', async () => {
    await open();
    await goTo('Colors');
    await fireEvent.input(screen.getByTestId('picker'), { target: { value: '#112233' } });
    expect(input('hex').value).toBe('#112233');
    await fireEvent.click(screen.getByRole('button', { name: '#E5484D' }));
    expect(input('hex').value).toBe('#E5484D');
    expect(screen.getByRole('button', { name: '#E5484D' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('derives seven shades and shows the preview with them', async () => {
    await open();
    await goTo('Colors');
    for (const key of [
      'hover',
      'active',
      'light',
      'textOnColor',
      'softBackground',
      'softHover',
      'border',
    ]) {
      const row = screen.getByTestId(`derived-${key}`);
      expect(within(row).getByRole<HTMLInputElement>('textbox').value).toMatch(/^#[0-9A-F]{6}$/u);
    }
    expect(
      within(screen.getByTestId('derived-textOnColor')).getByRole<HTMLInputElement>('textbox')
        .value,
    ).toBe('#000000');
    expect(screen.getByTestId('preview').getAttribute('style')).toContain('--c: rgb(52, 120, 198)');
  });

  it('copies HEX, RGB and a derived colour', async () => {
    const { copied } = await open();
    await goTo('Colors');
    await fireEvent.click(screen.getByRole('button', { name: 'Copy HEX' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Copy RGB' }));
    await fireEvent.click(within(screen.getByTestId('derived-border')).getByRole('button'));
    await waitFor(() => {
      expect(copied).toHaveBeenCalledTimes(3);
    });
    expect(copied.mock.calls[0]?.[0]).toEqual({ text: '#3478C6' });
    expect(copied.mock.calls[1]?.[0]).toEqual({ text: 'rgb(52, 120, 198)' });
  });
});

describe('Image', () => {
  async function pick(name = 'photo.png', type = 'image/png') {
    await goTo('Image');
    const file = new File(['x'], name, { type });
    await fireEvent.change(screen.getByTestId('file'), { target: { files: [file] } });
  }

  it('reads a chosen image and shows its name and size', async () => {
    await open();
    await pick();
    expect((await screen.findByTestId('loaded')).textContent).toBe('photo.png · 200×100');
    expect(input('width').value).toBe('200');
    expect(input('height').value).toBe('100');
  });

  it('refuses a file that is not an image', async () => {
    await open();
    await pick('notes.txt', 'text/plain');
    expect((await screen.findByTestId('img-problem')).textContent).toContain('not an image');
    expect(screen.queryByTestId('loaded')).toBeNull();
  });

  it('reads an image dropped on the area, and ignores an empty drop', async () => {
    await open();
    await goTo('Image');
    const file = new File(['x'], 'dropped.png', { type: 'image/png' });
    await fireEvent.drop(screen.getByTestId('drop'), { dataTransfer: { files: [file] } });
    expect((await screen.findByTestId('loaded')).textContent).toContain('dropped.png');
    await fireEvent.dragOver(screen.getByTestId('drop'));
    await fireEvent.dragLeave(screen.getByTestId('drop'));
    await fireEvent.drop(screen.getByTestId('drop'), { dataTransfer: { files: [] } });
    expect(screen.getByTestId('loaded').textContent).toContain('dropped.png');
  });

  it('keeps the proportions when one side changes, and lets them go when asked', async () => {
    await open();
    await pick();
    await screen.findByTestId('loaded');
    await fireEvent.input(input('width'), { target: { value: '100' } });
    expect(input('height').value).toBe('50');
    await fireEvent.click(screen.getByTestId('ratio'));
    await fireEvent.input(input('width'), { target: { value: '30' } });
    expect(input('height').value).toBe('50');
  });

  it('resizes to the chosen format and shows the result with its size', async () => {
    const render = vi.fn((_url: string, options: { format: string }) =>
      Promise.resolve(`data:image/${options.format};base64,QUJDRA==`),
    );
    await open(fakeImages({ render }));
    await pick();
    await screen.findByTestId('loaded');
    await fireEvent.click(screen.getByTestId('format-jpeg'));
    await fireEvent.input(screen.getByTestId('quality'), { target: { value: '50' } });
    await fireEvent.click(screen.getByTestId('render'));
    await waitFor(() => {
      expect(render).toHaveBeenCalledWith(PIXEL, {
        width: 200,
        height: 100,
        format: 'jpeg',
        quality: 0.5,
        background: '#ffffff',
      });
    });
    expect((await screen.findByTestId('result-size')).textContent).toBe('200×100 · 4 B');
    expect(screen.getByTestId('result-img').getAttribute('src')).toBe(
      'data:image/jpeg;base64,QUJDRA==',
    );
  });

  it('draws no quality slider for PNG and keeps the background clear', async () => {
    const render = vi.fn((_url: string, _options: unknown) =>
      Promise.resolve('data:image/png;base64,QUJD'),
    );
    await open(fakeImages({ render }));
    await pick();
    await screen.findByTestId('loaded');
    expect(screen.queryByTestId('quality')).toBeNull();
    await fireEvent.click(screen.getByTestId('render'));
    await waitFor(() => {
      expect(render).toHaveBeenCalledTimes(1);
    });
    expect((render.mock.calls[0]?.[1] as { background?: string }).background).toBeUndefined();
  });

  it('says so when the format cannot be written or the image is too big', async () => {
    await open(fakeImages({ render: () => Promise.resolve(undefined) }));
    await pick();
    await screen.findByTestId('loaded');
    await fireEvent.click(screen.getByTestId('format-webp'));
    await fireEvent.click(screen.getByTestId('render'));
    expect((await screen.findByTestId('out-problem')).textContent).toContain('WEBP');
    await fireEvent.click(screen.getByTestId('ratio'));
    await fireEvent.input(input('width'), { target: { value: '16000' } });
    await fireEvent.input(input('height'), { target: { value: '16000' } });
    await fireEvent.click(screen.getByTestId('render'));
    await waitFor(() => {
      expect(screen.getByTestId('out-problem').textContent).toContain('too many pixels');
    });
  });

  it('saves the result through the host with a name from the file', async () => {
    const { saveFile } = await open();
    await pick('photo.png');
    await screen.findByTestId('loaded');
    await fireEvent.click(screen.getByTestId('render'));
    await fireEvent.click(await screen.findByTestId('save'));
    await waitFor(() => {
      expect(saveFile).toHaveBeenCalledWith({
        suggestedName: 'photo.png',
        extension: 'png',
        base64: 'QUJD',
      });
    });
    expect((await screen.findByTestId('img-note')).textContent).toContain('saved');
  });

  it('is quiet when the save dialog is cancelled and says so when the write fails', async () => {
    const { saveFile } = await open();
    await pick();
    await screen.findByTestId('loaded');
    await fireEvent.click(screen.getByTestId('render'));
    saveFile.mockReturnValueOnce({ ok: false, error: 'cancelled' });
    await fireEvent.click(await screen.findByTestId('save'));
    await flush();
    expect(screen.queryByTestId('img-note')).toBeNull();
    saveFile.mockReturnValueOnce({ ok: false, error: 'failed' });
    await fireEvent.click(screen.getByTestId('save'));
    expect((await screen.findByTestId('img-note')).textContent).toContain('could not be saved');
  });

  it('shows the data URL, the CSS and the HTML forms for the same image', async () => {
    const { copied } = await open();
    await pick();
    await screen.findByTestId('loaded');
    await fireEvent.click(screen.getByTestId('mode-base64'));
    expect(input('out-base64').value).toBe(PIXEL);
    expect(input('out-css').value).toBe(`url("${PIXEL}")`);
    expect(input('out-html').value).toBe(`<img src="${PIXEL}" width="200" height="100" alt="">`);
    await fireEvent.click(screen.getByRole('button', { name: 'Copy CSS url()' }));
    await waitFor(() => {
      expect(copied).toHaveBeenCalledWith({ text: `url("${PIXEL}")` });
    });
  });

  it('asks for an image first in the Base64 and Resize modes', async () => {
    await open();
    await goTo('Image');
    expect(screen.getByText('Choose an image first')).toBeTruthy();
    await fireEvent.click(screen.getByTestId('mode-base64'));
    expect(screen.getByText('Choose an image first')).toBeTruthy();
  });

  it('pastes an image from the clipboard', async () => {
    await open();
    await goTo('Image');
    const file = new File(['x'], 'clip', { type: 'image/png' });
    const event = new Event('paste', { bubbles: true, cancelable: true }) as Event & {
      clipboardData: { items: { type: string; getAsFile: () => File }[] };
    };
    event.clipboardData = { items: [{ type: 'image/png', getAsFile: () => file }] };
    window.dispatchEvent(event);
    expect((await screen.findByTestId('loaded')).textContent).toContain('pasted image');
    expect(event.defaultPrevented).toBe(true);
  });

  it('ignores a paste without an image', async () => {
    await open();
    await goTo('Image');
    const event = new Event('paste', { bubbles: true, cancelable: true }) as Event & {
      clipboardData: { items: { type: string }[] };
    };
    event.clipboardData = { items: [{ type: 'text/plain' }] };
    window.dispatchEvent(event);
    await flush();
    expect(screen.queryByTestId('loaded')).toBeNull();
    expect(event.defaultPrevented).toBe(false);
  });

  describe('the SVG editor', () => {
    async function openSvg() {
      const view = await open();
      await goTo('Image');
      await fireEvent.click(screen.getByTestId('mode-svg'));
      return view;
    }

    it('starts with a drawing and previews it', async () => {
      await openSvg();
      expect(input('svg-text').value).toContain('<svg');
      expect(screen.getByTestId('svg-preview').getAttribute('src')).toMatch(
        /^data:image\/svg\+xml;base64,/u,
      );
    });

    it('stops previewing text that is not an SVG and says so', async () => {
      await openSvg();
      await fireEvent.input(input('svg-text'), { target: { value: '<div></div>' } });
      expect(await screen.findByTestId('svg-invalid')).toBeTruthy();
      expect(screen.queryByTestId('svg-preview')).toBeNull();
      expect(screen.getByTestId<HTMLButtonElement>('svg-png').disabled).toBe(true);
    });

    it('formats the text, and complains about text that is not an SVG', async () => {
      await openSvg();
      await fireEvent.input(input('svg-text'), {
        target: { value: '<svg><g><circle r="1"/></g></svg>' },
      });
      await fireEvent.click(screen.getByTestId('svg-format'));
      expect(input('svg-text').value).toBe('<svg>\n  <g>\n    <circle r="1"/>\n  </g>\n</svg>');
      await fireEvent.input(input('svg-text'), { target: { value: 'nope' } });
      await fireEvent.click(screen.getByTestId('svg-format'));
      expect((await screen.findByTestId('svg-problem')).textContent).toContain('not an SVG');
    });

    it('applies a fill to the root element', async () => {
      await openSvg();
      await fireEvent.input(input('svg-text'), { target: { value: '<svg width="5"></svg>' } });
      await fireEvent.input(screen.getByTestId('svg-fill'), { target: { value: '#ff0000' } });
      await fireEvent.click(screen.getByTestId('svg-apply-fill'));
      expect(input('svg-text').value).toBe('<svg width="5" fill="#ff0000"></svg>');
    });

    it('changes the stage background', async () => {
      await openSvg();
      await fireEvent.input(screen.getByTestId('svg-bg'), { target: { value: '#000000' } });
      expect(screen.getByTestId('svg-preview').parentElement?.getAttribute('style')).toContain(
        'rgb(0, 0, 0)',
      );
    });

    it('exports a PNG at the size the SVG declares, over the background colour', async () => {
      const render = vi.fn((_url: string, _options: unknown) =>
        Promise.resolve('data:image/png;base64,QUJD'),
      );
      const { saveFile } = await open(fakeImages({ render }));
      await goTo('Image');
      await fireEvent.click(screen.getByTestId('mode-svg'));
      await fireEvent.click(screen.getByTestId('svg-png'));
      await waitFor(() => {
        expect(saveFile).toHaveBeenCalledWith({
          suggestedName: 'image',
          extension: 'png',
          base64: 'QUJD',
        });
      });
      expect(render.mock.calls[0]?.[1]).toEqual({
        width: 200,
        height: 200,
        format: 'png',
        quality: 1,
        background: '#ffffff',
      });
    });

    it('uses 512 when the SVG declares no size, and reports a failed render', async () => {
      const render = vi.fn((_url: string, _options: unknown): Promise<string | undefined> =>
        Promise.resolve(undefined),
      );
      await open(fakeImages({ render }));
      await goTo('Image');
      await fireEvent.click(screen.getByTestId('mode-svg'));
      await fireEvent.input(input('svg-text'), {
        target: { value: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' },
      });
      await fireEvent.click(screen.getByTestId('svg-png'));
      expect((await screen.findByTestId('svg-problem')).textContent).toContain('PNG');
      expect((render.mock.calls[0]?.[1] as { width: number }).width).toBe(512);
    });
  });
});

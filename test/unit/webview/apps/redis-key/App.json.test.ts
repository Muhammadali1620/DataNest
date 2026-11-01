import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import {
  type JsonNodeInfo,
  redisKeyProtocol,
  type RedisKeyProtocol,
  type RedisKeyState,
} from '../../../../../src/shared/protocols/redis-key';
import { RpcPeer } from '../../../../../src/shared/rpc';
import App from '../../../../../webview/src/apps/redis-key/App.svelte';
import { createTranslator } from '../../../../../webview/src/lib/i18n';
import { createLinkedTransports, flush } from '../../../../helpers/rpc';

type HostPeer = RpcPeer<RedisKeyProtocol['host'], RedisKeyProtocol['webview']>;

const ROOT: JsonNodeInfo = { path: '$', label: '$', kind: 'object', size: 4 };

function node(path: string, label: string, kind: string, extra: Partial<JsonNodeInfo> = {}) {
  return { path, label, kind, ...extra } satisfies JsonNodeInfo;
}

/** The members of the document used throughout: a small user record. */
const MEMBERS: Record<string, JsonNodeInfo[] | undefined> = {
  $: [
    node('$["name"]', 'name', 'string', { size: 3, preview: 'Ann' }),
    node('$["age"]', 'age', 'integer', { preview: '30' }),
    node('$["tags"]', 'tags', 'array', { size: 2 }),
    node('$["address"]', 'address', 'object', { size: 1 }),
  ],
  '$["tags"]': [
    node('$["tags"][0]', '0', 'string', { size: 1, preview: 'a' }),
    node('$["tags"][1]', '1', 'string', { size: 1, preview: 'b' }),
  ],
  '$["address"]': [node('$["address"]["city"]', 'city', 'string', { size: 4, preview: 'Oslo' })],
};

const TEXTS: Record<string, string> = {
  $: '{\n  "name": "Ann"\n}',
  '$["name"]': '"Ann"',
  '$["age"]': '30',
  '$["tags"]': '["a", "b"]',
  '$["address"]': '{\n  "city": "Oslo"\n}',
};

function state(overrides: Partial<RedisKeyState> = {}): RedisKeyState {
  return {
    key: { text: 'user:1' },
    database: 0,
    connectionName: 'Stack',
    readOnly: false,
    exists: true,
    type: 'ReJSON-RL',
    ttlMs: null,
    json: ROOT,
    ...overrides,
  };
}

interface Opened {
  host: HostPeer;
  /** Replaces what the host answers to the reads, once the page is open. */
  answer: {
    children?: (params: { path: string; offset: number }) => unknown;
    text?: (params: { path: string }) => unknown;
  };
  children: ReturnType<typeof vi.fn>;
  text: ReturnType<typeof vi.fn>;
  copy: ReturnType<typeof vi.fn>;
}

/** The tree has its first level. */
async function ready(): Promise<void> {
  await waitFor(() => {
    expect(screen.getAllByRole('treeitem').length).toBeGreaterThan(1);
  });
}

async function open(
  initial: RedisKeyState,
  options: {
    members?: Record<string, JsonNodeInfo[] | undefined>;
    texts?: Record<string, string>;
    page?: number;
  } = {},
): Promise<Opened> {
  const members = options.members ?? MEMBERS;
  const texts = options.texts ?? TEXTS;
  const transports = createLinkedTransports();
  const host: HostPeer = new RpcPeer({
    local: redisKeyProtocol.host,
    remote: redisKeyProtocol.webview,
    transport: transports.host,
  });
  const rpc = new RpcPeer({
    local: redisKeyProtocol.webview,
    remote: redisKeyProtocol.host,
    transport: transports.webview,
  });
  const answer: Opened['answer'] = {};
  const children = vi.fn((params: { path: string; offset: number }) => {
    if (answer.children) {
      return answer.children(params) as never;
    }
    const { path, offset } = params;
    const all = members[path] ?? [];
    const size = options.page ?? 1000;
    return {
      nodes: all.slice(offset, offset + size),
      total: all.length,
      more: offset + size < all.length,
    };
  });
  const text = vi.fn((params: { path: string }) => {
    if (answer.text) {
      return answer.text(params) as never;
    }
    const { path } = params;
    const found = texts[path];
    if (found === undefined) {
      throw new Error('The path no longer exists: refresh the key');
    }
    return { text: found };
  });
  const copy = vi.fn(() => ({}));
  host.handle('jsonChildren', children);
  host.handle('jsonText', text);
  host.handle('copyText', copy);
  render(App, { props: { rpc, t: createTranslator('en') } });
  await flush();
  host.emit('state', initial);
  await waitFor(() => {
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeNull();
  });
  return { host, answer, children, text, copy };
}

const row = (name: string): HTMLElement => {
  const found = screen
    .getAllByRole('treeitem')
    .find((item) => item.querySelector('.name')?.textContent === name);
  if (!found) {
    throw new Error(`No row named ${name}`);
  }
  return found;
};

const names = (): string[] =>
  screen.getAllByRole('treeitem').map((item) => item.querySelector('.name')?.textContent ?? '');

describe('Redis key page: a RedisJSON document (V13.14)', () => {
  it('shows the type and a tree with the first level opened, not a list of items', async () => {
    await open(state());
    expect(screen.getByTestId('meta').textContent).toContain('ReJSON-RL');
    await waitFor(() => {
      expect(names()).toEqual(['JSON document', 'name', 'age', 'tags', 'address']);
    });
    expect(screen.queryByTestId('unsupported')).toBeNull();
    expect(screen.queryByTestId('json-unavailable')).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('writes each row with its value or its size', async () => {
    await open(state());
    await waitFor(() => {
      expect(names()).toHaveLength(5);
    });
    expect(row('name').querySelector('.value')?.textContent).toBe('"Ann"');
    expect(row('age').querySelector('.value')?.textContent).toBe('30');
    expect(row('tags').querySelector('.value')?.textContent).toBe('2 items');
    expect(row('address').querySelector('.value')?.textContent).toBe('1 members');
    expect(row('JSON document').querySelector('.value')?.textContent).toBe('4 members');
  });

  it('opens a node when it is asked, once, and closes it again', async () => {
    const { children } = await open(state());
    await waitFor(() => {
      expect(names()).toHaveLength(5);
    });
    await fireEvent.click(within(row('tags')).getByTestId('twist'));
    await waitFor(() => {
      expect(names()).toEqual(['JSON document', 'name', 'age', 'tags', '[0]', '[1]', 'address']);
    });
    expect(children).toHaveBeenCalledWith({ path: '$["tags"]', offset: 0 });
    expect(row('tags').getAttribute('aria-expanded')).toBe('true');
    await fireEvent.click(within(row('tags')).getByTestId('twist'));
    expect(names()).toEqual(['JSON document', 'name', 'age', 'tags', 'address']);
    // Opened again, it is not read again.
    const reads = children.mock.calls.length;
    await fireEvent.click(within(row('tags')).getByTestId('twist'));
    await waitFor(() => {
      expect(names()).toContain('[0]');
    });
    expect(children.mock.calls).toHaveLength(reads);
  });

  it('gives a scalar no twist and no aria-expanded', async () => {
    await open(state());
    await waitFor(() => {
      expect(names()).toHaveLength(5);
    });
    expect(within(row('age')).queryByTestId('twist')).toBeNull();
    expect(row('age').getAttribute('aria-expanded')).toBeNull();
  });

  it('shows the text of the selected node and its path', async () => {
    const { text } = await open(state());
    await waitFor(() => {
      expect(screen.getByTestId('json-text').textContent).toBe(TEXTS.$);
    });
    await fireEvent.click(row('address'));
    await waitFor(() => {
      expect(screen.getByTestId('json-text').textContent).toBe(TEXTS['$["address"]']);
    });
    expect(screen.getByTestId('json-path').textContent).toBe('$["address"]');
    expect(text).toHaveBeenCalledWith({ path: '$["address"]' });
    expect(row('address').getAttribute('aria-selected')).toBe('true');
    expect(row('JSON document').getAttribute('aria-selected')).toBe('false');
  });

  it('copies the path and the value through the host', async () => {
    const { copy } = await open(state());
    await fireEvent.click(await screen.findByRole('treeitem', { name: /age/u }));
    await waitFor(() => {
      expect(screen.getByTestId('json-text').textContent).toBe('30');
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Copy path' }));
    await waitFor(() => {
      expect(copy).toHaveBeenCalledWith({ text: '$["age"]' });
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Copy value' }));
    await waitFor(() => {
      expect(copy).toHaveBeenCalledWith({ text: '30' });
    });
  });

  it('asks for the next page when "load more" is pressed', async () => {
    const { children } = await open(state(), { page: 2 });
    await waitFor(() => {
      expect(names()).toEqual(['JSON document', 'name', 'age']);
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Load more (2 of 4 shown)' }));
    await waitFor(() => {
      expect(names()).toEqual(['JSON document', 'name', 'age', 'tags', 'address']);
    });
    expect(children).toHaveBeenLastCalledWith({ path: '$', offset: 2 });
    expect(screen.queryByRole('button', { name: /Load more/u })).toBeNull();
  });

  it('moves with the arrow keys, opening and closing nodes', async () => {
    await open(state());
    await waitFor(() => {
      expect(names()).toHaveLength(5);
    });
    row('JSON document').focus();
    await fireEvent.keyDown(row('JSON document'), { key: 'ArrowDown' });
    await waitFor(() => {
      expect(row('name').getAttribute('aria-selected')).toBe('true');
    });
    await fireEvent.keyDown(row('name'), { key: 'End' });
    await waitFor(() => {
      expect(row('address').getAttribute('aria-selected')).toBe('true');
    });
    await fireEvent.keyDown(row('address'), { key: 'ArrowRight' });
    await waitFor(() => {
      expect(names()).toContain('city');
    });
    await fireEvent.keyDown(row('address'), { key: 'ArrowRight' });
    await waitFor(() => {
      expect(row('city').getAttribute('aria-selected')).toBe('true');
    });
    await fireEvent.keyDown(row('city'), { key: 'ArrowLeft' });
    await waitFor(() => {
      expect(row('address').getAttribute('aria-selected')).toBe('true');
    });
    await fireEvent.keyDown(row('address'), { key: 'ArrowLeft' });
    expect(names()).not.toContain('city');
    await fireEvent.keyDown(row('address'), { key: 'Home' });
    await waitFor(() => {
      expect(row('JSON document').getAttribute('aria-selected')).toBe('true');
    });
    // Up from the first row stays.
    await fireEvent.keyDown(row('JSON document'), { key: 'ArrowUp' });
    expect(row('JSON document').getAttribute('aria-selected')).toBe('true');
  });

  it('selects and opens with Enter', async () => {
    await open(state());
    await waitFor(() => {
      expect(names()).toHaveLength(5);
    });
    await fireEvent.keyDown(row('tags'), { key: 'Enter' });
    await waitFor(() => {
      expect(names()).toContain('[1]');
    });
    expect(row('tags').getAttribute('aria-selected')).toBe('true');
  });

  it('edits the value of a node and sends the text with its path', async () => {
    const { host } = await open(state());
    const set = vi.fn(() => ({}));
    host.handle('jsonSet', set);
    await ready();
    await fireEvent.click(row('age'));
    await waitFor(() => {
      expect(screen.getByTestId('json-text').textContent).toBe('30');
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Edit value' }));
    const box = screen.getByRole('textbox', { name: 'Edit value' });
    expect((box as HTMLTextAreaElement).value).toBe('30');
    await fireEvent.input(box, { target: { value: '31' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Save value' }));
    await waitFor(() => {
      expect(set).toHaveBeenCalledWith({ path: '$["age"]', text: '31' });
    });
    // Saved: the editor closes.
    await waitFor(() => {
      expect(screen.queryByRole('textbox', { name: 'Edit value' })).toBeNull();
    });
  });

  it('keeps the editor open and shows the error when the host refuses the text', async () => {
    const { host } = await open(state());
    host.handle('jsonSet', () => {
      throw new Error('Not valid JSON: Unexpected token');
    });
    await ready();
    await fireEvent.click(row('age'));
    await waitFor(() => {
      expect(screen.getByTestId('json-text')).toBeTruthy();
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Edit value' }));
    await fireEvent.input(screen.getByRole('textbox', { name: 'Edit value' }), {
      target: { value: '{oops' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Save value' }));
    await waitFor(() => {
      expect(screen.getByTestId('error').textContent).toContain('Not valid JSON');
    });
    expect(screen.getByRole('textbox', { name: 'Edit value' })).toBeTruthy();
    // Cancelling leaves the text as it was.
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('textbox', { name: 'Edit value' })).toBeNull();
  });

  it('asks before it deletes a node, then sends the path', async () => {
    const { host } = await open(state());
    const remove = vi.fn(() => ({}));
    host.handle('jsonDelete', remove);
    await ready();
    await fireEvent.click(row('tags'));
    await waitFor(() => {
      expect(screen.getByTestId('json-path').textContent).toBe('$["tags"]');
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(remove).not.toHaveBeenCalled();
    expect(screen.getByTestId('json-confirm').textContent).toContain('$["tags"]');
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('json-confirm')).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Yes, delete' }));
    await waitFor(() => {
      expect(remove).toHaveBeenCalledWith({ path: '$["tags"]' });
    });
  });

  it('cannot delete the root: that is deleting the key', async () => {
    await open(state());
    await waitFor(() => {
      expect(screen.getByTestId('json-path').textContent).toBe('$');
    });
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit value' })).toBeTruthy();
  });

  it('offers no change on a read-only connection, but still shows and copies', async () => {
    await open(state({ readOnly: true }));
    await waitFor(() => {
      expect(screen.getByTestId('json-text')).toBeTruthy();
    });
    for (const name of ['Edit value', 'Delete', 'Delete key']) {
      expect(screen.queryByRole('button', { name }), name).toBeNull();
    }
    expect(screen.getByRole('button', { name: 'Copy path' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy value' })).toBeTruthy();
  });

  it('reads what was opened again after the key was read again', async () => {
    const { host, children, text } = await open(state());
    await waitFor(() => {
      expect(names()).toHaveLength(5);
    });
    await fireEvent.click(within(row('tags')).getByTestId('twist'));
    await waitFor(() => {
      expect(names()).toContain('[1]');
    });
    await fireEvent.click(row('tags'));
    await waitFor(() => {
      expect(screen.getByTestId('json-text').textContent).toBe('["a", "b"]');
    });
    children.mockClear();
    text.mockClear();
    host.emit('state', state({ json: { ...ROOT, size: 5 } }));
    await waitFor(() => {
      expect(children).toHaveBeenCalledWith({ path: '$', offset: 0 });
      expect(children).toHaveBeenCalledWith({ path: '$["tags"]', offset: 0 });
      expect(text).toHaveBeenCalledWith({ path: '$["tags"]' });
    });
    expect(row('JSON document').querySelector('.value')?.textContent).toBe('5 members');
    // The tree is still open where it was.
    expect(names()).toContain('[1]');
  });

  it('falls back to the document when the selected node was removed elsewhere', async () => {
    const texts = { ...TEXTS };
    const { host } = await open(state(), { texts });
    await ready();
    await fireEvent.click(row('age'));
    await waitFor(() => {
      expect(screen.getByTestId('json-path').textContent).toBe('$["age"]');
    });
    delete texts['$["age"]'];
    host.emit('state', state());
    await waitFor(() => {
      expect(screen.getByTestId('json-path').textContent).toBe('$');
    });
  });

  it('shows the reason a node cannot be listed, and closes it', async () => {
    const { answer } = await open(state());
    await waitFor(() => {
      expect(names()).toHaveLength(5);
    });
    answer.children = () => {
      throw new Error('The path no longer exists: refresh the key');
    };
    await fireEvent.click(within(row('tags')).getByTestId('twist'));
    await waitFor(() => {
      expect(screen.getByTestId('json-problem').textContent).toContain('no longer exists');
    });
    expect(row('tags').getAttribute('aria-expanded')).toBe('false');
  });

  it('says a part is too big to show, and offers no editing of it', async () => {
    const { answer } = await open(state());
    answer.text = () => ({ text: '', tooLarge: 6 * 1024 * 1024 });
    await ready();
    await fireEvent.click(row('address'));
    await waitFor(() => {
      expect(screen.getByTestId('json-too-large').textContent).toContain('6.0 MB');
    });
    expect(screen.queryByRole('button', { name: 'Edit value' })).toBeNull();
    expect(screen.queryByTestId('json-text')).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy value' }).hasAttribute('disabled')).toBe(true);
  });

  it('shows cut text with a note, and cannot edit it', async () => {
    const { answer } = await open(state());
    answer.text = () => ({ text: '{"a":', truncated: true });
    await ready();
    await fireEvent.click(row('address'));
    await waitFor(() => {
      expect(screen.getByTestId('json-text').textContent).toBe('{"a":');
    });
    expect(screen.getByText('Only the start of the text is shown.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit value' })).toBeNull();
  });

  it('explains a document that cannot be read, without a tree', async () => {
    await open(state({ json: undefined, jsonError: "ERR unknown command 'JSON.TYPE'" }));
    const notice = screen.getByTestId('json-unavailable').textContent;
    expect(notice).toContain("unknown command 'JSON.TYPE'");
    expect(notice).toContain('RedisJSON module');
    expect(screen.queryByTestId('json-view')).toBeNull();
    // TTL, rename and delete still work around it.
    expect(screen.getByRole('button', { name: 'Delete key' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Rename' })).toBeTruthy();
  });

  it('shows an empty document as a root with no members', async () => {
    await open(state({ json: { path: '$', label: '$', kind: 'object', size: 0 } }), {
      texts: { $: '{}' },
    });
    await waitFor(() => {
      expect(screen.getByTestId('json-text').textContent).toBe('{}');
    });
    expect(names()).toEqual(['JSON document']);
    expect(within(row('JSON document')).queryByTestId('twist')).toBeNull();
  });

  it('shows a scalar document by its value', async () => {
    await open(state({ json: { path: '$', label: '$', kind: 'integer', preview: '42' } }), {
      texts: { $: '42' },
    });
    await waitFor(() => {
      expect(screen.getByTestId('json-text').textContent).toBe('42');
    });
    expect(row('JSON document').querySelector('.value')?.textContent).toBe('42');
  });

  it('writes the strings of the page in Russian', async () => {
    const transports = createLinkedTransports();
    const host: HostPeer = new RpcPeer({
      local: redisKeyProtocol.host,
      remote: redisKeyProtocol.webview,
      transport: transports.host,
    });
    const rpc = new RpcPeer({
      local: redisKeyProtocol.webview,
      remote: redisKeyProtocol.host,
      transport: transports.webview,
    });
    host.handle('jsonChildren', ({ path }) => ({
      nodes: MEMBERS[path] ?? [],
      total: MEMBERS[path]?.length ?? 0,
      more: false,
    }));
    host.handle('jsonText', () => ({ text: '{}' }));
    render(App, { props: { rpc, t: createTranslator('ru') } });
    await flush();
    host.emit('state', state());
    await waitFor(() => {
      expect(screen.getAllByRole('treeitem').length).toBe(5);
    });
    expect(row('JSON-документ').querySelector('.value')?.textContent).toBe('Полей: 4');
    expect(row('tags').querySelector('.value')?.textContent).toBe('Элементов: 2');
    expect(screen.getByRole('button', { name: 'Копировать путь' })).toBeTruthy();
  });
});

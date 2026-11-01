// The dialogs of the etcd commands (V13.19) over the editor's own: what they ask, and
// what they make of the answers.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { etcdCommandUi } from '../../../../src/vscode/etcd/etcd-ui';
import type { ConnectionConfig } from '../../../../src/shared/connection';
import * as stub from '../../../helpers/vscode-stub';

vi.mock('vscode', () => import('../../../helpers/vscode-stub'));

const configs: Record<string, ConnectionConfig> = {
  c1: { id: 'c1', name: 'Prod etcd', driver: 'etcd', host: 'etcd.local', port: 2379 },
};
const ui = etcdCommandUi({ get: (id) => configs[id] });

beforeEach(() => {
  stub.resetWindow();
});

describe('input', () => {
  it('passes the question on and returns the answer', async () => {
    stub.window.showInputBox.mockResolvedValue('/typed');
    const answer = await ui.input({
      title: 'New Key',
      prompt: 'Name',
      value: '/start/',
      placeHolder: '/x',
    });
    expect(answer).toBe('/typed');
    expect(stub.window.showInputBox).toHaveBeenCalledWith({
      title: 'New Key',
      prompt: 'Name',
      value: '/start/',
      placeHolder: '/x',
    });
  });

  it('leaves out what was not given and checks as asked', async () => {
    stub.window.showInputBox.mockResolvedValue(undefined);
    const validate = (value: string): string | undefined => (value === '' ? 'empty' : undefined);
    expect(await ui.input({ title: 't', prompt: 'p', validate })).toBeUndefined();
    const options = stub.window.showInputBox.mock.calls[0]?.[0] as {
      validateInput?: (value: string) => string | undefined;
      value?: string;
    };
    expect(options.value).toBeUndefined();
    expect(options.validateInput?.('')).toBe('empty');
    expect(options.validateInput?.('x')).toBeUndefined();
  });
});

describe('pickKey', () => {
  const keys = [{ text: '/a' }, { text: '/b', hex: '2f62' }];

  it('lists the keys and returns the one picked', async () => {
    stub.window.showQuickPick.mockImplementation((items: { key: unknown }[]) =>
      Promise.resolve(items[1]),
    );
    const picked = await ui.pickKey({ title: 'Keys', keys, more: false });
    expect(picked).toEqual(keys[1]);
    const [items, options] = stub.window.showQuickPick.mock.calls[0] as [
      { label: string }[],
      { title: string; placeHolder: string },
    ];
    expect(items.map((item) => item.label)).toEqual(['/a', '/b']);
    expect(options.title).toBe('Keys');
    expect(options.placeHolder).toBe('2 keys');
  });

  it('says the list was cut when there are more', async () => {
    stub.window.showQuickPick.mockResolvedValue(undefined);
    expect(await ui.pickKey({ title: 'Keys', keys, more: true })).toBeUndefined();
    const options = stub.window.showQuickPick.mock.calls[0]?.[1] as { placeHolder: string };
    expect(options.placeHolder).toContain('The first 2 keys');
  });
});

describe('confirm', () => {
  it('is true only when the user takes the action', async () => {
    stub.window.showWarningMessage.mockResolvedValue('Delete');
    expect(await ui.confirm('Delete it?', 'detail', 'Delete')).toBe(true);
    expect(stub.window.showWarningMessage).toHaveBeenCalledWith(
      'Delete it?',
      { modal: true, detail: 'detail' },
      'Delete',
    );
    stub.window.showWarningMessage.mockResolvedValue(undefined);
    expect(await ui.confirm('Delete it?', undefined, 'Delete')).toBe(false);
    expect(stub.window.showWarningMessage).toHaveBeenLastCalledWith(
      'Delete it?',
      { modal: true },
      'Delete',
    );
  });
});

describe('pickConnection', () => {
  it('names each connection and says where it is', async () => {
    stub.window.showQuickPick.mockImplementation((items: { id: string }[]) =>
      Promise.resolve(items[0]),
    );
    expect(await ui.pickConnection(['c1', 'gone'])).toBe('c1');
    const items = stub.window.showQuickPick.mock.calls[0]?.[0] as {
      label: string;
      description: string;
    }[];
    expect(items[0]).toMatchObject({ label: 'Prod etcd', description: 'etcd.local:2379' });
    expect(items[1]).toMatchObject({ label: 'gone', description: '' });
  });

  it('is undefined when the user backs out', async () => {
    stub.window.showQuickPick.mockResolvedValue(undefined);
    expect(await ui.pickConnection(['c1'])).toBeUndefined();
  });
});

describe('info', () => {
  it('shows a message', () => {
    ui.info('Nothing to delete');
    expect(stub.window.showInformationMessage).toHaveBeenCalledWith('Nothing to delete');
  });
});

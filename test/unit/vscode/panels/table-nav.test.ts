import type * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
  executeCommand: vi.fn<(command: string, ...args: unknown[]) => Promise<unknown>>(),
  showWarningMessage: vi.fn<(...args: unknown[]) => Promise<string | undefined>>(),
}));

vi.mock('vscode', () => ({
  commands: { executeCommand: host.executeCommand },
  window: { showWarningMessage: host.showWarningMessage },
  l10n: { t: (text: string) => text },
}));

import { COMMAND_IDS } from '../../../../src/vscode/command-ids';
import {
  clearOffer,
  guardPanel,
  hasOfferedPanel,
  isGuarded,
  takeOffer,
} from '../../../../src/vscode/panels/panel-handoff';
import { navigateTable, onTableNav } from '../../../../src/vscode/panels/table-nav';

function guardedTab() {
  const closed = vi.fn();
  const listeners: (() => void)[] = [];
  const tab = {
    onDidDispose: (listener: () => void) => {
      listeners.push(listener);
      return { dispose: () => undefined };
    },
    dispose: () => undefined,
    webview: {},
  } as unknown as vscode.WebviewPanel;
  const guard = guardPanel(tab);
  guard.onDidDispose(closed);
  return { guard, tab, closed };
}

const CALL = {
  command: 'datanest.table.design',
  args: [{ table: 'orders' }],
  page: 'properties' as const,
  isView: false,
};

beforeEach(() => {
  host.executeCommand.mockResolvedValue(undefined);
});

afterEach(() => {
  clearOffer();
  host.executeCommand.mockReset();
  host.showWarningMessage.mockReset();
});

describe('navigateTable', () => {
  it('offers the tab while the target opens, so the target takes it', async () => {
    const { guard, tab, closed } = guardedTab();
    let taken: unknown;
    host.executeCommand.mockImplementation(() => {
      // The target page creating its panel.
      taken = takeOffer('table-designer');
      return Promise.resolve(undefined);
    });
    await navigateTable(guard, CALL, false);
    expect(host.executeCommand).toHaveBeenCalledWith(CALL.command, ...CALL.args);
    expect(taken).toEqual({ panel: tab, bar: { page: 'properties', isView: false } });
    expect(closed).toHaveBeenCalledTimes(1);
    expect(hasOfferedPanel()).toBe(false);
  });

  it('leaves the old page alone when nobody takes the tab', async () => {
    const { guard, closed } = guardedTab();
    await navigateTable(guard, CALL, false);
    expect(hasOfferedPanel()).toBe(false);
    expect(isGuarded(guard)).toBe(true);
    expect(closed).not.toHaveBeenCalled();
  });

  it('withdraws the offer when the command fails', async () => {
    const { guard } = guardedTab();
    host.executeCommand.mockRejectedValue(new Error('boom'));
    await expect(navigateTable(guard, CALL, false)).rejects.toThrow('boom');
    expect(hasOfferedPanel()).toBe(false);
    expect(isGuarded(guard)).toBe(true);
  });

  it('asks before leaving unsaved changes, and stays when the user declines', async () => {
    const { guard } = guardedTab();
    host.showWarningMessage.mockResolvedValue(undefined);
    await navigateTable(guard, CALL, true);
    expect(host.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(host.executeCommand).not.toHaveBeenCalled();
    expect(hasOfferedPanel()).toBe(false);
  });

  it('goes on after the user agrees to leave', async () => {
    const { guard } = guardedTab();
    host.showWarningMessage.mockResolvedValue('Leave');
    await navigateTable(guard, CALL, true);
    expect(host.executeCommand).toHaveBeenCalledTimes(1);
  });

  it('does not ask when nothing is unsaved', async () => {
    const { guard } = guardedTab();
    await navigateTable(guard, CALL, false);
    expect(host.showWarningMessage).not.toHaveBeenCalled();
  });

  it('keeps the history out of the hand-over: it is a quick pick over the page', async () => {
    const { guard } = guardedTab();
    let offered = true;
    host.executeCommand.mockImplementation(() => {
      offered = hasOfferedPanel();
      return Promise.resolve(undefined);
    });
    await navigateTable(
      guard,
      { command: COMMAND_IDS.showHistory, args: [{ table: 'orders' }] },
      true,
    );
    expect(offered).toBe(false);
    expect(host.showWarningMessage).not.toHaveBeenCalled();
  });
});

describe('onTableNav', () => {
  const view = {
    target: { connectionId: 'c1', database: 'shop' },
    table: { name: 'orders', schema: 'public' },
  } as never;

  it('ignores a page without a table and the button of the page itself', () => {
    const { guard } = guardedTab();
    onTableNav(guard, 'properties', undefined, { action: 'er', dirty: false });
    onTableNav(guard, 'properties', view, { action: 'properties', dirty: false });
    expect(host.executeCommand).not.toHaveBeenCalled();
  });

  it('runs the action of another button', async () => {
    const { guard } = guardedTab();
    onTableNav(guard, 'properties', view, { action: 'er', dirty: false });
    await vi.waitFor(() => {
      expect(host.executeCommand).toHaveBeenCalledTimes(1);
    });
  });
});

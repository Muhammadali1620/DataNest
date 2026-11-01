import { beforeEach, describe, expect, it, vi } from 'vitest';

const host: { dragNames: boolean } = vi.hoisted(() => ({ dragNames: true }));

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({
      get: (_key: string, fallback: boolean) => (host.dragNames ? fallback : false),
    }),
  },
  window: { showErrorMessage: () => undefined },
  l10n: { t: (text: string) => text },
  DataTransferItem: class {
    constructor(readonly value: unknown) {}
  },
}));

import { mysqlDialect } from '../../../../src/drivers/mysql/dialect';
import { postgresDialect } from '../../../../src/drivers/postgres/dialect';
import {
  ConnectionsDragAndDrop,
  CONNECTIONS_MIME,
} from '../../../../src/vscode/tree/connection-dnd';
import type { TreeNode } from '../../../../src/vscode/tree/nodes';
import { RecordingLogger } from '../../../helpers/fakes';

class Transfer {
  readonly items = new Map<string, { value: unknown }>();
  set(mime: string, item: { value: unknown }): void {
    this.items.set(mime, item);
  }
}

const table = (connectionId: string, name: string): TreeNode => ({
  kind: 'table',
  connectionId,
  scope: {},
  name,
  tableKind: 'table',
});

function controller(dialectOf?: (id: string) => Promise<typeof mysqlDialect>) {
  const store = { projectOf: () => undefined, get: () => undefined } as never;
  return new ConnectionsDragAndDrop(store, new RecordingLogger(), dialectOf);
}

async function drag(dnd: ConnectionsDragAndDrop, nodes: TreeNode[]): Promise<Transfer> {
  const transfer = new Transfer();
  await dnd.handleDrag(nodes, transfer as never);
  return transfer;
}

describe('dragging names out of the tree (V13.4)', () => {
  beforeEach(() => {
    host.dragNames = true;
  });

  const dialects = { m: mysqlDialect, p: postgresDialect };
  const lookup = (id: string) => Promise.resolve(dialects[id as 'm' | 'p']);

  it('offers plain text next to the tree’s own type', () => {
    expect(controller().dragMimeTypes).toEqual([CONNECTIONS_MIME, 'text/plain']);
  });

  it('puts the quoted names of the dragged nodes into the text', async () => {
    const transfer = await drag(controller(lookup), [table('m', 'a b'), table('p', 'c')]);
    expect(transfer.items.get('text/plain')?.value).toBe('`a b`\n"c"');
  });

  it('writes nothing for nodes that are not names', async () => {
    const transfer = await drag(controller(lookup), [
      { kind: 'connection', connectionId: 'm' },
      { kind: 'connectionFolder', folder: 'Work' },
    ]);
    expect(transfer.items.has('text/plain')).toBe(false);
  });

  it('takes the real node out of a favorites entry', async () => {
    const entry = { kind: 'favorite', via: '', target: table('m', 'fav') } as unknown as TreeNode;
    const transfer = await drag(controller(lookup), [entry]);
    expect(transfer.items.get('text/plain')?.value).toBe('`fav`');
  });

  it('is off with the setting, and without a way to find a dialect', async () => {
    host.dragNames = false;
    expect((await drag(controller(lookup), [table('m', 'a')])).items.has('text/plain')).toBe(false);
    host.dragNames = true;
    expect((await drag(controller(), [table('m', 'a')])).items.has('text/plain')).toBe(false);
  });

  it('skips a connection whose dialect cannot be had, keeps the others', async () => {
    const transfer = await drag(
      controller((id) => (id === 'bad' ? Promise.reject(new Error('gone')) : lookup(id))),
      [table('bad', 'x'), table('m', 'y')],
    );
    expect(transfer.items.get('text/plain')?.value).toBe('`y`');
  });

  it('still drags connections for moving, as before', async () => {
    const transfer = await drag(controller(lookup), [{ kind: 'connection', connectionId: 'm' }]);
    expect(transfer.items.has(CONNECTIONS_MIME)).toBe(true);
    expect(transfer.items.has('text/plain')).toBe(false);
  });
});

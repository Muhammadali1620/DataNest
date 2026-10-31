import { describe, expect, it, vi } from 'vitest';
import type { ObjectRef } from '../../../../src/core/model/objects';
import type { SchemaAction } from '../../../../src/services/schema-actions';
import type { DriverId } from '../../../../src/shared/connection';
import { objectEditHandlers, ObjectEditRegistry } from '../../../../src/vscode/editor/object-edit';
import type { TreeNode } from '../../../../src/vscode/tree/nodes';
import type { PerformOutcome } from '../../../../src/vscode/tree/schema-commands';

function setup(options: { driver?: DriverId; outcome?: PerformOutcome } = {}) {
  const registry = new ObjectEditRegistry();
  const texts = new Map<string, string>();
  const opened: { binding: unknown; text: string }[] = [];
  const infos: string[] = [];
  let definition = ['CREATE PROCEDURE p() SELECT 1'];
  const reads: ObjectRef[] = [];
  const perform = vi.fn(
    (_connectionId: string, _action: SchemaAction, _title: string, _label: string) =>
      Promise.resolve(options.outcome ?? 'ran'),
  );
  const handlers = objectEditHandlers({
    manager: { driverOf: () => Promise.resolve({ id: options.driver ?? 'mysql' } as never) },
    registry,
    readDefinition: (_connectionId, object) => {
      reads.push(object);
      return Promise.resolve([...definition]);
    },
    renderDefinition: (_connectionId, statements) =>
      Promise.resolve(`${statements.join(';\n')};\n`),
    openDocument: (binding, text) => {
      opened.push({ binding, text });
      const uri = `untitled:${opened.length}`;
      texts.set(uri, text);
      return Promise.resolve(uri);
    },
    textOf: (uri) => texts.get(uri),
    perform,
    info: (message) => {
      infos.push(message);
    },
    texts: {
      applyTitle: (name) => `replace ${name}?`,
      apply: 'Apply',
      notAnObjectEditor: 'not an editor',
      nothingToApply: 'nothing',
    },
  });
  return {
    handlers,
    registry,
    texts,
    opened,
    infos,
    perform,
    reads,
    setDefinition: (next: string[]) => {
      definition = next;
    },
  };
}

const procedure: TreeNode = {
  kind: 'object',
  connectionId: 'c1',
  object: { database: 'shop', kind: 'procedure', name: 'p' },
};

describe('editObject', () => {
  it('opens an object named directly, as the table page does for a trigger', async () => {
    const { handlers, opened, registry } = setup();
    const trigger: ObjectRef = { database: 'shop', kind: 'trigger', name: 'trg', table: 'o' };
    await handlers.editObject('c1', trigger);
    expect(opened).toHaveLength(1);
    expect(opened[0]?.binding).toEqual({ connectionId: 'c1', database: 'shop' });
    expect(registry.get('untitled:1')).toMatchObject({ connectionId: 'c1', object: trigger });
  });

  it('does nothing for a kind that is not edited as text', async () => {
    const { handlers, opened } = setup();
    await handlers.editObject('c1', { kind: 'table', name: 't' });
    expect(opened).toHaveLength(0);
  });
});

describe('edit', () => {
  it('opens the definition on the same connection and remembers the object', async () => {
    const { handlers, opened, registry } = setup();
    await handlers.edit(procedure);
    expect(opened).toEqual([
      {
        binding: { connectionId: 'c1', database: 'shop' },
        text: 'CREATE PROCEDURE p() SELECT 1;\n',
      },
    ]);
    expect(registry.get('untitled:1')).toEqual({
      connectionId: 'c1',
      object: { database: 'shop', kind: 'procedure', name: 'p' },
      original: ['CREATE PROCEDURE p() SELECT 1'],
    });
  });

  it('edits views, materialized ones included, but not tables or sequences', async () => {
    const { handlers, opened } = setup();
    await handlers.edit({
      kind: 'table',
      connectionId: 'c1',
      scope: {},
      name: 'mv',
      tableKind: 'view',
      materialized: true,
    });
    expect(opened).toHaveLength(1);
    await handlers.edit({
      kind: 'table',
      connectionId: 'c1',
      scope: {},
      name: 't',
      tableKind: 'table',
    });
    await handlers.edit({
      kind: 'object',
      connectionId: 'c1',
      object: { kind: 'sequence', name: 's' },
    });
    await handlers.edit({ kind: 'connection', connectionId: 'c1' });
    await handlers.edit();
    expect(opened).toHaveLength(1);
  });
});

describe('apply', () => {
  it('replaces the object with the statements of the editor', async () => {
    const harness = setup();
    await harness.handlers.edit(procedure);
    harness.texts.set(
      'untitled:1',
      'DELIMITER //\nCREATE PROCEDURE p()\nBEGIN\n  SELECT 2;\nEND//\nDELIMITER ;\n',
    );
    expect(await harness.handlers.apply('untitled:1')).toBe('ran');
    expect(harness.perform).toHaveBeenCalledWith(
      'c1',
      {
        kind: 'replaceObject',
        object: { database: 'shop', kind: 'procedure', name: 'p' },
        statements: ['CREATE PROCEDURE p()\nBEGIN\n  SELECT 2;\nEND'],
        original: ['CREATE PROCEDURE p() SELECT 1'],
      },
      'replace p?',
      'Apply',
    );
  });

  it('takes the new definition as the one to restore next time', async () => {
    const harness = setup();
    await harness.handlers.edit(procedure);
    harness.setDefinition(['CREATE PROCEDURE p() SELECT 2']);
    await harness.handlers.apply('untitled:1');
    expect(harness.registry.get('untitled:1')?.original).toEqual(['CREATE PROCEDURE p() SELECT 2']);
  });

  it('keeps the old definition when the dialog is dismissed', async () => {
    const harness = setup({ outcome: 'cancelled' });
    await harness.handlers.edit(procedure);
    harness.setDefinition(['changed elsewhere']);
    expect(await harness.handlers.apply('untitled:1')).toBe('cancelled');
    expect(harness.registry.get('untitled:1')?.original).toEqual(['CREATE PROCEDURE p() SELECT 1']);
  });

  it('says so for an editor that edits no object, or an empty one', async () => {
    const harness = setup();
    expect(await harness.handlers.apply('untitled:9')).toBeUndefined();
    expect(await harness.handlers.apply()).toBeUndefined();
    await harness.handlers.edit(procedure);
    harness.texts.set('untitled:1', '  -- nothing\n');
    expect(await harness.handlers.apply('untitled:1')).toBeUndefined();
    expect(harness.infos).toEqual(['not an editor', 'not an editor', 'nothing']);
    expect(harness.perform).not.toHaveBeenCalled();
  });
});

describe('ObjectEditRegistry', () => {
  it('tells listeners about new and forgotten editors only', () => {
    const registry = new ObjectEditRegistry();
    const listener = vi.fn();
    const subscription = registry.onDidChange(listener);
    registry.set('u', { connectionId: 'c', object: { kind: 'view', name: 'v' }, original: [] });
    registry.forget('u');
    registry.forget('u');
    expect(listener).toHaveBeenCalledTimes(2);
    subscription.dispose();
    registry.set('u', { connectionId: 'c', object: { kind: 'view', name: 'v' }, original: [] });
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

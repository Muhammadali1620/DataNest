// Editing a view, routine, trigger or event as SQL: the definition opens in an
// editor that remembers which object it edits, and "Apply" puts the edited text in
// place of the object. Free of `vscode`, so the flow is unit-tested.

import type { ObjectRef } from '../../core/model/objects';
import { splitStatements } from '../../core/sql/split';
import type { ConnectionManager } from '../../services/connection-manager';
import type { SchemaAction } from '../../services/schema-actions';
import type { DocumentBinding } from './document-bindings';
import { isTreeNode, objectRefOf } from '../tree/nodes';
import type { CommandTarget } from '../tree/tree-commands';
import type { PerformOutcome } from '../tree/schema-commands';

/** Kinds whose definition is edited as text; tables have the designer instead. */
const EDITABLE: ReadonlySet<ObjectRef['kind']> = new Set([
  'view',
  'function',
  'procedure',
  'trigger',
  'event',
]);

export interface ObjectEdit {
  readonly connectionId: string;
  readonly object: ObjectRef;
  /** The definition as it is in the database: what a failed MySQL replace restores. */
  original: readonly string[];
}

/** Which open documents edit which object. */
export class ObjectEditRegistry {
  private readonly edits = new Map<string, ObjectEdit>();
  private readonly listeners = new Set<() => void>();

  get(documentUri: string): ObjectEdit | undefined {
    return this.edits.get(documentUri);
  }

  set(documentUri: string, edit: ObjectEdit): void {
    this.edits.set(documentUri, edit);
    this.notify();
  }

  forget(documentUri: string): void {
    if (this.edits.delete(documentUri)) {
      this.notify();
    }
  }

  /** Called whenever a document starts or stops editing an object. */
  onDidChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}

export interface ObjectEditTexts {
  applyTitle(name: string): string;
  readonly apply: string;
  readonly notAnObjectEditor: string;
  readonly nothingToApply: string;
}

export interface ObjectEditDeps {
  readonly manager: Pick<ConnectionManager, 'driverOf'>;
  readonly registry: ObjectEditRegistry;
  /** The definition of an object, read now, as statements. */
  readonly readDefinition: (connectionId: string, object: ObjectRef) => Promise<string[]>;
  /** The definition as the text of an editor (MySQL bodies get a DELIMITER). */
  readonly renderDefinition: (
    connectionId: string,
    statements: readonly string[],
  ) => Promise<string>;
  /** Opens a SQL editor with this text; resolves to its document URI. */
  readonly openDocument: (binding: DocumentBinding, text: string) => Promise<string>;
  readonly textOf: (documentUri: string) => string | undefined;
  readonly perform: (
    connectionId: string,
    action: SchemaAction,
    title: string,
    runLabel: string,
  ) => Promise<PerformOutcome>;
  readonly info: (message: string) => void;
  readonly texts: ObjectEditTexts;
}

export function objectEditHandlers(deps: ObjectEditDeps): {
  edit: (target?: CommandTarget) => Promise<void>;
  apply: (documentUri?: string) => Promise<PerformOutcome | undefined>;
} {
  return {
    /** Opens the definition of a view, routine, trigger or event for editing. */
    edit: async (target) => {
      if (!isTreeNode(target) || !('connectionId' in target) || target.connectionId === undefined) {
        return;
      }
      const object = objectRefOf(target);
      if (object === undefined || !EDITABLE.has(object.kind)) {
        return;
      }
      const { connectionId } = target;
      const original = await deps.readDefinition(connectionId, object);
      const text = await deps.renderDefinition(connectionId, original);
      const documentUri = await deps.openDocument(
        object.database === undefined
          ? { connectionId }
          : { connectionId, database: object.database },
        text,
      );
      deps.registry.set(documentUri, { connectionId, object, original });
    },

    /** Replaces the object with the text of its editor, after showing what will run. */
    apply: async (documentUri) => {
      const edit = documentUri === undefined ? undefined : deps.registry.get(documentUri);
      const text = documentUri === undefined ? undefined : deps.textOf(documentUri);
      if (edit === undefined || text === undefined) {
        deps.info(deps.texts.notAnObjectEditor);
        return undefined;
      }
      const driver = await deps.manager.driverOf(edit.connectionId);
      const statements = splitStatements(text, driver.id).map((statement) => statement.text);
      if (statements.length === 0) {
        deps.info(deps.texts.nothingToApply);
        return undefined;
      }
      const outcome = await deps.perform(
        edit.connectionId,
        { kind: 'replaceObject', object: edit.object, statements, original: edit.original },
        deps.texts.applyTitle(edit.object.name),
        deps.texts.apply,
      );
      if (outcome === 'ran') {
        // The next apply must restore what is in the database now, not what was before.
        edit.original = await deps
          .readDefinition(edit.connectionId, edit.object)
          .catch(() => [...statements]);
      }
      return outcome;
    },
  };
}

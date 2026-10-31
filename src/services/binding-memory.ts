// Which connection and database each saved SQL file talks to (V10.2.2), so a file
// opened again — after a restart too — is bound as it was. Kept in the workspace state;
// untitled documents are not kept: they do not survive a restart anyway. Records of a
// deleted connection are harmless (its id is never used again) and age out.

import type { KeyValueState } from './connection-store';
import type { SessionTarget } from './connection-manager';

const STATE_KEY = 'datanest.documentBindings';

/** Files kept; the ones bound longest ago are forgotten first. */
export const MAX_REMEMBERED_FILES = 1000;

/** URI schemes of documents that live on as files. */
const KEPT_SCHEMES: readonly string[] = ['file:', 'vscode-remote:'];

/** True for a document whose binding is worth keeping: a file, not an untitled buffer. */
export function isKeptDocument(documentUri: string): boolean {
  return KEPT_SCHEMES.some((scheme) => documentUri.startsWith(scheme));
}

type Stored = readonly (readonly [string, SessionTarget])[];

function isTarget(value: unknown): value is SessionTarget {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { connectionId, database } = value as Record<string, unknown>;
  return (
    typeof connectionId === 'string' &&
    connectionId !== '' &&
    (database === undefined || typeof database === 'string')
  );
}

function isStored(value: unknown): value is Stored {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === 'string' &&
        isTarget(entry[1]),
    )
  );
}

function sameTarget(a: SessionTarget | undefined, b: SessionTarget): boolean {
  return a?.connectionId === b.connectionId && a.database === b.database;
}

export class BindingMemory {
  constructor(private readonly state: KeyValueState) {}

  get(documentUri: string): SessionTarget | undefined {
    return this.read().get(documentUri);
  }

  /** Keeps a file's binding; untitled documents and unchanged bindings are skipped. */
  async remember(documentUri: string, target: SessionTarget): Promise<void> {
    if (!isKeptDocument(documentUri)) {
      return;
    }
    const kept = this.read();
    if (sameTarget(kept.get(documentUri), target)) {
      return;
    }
    kept.delete(documentUri);
    kept.set(documentUri, {
      connectionId: target.connectionId,
      ...(target.database === undefined ? {} : { database: target.database }),
    });
    await this.write(kept);
  }

  /** A renamed or moved file keeps its binding under its new name. */
  async rename(from: string, to: string): Promise<void> {
    const kept = this.read();
    const target = kept.get(from);
    if (target === undefined) {
      return;
    }
    kept.delete(from);
    if (isKeptDocument(to)) {
      kept.delete(to);
      kept.set(to, target);
    }
    await this.write(kept);
  }

  private read(): Map<string, SessionTarget> {
    const stored = this.state.get(STATE_KEY);
    return new Map(isStored(stored) ? stored : []);
  }

  private async write(kept: Map<string, SessionTarget>): Promise<void> {
    await this.state.update(STATE_KEY, [...kept].slice(-MAX_REMEMBERED_FILES));
  }
}

/** How long apart the editor may close an untitled query and open the file it saved. */
export const SAVE_AS_WINDOW_MS = 3000;

/** Longer texts are not compared or held: a huge script is not saved from a new query. */
export const SAVE_AS_MAX_TEXT = 1_000_000;

interface Seen<T> {
  readonly text: string;
  readonly at: number;
  readonly value: T;
}

/**
 * "Save As" of an untitled query closes it and opens the new file, in either order and
 * without saying which file came from which. The file with the same text, within a few
 * seconds, is the one: it takes over the untitled query's binding.
 */
export class SaveAsMatcher {
  private closed: Seen<SessionTarget>[] = [];
  private opened: Seen<string>[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  /** A bound untitled query closed; returns the file it became if that opened first. */
  untitledClosed(text: string, target: SessionTarget): string | undefined {
    this.expire();
    if (text.length > SAVE_AS_MAX_TEXT) {
      return undefined;
    }
    const match = this.opened.findIndex((seen) => seen.text === text);
    if (match !== -1) {
      const [file] = this.opened.splice(match, 1);
      return file?.value;
    }
    this.closed.push({ text, at: this.now(), value: target });
    return undefined;
  }

  /** An unbound file opened; returns the binding of the query it was saved from. */
  fileOpened(documentUri: string, text: string): SessionTarget | undefined {
    this.expire();
    if (text.length > SAVE_AS_MAX_TEXT) {
      return undefined;
    }
    const match = this.closed.findIndex((seen) => seen.text === text);
    if (match !== -1) {
      const [query] = this.closed.splice(match, 1);
      return query?.value;
    }
    this.opened.push({ text, at: this.now(), value: documentUri });
    return undefined;
  }

  private expire(): void {
    const oldest = this.now() - SAVE_AS_WINDOW_MS;
    this.closed = this.closed.filter((seen) => seen.at >= oldest);
    this.opened = this.opened.filter((seen) => seen.at >= oldest);
  }
}

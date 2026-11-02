// What the file browser does with a server's files (V13.16), over any `SftpSession`. Every
// copy is a stream, so memory stays small whatever the size of the file, and every long
// task checks its abort signal between files and inside the stream.

import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform, type Readable, type Writable } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import { DbError } from '../core/errors';
import { msg } from '../core/user-message';
import { baseName, isInside, joinRemote, parentPath } from '../shared/remote-path';
import type { SftpEntry, SftpSession } from './sftp-types';

export interface TransferProgress {
  /** Files finished so far. */
  readonly files: number;
  /** Bytes moved so far. */
  readonly bytes: number;
  /** The file being moved now. */
  readonly current: string;
}

export interface TransferControl {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: TransferProgress) => void;
}

export interface TransferResult {
  readonly files: number;
  readonly folders: number;
  readonly bytes: number;
  /** Links and special files that were not followed or copied. */
  readonly skipped: number;
}

interface Counter {
  files: number;
  folders: number;
  bytes: number;
  skipped: number;
}

function newCounter(): Counter {
  return { files: 0, folders: 0, bytes: 0, skipped: 0 };
}

function cancelled(): DbError {
  return new DbError('cancelled', msg('Cancelled'));
}

function checkCancelled(control: TransferControl): void {
  if (control.signal?.aborted === true) {
    throw cancelled();
  }
}

function isAbort(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === 'AbortError';
}

/** Folders first, then names in the order people expect: `file2` before `file10`. */
export function sortEntries(entries: readonly SftpEntry[]): SftpEntry[] {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  return [...entries].sort((a, b) => {
    const folders = Number(b.kind === 'directory') - Number(a.kind === 'directory');
    return folders !== 0 ? folders : collator.compare(a.name, b.name);
  });
}

/** True when the first bytes hold a NUL, which text does not. */
export function looksBinary(data: Buffer): boolean {
  return data.subarray(0, 8000).includes(0);
}

function counting(counter: Counter, current: string, control: TransferControl): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      counter.bytes += chunk.length;
      control.onProgress?.({ files: counter.files, bytes: counter.bytes, current });
      done(null, chunk);
    },
  });
}

/** Moves one stream into another, counting the bytes; the target is removed if it fails. */
async function pump(
  from: Readable,
  to: Writable,
  counter: Counter,
  current: string,
  control: TransferControl,
  discard: () => Promise<void>,
): Promise<void> {
  try {
    await pipeline(
      from,
      counting(counter, current, control),
      to,
      control.signal === undefined ? {} : { signal: control.signal },
    );
  } catch (error) {
    from.destroy();
    to.destroy();
    await discard().catch(() => undefined);
    throw isAbort(error) ? cancelled() : error;
  }
  counter.files += 1;
  control.onProgress?.({ files: counter.files, bytes: counter.bytes, current });
}

function finish(counter: Counter): TransferResult {
  return { ...counter };
}

/** Reads a file whole, but refuses one larger than `maxBytes` before and while reading. */
export async function readLimited(
  session: SftpSession,
  path: string,
  maxBytes: number,
): Promise<Buffer> {
  const { stream, size } = await session.openRead(path);
  if (size > maxBytes) {
    stream.destroy();
    throw tooLarge(path, size, maxBytes);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const part = chunk as Buffer;
      total += part.length;
      if (total > maxBytes) {
        throw tooLarge(path, total, maxBytes);
      }
      chunks.push(part);
    }
  } finally {
    stream.destroy();
  }
  return Buffer.concat(chunks);
}

function tooLarge(path: string, size: number, maxBytes: number): DbError {
  return new DbError(
    'unsupported',
    msg(
      '{0} is {1} MB, more than the {2} MB that open in the editor. Download it instead.',
      path,
      Math.ceil(size / 1_048_576),
      Math.floor(maxBytes / 1_048_576),
    ),
  );
}

/** Writes the whole content into a file, created or emptied first. */
export async function writeBuffer(
  session: SftpSession,
  path: string,
  data: Uint8Array,
  mode?: number,
): Promise<void> {
  const out = await session.openWrite(path, mode);
  out.end(data);
  await finished(out);
}

/** The entry a path names, as its folder lists it (so a link stays a link); undefined if none. */
export async function entryAt(session: SftpSession, path: string): Promise<SftpEntry | undefined> {
  const name = baseName(path);
  return (await session.list(parentPath(path))).find((entry) => entry.name === name);
}

export async function exists(session: SftpSession, path: string): Promise<boolean> {
  return (await session.stat(path)) !== undefined;
}

/** Makes the folder if it is not there; a file in its place is an error. */
export async function ensureFolder(session: SftpSession, path: string): Promise<void> {
  const found = await session.stat(path);
  if (found === undefined) {
    await session.mkdir(path);
  } else if (found.kind !== 'directory') {
    throw new DbError('unsupported', msg('{0} on the server is a file, not a folder', path));
  }
}

/** A new empty file; one that is already there is not touched. */
export async function createEmptyFile(session: SftpSession, path: string): Promise<void> {
  if (await exists(session, path)) {
    throw new DbError('unsupported', msg('{0} already exists on the server', path));
  }
  await writeBuffer(session, path, new Uint8Array());
}

/** Copies a file or a folder of the server onto this machine. */
export async function downloadTree(
  session: SftpSession,
  remote: string,
  local: string,
  control: TransferControl = {},
): Promise<TransferResult> {
  const counter = newCounter();
  const found = await session.stat(remote);
  if (found === undefined) {
    throw new DbError('not-found', msg('{0} does not exist on the server', remote));
  }
  await downloadInto(session, remote, found.kind, local, counter, control);
  return finish(counter);
}

async function downloadInto(
  session: SftpSession,
  remote: string,
  kind: string,
  local: string,
  counter: Counter,
  control: TransferControl,
): Promise<void> {
  checkCancelled(control);
  if (kind === 'directory') {
    await mkdir(local, { recursive: true });
    counter.folders += 1;
    for (const entry of sortEntries(await session.list(remote))) {
      // A link to a folder could lead back into the tree being copied: not followed.
      if (entry.link && entry.kind === 'directory') {
        counter.skipped += 1;
      } else if (entry.kind === 'directory' || entry.kind === 'file') {
        await downloadInto(
          session,
          entry.path,
          entry.kind,
          join(local, entry.name),
          counter,
          control,
        );
      } else {
        counter.skipped += 1;
      }
    }
    return;
  }
  const { stream } = await session.openRead(remote);
  await pump(stream, createWriteStream(local), counter, remote, control, () => unlink(local));
}

/** Copies a file or a folder of this machine to the server. */
export async function uploadTree(
  session: SftpSession,
  local: string,
  remote: string,
  control: TransferControl = {},
): Promise<TransferResult> {
  const counter = newCounter();
  await uploadInto(session, local, remote, counter, control);
  return finish(counter);
}

async function uploadInto(
  session: SftpSession,
  local: string,
  remote: string,
  counter: Counter,
  control: TransferControl,
): Promise<void> {
  checkCancelled(control);
  const found = await lstat(local);
  if (found.isDirectory()) {
    await ensureFolder(session, remote);
    counter.folders += 1;
    const names = (await readdir(local)).sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      await uploadInto(session, join(local, name), joinRemote(remote, name), counter, control);
    }
    return;
  }
  if (!found.isFile()) {
    // Links and devices of this machine are not copied.
    counter.skipped += 1;
    return;
  }
  const out = await session.openWrite(remote, found.mode & 0o777);
  await pump(createReadStream(local), out, counter, local, control, () => session.unlink(remote));
}

/**
 * Copies a file or a folder between two places on servers — the same session or two. The
 * bytes pass through this machine as a stream; nothing is kept.
 */
export async function copyTree(
  from: SftpSession,
  fromEntry: Pick<SftpEntry, 'path' | 'kind' | 'link'>,
  to: SftpSession,
  toPath: string,
  control: TransferControl = {},
): Promise<TransferResult> {
  const counter = newCounter();
  if (from === to && fromEntry.kind === 'directory' && isInside(fromEntry.path, toPath)) {
    throw new DbError('unsupported', msg('A folder cannot be copied into itself'));
  }
  await copyInto(from, fromEntry.path, fromEntry.kind, to, toPath, counter, control);
  return finish(counter);
}

async function copyInto(
  from: SftpSession,
  fromPath: string,
  kind: string,
  to: SftpSession,
  toPath: string,
  counter: Counter,
  control: TransferControl,
): Promise<void> {
  checkCancelled(control);
  if (kind === 'directory') {
    await ensureFolder(to, toPath);
    counter.folders += 1;
    for (const entry of sortEntries(await from.list(fromPath))) {
      if (entry.link && entry.kind === 'directory') {
        counter.skipped += 1;
      } else if (entry.kind === 'directory' || entry.kind === 'file') {
        await copyInto(
          from,
          entry.path,
          entry.kind,
          to,
          joinRemote(toPath, entry.name),
          counter,
          control,
        );
      } else {
        counter.skipped += 1;
      }
    }
    return;
  }
  const { stream } = await from.openRead(fromPath);
  const out = await to.openWrite(toPath);
  await pump(stream, out, counter, fromPath, control, () => to.unlink(toPath));
}

/**
 * Deletes a file, a link (never what it points at) or a folder with everything in it.
 * Returns the number of things removed.
 */
export async function removeTree(
  session: SftpSession,
  entry: Pick<SftpEntry, 'path' | 'kind' | 'link'>,
  control: TransferControl = {},
): Promise<number> {
  checkCancelled(control);
  if (entry.kind !== 'directory' || entry.link) {
    await session.unlink(entry.path);
    return 1;
  }
  let removed = 0;
  for (const child of await session.list(entry.path)) {
    removed += await removeTree(session, child, control);
  }
  await session.rmdir(entry.path);
  return removed + 1;
}

/** Moves within one server: a rename, which never copies. */
export async function moveEntry(
  session: SftpSession,
  from: Pick<SftpEntry, 'path' | 'kind'>,
  to: string,
): Promise<void> {
  if (from.kind === 'directory' && isInside(from.path, to)) {
    throw new DbError('unsupported', msg('A folder cannot be moved into itself'));
  }
  if (await exists(session, to)) {
    throw new DbError('unsupported', msg('{0} already exists on the server', to));
  }
  await session.rename(from.path, to);
}

/** The name `name copy`, `name copy 2`, … that is free in the folder. */
export async function freeName(
  session: SftpSession,
  folder: string,
  name: string,
): Promise<string> {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';
  for (let attempt = 1; ; attempt += 1) {
    const candidate = `${stem} copy${attempt === 1 ? '' : ` ${attempt}`}${extension}`;
    if (!(await exists(session, joinRemote(folder, candidate)))) {
      return candidate;
    }
  }
}

/** Where a copy of `source` goes when dropped into `folder`: the same name. */
export function targetInFolder(folder: string, source: string): string {
  return joinRemote(folder, baseName(source));
}

export interface MoveOutcome {
  readonly result: TransferResult;
  /** False when the source was kept because something in it was not copied (a link, a device). */
  readonly sourceRemoved: boolean;
}

/**
 * Moves between two places that may be on different servers: a rename when it is one session,
 * otherwise a copy and then a delete of the source. The source goes only after every byte was
 * written, and is kept when the copy had to skip something (a link, a device), so that
 * nothing is lost by a "move".
 */
export async function moveTree(
  from: SftpSession,
  fromEntry: Pick<SftpEntry, 'path' | 'kind' | 'link'>,
  to: SftpSession,
  toPath: string,
  control: TransferControl = {},
): Promise<MoveOutcome> {
  if (from === to) {
    await moveEntry(from, fromEntry, toPath);
    return { result: { files: 0, folders: 0, bytes: 0, skipped: 0 }, sourceRemoved: true };
  }
  if (await exists(to, toPath)) {
    throw new DbError('unsupported', msg('{0} already exists on the server', toPath));
  }
  const result = await copyTree(from, fromEntry, to, toPath, control);
  if (result.skipped > 0) {
    return { result, sourceRemoved: false };
  }
  await removeTree(from, fromEntry, control);
  return { result, sourceRemoved: true };
}

export interface AttributeChange {
  /** New permission bits for files. */
  readonly fileMode?: number;
  /** New permission bits for folders. */
  readonly folderMode?: number;
  readonly uid?: number;
  readonly gid?: number;
}

export interface AttributeResult {
  readonly changed: number;
  /** Links, which are left alone: a change would land on what they point at. */
  readonly skipped: number;
}

type Attributed = Pick<SftpEntry, 'path' | 'kind' | 'link' | 'uid' | 'gid'>;

/**
 * Changes permissions and/or owner of an item and, for a folder, of everything inside it.
 * Links are skipped (the request would follow them out of the tree). Children change before
 * their folder, so a mode that removes access does not stop the walk.
 */
export async function changeAttributes(
  session: SftpSession,
  entry: Attributed,
  change: AttributeChange,
  recursive: boolean,
  control: TransferControl = {},
): Promise<AttributeResult> {
  const counter = { changed: 0, skipped: 0 };
  await changeInto(session, entry, change, recursive, counter, control);
  return counter;
}

async function changeInto(
  session: SftpSession,
  entry: Attributed,
  change: AttributeChange,
  recursive: boolean,
  counter: { changed: number; skipped: number },
  control: TransferControl,
): Promise<void> {
  checkCancelled(control);
  if (entry.link) {
    counter.skipped += 1;
    return;
  }
  const folder = entry.kind === 'directory';
  if (folder && recursive) {
    for (const child of await session.list(entry.path)) {
      await changeInto(session, child, change, recursive, counter, control);
    }
  }
  if (change.uid !== undefined || change.gid !== undefined) {
    // chown sets both; the one not asked for keeps what the server says it is now.
    const known =
      entry.uid === undefined || entry.gid === undefined ? await session.stat(entry.path) : entry;
    await session.chown(
      entry.path,
      change.uid ?? known?.uid ?? entry.uid ?? 0,
      change.gid ?? known?.gid ?? entry.gid ?? 0,
    );
  }
  const mode = folder ? change.folderMode : change.fileMode;
  if (mode !== undefined) {
    await session.chmod(entry.path, mode);
  }
  counter.changed += 1;
}

/** `1000:1000`, `1000` (owner only) or `:1000` (group only) as numbers; undefined if not one. */
export function parseOwner(text: string): { uid?: number; gid?: number } | undefined {
  const match = /^\s*(\d+)?\s*(?::\s*(\d+)?)?\s*$/u.exec(text);
  if (match === null || (match[1] === undefined && match[2] === undefined)) {
    return undefined;
  }
  return {
    ...(match[1] === undefined ? {} : { uid: Number(match[1]) }),
    ...(match[2] === undefined ? {} : { gid: Number(match[2]) }),
  };
}

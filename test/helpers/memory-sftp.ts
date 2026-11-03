// A read-write SFTP file system in memory, to serve from the SSH server of a test
// (`startSshServer({ sftp: fs.serve })`): folders, files, links, permissions, writes,
// renames. The file browser (V13.16) is tested against it with real logins and a real SFTP
// subsystem, no Docker.

import { type Attributes, type SFTPWrapper, utils } from 'ssh2';

const { STATUS_CODE, OPEN_MODE } = utils.sftp;

const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

interface Owner {
  uid?: number;
  gid?: number;
}

type Node =
  | ({ type: 'file'; data: Buffer; mode: number; mtime: number } & Owner)
  | ({ type: 'dir'; mode: number; mtime: number } & Owner)
  | ({ type: 'link'; target: string; mtime: number } & Owner);

interface Handle {
  readonly path: string;
  readonly dir: boolean;
  listed: boolean;
  readonly writable: boolean;
}

function normalize(path: string, home: string): string {
  const parts: string[] = [];
  const absolute = path.startsWith('/') ? path : `${home}/${path}`;
  for (const part of absolute.split('/')) {
    if (part === '' || part === '.') {
      continue;
    }
    if (part === '..') {
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return `/${parts.join('/')}`;
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash <= 0 ? '/' : path.slice(0, slash);
}

export class MemorySftpFs {
  private readonly nodes = new Map<string, Node>();
  private readonly denied = new Set<string>();
  private readonly unreadable = new Set<string>();
  /** Every request, as `VERB path`, in order. */
  readonly log: string[] = [];
  /** The time new files get; tests move it to show a change. */
  clock = 1_700_000_000;
  /** The most bytes one READ may return: keeps files larger than a single packet honest. */
  maxRead = 32 * 1024;

  constructor(readonly home = '/home/deploy') {
    this.nodes.set('/', { type: 'dir', mode: 0o755, mtime: this.clock });
    this.folder(home);
  }

  /** A folder and every folder above it. */
  folder(path: string, mode = 0o755): this {
    const full = normalize(path, this.home);
    if (!this.nodes.has(full)) {
      this.folder(parentOf(full));
      this.nodes.set(full, { type: 'dir', mode, mtime: this.clock });
    }
    return this;
  }

  /** A file with its content, in a folder that is made if needed. */
  file(path: string, content: string | Buffer = '', mode = 0o644, mtime?: number): this {
    const full = normalize(path, this.home);
    this.folder(parentOf(full));
    this.nodes.set(full, {
      type: 'file',
      data: typeof content === 'string' ? Buffer.from(content) : content,
      mode,
      mtime: mtime ?? this.clock,
    });
    return this;
  }

  link(path: string, target: string): this {
    const full = normalize(path, this.home);
    this.folder(parentOf(full));
    this.nodes.set(full, {
      type: 'link',
      target: normalize(target, parentOf(full)),
      mtime: this.clock,
    });
    return this;
  }

  /** Every request for the path, and anything below it, is refused with "permission denied". */
  deny(path: string): this {
    this.denied.add(normalize(path, this.home));
    return this;
  }

  /** The path can be seen and stat'ed, but opening it for reading is refused (a file of mode 000). */
  unreadableFile(path: string): this {
    this.unreadable.add(normalize(path, this.home));
    return this;
  }

  has(path: string): boolean {
    return this.nodes.has(normalize(path, this.home));
  }

  text(path: string): string | undefined {
    const node = this.nodes.get(normalize(path, this.home));
    return node?.type === 'file' ? node.data.toString() : undefined;
  }

  bytes(path: string): Buffer | undefined {
    const node = this.nodes.get(normalize(path, this.home));
    return node?.type === 'file' ? node.data : undefined;
  }

  modeOf(path: string): number | undefined {
    const node = this.nodes.get(normalize(path, this.home));
    return node === undefined || node.type === 'link' ? undefined : node.mode & 0o7777;
  }

  /** Numeric owner and group of a path (1000:1000 until a test changes them). */
  ownerOf(path: string): { uid: number; gid: number } | undefined {
    const node = this.nodes.get(normalize(path, this.home));
    return node === undefined ? undefined : { uid: node.uid ?? 1000, gid: node.gid ?? 1000 };
  }

  mtimeOf(path: string): number | undefined {
    return this.nodes.get(normalize(path, this.home))?.mtime;
  }

  /** Names directly inside a folder, sorted. */
  names(path: string): string[] {
    const full = normalize(path, this.home);
    return this.childrenOf(full).map(([child]) => child.slice(full === '/' ? 1 : full.length + 1));
  }

  /** The paths of everything in the file system, sorted. */
  paths(): string[] {
    return [...this.nodes.keys()].sort();
  }

  touch(path: string, mtime: number): void {
    const node = this.nodes.get(normalize(path, this.home));
    if (node !== undefined) {
      node.mtime = mtime;
    }
  }

  private childrenOf(full: string): [string, Node][] {
    const prefix = full === '/' ? '/' : `${full}/`;
    return [...this.nodes.entries()]
      .filter(
        ([path]) =>
          path !== full && path.startsWith(prefix) && !path.slice(prefix.length).includes('/'),
      )
      .sort(([a], [b]) => a.localeCompare(b));
  }

  private isDenied(path: string): boolean {
    return [...this.denied].some((root) => path === root || path.startsWith(`${root}/`));
  }

  private resolve(path: string, follow: boolean): { path: string; node: Node | undefined } {
    let current = path;
    for (let hops = 0; hops < 16; hops += 1) {
      const node = this.nodes.get(current);
      if (node?.type === 'link' && follow) {
        current = node.target;
      } else {
        return { path: current, node };
      }
    }
    return { path: current, node: undefined };
  }

  private attrs(node: Node): Attributes {
    switch (node.type) {
      case 'file':
        return {
          mode: S_IFREG | node.mode,
          uid: node.uid ?? 1000,
          gid: node.gid ?? 1000,
          size: node.data.length,
          atime: node.mtime,
          mtime: node.mtime,
        };
      case 'dir':
        return {
          mode: S_IFDIR | node.mode,
          uid: node.uid ?? 1000,
          gid: node.gid ?? 1000,
          size: 4096,
          atime: node.mtime,
          mtime: node.mtime,
        };
      case 'link':
        return {
          mode: S_IFLNK | 0o777,
          uid: node.uid ?? 1000,
          gid: node.gid ?? 1000,
          size: node.target.length,
          atime: node.mtime,
          mtime: node.mtime,
        };
    }
  }

  /** The SFTP subsystem; pass it to `startSshServer({ sftp: (s) => fs.serve(s) })`. */
  serve = (sftp: SFTPWrapper): void => {
    const handles = new Map<string, Handle>();
    let next = 0;
    const open = (handle: Handle): Buffer => {
      next += 1;
      const id = Buffer.from(String(next));
      handles.set(id.toString(), handle);
      return id;
    };
    const status = (reqid: number, code: number): void => {
      sftp.status(reqid, code);
    };
    const guard = (reqid: number, verb: string, path: string): boolean => {
      this.log.push(`${verb} ${path}`);
      if (this.isDenied(path)) {
        status(reqid, STATUS_CODE.PERMISSION_DENIED);
        return false;
      }
      return true;
    };
    const stat = (reqid: number, raw: string, follow: boolean, verb: string): void => {
      const path = normalize(raw, this.home);
      if (!guard(reqid, verb, path)) {
        return;
      }
      const { node } = this.resolve(path, follow);
      if (node === undefined) {
        status(reqid, STATUS_CODE.NO_SUCH_FILE);
      } else {
        sftp.attrs(reqid, this.attrs(node));
      }
    };
    sftp.on('REALPATH', (reqid, raw) => {
      const path = normalize(raw, this.home);
      this.log.push(`REALPATH ${path}`);
      sftp.name(reqid, [{ filename: path, longname: path, attrs: {} as Attributes }]);
    });
    sftp.on('STAT', (reqid, path) => {
      stat(reqid, path, true, 'STAT');
    });
    sftp.on('LSTAT', (reqid, path) => {
      stat(reqid, path, false, 'LSTAT');
    });
    sftp.on('OPENDIR', (reqid, raw) => {
      const path = normalize(raw, this.home);
      if (!guard(reqid, 'OPENDIR', path)) {
        return;
      }
      const { path: real, node } = this.resolve(path, true);
      if (node === undefined) {
        status(reqid, STATUS_CODE.NO_SUCH_FILE);
      } else if (node.type !== 'dir') {
        status(reqid, STATUS_CODE.FAILURE);
      } else {
        sftp.handle(reqid, open({ path: real, dir: true, listed: false, writable: false }));
      }
    });
    sftp.on('READDIR', (reqid, id) => {
      const handle = handles.get(id.toString());
      if (!handle?.dir) {
        status(reqid, STATUS_CODE.FAILURE);
        return;
      }
      if (handle.listed) {
        status(reqid, STATUS_CODE.EOF);
        return;
      }
      handle.listed = true;
      const names = this.childrenOf(handle.path).map(([path, node]) => ({
        filename: path.slice(path.lastIndexOf('/') + 1),
        longname: path,
        attrs: this.attrs(node),
      }));
      if (names.length === 0) {
        status(reqid, STATUS_CODE.EOF);
      } else {
        sftp.name(reqid, names);
      }
    });
    sftp.on('OPEN', (reqid, raw, flags) => {
      const path = normalize(raw, this.home);
      if (!guard(reqid, 'OPEN', path)) {
        return;
      }
      const { path: real, node } = this.resolve(path, true);
      const writing = (flags & (OPEN_MODE.WRITE | OPEN_MODE.APPEND)) !== 0;
      if (!writing && this.unreadable.has(real)) {
        status(reqid, STATUS_CODE.PERMISSION_DENIED);
        return;
      }
      if (node?.type === 'dir') {
        status(reqid, STATUS_CODE.FAILURE);
        return;
      }
      if (node === undefined) {
        if ((flags & OPEN_MODE.CREAT) === 0 || !this.nodes.has(parentOf(real))) {
          status(reqid, STATUS_CODE.NO_SUCH_FILE);
          return;
        }
        this.nodes.set(real, {
          type: 'file',
          data: Buffer.alloc(0),
          mode: 0o644,
          mtime: this.clock,
        });
      } else if (writing && node.type === 'file' && (flags & OPEN_MODE.TRUNC) !== 0) {
        node.data = Buffer.alloc(0);
        node.mtime = this.clock;
      }
      sftp.handle(reqid, open({ path: real, dir: false, listed: false, writable: writing }));
    });
    sftp.on('FSTAT', (reqid, id) => {
      const handle = handles.get(id.toString());
      const node = handle === undefined ? undefined : this.nodes.get(handle.path);
      if (node === undefined) {
        status(reqid, STATUS_CODE.FAILURE);
      } else {
        sftp.attrs(reqid, this.attrs(node));
      }
    });
    sftp.on('READ', (reqid, id, offset, length) => {
      const handle = handles.get(id.toString());
      const node = handle === undefined ? undefined : this.nodes.get(handle.path);
      if (node?.type !== 'file') {
        status(reqid, STATUS_CODE.FAILURE);
      } else if (offset >= node.data.length) {
        status(reqid, STATUS_CODE.EOF);
      } else {
        sftp.data(reqid, node.data.subarray(offset, offset + Math.min(length, this.maxRead)));
      }
    });
    sftp.on('WRITE', (reqid, id, offset, data) => {
      const handle = handles.get(id.toString());
      const node = handle === undefined ? undefined : this.nodes.get(handle.path);
      if (node?.type !== 'file' || handle?.writable !== true) {
        status(reqid, STATUS_CODE.PERMISSION_DENIED);
        return;
      }
      const end = offset + data.length;
      if (end > node.data.length) {
        const grown = Buffer.alloc(end);
        node.data.copy(grown);
        node.data = grown;
      }
      data.copy(node.data, offset);
      node.mtime = this.clock;
      status(reqid, STATUS_CODE.OK);
    });
    sftp.on('CLOSE', (reqid, id) => {
      handles.delete(id.toString());
      status(reqid, STATUS_CODE.OK);
    });
    sftp.on('MKDIR', (reqid, raw) => {
      const path = normalize(raw, this.home);
      if (!guard(reqid, 'MKDIR', path)) {
        return;
      }
      if (this.nodes.has(path)) {
        status(reqid, STATUS_CODE.FAILURE);
      } else if (!this.nodes.has(parentOf(path))) {
        status(reqid, STATUS_CODE.NO_SUCH_FILE);
      } else {
        this.nodes.set(path, { type: 'dir', mode: 0o755, mtime: this.clock });
        status(reqid, STATUS_CODE.OK);
      }
    });
    sftp.on('RMDIR', (reqid, raw) => {
      const path = normalize(raw, this.home);
      if (!guard(reqid, 'RMDIR', path)) {
        return;
      }
      const node = this.nodes.get(path);
      if (node?.type !== 'dir') {
        status(reqid, node === undefined ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.FAILURE);
      } else if (this.childrenOf(path).length > 0) {
        status(reqid, STATUS_CODE.FAILURE);
      } else {
        this.nodes.delete(path);
        status(reqid, STATUS_CODE.OK);
      }
    });
    sftp.on('REMOVE', (reqid, raw) => {
      const path = normalize(raw, this.home);
      if (!guard(reqid, 'REMOVE', path)) {
        return;
      }
      const node = this.nodes.get(path);
      if (node === undefined) {
        status(reqid, STATUS_CODE.NO_SUCH_FILE);
      } else if (node.type === 'dir') {
        status(reqid, STATUS_CODE.FAILURE);
      } else {
        this.nodes.delete(path);
        status(reqid, STATUS_CODE.OK);
      }
    });
    sftp.on('RENAME', (reqid, rawFrom, rawTo) => {
      const from = normalize(rawFrom, this.home);
      const to = normalize(rawTo, this.home);
      if (!guard(reqid, 'RENAME', `${from} ${to}`) || this.isDenied(to)) {
        return;
      }
      if (!this.nodes.has(from)) {
        status(reqid, STATUS_CODE.NO_SUCH_FILE);
        return;
      }
      if (this.nodes.has(to) || !this.nodes.has(parentOf(to))) {
        status(reqid, STATUS_CODE.FAILURE);
        return;
      }
      for (const [path, node] of [...this.nodes.entries()]) {
        if (path === from || path.startsWith(`${from}/`)) {
          this.nodes.delete(path);
          this.nodes.set(`${to}${path.slice(from.length)}`, node);
        }
      }
      status(reqid, STATUS_CODE.OK);
    });
    sftp.on('SETSTAT', (reqid, raw, attrs) => {
      const path = normalize(raw, this.home);
      if (!guard(reqid, 'SETSTAT', path)) {
        return;
      }
      const { node } = this.resolve(path, true);
      if (node === undefined) {
        status(reqid, STATUS_CODE.NO_SUCH_FILE);
        return;
      }
      if (node.type !== 'link' && typeof attrs.mode === 'number') {
        node.mode = attrs.mode & 0o7777;
      }
      if (typeof attrs.uid === 'number') {
        node.uid = attrs.uid;
      }
      if (typeof attrs.gid === 'number') {
        node.gid = attrs.gid;
      }
      status(reqid, STATUS_CODE.OK);
    });
    sftp.on('FSETSTAT', (reqid) => {
      status(reqid, STATUS_CODE.OK);
    });
    sftp.on('READLINK', (reqid, raw) => {
      const path = normalize(raw, this.home);
      const node = this.nodes.get(path);
      if (node?.type !== 'link') {
        status(reqid, STATUS_CODE.FAILURE);
      } else {
        sftp.name(reqid, [
          { filename: node.target, longname: node.target, attrs: {} as Attributes },
        ]);
      }
    });
  };
}

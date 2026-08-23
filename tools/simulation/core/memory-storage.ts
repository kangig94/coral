import { dirname, normalize } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  DirentLike,
  SqliteDatabasePort,
  StorageBigIntStat,
  StorageData,
  StorageEntryKind,
  StoragePort,
  TimePort,
} from '../../../src/infra/port-types.js';
import { DEFAULT_CORAL_ROOT, DEFAULT_JOBS_DIR } from './constants.js';

const SIMULATED_OWNER_UID = BigInt(process.getuid?.() ?? 0);
// A caller reading the file type out of `mode` must not disagree with `isDirectory()`.
const DIRECTORY_TYPE_BITS = 0o040000n;
const REGULAR_FILE_TYPE_BITS = 0o100000n;
const POSIX_MODE_BITS = 0o7777;

type FileIdentity = {
  dev: number;
  ino: number;
};

type FileNode = FileIdentity & {
  kind: 'file';
  content: Buffer;
  mode: number;
  mtimeMs: number;
  mtimeNs: bigint;
};

type DirectoryNode = FileIdentity & {
  kind: 'dir';
  mode: number;
  mtimeMs: number;
  mtimeNs: bigint;
};

type OpenFile = {
  path: string;
  position: number;
  mode: 'r' | 'r+' | 'w' | 'w+' | 'a' | 'wx' | 'ax';
  identity: FileIdentity;
};

export type InMemoryStorageSnapshot = {
  files: Array<[string, FileNode]>;
  directories: Array<[string, DirectoryNode]>;
  nextFd: number;
  nextIno: number;
  openFiles: Array<[number, OpenFile]>;
  lastStamp: number;
  subTickCounter: bigint;
};

export type InMemoryRoots = {
  jobsDir?: string;
  coralRoot?: string;
};

export function normalizePathForStorage(path: string): string {
  const normalized = normalize(path.replace(/\\/g, '/'));
  if (normalized === '.' || normalized === '') {
    return '/';
  }
  const absolute = normalized.startsWith('/') ? normalized : `/${normalized}`;
  return absolute.length > 1 && absolute.endsWith('/') ? absolute.slice(0, -1) : absolute;
}

function parentPath(path: string): string {
  if (path === '/') {
    return '/';
  }
  const parent = dirname(path);
  return parent === '.' ? '/' : normalizePathForStorage(parent);
}

function childName(path: string): string {
  const normalized = normalizePathForStorage(path);
  const parent = parentPath(normalized);
  return parent === '/' ? normalized.slice(1) : normalized.slice(parent.length + 1);
}

function childPath(parent: string, name: string): string {
  return parent === '/' ? `/${name}` : `${parent}/${name}`;
}

function replacePathPrefix(path: string, from: string, to: string): string | null {
  if (path === from) {
    return to;
  }
  if (!path.startsWith(`${from}/`)) {
    return null;
  }
  return `${to}${path.slice(from.length)}`;
}

function cloneFileNode(node: FileNode): FileNode {
  return {
    kind: 'file',
    content: Buffer.from(node.content),
    mode: node.mode,
    mtimeMs: node.mtimeMs,
    mtimeNs: node.mtimeNs,
    dev: node.dev,
    ino: node.ino,
  };
}

function cloneDirectoryNode(node: DirectoryNode): DirectoryNode {
  return {
    kind: 'dir',
    mode: node.mode,
    mtimeMs: node.mtimeMs,
    mtimeNs: node.mtimeNs,
    dev: node.dev,
    ino: node.ino,
  };
}

function cloneOpenFile(open: OpenFile): OpenFile {
  return {
    path: open.path,
    position: open.position,
    mode: open.mode,
    identity: { ...open.identity },
  };
}

function createErrnoError(code: string, path: string, message?: string): NodeJS.ErrnoException {
  const error = new Error(message ?? `${code}: ${path}`) as NodeJS.ErrnoException;
  error.code = code;
  error.path = path;
  return error;
}

function createUnsupportedFlagError(operation: string, flag: string, supportedFlags: string): NodeJS.ErrnoException {
  const error = new TypeError(
    `Unsupported ${operation} flag: ${flag}. Supported flags: ${supportedFlags}`,
  ) as NodeJS.ErrnoException;
  error.code = 'ERR_INVALID_ARG_VALUE';
  return error;
}

function posixMode(mode: number): number {
  return mode & POSIX_MODE_BITS;
}

function createWithUmaskMode(mode?: number): number {
  return posixMode(mode ?? 0o666) & ~process.umask();
}

function exclusiveThenChmodMode(mode?: number): number {
  return posixMode(mode ?? 0o600);
}

function durableAtomicMode(mode?: number): number {
  return mode === undefined ? createWithUmaskMode() : posixMode(mode);
}

function defaultDirectoryMode(): number {
  return 0o777 & ~process.umask();
}

export class InMemoryStorage implements StoragePort {
  private readonly files = new Map<string, FileNode>();
  private readonly directories = new Map<string, DirectoryNode>();
  private readonly childIndex = new Map<string, Set<string>>();
  private readonly openFiles = new Map<number, OpenFile>();
  private readonly sqliteDatabases = new Map<string, SqliteDatabasePort>();
  private nextFd = 100;
  private nextIno = 1;
  private lastStamp: number;
  private subTickCounter: bigint = 0n;

  private readonly time: Pick<TimePort, 'now'>;
  private readonly roots: InMemoryRoots;
  constructor(time: Pick<TimePort, 'now'>, roots: InMemoryRoots = {}) {
    this.time = time;
    this.roots = roots;
    this.lastStamp = this.time.now();
    this.directories.set('/', {
      kind: 'dir',
      mode: defaultDirectoryMode(),
      ...this.nextIdentity(),
      ...this.nextStamps(),
    });
    this.childIndex.set('/', new Set());
    this.mkdirSync(this.jobsDirRoot(), { recursive: true });
    this.mkdirSync(this.coralRoot(), { recursive: true });
  }

  snapshot(): InMemoryStorageSnapshot {
    return {
      files: [...this.files.entries()].map(([path, node]) => [path, cloneFileNode(node)]),
      directories: [...this.directories.entries()].map(([path, node]) => [path, cloneDirectoryNode(node)]),
      nextFd: this.nextFd,
      nextIno: this.nextIno,
      openFiles: [...this.openFiles.entries()].map(([fd, open]) => [fd, cloneOpenFile(open)]),
      lastStamp: this.lastStamp,
      subTickCounter: this.subTickCounter,
    };
  }

  restore(snapshot: InMemoryStorageSnapshot): void {
    this.files.clear();
    this.directories.clear();
    this.childIndex.clear();
    this.openFiles.clear();

    for (const [path, node] of snapshot.files) {
      this.files.set(path, cloneFileNode(node));
    }
    for (const [path, node] of snapshot.directories) {
      this.directories.set(path, cloneDirectoryNode(node));
    }
    for (const [fd, open] of snapshot.openFiles) {
      this.openFiles.set(fd, cloneOpenFile(open));
    }
    this.nextFd = snapshot.nextFd;
    this.nextIno = snapshot.nextIno;
    this.lastStamp = snapshot.lastStamp;
    this.subTickCounter = snapshot.subTickCounter;
    this.rebuildChildIndex();
  }

  assertReadableSync(path: string): void {
    const normalized = normalizePathForStorage(path);
    const node = this.files.get(normalized) ?? this.directories.get(normalized);
    if (node === undefined) throw createErrnoError('ENOENT', normalized);
    if ((node.mode & 0o444) === 0) {
      const error = createErrnoError('EACCES', normalized);
      error.errno = -13;
      throw error;
    }
  }

  async readFile(path: string, encoding: 'utf-8'): Promise<string> {
    return this.readFileSync(path, encoding);
  }

  readFileSync(path: string, encoding: 'utf-8'): string {
    const normalized = normalizePathForStorage(path);
    const file = this.files.get(normalized);
    if (!file) {
      if (this.directories.has(normalized)) {
        throw createErrnoError('EISDIR', normalized);
      }
      throw createErrnoError('ENOENT', normalized);
    }
    return file.content.toString(encoding);
  }

  writeFileSync(
    path: string,
    data: StorageData,
    options?: { encoding?: BufferEncoding; mode?: number; flag?: string },
  ): void {
    const normalized = normalizePathForStorage(path);
    const parent = parentPath(normalized);
    const flag = options?.flag ?? 'w';
    if (flag !== 'w' && flag !== 'w+' && flag !== 'wx' && flag !== 'a' && flag !== 'ax' && flag !== 'r+') {
      throw createUnsupportedFlagError('writeFileSync', flag, 'w, w+, wx, a, ax, r+');
    }
    const current = this.files.get(normalized);
    if ((flag === 'wx' || flag === 'ax') && (current !== undefined || this.directories.has(normalized))) {
      throw createErrnoError('EEXIST', normalized);
    }
    if (this.directories.has(normalized)) {
      throw createErrnoError('EISDIR', normalized);
    }
    if (flag === 'r+' && current === undefined) {
      throw createErrnoError('ENOENT', normalized);
    }
    this.requireDirectory(parent);
    const nextContent = bufferFromStorageData(data, options?.encoding);
    if (flag === 'a' && current !== undefined) {
      current.content = Buffer.concat([current.content, nextContent]);
      const stamps = this.nextStamps();
      current.mtimeMs = stamps.mtimeMs;
      current.mtimeNs = stamps.mtimeNs;
      this.touchAncestors(parent);
      return;
    }
    if (flag === 'r+' && current !== undefined) {
      const content = Buffer.alloc(Math.max(current.content.length, nextContent.length));
      current.content.copy(content);
      nextContent.copy(content);
      current.content = content;
      const stamps = this.nextStamps();
      current.mtimeMs = stamps.mtimeMs;
      current.mtimeNs = stamps.mtimeNs;
      this.touchAncestors(parent);
      return;
    }
    const identity = current ? fileIdentityOf(current) : this.nextIdentity();
    this.files.set(normalized, {
      kind: 'file',
      content: nextContent,
      mode: current?.mode ?? createWithUmaskMode(options?.mode),
      ...identity,
      ...this.nextStamps(),
    });
    this.registerChild(normalized);
    this.touchAncestors(parent);
  }

  renameSync(oldPath: string, newPath: string): void {
    const from = normalizePathForStorage(oldPath);
    const to = normalizePathForStorage(newPath);
    if (from === to) {
      return;
    }

    if (this.files.has(from)) {
      const parent = parentPath(to);
      this.requireDirectory(parent);
      if (this.directories.has(to)) {
        throw createErrnoError('EISDIR', to);
      }
      const existing = this.files.get(from);
      if (!existing) {
        throw createErrnoError('ENOENT', from);
      }
      this.files.delete(from);
      this.unregisterChildIfUnreferenced(from);
      this.files.set(to, {
        kind: 'file',
        content: Buffer.from(existing.content),
        mode: existing.mode,
        dev: existing.dev,
        ino: existing.ino,
        ...this.nextStamps(),
      });
      this.registerChild(to);
      this.touchAncestors(parentPath(from));
      this.touchAncestors(parent);
      for (const open of this.openFiles.values()) {
        if (open.path === from) {
          open.path = to;
        }
      }
      return;
    }

    if (!this.directories.has(from)) {
      throw createErrnoError('ENOENT', from);
    }
    if (to.startsWith(`${from}/`)) {
      throw createErrnoError('EINVAL', to);
    }

    const targetParent = parentPath(to);
    this.requireDirectory(targetParent);
    if (this.files.has(to)) {
      this.files.delete(to);
      this.unregisterChild(to);
    }
    if (this.directories.has(to)) {
      this.rmSync(to, { recursive: true, force: true });
    }

    const subtree = this.collectSubtree(from);
    const movedDirectories = subtree.directories.map((path) => [path, this.requireDirectoryNode(path)] as const);
    const movedFiles = subtree.files.map((path) => [path, this.requireFileNode(path)] as const);

    this.deleteSubtree(subtree.directories, subtree.files);

    for (const [path, node] of movedDirectories) {
      const nextPath = replacePathPrefix(path, from, to) ?? to;
      this.directories.set(nextPath, {
        kind: 'dir',
        mode: node.mode,
        dev: node.dev,
        ino: node.ino,
        ...this.nextStamps(),
      });
      this.registerDirectory(nextPath);
    }
    for (const [path, node] of movedFiles) {
      const nextPath = replacePathPrefix(path, from, to) ?? to;
      this.files.set(nextPath, {
        kind: 'file',
        content: Buffer.from(node.content),
        mode: node.mode,
        dev: node.dev,
        ino: node.ino,
        ...this.nextStamps(),
      });
      this.registerChild(nextPath);
    }

    for (const open of this.openFiles.values()) {
      const nextPath = replacePathPrefix(open.path, from, to);
      if (nextPath !== null) {
        open.path = nextPath;
      }
    }
    this.touchAncestors(parentPath(from));
    this.touchAncestors(targetParent);
  }

  mkdirSync(path: string, options?: { recursive?: boolean; mode?: number }): void {
    const normalized = normalizePathForStorage(path);
    if (this.files.has(normalized)) {
      throw createErrnoError('EEXIST', normalized);
    }
    if (this.directories.has(normalized)) {
      if (options?.recursive) {
        return;
      }
      throw createErrnoError('EEXIST', normalized);
    }

    const parent = parentPath(normalized);
    if (!options?.recursive && this.files.has(parent)) {
      throw createErrnoError('ENOTDIR', parent);
    }
    if (!options?.recursive && !this.directories.has(parent)) {
      throw createErrnoError('ENOENT', normalized);
    }

    const mode = posixMode(options?.mode ?? 0o777) & ~process.umask();

    if (options?.recursive) {
      this.createDirectoryTree(normalized, mode);
      return;
    }

    this.directories.set(normalized, {
      kind: 'dir',
      mode,
      ...this.nextIdentity(),
      ...this.nextStamps(),
    });
    this.registerDirectory(normalized);
    this.touchAncestors(parent);
  }

  private createDirectoryTree(path: string, mode: number): void {
    const segments = path.split('/').filter(Boolean);
    let cursor = '';
    for (const segment of segments) {
      cursor += `/${segment}`;
      if (this.files.has(cursor)) {
        throw createErrnoError('ENOTDIR', cursor);
      }
      if (!this.directories.has(cursor)) {
        this.directories.set(cursor, {
          kind: 'dir',
          mode,
          ...this.nextIdentity(),
          ...this.nextStamps(),
        });
        this.registerDirectory(cursor);
        this.touchAncestors(parentPath(cursor));
      }
    }
  }

  rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void {
    const normalized = normalizePathForStorage(path);
    const isFile = this.files.has(normalized);
    const isDir = this.directories.has(normalized);

    if (!isFile && !isDir) {
      if (options?.force) {
        return;
      }
      throw createErrnoError('ENOENT', normalized);
    }

    if (isFile) {
      this.files.delete(normalized);
      this.unregisterChild(normalized);
      this.touchAncestors(parentPath(normalized));
      return;
    }

    const subtree = this.collectSubtree(normalized);
    const hasDescendants = subtree.files.length > 0 || subtree.directories.length > 1;
    if (hasDescendants && !options?.recursive) {
      throw createErrnoError('ENOTEMPTY', normalized);
    }

    const directoriesToDelete = normalized === '/' ? subtree.directories.slice(1) : subtree.directories;
    this.deleteSubtree(directoriesToDelete, subtree.files);
    this.touchAncestors(normalized === '/' ? '/' : parentPath(normalized));
  }

  rmdirSync(path: string): void {
    this.rmSync(path);
  }

  readdirSync(path: string): string[];
  readdirSync(path: string, options: { withFileTypes: true }): DirentLike[];
  readdirSync(path: string, options?: { withFileTypes: true }): string[] | DirentLike[] {
    const normalized = normalizePathForStorage(path);
    this.requireDirectory(normalized);

    const sortedNames = [...(this.childIndex.get(normalized) ?? [])].sort((left, right) => left.localeCompare(right));

    if (options?.withFileTypes === true) {
      return sortedNames.map((name) => {
        const childPathValue = childPath(normalized, name);
        return {
          name,
          isDirectory: () => this.directories.has(childPathValue),
          isFile: () => this.files.has(childPathValue),
        };
      });
    }

    return sortedNames;
  }

  readDirectoryBoundedSync(
    path: string,
    limit: number,
  ): { readonly entries: readonly string[]; readonly overflow: boolean } {
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new TypeError('Directory entry limit must be a non-negative safe integer.');
    }
    const entries = this.readdirSync(path);
    return {
      entries: entries.slice(0, limit),
      overflow: entries.length > limit,
    };
  }

  lstatSync(path: string): StorageEntryKind;
  lstatSync(path: string, options: { bigint: true }): StorageBigIntStat;
  lstatSync(path: string, options?: { bigint: true }): StorageEntryKind | StorageBigIntStat {
    const normalized = normalizePathForStorage(path);
    if (options?.bigint === true) {
      return this.statSync(normalized, { bigint: true });
    }
    if (this.files.has(normalized)) {
      return {
        isDirectory: () => false,
        isFile: () => true,
        isSymbolicLink: () => false,
      };
    }
    if (this.directories.has(normalized)) {
      return {
        isDirectory: () => true,
        isFile: () => false,
        isSymbolicLink: () => false,
      };
    }
    throw createErrnoError('ENOENT', normalized);
  }

  realpathSync(path: string): string {
    const normalized = normalizePathForStorage(path);
    if (!this.files.has(normalized) && !this.directories.has(normalized)) {
      throw createErrnoError('ENOENT', normalized);
    }
    return normalized;
  }

  statSync(path: string): { size: number; mtimeMs: number; isDirectory(): boolean; isFile(): boolean };
  statSync(path: string, options: { bigint: true }): StorageBigIntStat;
  statSync(
    path: string,
    options?: { bigint: true },
  ): { size: number; mtimeMs: number; isDirectory(): boolean; isFile(): boolean } | StorageBigIntStat {
    const normalized = normalizePathForStorage(path);
    const file = this.files.get(normalized);
    if (file) {
      if (options?.bigint === true) {
        return {
          dev: BigInt(file.dev),
          ino: BigInt(file.ino),
          mode: REGULAR_FILE_TYPE_BITS | BigInt(posixMode(file.mode)),
          uid: SIMULATED_OWNER_UID,
          size: BigInt(file.content.length),
          mtimeNs: file.mtimeNs,
          isDirectory: () => false,
          isFile: () => true,
        };
      }
      return {
        size: file.content.length,
        mtimeMs: file.mtimeMs,
        isDirectory: () => false,
        isFile: () => true,
      };
    }
    const directory = this.directories.get(normalized);
    if (!directory) {
      throw createErrnoError('ENOENT', normalized);
    }
    if (options?.bigint === true) {
      return {
        dev: BigInt(directory.dev),
        ino: BigInt(directory.ino),
        mode: DIRECTORY_TYPE_BITS | BigInt(posixMode(directory.mode)),
        uid: SIMULATED_OWNER_UID,
        size: 0n,
        mtimeNs: directory.mtimeNs,
        isDirectory: () => true,
        isFile: () => false,
      };
    }
    return {
      size: 0,
      mtimeMs: directory.mtimeMs,
      isDirectory: () => true,
      isFile: () => false,
    };
  }

  fstatSync(fd: number, _options: { bigint: true }): StorageBigIntStat {
    const open = this.openFiles.get(fd);
    if (!open) {
      throw createErrnoError('EBADF', String(fd));
    }
    const file = this.requireOpenFileNode(open);
    return {
      dev: BigInt(file.dev),
      ino: BigInt(file.ino),
      mode: REGULAR_FILE_TYPE_BITS | BigInt(posixMode(file.mode)),
      uid: SIMULATED_OWNER_UID,
      size: BigInt(file.content.length),
      mtimeNs: file.mtimeNs,
      isDirectory: () => false,
      isFile: () => true,
    };
  }

  existsSync(path: string): boolean {
    const normalized = normalizePathForStorage(path);
    return this.files.has(normalized) || this.directories.has(normalized);
  }

  openSync(path: string, flags: string, mode?: number): number {
    const normalized = normalizePathForStorage(path);
    if (
      flags !== 'r' &&
      flags !== 'r+' &&
      flags !== 'w' &&
      flags !== 'w+' &&
      flags !== 'a' &&
      flags !== 'wx' &&
      flags !== 'ax'
    ) {
      throw createUnsupportedFlagError('openSync', flags, 'r, r+, w, w+, a, wx, ax');
    }
    let file = this.files.get(normalized);
    if ((flags === 'wx' || flags === 'ax') && (file !== undefined || this.directories.has(normalized))) {
      throw createErrnoError('EEXIST', normalized);
    }
    if (!file) {
      if (this.directories.has(normalized)) {
        throw createErrnoError('EISDIR', normalized);
      }
      if (flags === 'r' || flags === 'r+') {
        throw createErrnoError('ENOENT', normalized);
      }
      const parent = parentPath(normalized);
      this.requireDirectory(parent);
      file = {
        kind: 'file',
        content: Buffer.alloc(0),
        mode: createWithUmaskMode(mode),
        ...this.nextIdentity(),
        ...this.nextStamps(),
      };
      this.files.set(normalized, file);
      this.registerChild(normalized);
      this.touchAncestors(parent);
    } else if (flags === 'w' || flags === 'w+') {
      file.content = Buffer.alloc(0);
      const stamps = this.nextStamps();
      file.mtimeMs = stamps.mtimeMs;
      file.mtimeNs = stamps.mtimeNs;
    }
    const fd = this.nextFd++;
    this.openFiles.set(fd, {
      path: normalized,
      position: flags === 'a' || flags === 'ax' ? file.content.length : 0,
      mode: flags,
      identity: fileIdentityOf(file),
    });
    return fd;
  }

  readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number | null): number {
    const open = this.openFiles.get(fd);
    if (!open) {
      throw createErrnoError('EBADF', String(fd));
    }
    if (open.mode !== 'r' && open.mode !== 'r+' && open.mode !== 'w+') {
      throw createErrnoError('EBADF', String(fd));
    }
    const file = this.requireOpenFileNode(open);
    const start = position ?? open.position;
    const end = Math.min(start + length, file.content.length);
    const slice = file.content.subarray(start, end);
    slice.copy(buffer, offset, 0, slice.length);
    open.position = end;
    return slice.length;
  }

  writeSync(fd: number, buffer: Buffer, offset: number, length: number, position: number | null): number {
    const open = this.openFiles.get(fd);
    if (!open) {
      throw createErrnoError('EBADF', String(fd));
    }
    if (
      open.mode !== 'r+' &&
      open.mode !== 'w' &&
      open.mode !== 'w+' &&
      open.mode !== 'a' &&
      open.mode !== 'wx' &&
      open.mode !== 'ax'
    ) {
      throw createErrnoError('EBADF', String(fd));
    }
    const file = this.requireOpenFileNode(open);
    const start = open.mode === 'a' || open.mode === 'ax' ? file.content.length : (position ?? open.position);
    const end = start + length;
    if (end > file.content.length) {
      const expanded = Buffer.alloc(end);
      file.content.copy(expanded);
      file.content = expanded;
    }
    buffer.copy(file.content, start, offset, offset + length);
    open.position = end;
    const stamps = this.nextStamps();
    file.mtimeMs = stamps.mtimeMs;
    file.mtimeNs = stamps.mtimeNs;
    return length;
  }

  fdatasyncSync(fd: number): void {
    if (!this.openFiles.has(fd)) {
      throw createErrnoError('EBADF', String(fd));
    }
  }

  closeSync(fd: number): void {
    if (!this.openFiles.delete(fd)) {
      throw createErrnoError('EBADF', String(fd));
    }
  }

  appendFileSync(path: string, data: string): void {
    const normalized = normalizePathForStorage(path);
    const parent = parentPath(normalized);
    this.requireDirectory(parent);
    const current = this.files.get(normalized);
    if (this.directories.has(normalized)) {
      throw createErrnoError('EISDIR', normalized);
    }
    if (current) {
      current.content = Buffer.concat([current.content, Buffer.from(data, 'utf-8')]);
      const stamps = this.nextStamps();
      current.mtimeMs = stamps.mtimeMs;
      current.mtimeNs = stamps.mtimeNs;
    } else {
      this.files.set(normalized, {
        kind: 'file',
        content: Buffer.from(data, 'utf-8'),
        mode: createWithUmaskMode(),
        ...this.nextIdentity(),
        ...this.nextStamps(),
      });
      this.registerChild(normalized);
    }
    this.touchAncestors(parent);
  }

  appendFileDurableSync(path: string, data: string): boolean {
    this.mkdirSync(parentPath(normalizePathForStorage(path)), { recursive: true });
    try {
      this.appendFileSync(path, data);
      return true;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }

  appendFileWithCanonicalCheckSync(
    path: string,
    data: string,
    options: { canonicalPath: string; maxRetries?: number },
  ): { ok: boolean; retries: number; orphanPath?: string } {
    const buffer = Buffer.from(data, 'utf-8');
    const maxRetries = normalizeMaxRetries(options.maxRetries);
    let retries = 0;
    let targetPath = path;
    let lastOrphanPath: string | undefined;

    while (true) {
      try {
        const result = this.appendAndCheckCanonical(targetPath, buffer, options.canonicalPath);
        if (result.ok) {
          return { ok: true, retries };
        }
        lastOrphanPath = result.orphanPath;
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return { ok: false, retries, ...(lastOrphanPath ? { orphanPath: lastOrphanPath } : {}) };
        }
        throw error;
      }

      if (retries >= maxRetries) {
        return { ok: false, retries, ...(lastOrphanPath ? { orphanPath: lastOrphanPath } : {}) };
      }

      retries += 1;
      targetPath = options.canonicalPath;
    }
  }

  unlinkSync(path: string): void {
    const normalized = normalizePathForStorage(path);
    if (!this.files.has(normalized)) {
      if (this.directories.has(normalized)) {
        throw createErrnoError('EISDIR', normalized);
      }
      throw createErrnoError('ENOENT', normalized);
    }
    this.files.delete(normalized);
    this.unregisterChildIfUnreferenced(normalized);
    this.touchAncestors(parentPath(normalized));
  }

  tryExclusiveWriteSync(
    path: string,
    data: StorageData,
    options?: { encoding?: BufferEncoding; mode?: number },
  ): boolean {
    const normalized = normalizePathForStorage(path);
    this.mkdirSync(parentPath(normalized), { recursive: true });
    if (this.existsSync(normalized)) {
      return false;
    }
    this.files.set(normalized, {
      kind: 'file',
      content: bufferFromStorageData(data, options?.encoding),
      mode: exclusiveThenChmodMode(options?.mode),
      ...this.nextIdentity(),
      ...this.nextStamps(),
    });
    this.registerChild(normalized);
    this.touchAncestors(parentPath(normalized));
    return true;
  }

  writeAtomicSync(path: string, data: StorageData, options?: { encoding?: BufferEncoding; mode?: number }): boolean {
    const normalized = normalizePathForStorage(path);
    const parent = parentPath(normalized);
    if (!this.directories.has(parent)) {
      return false;
    }

    const tempPath = `${normalized}.tmp`;
    const fd = this.openSync(tempPath, 'w', options?.mode);
    try {
      if (options?.mode !== undefined) {
        this.chmodSync(tempPath, options.mode);
      }
      const content = bufferFromStorageData(data, options?.encoding);
      this.writeSync(fd, content, 0, content.length, null);
    } finally {
      this.closeSync(fd);
    }
    this.renameSync(tempPath, normalized);
    return true;
  }

  writeAtomicDurableSync(
    path: string,
    data: StorageData,
    options?: { encoding?: BufferEncoding; mode?: number },
  ): boolean {
    const normalized = normalizePathForStorage(path);
    const parent = parentPath(normalized);
    this.mkdirSync(parent, { recursive: true });

    const tempPath = `${normalized}.tmp`;
    if (this.directories.has(tempPath)) {
      throw createErrnoError('EISDIR', tempPath);
    }
    const current = this.files.get(tempPath);
    const identity = current ? fileIdentityOf(current) : this.nextIdentity();
    this.files.set(tempPath, {
      kind: 'file',
      content: bufferFromStorageData(data, options?.encoding),
      mode: options?.mode === undefined ? (current?.mode ?? durableAtomicMode()) : durableAtomicMode(options.mode),
      ...identity,
      ...this.nextStamps(),
    });
    this.registerChild(tempPath);
    this.touchAncestors(parent);
    this.renameSync(tempPath, normalized);
    return this.syncDirectoryDurableSync(parent);
  }

  syncDirectoryDurableSync(path: string): boolean {
    return this.directories.has(normalizePathForStorage(path));
  }

  chmodSync(path: string, mode: number): void {
    const normalized = normalizePathForStorage(path);
    const file = this.files.get(normalized);
    if (file) {
      file.mode = posixMode(mode);
      const stamps = this.nextStamps();
      file.mtimeMs = stamps.mtimeMs;
      file.mtimeNs = stamps.mtimeNs;
      return;
    }
    const directory = this.directories.get(normalized);
    if (directory) {
      directory.mode = posixMode(mode);
      const stamps = this.nextStamps();
      directory.mtimeMs = stamps.mtimeMs;
      directory.mtimeNs = stamps.mtimeNs;
      return;
    }
    throw createErrnoError('ENOENT', normalized);
  }

  openSqliteDatabaseSync(path: string, options?: { readOnly?: boolean }): SqliteDatabasePort {
    const normalized = normalizePathForStorage(path);
    const existing = this.sqliteDatabases.get(normalized);
    if (existing !== undefined) return existing;
    if (options?.readOnly === true) throw createErrnoError('ENOENT', normalized);

    this.writeFileSync(normalized, Buffer.alloc(0), { mode: 0o600, flag: 'wx' });
    const database = new DatabaseSync(':memory:');
    const port: SqliteDatabasePort = {
      exec: (sql) => database.exec(sql),
      prepare: (sql) => {
        const statement = database.prepare(sql);
        return {
          all: (...values) => statement.all(...values),
          get: (...values) => statement.get(...values),
          run: (...values) => {
            const result = statement.run(...values);
            return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
          },
        };
      },
      close: () => undefined,
    };
    this.sqliteDatabases.set(normalized, port);
    return port;
  }

  private appendAndCheckCanonical(
    path: string,
    buffer: Buffer,
    canonicalPath: string,
  ): { ok: true } | { ok: false; orphanPath: string } {
    const normalized = normalizePathForStorage(path);
    this.mkdirSync(parentPath(normalized), { recursive: true });

    const fd = this.openSync(normalized, 'a');
    try {
      this.writeOpenFileAppendSync(fd, buffer);
      const openedIdentity = this.openFileIdentity(fd);
      const canonicalIdentity = this.statIdentityIfPresent(canonicalPath);
      if (canonicalIdentity && sameFileIdentity(openedIdentity, canonicalIdentity)) {
        return { ok: true };
      }
      return {
        ok: false,
        orphanPath: this.findPathByIdentity(openedIdentity) ?? normalized,
      };
    } finally {
      this.closeSync(fd);
    }
  }

  private writeOpenFileAppendSync(fd: number, buffer: Buffer): void {
    const open = this.openFiles.get(fd);
    if (!open || open.mode !== 'a') {
      throw createErrnoError('EBADF', String(fd));
    }
    const [path, file] = this.requireOpenFileEntry(open);
    file.content = Buffer.concat([file.content, buffer]);
    const stamps = this.nextStamps();
    file.mtimeMs = stamps.mtimeMs;
    file.mtimeNs = stamps.mtimeNs;
    open.path = path;
    open.position = file.content.length;
    this.touchAncestors(parentPath(path));
  }

  private openFileIdentity(fd: number): FileIdentity {
    const open = this.openFiles.get(fd);
    if (!open) {
      throw createErrnoError('EBADF', String(fd));
    }
    return { ...open.identity };
  }

  private statIdentityIfPresent(path: string): FileIdentity | null {
    const normalized = normalizePathForStorage(path);
    const file = this.files.get(normalized);
    if (file) {
      return fileIdentityOf(file);
    }
    const directory = this.directories.get(normalized);
    if (directory) {
      return fileIdentityOf(directory);
    }
    return null;
  }

  private requireOpenFileNode(open: OpenFile): FileNode {
    return this.requireOpenFileEntry(open)[1];
  }

  private requireOpenFileEntry(open: OpenFile): [string, FileNode] {
    const entry = this.findFileEntryByIdentity(open.identity);
    if (!entry) {
      throw createErrnoError('ENOENT', open.path);
    }
    open.path = entry[0];
    return entry;
  }

  private findPathByIdentity(identity: FileIdentity): string | undefined {
    return this.findFileEntryByIdentity(identity)?.[0];
  }

  private findFileEntryByIdentity(identity: FileIdentity): [string, FileNode] | undefined {
    for (const entry of this.files.entries()) {
      if (sameFileIdentity(fileIdentityOf(entry[1]), identity)) {
        return entry;
      }
    }
    return undefined;
  }

  private jobsDirRoot(): string {
    return this.roots.jobsDir ?? DEFAULT_JOBS_DIR;
  }

  private coralRoot(): string {
    return this.roots.coralRoot ?? DEFAULT_CORAL_ROOT;
  }

  private nextIdentity(): FileIdentity {
    return { dev: 1, ino: this.nextIno++ };
  }

  private nextStamps(): { mtimeMs: number; mtimeNs: bigint } {
    const candidate = this.time.now();
    const previousMs = this.lastStamp;
    this.lastStamp = Math.max(candidate, previousMs + 1);
    if (this.lastStamp === previousMs) {
      this.subTickCounter += 1n;
    } else {
      this.subTickCounter = 0n;
    }
    return {
      mtimeMs: this.lastStamp,
      mtimeNs: BigInt(this.lastStamp) * 1_000_000n + this.subTickCounter,
    };
  }

  private requireDirectory(path: string): void {
    const normalized = normalizePathForStorage(path);
    if (this.directories.has(normalized)) {
      return;
    }
    if (this.files.has(normalized)) {
      throw createErrnoError('ENOTDIR', normalized);
    }
    throw createErrnoError('ENOENT', normalized);
  }

  private requireFileNode(path: string): FileNode {
    const normalized = normalizePathForStorage(path);
    const file = this.files.get(normalized);
    if (!file) {
      throw createErrnoError('ENOENT', normalized);
    }
    return file;
  }

  private requireDirectoryNode(path: string): DirectoryNode {
    const normalized = normalizePathForStorage(path);
    const directory = this.directories.get(normalized);
    if (!directory) {
      throw createErrnoError('ENOENT', normalized);
    }
    return directory;
  }

  private registerDirectory(path: string): void {
    const normalized = normalizePathForStorage(path);
    this.ensureChildSet(normalized);
    this.registerChild(normalized);
  }

  private unregisterDirectory(path: string): void {
    const normalized = normalizePathForStorage(path);
    this.childIndex.delete(normalized);
    this.unregisterChildIfUnreferenced(normalized);
  }

  private registerChild(path: string): void {
    const normalized = normalizePathForStorage(path);
    if (normalized === '/') {
      this.ensureChildSet(normalized);
      return;
    }
    this.ensureChildSet(parentPath(normalized)).add(childName(normalized));
  }

  private unregisterChild(path: string): void {
    const normalized = normalizePathForStorage(path);
    if (normalized === '/') {
      return;
    }
    this.childIndex.get(parentPath(normalized))?.delete(childName(normalized));
  }

  private unregisterChildIfUnreferenced(path: string): void {
    const normalized = normalizePathForStorage(path);
    if (!this.files.has(normalized) && !this.directories.has(normalized)) {
      this.unregisterChild(normalized);
    }
  }

  private ensureChildSet(path: string): Set<string> {
    const normalized = normalizePathForStorage(path);
    const existing = this.childIndex.get(normalized);
    if (existing) {
      return existing;
    }
    const children = new Set<string>();
    this.childIndex.set(normalized, children);
    return children;
  }

  private collectSubtree(root: string): { directories: string[]; files: string[] } {
    const normalized = normalizePathForStorage(root);
    const directories = [normalized];
    const files: string[] = [];

    for (let index = 0; index < directories.length; index += 1) {
      const directoryPath = directories[index];
      if (directoryPath === undefined) {
        break;
      }
      for (const name of this.childIndex.get(directoryPath) ?? []) {
        const candidate = childPath(directoryPath, name);
        if (this.files.has(candidate)) {
          files.push(candidate);
          continue;
        }
        if (this.directories.has(candidate)) {
          directories.push(candidate);
        }
      }
    }

    return { directories, files };
  }

  private deleteSubtree(directories: string[], files: string[]): void {
    for (const path of files) {
      this.files.delete(path);
      this.unregisterChild(path);
    }
    for (let index = directories.length - 1; index >= 0; index -= 1) {
      const path = directories[index];
      if (path === undefined) {
        continue;
      }
      this.directories.delete(path);
      this.unregisterDirectory(path);
    }
  }

  private rebuildChildIndex(): void {
    this.childIndex.clear();
    for (const path of this.directories.keys()) {
      this.ensureChildSet(path);
    }
    for (const path of this.directories.keys()) {
      this.registerChild(path);
    }
    for (const path of this.files.keys()) {
      this.registerChild(path);
    }
  }

  private touchAncestors(path: string): void {
    let cursor = normalizePathForStorage(path);
    while (true) {
      const directory = this.directories.get(cursor);
      if (directory) {
        const stamps = this.nextStamps();
        directory.mtimeMs = stamps.mtimeMs;
        directory.mtimeNs = stamps.mtimeNs;
      }
      if (cursor === '/') {
        return;
      }
      cursor = parentPath(cursor);
    }
  }
}

function bufferFromStorageData(data: StorageData, encoding: BufferEncoding = 'utf-8'): Buffer {
  return typeof data === 'string' ? Buffer.from(data, encoding) : Buffer.from(data);
}

function fileIdentityOf(node: FileIdentity): FileIdentity {
  return { dev: node.dev, ino: node.ino };
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function normalizeMaxRetries(maxRetries: number | undefined): number {
  if (maxRetries === undefined) {
    return 3;
  }
  if (!Number.isFinite(maxRetries)) {
    return 0;
  }
  return Math.max(0, Math.floor(maxRetries));
}

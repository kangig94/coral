import { dirname, normalize } from 'node:path';
import type { RuntimeDirentLike, StorageData, StoragePort, TimePort } from '../../../src/runtime/ports.js';
import { DEFAULT_CORAL_ROOT, DEFAULT_INSTALLATIONS_DIR, DEFAULT_JOBS_DIR, DEFAULT_SESSION_BASE } from './constants.js';

type FileNode = {
  kind: 'file';
  content: Buffer;
  mode?: number;
  mtimeMs: number;
};

type DirectoryNode = {
  kind: 'dir';
  mode?: number;
  mtimeMs: number;
};

type OpenFile = {
  path: string;
  position: number;
};

export type InMemoryStorageSnapshot = {
  files: Array<[string, FileNode]>;
  directories: Array<[string, DirectoryNode]>;
  nextFd: number;
  openFiles: Array<[number, OpenFile]>;
  lastStamp: number;
};

export type InMemoryRoots = {
  jobsDir?: string;
  sessionBase?: string;
  installationsDir?: string;
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
  };
}

function cloneDirectoryNode(node: DirectoryNode): DirectoryNode {
  return {
    kind: 'dir',
    mode: node.mode,
    mtimeMs: node.mtimeMs,
  };
}

function createErrnoError(code: string, path: string, message?: string): NodeJS.ErrnoException {
  const error = new Error(message ?? `${code}: ${path}`) as NodeJS.ErrnoException;
  error.code = code;
  error.path = path;
  return error;
}

export class InMemoryStorage implements StoragePort {
  private readonly files = new Map<string, FileNode>();
  private readonly directories = new Map<string, DirectoryNode>();
  private readonly childIndex = new Map<string, Set<string>>();
  private readonly openFiles = new Map<number, OpenFile>();
  private nextFd = 100;
  private lastStamp: number;

  constructor(
    private readonly time: Pick<TimePort, 'now'>,
    private readonly roots: InMemoryRoots = {},
  ) {
    this.lastStamp = this.time.now();
    this.directories.set('/', { kind: 'dir', mtimeMs: this.nextStamp() });
    this.childIndex.set('/', new Set());
    this.mkdirSync(this.jobsDirRoot(), { recursive: true });
    this.mkdirSync(this.sessionBaseRoot(), { recursive: true });
    this.mkdirSync(this.installationsDirRoot(), { recursive: true });
    this.mkdirSync(this.coralRoot(), { recursive: true });
  }

  snapshot(): InMemoryStorageSnapshot {
    return {
      files: [...this.files.entries()].map(([path, node]) => [path, cloneFileNode(node)]),
      directories: [...this.directories.entries()].map(([path, node]) => [path, cloneDirectoryNode(node)]),
      nextFd: this.nextFd,
      openFiles: [...this.openFiles.entries()].map(([fd, open]) => [fd, { ...open }]),
      lastStamp: this.lastStamp,
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
      this.openFiles.set(fd, { ...open });
    }
    this.nextFd = snapshot.nextFd;
    this.lastStamp = snapshot.lastStamp;
    this.rebuildChildIndex();
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

  writeFileSync(path: string, data: StorageData, options?: { encoding?: BufferEncoding; mode?: number }): void {
    const normalized = normalizePathForStorage(path);
    const parent = parentPath(normalized);
    this.requireDirectory(parent);
    if (this.directories.has(normalized)) {
      throw createErrnoError('EISDIR', normalized);
    }
    this.files.set(normalized, {
      kind: 'file',
      content: bufferFromStorageData(data, options?.encoding),
      mode: options?.mode,
      mtimeMs: this.nextStamp(),
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
        mtimeMs: this.nextStamp(),
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
        mtimeMs: this.nextStamp(),
      });
      this.registerDirectory(nextPath);
    }
    for (const [path, node] of movedFiles) {
      const nextPath = replacePathPrefix(path, from, to) ?? to;
      this.files.set(nextPath, {
        kind: 'file',
        content: Buffer.from(node.content),
        mode: node.mode,
        mtimeMs: this.nextStamp(),
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

  mkdirSync(path: string, options?: { recursive?: boolean }): void {
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
    if (!options?.recursive && !this.directories.has(parent)) {
      throw createErrnoError('ENOENT', normalized);
    }

    if (options?.recursive) {
      const segments = normalized.split('/').filter(Boolean);
      let cursor = '';
      for (const segment of segments) {
        cursor += `/${segment}`;
        if (!this.directories.has(cursor)) {
          this.directories.set(cursor, {
            kind: 'dir',
            mtimeMs: this.nextStamp(),
          });
          this.registerDirectory(cursor);
          this.touchAncestors(parentPath(cursor));
        }
      }
      return;
    }

    this.directories.set(normalized, {
      kind: 'dir',
      mtimeMs: this.nextStamp(),
    });
    this.registerDirectory(normalized);
    this.touchAncestors(parent);
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

  readdirSync(path: string, options: { withFileTypes: true }): RuntimeDirentLike[] {
    if (!options.withFileTypes) {
      throw new Error('InMemoryStorage.readdirSync requires withFileTypes: true');
    }
    const normalized = normalizePathForStorage(path);
    this.requireDirectory(normalized);

    return [...(this.childIndex.get(normalized) ?? [])]
      .sort((left, right) => left.localeCompare(right))
      .map((name) => {
        const childPathValue = childPath(normalized, name);
        return {
          name,
          isDirectory: () => this.directories.has(childPathValue),
          isFile: () => this.files.has(childPathValue),
        };
      });
  }

  statSync(path: string): { size: number; mtimeMs: number; isDirectory(): boolean; isFile(): boolean } {
    const normalized = normalizePathForStorage(path);
    const file = this.files.get(normalized);
    if (file) {
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
    return {
      size: 0,
      mtimeMs: directory.mtimeMs,
      isDirectory: () => true,
      isFile: () => false,
    };
  }

  existsSync(path: string): boolean {
    const normalized = normalizePathForStorage(path);
    return this.files.has(normalized) || this.directories.has(normalized);
  }

  openSync(path: string, flags: string): number {
    const normalized = normalizePathForStorage(path);
    if (flags !== 'r') {
      throw new Error(`InMemoryStorage.openSync only supports 'r' (received ${flags})`);
    }
    if (!this.files.has(normalized)) {
      if (this.directories.has(normalized)) {
        throw createErrnoError('EISDIR', normalized);
      }
      throw createErrnoError('ENOENT', normalized);
    }
    const fd = this.nextFd++;
    this.openFiles.set(fd, { path: normalized, position: 0 });
    return fd;
  }

  readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number | null): number {
    const open = this.openFiles.get(fd);
    if (!open) {
      throw createErrnoError('EBADF', String(fd));
    }
    const file = this.files.get(open.path);
    if (!file) {
      throw createErrnoError('ENOENT', open.path);
    }
    const start = position ?? open.position;
    const end = Math.min(start + length, file.content.length);
    const slice = file.content.subarray(start, end);
    slice.copy(buffer, offset, 0, slice.length);
    open.position = end;
    return slice.length;
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
    if (current && current.kind !== 'file') {
      throw createErrnoError('EISDIR', normalized);
    }
    const content = current ? Buffer.concat([current.content, Buffer.from(data, 'utf-8')]) : Buffer.from(data, 'utf-8');
    this.files.set(normalized, {
      kind: 'file',
      content,
      mode: current?.mode,
      mtimeMs: this.nextStamp(),
    });
    this.registerChild(normalized);
    this.touchAncestors(parent);
  }

  appendFileDurableSync(path: string, data: string): boolean {
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

  tryExclusiveWriteSync(path: string, data: StorageData, options?: { encoding?: BufferEncoding; mode?: number }): boolean {
    const normalized = normalizePathForStorage(path);
    this.mkdirSync(parentPath(normalized), { recursive: true });
    if (this.existsSync(normalized)) {
      return false;
    }
    this.files.set(normalized, {
      kind: 'file',
      content: bufferFromStorageData(data, options?.encoding),
      mode: options?.mode,
      mtimeMs: this.nextStamp(),
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
    this.files.set(tempPath, {
      kind: 'file',
      content: bufferFromStorageData(data, options?.encoding),
      mode: options?.mode,
      mtimeMs: this.nextStamp(),
    });
    this.registerChild(tempPath);
    this.renameSync(tempPath, normalized);
    return true;
  }

  writeAtomicDurableSync(path: string, data: StorageData, options?: { encoding?: BufferEncoding; mode?: number }): boolean {
    return this.writeAtomicSync(path, data, options);
  }

  chmodSync(path: string, mode: number): void {
    const normalized = normalizePathForStorage(path);
    const file = this.files.get(normalized);
    if (file) {
      file.mode = mode;
      file.mtimeMs = this.nextStamp();
      return;
    }
    const directory = this.directories.get(normalized);
    if (directory) {
      directory.mode = mode;
      directory.mtimeMs = this.nextStamp();
      return;
    }
    throw createErrnoError('ENOENT', normalized);
  }

  private jobsDirRoot(): string {
    return this.roots.jobsDir ?? DEFAULT_JOBS_DIR;
  }

  private sessionBaseRoot(): string {
    return this.roots.sessionBase ?? DEFAULT_SESSION_BASE;
  }

  private installationsDirRoot(): string {
    return this.roots.installationsDir ?? DEFAULT_INSTALLATIONS_DIR;
  }

  private coralRoot(): string {
    return this.roots.coralRoot ?? DEFAULT_CORAL_ROOT;
  }

  private nextStamp(): number {
    const candidate = this.time.now();
    this.lastStamp = Math.max(candidate, this.lastStamp + 1);
    return this.lastStamp;
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
        directory.mtimeMs = this.nextStamp();
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

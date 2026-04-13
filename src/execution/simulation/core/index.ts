import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { basename, dirname, join, normalize } from 'node:path';
import { PassThrough } from 'node:stream';
import { removeBackendInfoIfOwner, writeBackendInfo, type BackendInfo } from '../../../infra/backend-info.js';
import { createPluginRegistry } from '../../../infra/plugin-registry.js';
import { ProviderRegistry } from '../../../providers/registry.js';
import type { Provider } from '../../../providers/types.js';
import { readAppendedLines } from '../../../shared/file-tail.js';
import type { CallerContext } from '../../../shared/request-context.js';
import type { DurableCliRuntimeRecord, PersistedExitRecord, ProviderResult } from '../../../shared/types.js';
import { nowIsoString } from '../../../shared/utils.js';
import { LaunchCoordinator } from '../../engine.js';
import { TypedEventBus } from '../../event-bus.js';
import { createProviderHostManager } from '../../host-manager.js';
import { ProgressStore } from '../../progress-store.js';
import type {
  ChildProcessLike,
  ChildReadableLike,
  ChildStdinLike,
  DurableExecutionTransport,
  DurableLaunchOptions,
  DurableLaunchResult,
  Runtime,
  RuntimeDirentLike,
  RuntimeEnv,
  RuntimeIds,
  RuntimePaths,
  RuntimeProcess,
  RuntimeSpawnOptions,
  RuntimeStorage,
  RuntimeTimerHandle,
  RuntimeTime,
} from '../../runtime.js';
import {
  createBackendServer,
  type BackendServerController,
  type CreateServerFn,
} from '../../server.js';
import { ExecutionService } from '../../service.js';
import { createDeferred, type Deferred } from './deferred.js';

export { createDeferred, type Deferred } from './deferred.js';

export const DEFAULT_EPOCH_MS = 1_000_000;
const DEFAULT_PID = 12_345;
const DEFAULT_PLATFORM = 'linux';
const DEFAULT_CWD = '/tmp/sim';
const DEFAULT_HOME = '/tmp/sim/home';
const DEFAULT_PATH = '/usr/bin';
const DEFAULT_JOBS_DIR = '/tmp/sim/jobs';
const DEFAULT_SESSION_BASE = '/tmp/sim/sessions';
const DEFAULT_INSTALLATIONS_DIR = '/tmp/sim/installations';
const DEFAULT_LISTEN_HOST = '127.0.0.1';
const DEFAULT_LISTEN_PORT = 4_100;
const DEFAULT_PLUGIN_ROOT = '/tmp/sim/plugin';
const DEFAULT_PROJECT_ROOT = '/tmp/sim/project';
const DEFAULT_VERSION = 'sim-version';
const DEFAULT_BUNDLE_HASH = 'sim-bundle';
const DEFAULT_FAKE_PROVIDER = 'fake-provider';

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

type TimerRecord = {
  handle: VirtualTimerHandle;
  deadline: number;
  fn: () => void;
  intervalMs: number | null;
  order: number;
  active: boolean;
};

type ProcessExitOutcome = {
  delayMs?: number;
  exitCode?: number | null;
  signal?: string | null;
};

export type ChildOutputChunk = {
  delayMs?: number;
  data: string;
};

export type MockKillAction = {
  signal?: NodeJS.Signals | 0 | 'default';
  delayMs?: number;
  exitCode?: number | null;
  exitSignal?: string | null;
};

export type MockSpawnScript = {
  pid?: number;
  stdout?: string | ChildOutputChunk[];
  stderr?: string | ChildOutputChunk[];
  close?: {
    delayMs?: number;
    code?: number | null;
    signal?: string | null;
  } | null;
  error?: {
    delayMs?: number;
    error: Error | string;
  } | null;
  kills?: MockKillAction[];
};

export type MockDurableScript = {
  pid?: number;
  runtimeDelayMs?: number;
  stdout?: string | ChildOutputChunk[];
  stderr?: string | ChildOutputChunk[];
  runtimeRecord?: Partial<DurableCliRuntimeRecord>;
  exit?: {
    delayMs?: number;
    exitCode?: number | null;
    signal?: string | null;
  } | null;
  kills?: MockKillAction[];
  waitForExitError?: Error | string;
};

export type FakeProviderScenario = {
  name?: string;
  cli?: {
    command?: string;
    args?: string[];
    extraEnv?: Record<string, string>;
  };
  progress?: Array<{ delayMs?: number; message: string }>;
  result?: Partial<ProviderResult>;
  preflightError?: Error | string;
};

export type SimulationScenario = {
  epochMs?: number;
  pluginRoot?: string;
  projectRoot?: string;
  listen?: {
    host?: string;
    port?: number;
  };
  env?: Record<string, string>;
  spawn?: MockSpawnScript[];
  durable?: MockDurableScript[];
  fakeProvider?: FakeProviderScenario;
};

export type InMemoryStorageSnapshot = {
  files: Array<[string, FileNode]>;
  directories: Array<[string, DirectoryNode]>;
  nextFd: number;
  openFiles: Array<[number, OpenFile]>;
  lastStamp: number;
};

export type InMemoryPathsSnapshot = {
  namespaceCache: Array<[string, string]>;
  projectSourceCache: Array<[string, string]>;
};

type InMemoryRoots = {
  jobsDir?: string;
  sessionBase?: string;
  installationsDir?: string;
};

type RegisteredProcess = {
  pid: number;
  alive: boolean;
  closed: boolean;
  timers: Set<RuntimeTimerHandle>;
  child: MockChildProcess | null;
  killActions: MockKillAction[];
  complete: (outcome: ProcessExitOutcome) => void;
  waitForExit: Deferred<PersistedExitRecord> | null;
};

function normalizePathForStorage(path: string): string {
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

function immediateChildrenOf(path: string, candidates: Iterable<string>): string[] {
  const normalized = normalizePathForStorage(path);
  const prefix = normalized === '/' ? '/' : `${normalized}/`;
  const children = new Set<string>();
  for (const candidate of candidates) {
    if (candidate === normalized || !candidate.startsWith(prefix)) {
      continue;
    }
    const suffix = candidate.slice(prefix.length);
    const child = suffix.split('/')[0];
    if (child) {
      children.add(child);
    }
  }
  return [...children].sort((left, right) => left.localeCompare(right));
}

function hashToken(input: string, length: number): string {
  return createHash('sha256').update(input).digest('hex').slice(0, length);
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

function asChunks(value: string | ChildOutputChunk[] | undefined): ChildOutputChunk[] {
  if (value === undefined) {
    return [];
  }
  if (typeof value === 'string') {
    return [{ delayMs: 0, data: value }];
  }
  return value.map((chunk) => ({ delayMs: chunk.delayMs ?? 0, data: chunk.data }));
}

function toError(value: Error | string): Error {
  return value instanceof Error ? value : new Error(value);
}

function flushMicrotasks(rounds = 4): Promise<void> {
  let chain = Promise.resolve();
  for (let index = 0; index < rounds; index += 1) {
    chain = chain.then(() => undefined);
  }
  return chain;
}

class VirtualTimerHandle implements RuntimeTimerHandle {
  constructor(readonly id: number) {}

  unref(): void {}
}

export class VirtualTime implements RuntimeTime {
  private currentTime: number;
  private readonly timers = new Map<number, TimerRecord>();
  private nextId = 1;
  private nextOrder = 1;

  constructor(epochMs = DEFAULT_EPOCH_MS) {
    this.currentTime = epochMs;
  }

  now(): number {
    return this.currentTime;
  }

  sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.setTimeout(resolve, ms);
    });
  }

  setTimeout(fn: () => void, ms: number): RuntimeTimerHandle {
    return this.schedule(fn, ms, null);
  }

  clearTimeout(handle: RuntimeTimerHandle | null): void {
    this.clear(handle);
  }

  setInterval(fn: () => void, ms: number): RuntimeTimerHandle {
    const delay = Math.max(1, Math.floor(ms));
    return this.schedule(fn, delay, delay);
  }

  clearInterval(handle: RuntimeTimerHandle | null): void {
    this.clear(handle);
  }

  tick(ms: number): void {
    const delta = Math.max(0, Math.floor(ms));
    const target = this.currentTime + delta;

    while (true) {
      const next = this.nextDueTimer(target);
      if (!next) {
        this.currentTime = target;
        return;
      }

      this.currentTime = next.deadline;
      if (!next.active) {
        this.timers.delete(next.handle.id);
        continue;
      }

      if (next.intervalMs === null) {
        next.active = false;
        this.timers.delete(next.handle.id);
      }

      next.fn();

      if (next.intervalMs !== null && next.active) {
        next.deadline += next.intervalMs;
        next.order = this.nextOrder++;
      } else {
        this.timers.delete(next.handle.id);
      }
    }
  }

  private schedule(fn: () => void, ms: number, intervalMs: number | null): RuntimeTimerHandle {
    const delay = Math.max(0, Math.floor(ms));
    const handle = new VirtualTimerHandle(this.nextId++);
    this.timers.set(handle.id, {
      handle,
      deadline: this.currentTime + delay,
      fn,
      intervalMs,
      order: this.nextOrder++,
      active: true,
    });
    return handle;
  }

  private clear(handle: RuntimeTimerHandle | null): void {
    if (!(handle instanceof VirtualTimerHandle)) {
      return;
    }
    const record = this.timers.get(handle.id);
    if (!record) {
      return;
    }
    record.active = false;
    this.timers.delete(handle.id);
  }

  private nextDueTimer(target: number): TimerRecord | null {
    let next: TimerRecord | null = null;
    for (const record of this.timers.values()) {
      if (!record.active || record.deadline > target) {
        continue;
      }
      if (
        next === null ||
        record.deadline < next.deadline ||
        (record.deadline === next.deadline && record.order < next.order)
      ) {
        next = record;
      }
    }
    return next;
  }
}

export class InMemoryStorage implements RuntimeStorage {
  private readonly files = new Map<string, FileNode>();
  private readonly directories = new Map<string, DirectoryNode>();
  private readonly openFiles = new Map<number, OpenFile>();
  private nextFd = 100;
  private lastStamp: number;

  constructor(
    private readonly time: Pick<RuntimeTime, 'now'>,
    private readonly roots: InMemoryRoots = {},
  ) {
    this.lastStamp = this.time.now();
    this.directories.set('/', { kind: 'dir', mtimeMs: this.nextStamp() });
    this.mkdirSync(this.jobsDirRoot(), { recursive: true });
    this.mkdirSync(this.sessionBaseRoot(), { recursive: true });
    this.mkdirSync(this.installationsDirRoot(), { recursive: true });
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

  writeFileSync(path: string, data: string, options?: { encoding?: BufferEncoding; mode?: number }): void {
    const normalized = normalizePathForStorage(path);
    const parent = parentPath(normalized);
    this.requireDirectory(parent);
    if (this.directories.has(normalized)) {
      throw createErrnoError('EISDIR', normalized);
    }
    this.files.set(normalized, {
      kind: 'file',
      content: Buffer.from(data, options?.encoding ?? 'utf-8'),
      mode: options?.mode,
      mtimeMs: this.nextStamp(),
    });
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
      this.files.set(to, {
        kind: 'file',
        content: Buffer.from(existing.content),
        mode: existing.mode,
        mtimeMs: this.nextStamp(),
      });
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

    const targetParent = parentPath(to);
    this.requireDirectory(targetParent);
    if (this.files.has(to)) {
      this.files.delete(to);
    }
    if (this.directories.has(to)) {
      this.rmSync(to, { recursive: true, force: true });
    }

    const movedDirectories = [...this.directories.entries()].filter(([path]) => path === from || path.startsWith(`${from}/`));
    const movedFiles = [...this.files.entries()].filter(([path]) => path.startsWith(`${from}/`));

    for (const [path] of movedDirectories) {
      this.directories.delete(path);
    }
    for (const [path] of movedFiles) {
      this.files.delete(path);
    }

    for (const [path, node] of movedDirectories) {
      const suffix = path.slice(from.length);
      this.directories.set(`${to}${suffix}`, {
        kind: 'dir',
        mode: node.mode,
        mtimeMs: this.nextStamp(),
      });
    }
    for (const [path, node] of movedFiles) {
      const suffix = path.slice(from.length);
      const nextPath = `${to}${suffix}`;
      this.files.set(nextPath, {
        kind: 'file',
        content: Buffer.from(node.content),
        mode: node.mode,
        mtimeMs: this.nextStamp(),
      });
      for (const open of this.openFiles.values()) {
        if (open.path === path || open.path.startsWith(`${path}/`)) {
          open.path = nextPath;
        }
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
          this.touchAncestors(parentPath(cursor));
        }
      }
      return;
    }

    this.directories.set(normalized, {
      kind: 'dir',
      mtimeMs: this.nextStamp(),
    });
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
      this.touchAncestors(parentPath(normalized));
      return;
    }

    const childPaths = [...this.directories.keys(), ...this.files.keys()].filter(
      (candidate) => candidate !== normalized && candidate.startsWith(`${normalized}/`),
    );
    if (childPaths.length > 0 && !options?.recursive) {
      throw createErrnoError('ENOTEMPTY', normalized);
    }

    for (const candidate of [...this.files.keys()]) {
      if (candidate.startsWith(`${normalized}/`)) {
        this.files.delete(candidate);
      }
    }
    for (const candidate of [...this.directories.keys()]) {
      if (candidate !== '/' && (candidate === normalized || candidate.startsWith(`${normalized}/`))) {
        this.directories.delete(candidate);
      }
    }
    this.touchAncestors(parentPath(normalized));
  }

  readdirSync(path: string, options: { withFileTypes: true }): RuntimeDirentLike[] {
    if (!options.withFileTypes) {
      throw new Error('InMemoryStorage.readdirSync requires withFileTypes: true');
    }
    const normalized = normalizePathForStorage(path);
    this.requireDirectory(normalized);

    const names = new Set<string>();
    for (const name of immediateChildrenOf(normalized, this.directories.keys())) {
      names.add(name);
    }
    for (const name of immediateChildrenOf(normalized, this.files.keys())) {
      names.add(name);
    }

    return [...names]
      .sort((left, right) => left.localeCompare(right))
      .map((name) => {
        const childPath = normalized === '/' ? `/${name}` : `${normalized}/${name}`;
        return {
          name,
          isDirectory: () => this.directories.has(childPath),
          isFile: () => this.files.has(childPath),
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
    this.touchAncestors(parent);
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
    this.touchAncestors(parentPath(normalized));
  }

  tryExclusiveWriteSync(path: string, data: string, options?: { encoding?: BufferEncoding; mode?: number }): boolean {
    const normalized = normalizePathForStorage(path);
    this.mkdirSync(parentPath(normalized), { recursive: true });
    if (this.existsSync(normalized)) {
      return false;
    }
    this.files.set(normalized, {
      kind: 'file',
      content: Buffer.from(data, options?.encoding ?? 'utf-8'),
      mode: options?.mode,
      mtimeMs: this.nextStamp(),
    });
    this.touchAncestors(parentPath(normalized));
    return true;
  }

  writeAtomicSync(path: string, data: string, options?: { encoding?: BufferEncoding; mode?: number }): boolean {
    const normalized = normalizePathForStorage(path);
    const parent = parentPath(normalized);
    if (!this.directories.has(parent)) {
      return false;
    }

    const tempPath = `${normalized}.tmp`;
    this.files.set(tempPath, {
      kind: 'file',
      content: Buffer.from(data, options?.encoding ?? 'utf-8'),
      mode: options?.mode,
      mtimeMs: this.nextStamp(),
    });
    this.renameSync(tempPath, normalized);
    return true;
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

export class InMemoryPaths implements RuntimePaths {
  private readonly namespaceCache = new Map<string, string>();
  private readonly projectSourceCache = new Map<string, string>();

  constructor(private readonly roots: InMemoryRoots = {}) {}

  snapshot(): InMemoryPathsSnapshot {
    return {
      namespaceCache: [...this.namespaceCache.entries()],
      projectSourceCache: [...this.projectSourceCache.entries()],
    };
  }

  restore(snapshot: InMemoryPathsSnapshot): void {
    this.namespaceCache.clear();
    this.projectSourceCache.clear();
    for (const [key, value] of snapshot.namespaceCache) {
      this.namespaceCache.set(key, value);
    }
    for (const [key, value] of snapshot.projectSourceCache) {
      this.projectSourceCache.set(key, value);
    }
  }

  jobsDir(): string {
    return this.roots.jobsDir ?? DEFAULT_JOBS_DIR;
  }

  sessionBase(): string {
    return this.roots.sessionBase ?? DEFAULT_SESSION_BASE;
  }

  backendInfoPath(pluginRoot: string): string {
    return join(this.installationsDir(), this.pluginRootNamespace(pluginRoot), 'backend.json');
  }

  backendLockPath(pluginRoot: string): string {
    return join(this.installationsDir(), this.pluginRootNamespace(pluginRoot), 'backend.lock');
  }

  pluginRootNamespace(pluginRoot: string): string {
    const normalized = normalizePathForStorage(pluginRoot);
    const cached = this.namespaceCache.get(normalized);
    if (cached) {
      return cached;
    }
    const namespace = hashToken(normalized, 12);
    this.namespaceCache.set(normalized, namespace);
    return namespace;
  }

  projectSource(projectRoot: string): string {
    const normalized = normalizePathForStorage(projectRoot);
    const cached = this.projectSourceCache.get(normalized);
    if (cached) {
      return cached;
    }
    const source = `local/${basename(normalized) || 'project'}-${hashToken(normalized, 8)}`;
    this.projectSourceCache.set(normalized, source);
    return source;
  }

  private installationsDir(): string {
    return this.roots.installationsDir ?? DEFAULT_INSTALLATIONS_DIR;
  }
}

export class SequentialIds implements RuntimeIds {
  private uuidCounter = 0;
  private byteCounter = 0;

  uuid(): string {
    this.uuidCounter += 1;
    return `00000000-0000-0000-0000-${String(this.uuidCounter).padStart(12, '0')}`;
  }

  randomBytes(size: number): Buffer {
    const bytes = Buffer.alloc(size);
    for (let index = 0; index < size; index += 1) {
      bytes[index] = this.byteCounter % 256;
      this.byteCounter += 1;
    }
    return bytes;
  }
}

export class SealedEnv implements RuntimeEnv {
  private readonly fullEnv: Readonly<Record<string, string>>;
  private readonly coralEnv: Readonly<Record<string, string>>;

  constructor(overrides: Record<string, string> = {}) {
    const fullEnv = {
      HOME: DEFAULT_HOME,
      USERPROFILE: DEFAULT_HOME,
      PATH: DEFAULT_PATH,
      PWD: DEFAULT_CWD,
      CORAL_OWNER: 'sim-owner',
      CORAL_EFFORT: 'medium',
      ...overrides,
    };
    const coralEntries = Object.fromEntries(Object.entries(fullEnv).filter(([key]) => key.startsWith('CORAL_')));
    this.fullEnv = Object.freeze({ ...fullEnv });
    this.coralEnv = Object.freeze({ ...coralEntries });
  }

  get(key: string): string | undefined {
    return this.fullEnv[key];
  }

  coralSnapshot(): Readonly<Record<string, string>> {
    return this.coralEnv;
  }

  pid(): number {
    return DEFAULT_PID;
  }

  platform(): string {
    return DEFAULT_PLATFORM;
  }

  cwd(): string {
    return DEFAULT_CWD;
  }
}

class MockStdin extends EventEmitter implements ChildStdinLike {
  destroyed = false;
  readonly writes: string[] = [];

  write(chunk: string | Uint8Array): boolean {
    if (this.destroyed) {
      this.emit('error', new Error('stdin is destroyed'));
      return false;
    }
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
    this.writes.push(text);
    return true;
  }

  end(chunk?: string | Uint8Array): void {
    if (chunk !== undefined) {
      this.write(chunk);
    }
    this.destroyed = true;
  }
}

class MockChildProcess extends EventEmitter implements ChildProcessLike {
  readonly stdin: ChildStdinLike | null;
  readonly stdout: ChildReadableLike | null;
  readonly stderr: ChildReadableLike | null;

  constructor(
    readonly pid: number,
    mode: RuntimeSpawnOptions['mode'],
    private readonly onKill: (pid: number, signal?: NodeJS.Signals) => boolean,
  ) {
    super();
    this.stdin = mode === 'piped' ? new MockStdin() : null;
    this.stdout = mode === 'piped' ? (new PassThrough() as unknown as ChildReadableLike) : null;
    this.stderr = mode === 'piped' ? (new PassThrough() as unknown as ChildReadableLike) : null;
  }

  kill(signal?: NodeJS.Signals): boolean {
    return this.onKill(this.pid, signal);
  }

  unref(): void {}

  pushStdout(data: string): void {
    const readable = this.stdout as unknown as PassThrough | null;
    readable?.write(data);
  }

  pushStderr(data: string): void {
    const readable = this.stderr as unknown as PassThrough | null;
    readable?.write(data);
  }

  emitClose(code: number | null, signal: string | null): void {
    (this.stdout as unknown as PassThrough | null)?.end();
    (this.stderr as unknown as PassThrough | null)?.end();
    if (this.stdin instanceof MockStdin) {
      this.stdin.destroyed = true;
    }
    this.emit('close', code, signal as NodeJS.Signals | null);
  }

  emitFailure(error: Error): void {
    this.emit('error', error);
  }
}

export class MockDurableTransport implements DurableExecutionTransport {
  readonly launchCalls: DurableLaunchOptions[] = [];
  readonly waitForExitCalls: DurableLaunchResult[] = [];

  constructor(private readonly spawner: MockProcessSpawner) {}

  enqueue(script: MockDurableScript): void {
    this.spawner.enqueueDurable(script);
  }

  async launch(options: DurableLaunchOptions): Promise<DurableLaunchResult> {
    this.launchCalls.push({
      ...options,
      args: [...options.args],
      ...(options.envAdditions ? { envAdditions: { ...options.envAdditions } } : {}),
    });
    return this.spawner.launchDurable(options);
  }

  waitForExit(handle: DurableLaunchResult): Promise<PersistedExitRecord> {
    this.waitForExitCalls.push(handle);
    return this.spawner.waitForDurableExit(handle);
  }
}

export class MockProcessSpawner {
  readonly spawnCalls: RuntimeSpawnOptions[] = [];
  readonly killCalls: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];
  readonly durable: MockDurableTransport;
  private readonly processes = new Map<number, RegisteredProcess>();
  private readonly spawnScripts: MockSpawnScript[] = [];
  private readonly durableScripts: MockDurableScript[] = [];
  private nextPid = 20_000;

  constructor(
    private readonly time: VirtualTime,
    private readonly storage: InMemoryStorage,
  ) {
    this.durable = new MockDurableTransport(this);
  }

  enqueueSpawn(script: MockSpawnScript): void {
    this.spawnScripts.push(script);
  }

  enqueueDurable(script: MockDurableScript): void {
    this.durableScripts.push(script);
  }

  spawn(options: RuntimeSpawnOptions): ChildProcessLike {
    this.spawnCalls.push({
      ...options,
      args: [...options.args],
      ...(options.envAdditions ? { envAdditions: { ...options.envAdditions } } : {}),
    });

    const script = this.spawnScripts.shift() ?? {};
    const pid = script.pid ?? this.allocatePid();
    const child = new MockChildProcess(pid, options.mode, (childPid, signal) => this.killChild(childPid, signal));
    const record = this.registerProcess(pid, child, script.kills ?? [], null);

    for (const chunk of asChunks(script.stdout)) {
      this.schedule(record, chunk.delayMs ?? 0, () => {
        if (!record.closed) {
          child.pushStdout(chunk.data);
        }
      });
    }
    for (const chunk of asChunks(script.stderr)) {
      this.schedule(record, chunk.delayMs ?? 0, () => {
        if (!record.closed) {
          child.pushStderr(chunk.data);
        }
      });
    }

    if (script.error) {
      this.schedule(record, script.error.delayMs ?? 0, () => {
        if (record.closed) {
          return;
        }
        record.alive = false;
        child.emitFailure(toError(script.error!.error));
      });
    }

    if (script.close !== null) {
      const close = script.close ?? { delayMs: 0, code: 0, signal: null };
      this.schedule(record, close.delayMs ?? 0, () => {
        record.complete({
          exitCode: close.code ?? 0,
          signal: close.signal ?? null,
        });
      });
    }

    return child;
  }

  kill(pid: number, signal: NodeJS.Signals | 0): void {
    this.killCalls.push({ pid, signal });
    if (signal === 0) {
      return;
    }
    const record = this.processes.get(pid);
    if (!record || record.closed) {
      return;
    }
    const action = this.resolveKillAction(record.killActions, signal);
    if (!action) {
      record.complete({
        exitCode: null,
        signal,
      });
      return;
    }
    this.schedule(record, action.delayMs ?? 0, () => {
      record.complete({
        exitCode: action.exitCode ?? null,
        signal: action.exitSignal ?? signal,
      });
    });
  }

  killChild(pid: number, signal?: NodeJS.Signals): boolean {
    const record = this.processes.get(pid);
    if (!record || record.closed) {
      return false;
    }
    this.kill(pid, signal ?? 'SIGTERM');
    return true;
  }

  isAlive(pid: number): boolean {
    return this.processes.get(pid)?.alive === true;
  }

  setAlive(pid: number, alive: boolean): void {
    const record = this.processes.get(pid);
    if (record) {
      record.alive = alive;
    }
  }

  async launchDurable(options: DurableLaunchOptions): Promise<DurableLaunchResult> {
    const script = this.durableScripts.shift() ?? {};
    const pid = script.pid ?? this.allocatePid();
    const stdoutPath = script.runtimeRecord?.stdoutPath ?? join(options.jobDir, 'stdout');
    const stderrPath = script.runtimeRecord?.stderrPath ?? join(options.jobDir, 'stderr');
    const runtimePath = join(options.jobDir, 'runtime.json');
    const exitPath = join(options.jobDir, 'exit.json');

    this.storage.mkdirSync(options.jobDir, { recursive: true });
    this.storage.writeFileSync(stdoutPath, '');
    this.storage.writeFileSync(stderrPath, '');

    const exitDeferred = createDeferred<PersistedExitRecord>();
    const exitError = script.waitForExitError ? toError(script.waitForExitError) : null;
    const record = this.registerProcess(pid, null, script.kills ?? [], exitDeferred, (outcome) => {
      const exitRecord: PersistedExitRecord = {
        exitCode: outcome.exitCode ?? null,
        signal: outcome.signal ?? null,
        endTime: nowIsoString(this.time),
      };
      this.storage.writeAtomicSync(exitPath, JSON.stringify(exitRecord, null, 2), { encoding: 'utf-8' });
      if (exitError) {
        exitDeferred.reject(exitError);
      } else {
        exitDeferred.resolve(exitRecord);
      }
    });

    for (const chunk of asChunks(script.stdout)) {
      this.schedule(record, chunk.delayMs ?? 0, () => {
        if (record.closed) {
          return;
        }
        this.storage.appendFileSync(stdoutPath, chunk.data);
      });
    }
    for (const chunk of asChunks(script.stderr)) {
      this.schedule(record, chunk.delayMs ?? 0, () => {
        if (record.closed) {
          return;
        }
        this.storage.appendFileSync(stderrPath, chunk.data);
      });
    }

    if (script.exit !== null) {
      const exit = script.exit ?? { delayMs: 0, exitCode: 0, signal: null };
      this.schedule(record, exit.delayMs ?? 0, () => {
        record.complete({
          exitCode: exit.exitCode ?? 0,
          signal: exit.signal ?? null,
        });
      });
    }

    if ((script.runtimeDelayMs ?? 0) > 0) {
      await this.time.sleep(script.runtimeDelayMs ?? 0);
    }
    if (!record.alive && !this.storage.existsSync(exitPath)) {
      throw new Error(`Durable process ${pid} exited before runtime.json was written`);
    }

    const runtimeRecord: DurableCliRuntimeRecord = {
      ...script.runtimeRecord,
      startTime: script.runtimeRecord?.startTime ?? nowIsoString(this.time),
      pid,
      stdoutPath,
      stderrPath,
    };
    this.storage.writeAtomicSync(runtimePath, JSON.stringify(runtimeRecord, null, 2), { encoding: 'utf-8' });

    return {
      pid,
      stdoutPath,
      stderrPath,
      runtimeRecord,
    };
  }

  waitForDurableExit(handle: DurableLaunchResult): Promise<PersistedExitRecord> {
    const record = this.processes.get(handle.pid);
    if (!record?.waitForExit) {
      return Promise.reject(new Error(`No durable process registered for pid ${handle.pid}`));
    }
    return record.waitForExit.promise;
  }

  private allocatePid(): number {
    const pid = this.nextPid;
    this.nextPid += 1;
    return pid;
  }

  private registerProcess(
    pid: number,
    child: MockChildProcess | null,
    killActions: MockKillAction[],
    waitForExit: Deferred<PersistedExitRecord> | null,
    onExit?: (outcome: ProcessExitOutcome) => void,
  ): RegisteredProcess {
    const record: RegisteredProcess = {
      pid,
      alive: true,
      closed: false,
      timers: new Set(),
      child,
      killActions,
      waitForExit,
      complete: (outcome) => {
        if (record.closed) {
          return;
        }
        record.closed = true;
        record.alive = false;
        for (const timer of record.timers) {
          this.time.clearTimeout(timer);
        }
        record.timers.clear();
        onExit?.(outcome);
        if (child) {
          child.emitClose(outcome.exitCode ?? null, outcome.signal ?? null);
        }
      },
    };
    this.processes.set(pid, record);
    return record;
  }

  private schedule(record: RegisteredProcess, delayMs: number, fn: () => void): void {
    const timer = this.time.setTimeout(() => {
      record.timers.delete(timer);
      fn();
    }, delayMs);
    record.timers.add(timer);
  }

  private resolveKillAction(killActions: MockKillAction[], signal: NodeJS.Signals | 0): MockKillAction | null {
    return (
      killActions.find((entry) => entry.signal === signal) ??
      killActions.find((entry) => entry.signal === 'default') ??
      null
    );
  }
}

export type SimulationRuntimeOptions = {
  epochMs?: number;
  env?: Record<string, string>;
};

export class SimulationRuntime implements Runtime {
  readonly time: VirtualTime;
  readonly storage: InMemoryStorage;
  readonly paths: InMemoryPaths;
  readonly ids: SequentialIds;
  readonly env: SealedEnv;
  readonly spawner: MockProcessSpawner;
  readonly process: RuntimeProcess;

  constructor(options: SimulationRuntimeOptions = {}) {
    const roots: InMemoryRoots = {};
    this.time = new VirtualTime(options.epochMs ?? DEFAULT_EPOCH_MS);
    this.env = new SealedEnv(options.env);
    this.paths = new InMemoryPaths(roots);
    this.storage = new InMemoryStorage(this.time, roots);
    this.ids = new SequentialIds();
    this.spawner = new MockProcessSpawner(this.time, this.storage);
    this.process = {
      spawn: (spawnOptions) => this.spawner.spawn(spawnOptions),
      kill: (pid, signal) => {
        this.spawner.kill(pid, signal);
      },
      isAlive: (pid) => this.spawner.isAlive(pid),
      durable: this.spawner.durable,
    };
  }
}

function readFileIfPresent(storage: Pick<RuntimeStorage, 'existsSync' | 'readFileSync'>, path: string): string {
  return storage.existsSync(path) ? storage.readFileSync(path, 'utf-8') : '';
}

function createMockKbSubsystem() {
  return {
    kb: {
      closeVectorStores: async () => {},
    } as never,
    curateScheduler: {
      start: async () => {},
      schedule: () => {},
      scheduleDeferredCommit: () => {},
      isRunning: () => false,
      stop: async () => {},
    },
  };
}

function createFakeProvider(runtime: SimulationRuntime, scenario: FakeProviderScenario | undefined): Provider {
  const providerName = scenario?.name ?? DEFAULT_FAKE_PROVIDER;
  const preflightError = scenario?.preflightError;
  return {
    name: providerName,
    ...(preflightError
      ? {
          preflight: async () => {
            throw toError(preflightError);
          },
        }
      : {}),
    execute: async (request, providerRuntime) => {
      const startedAt = runtime.time.now();

      for (const progress of scenario?.progress ?? []) {
        if ((progress.delayMs ?? 0) > 0) {
          await runtime.time.sleep(progress.delayMs ?? 0);
        }
        providerRuntime.onEvent({
          jobId: request.sessionId,
          message: progress.message,
          ts: nowIsoString(runtime.time),
        });
      }

      const cli = await providerRuntime.runCli({
        command: scenario?.cli?.command ?? providerName,
        args: scenario?.cli?.args ?? [`--${request.action}`],
        prompt: request.prompt,
        cwd: request.cwd,
        extraEnv: {
          ...request.coralEnv,
          ...(scenario?.cli?.extraEnv ?? {}),
        },
      });

      const result: ProviderResult = {
        content: scenario?.result?.content ?? cli.stdout.trimEnd(),
        exitCode: scenario?.result?.exitCode ?? cli.code,
        aborted: scenario?.result?.aborted ?? cli.aborted,
        durationMs: scenario?.result?.durationMs ?? runtime.time.now() - startedAt,
        ...scenario?.result,
      };
      return result;
    },
    recovery: {
      buildRecoveryMeta: () => ({ provider: providerName }),
      finalizeFromArtifacts: async ({ stdoutPath, stderrPath, exitCode, signal }) => {
        const stdout = readFileIfPresent(runtime.storage, stdoutPath).trimEnd();
        const stderr = readFileIfPresent(runtime.storage, stderrPath).trimEnd();
        const result: ProviderResult = {
          content: scenario?.result?.content ?? stdout,
          exitCode: scenario?.result?.exitCode ?? exitCode,
          aborted: scenario?.result?.aborted ?? (signal !== null),
          notice: scenario?.result?.notice ?? (stderr.length > 0 ? stderr : undefined),
          ...scenario?.result,
        };
        return result;
      },
      extractProgress: ({ stdoutPath, fromOffset }) => {
        const { lines, newOffset } = readAppendedLines(stdoutPath, fromOffset, runtime.storage);
        return {
          messages: lines,
          newOffset,
        };
      },
    },
  };
}

export type SimulationHookLog = {
  createServerCalls: Array<(req: IncomingMessage, res: ServerResponse) => void>;
  listenCalls: Array<{ host: string; port: number }>;
  acquireLockCalls: Array<{
    pluginRoot: string;
    instanceId: string;
    version: string;
    bundleHash: string;
    flavor: 'prod' | 'dev';
  }>;
  writeBackendInfoCalls: Array<{ pluginRoot: string; info: BackendInfo }>;
  removeBackendInfoCalls: Array<{ pluginRoot: string; instanceId: string }>;
  removeLockCalls: Array<{ pluginRoot: string; instanceId: string }>;
  createKbSubsystemCalls: Array<{ pluginRoot: string }>;
  recoverPersistedDiscussCalls: number;
};

export type SimulationBackend = {
  backend: BackendServerController;
  runtime: SimulationRuntime;
  time: VirtualTime;
  storage: InMemoryStorage;
  paths: InMemoryPaths;
  spawner: MockProcessSpawner;
  ids: SequentialIds;
  env: SealedEnv;
  eventBus: TypedEventBus;
  progressStore: ProgressStore;
  launchCoordinator: LaunchCoordinator;
  providerRegistry: ProviderRegistry;
  pluginRoot: string;
  projectRoot: string;
  namespace: string;
  hooks: SimulationHookLog;
  createCallerContext: (projectRoot?: string, coralEnv?: Record<string, string>) => CallerContext;
  createService: (projectRoot?: string, coralEnv?: Record<string, string>) => ExecutionService;
  service: ExecutionService;
  advance: (ms: number) => Promise<void>;
};

export function createSimulationBackend(scenario: SimulationScenario = {}): SimulationBackend {
  const runtime = new SimulationRuntime({
    epochMs: scenario.epochMs,
    env: scenario.env,
  });
  for (const spawnScript of scenario.spawn ?? []) {
    runtime.spawner.enqueueSpawn(spawnScript);
  }
  for (const durableScript of scenario.durable ?? []) {
    runtime.spawner.enqueueDurable(durableScript);
  }

  const pluginRoot = scenario.pluginRoot ?? DEFAULT_PLUGIN_ROOT;
  const projectRoot = scenario.projectRoot ?? DEFAULT_PROJECT_ROOT;
  const namespace = runtime.paths.pluginRootNamespace(pluginRoot);
  const eventBus = new TypedEventBus();
  const progressStore = new ProgressStore(namespace, eventBus, runtime);
  const launchCoordinator = new LaunchCoordinator({ runtime });
  const providerRegistry = new ProviderRegistry();
  providerRegistry.register(createFakeProvider(runtime, scenario.fakeProvider));

  runtime.storage.mkdirSync(pluginRoot, { recursive: true });
  runtime.storage.mkdirSync(projectRoot, { recursive: true });

  const providerHostManager = createProviderHostManager({
    runtime,
    spawnProviderServer: launchCoordinator.spawnProviderServer.bind(launchCoordinator),
  });
  const pluginRegistry = createPluginRegistry({
    storage: runtime.storage,
    env: runtime.env,
    homeDir: runtime.env.get('HOME'),
  });

  const hooks: SimulationHookLog = {
    createServerCalls: [],
    listenCalls: [],
    acquireLockCalls: [],
    writeBackendInfoCalls: [],
    removeBackendInfoCalls: [],
    removeLockCalls: [],
    createKbSubsystemCalls: [],
    recoverPersistedDiscussCalls: 0,
  };

  const services = new Map<string, ExecutionService>();
  const createCallerContext = (root = projectRoot, coralEnv = { ...runtime.env.coralSnapshot() }): CallerContext => ({
    projectRoot: root,
    pluginRoot,
    coralEnv: { ...coralEnv },
  });

  const createService = (root = projectRoot, coralEnv = { ...runtime.env.coralSnapshot() }): ExecutionService => {
    const key = normalizePathForStorage(root);
    const existing = services.get(key);
    if (existing) {
      return existing;
    }
    const service = new ExecutionService(createCallerContext(root, coralEnv), {
      runtime,
      progressStore,
      bundleHash: DEFAULT_BUNDLE_HASH,
      backendNamespace: namespace,
      providerHostManager,
      launchCoordinator,
      eventBus,
      providerRegistry,
      pluginRegistry,
    });
    services.set(key, service);
    return service;
  };

  const createServerFn: CreateServerFn = (handler) => {
    hooks.createServerCalls.push(handler);
    return createServer(handler);
  };

  const listenHost = scenario.listen?.host ?? DEFAULT_LISTEN_HOST;
  const listenPort = scenario.listen?.port ?? DEFAULT_LISTEN_PORT;

  const backend = createBackendServer({
    runtime,
    pluginRoot,
    backendNamespace: namespace,
    progressStore,
    launchCoordinator,
    eventBus,
    providerRegistry,
    providerHostManager,
    resolveProjectSourceFn: (root) => runtime.paths.projectSource(root),
    bootSnapshot: {
      version: DEFAULT_VERSION,
      bundleHash: DEFAULT_BUNDLE_HASH,
      flavor: 'dev',
      now: () => runtime.time.now(),
      pid: runtime.env.pid(),
      bindHost: listenHost,
      advertiseHost: listenHost,
    },
    createExecutionService: (ctx) => createService(ctx.projectRoot, ctx.coralEnv),
    createServerFn,
    listenFn: async () => {
      hooks.listenCalls.push({ host: listenHost, port: listenPort });
      return { host: listenHost, port: listenPort };
    },
    acquireLockFn: async (bootPluginRoot, instanceId, version, bundleHash, flavor) => {
      hooks.acquireLockCalls.push({
        pluginRoot: bootPluginRoot,
        instanceId,
        version,
        bundleHash,
        flavor,
      });
    },
    writeBackendInfoFn: (bootPluginRoot, info) => {
      hooks.writeBackendInfoCalls.push({ pluginRoot: bootPluginRoot, info });
      runtime.storage.mkdirSync(dirname(runtime.paths.backendInfoPath(bootPluginRoot)), { recursive: true });
      writeBackendInfo(bootPluginRoot, info, runtime);
    },
    removeBackendInfoIfOwnerFn: (bootPluginRoot, instanceId) => {
      hooks.removeBackendInfoCalls.push({ pluginRoot: bootPluginRoot, instanceId });
      removeBackendInfoIfOwner(bootPluginRoot, instanceId, runtime);
    },
    removeLockIfOwnerFn: (bootPluginRoot, instanceId) => {
      hooks.removeLockCalls.push({ pluginRoot: bootPluginRoot, instanceId });
    },
    createKbSubsystemFn: async ({ pluginRoot: kbPluginRoot }) => {
      hooks.createKbSubsystemCalls.push({ pluginRoot: kbPluginRoot });
      return createMockKbSubsystem();
    },
    registerBuiltInProvidersFn: () => {},
    recoverPersistedDiscussFn: async () => {
      hooks.recoverPersistedDiscussCalls += 1;
      return [];
    },
  });

  return {
    backend,
    runtime,
    time: runtime.time,
    storage: runtime.storage,
    paths: runtime.paths,
    spawner: runtime.spawner,
    ids: runtime.ids,
    env: runtime.env,
    eventBus,
    progressStore,
    launchCoordinator,
    providerRegistry,
    pluginRoot,
    projectRoot,
    namespace,
    hooks,
    createCallerContext,
    createService,
    service: createService(projectRoot),
    advance: async (ms: number) => {
      runtime.time.tick(ms);
      await flushMicrotasks();
    },
  };
}

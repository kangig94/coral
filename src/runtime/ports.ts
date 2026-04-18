import type { CoralPaths } from '../infra/coral-paths.js';
import type { DurableCliRuntimeRecord, PersistedExitRecord } from '../shared/types.js';

export interface RuntimeTimerHandle {
  unref?(): void;
}

export interface TimePort {
  now(): number;
  sleep(ms: number): Promise<void>;
  setTimeout(fn: () => void, ms: number): RuntimeTimerHandle;
  clearTimeout(handle: RuntimeTimerHandle | null): void;
  setInterval(fn: () => void, ms: number): RuntimeTimerHandle;
  clearInterval(handle: RuntimeTimerHandle | null): void;
}

export interface RuntimeDirentLike {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

export interface StoragePort {
  readFileSync(path: string, encoding: 'utf-8'): string;
  writeFileSync(path: string, data: string, options?: { encoding?: BufferEncoding; mode?: number }): void;
  renameSync(oldPath: string, newPath: string): void;
  mkdirSync(path: string, options?: { recursive?: boolean }): void;
  rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  readdirSync(path: string, options: { withFileTypes: true }): RuntimeDirentLike[];
  statSync(path: string): { size: number; mtimeMs: number; isDirectory(): boolean; isFile(): boolean };
  existsSync(path: string): boolean;
  openSync(path: string, flags: string): number;
  readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number | null): number;
  closeSync(fd: number): void;
  appendFileSync(path: string, data: string): void;
  appendFileDurableSync(path: string, data: string): boolean;
  unlinkSync(path: string): void;
  tryExclusiveWriteSync(path: string, data: string, options?: { encoding?: BufferEncoding; mode?: number }): boolean;
  writeAtomicSync(path: string, data: string, options?: { encoding?: BufferEncoding; mode?: number }): boolean;
  writeAtomicDurableSync(path: string, data: string, options?: { encoding?: BufferEncoding; mode?: number }): boolean;
  chmodSync(path: string, mode: number): void;
}

export interface DiscussPathResolver {
  projectSource(projectRoot: string): string;
  discussSourcesPath(): string;
  discussSourcesLockPath(): string;
  discussBaseDirForSource(source: string): string;
  discussDiscoveryPathForSource(source: string): string;
  discussDiscoveryLockPathForSource(source: string): string;
  discussSummaryIndexPathForSource(source: string): string;
  discussSessionDirForSource(source: string, sessionId: string): string;
  discussStatePath(sessionDir: string): string;
  discussEventLogPath(sessionDir: string): string;
  jobStatusPath(jobId: string): string;
}

export interface RuntimePaths extends DiscussPathResolver {
  jobsDir(): string;
  sessionBase(): string;
  installationDirForNamespace(namespace: string): string;
  backendInfoPath(pluginRoot: string): string;
  backendLockPath(pluginRoot: string): string;
  pluginRootNamespace(pluginRoot: string): string;
  readonly coral: CoralPaths;
}

export interface ChildStdinLike {
  readonly destroyed: boolean;
  write(chunk: string | Uint8Array): boolean;
  end(chunk?: string | Uint8Array): void;
  on(event: 'error', listener: (error: Error) => void): this;
}

export interface ChildReadableLike {
  setEncoding(encoding: BufferEncoding): this;
  on(event: 'data', listener: (chunk: string | Buffer) => void): this;
  on(event: 'end', listener: () => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  [Symbol.asyncIterator]?(): AsyncIterableIterator<string | Buffer>;
}

export interface ChildProcessLike {
  readonly pid: number | undefined;
  readonly stdin: ChildStdinLike | null;
  readonly stdout: ChildReadableLike | null;
  readonly stderr: ChildReadableLike | null;
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
  unref?(): void;
}

export interface Disposable {
  dispose(): void;
}

export interface SpawnEvent {
  child: ChildProcessLike;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export type SpawnListener = (event: SpawnEvent) => void;

export interface RuntimeObserver {
  onSpawn(listener: SpawnListener): Disposable;
}

export type RuntimeSpawnMode = 'piped' | 'ignored' | 'detached';

export type RuntimeSpawnOptions = {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  envAdditions?: Record<string, string>;
  inheritEnv?: boolean;
  shell?: boolean;
  mode: RuntimeSpawnMode;
};

export type LaunchPool = 'default' | 'discuss' | 'curate';

export type DurableLaunchOptions = {
  provider: string;
  command: string;
  args: string[];
  prompt?: string;
  cwd?: string;
  jobDir: string;
  pool?: LaunchPool;
  envAdditions?: Record<string, string>;
};

export type DurableLaunchResult = {
  pid: number;
  stdoutPath: string;
  stderrPath: string;
  runtimeRecord: DurableCliRuntimeRecord;
};

export interface DurableExecutionTransport {
  launch(options: DurableLaunchOptions): Promise<DurableLaunchResult>;
  waitForExit(handle: DurableLaunchResult): Promise<PersistedExitRecord>;
}

export type DurableTransportLike = DurableExecutionTransport;

export type RuntimeExecOptions = {
  cwd?: string;
  timeout?: number;
  encoding?: 'utf-8';
  env?: Record<string, string>;
  maxBuffer?: number;
  inheritEnv?: boolean;
};

export type ExecResult = {
  stdout: string;
  stderr: string;
  status: number | null;
  error?: Error;
};

export interface ProcessPort {
  spawn(options: RuntimeSpawnOptions): ChildProcessLike;
  exec(command: string, args: string[], options?: RuntimeExecOptions): Promise<ExecResult>;
  // Sync exec uses spawnSync semantics, including SIGTERM-only timeout handling.
  execSync(command: string, args: string[], options?: RuntimeExecOptions): ExecResult;
  kill(pid: number, signal: NodeJS.Signals | 0): void;
  isAlive(pid: number): boolean;
  durable: DurableExecutionTransport;
}

export interface IdPort {
  uuid(): string;
  randomBytes(size: number): Buffer;
  sha256(input: string): string;
}

export interface EnvPort {
  get(key: string): string | undefined;
  homedir(): string;
  pid(): number;
  platform(): string;
  cwd(): string;
  fullSnapshot(): Readonly<Record<string, string>>;
  coralSnapshot(): Readonly<Record<string, string>>;
}

export interface Runtime {
  readonly time: TimePort;
  readonly storage: StoragePort;
  readonly process: ProcessPort;
  readonly ids: IdPort;
  readonly env: EnvPort;
  readonly paths: RuntimePaths;
}

export type RuntimeTimePort = Runtime['time'];
export type RuntimeStoragePort = Runtime['storage'];
export type RuntimePathsPort = Runtime['paths'];
export type RuntimeProcessPort = Runtime['process'];
export type RuntimeIdsPort = Runtime['ids'];
export type RuntimeEnvPort = Runtime['env'];

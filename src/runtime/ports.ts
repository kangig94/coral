import type { BuildFlavor } from '../infra/build-flavor.js';
import type { CoralPaths } from '../infra/path/index.js';
import type { ChildProcessLike, EnvPort, StoragePort, TimePort } from '../infra/port-types.js';
import type { DurableCliRuntimeRecord, DurableProcessExit } from './durable-runtime.js';

export interface RuntimePaths {
  projectSource(projectRoot: string): string;
  /** Per-project data directory under the composed coral root (`<coralRoot>/projects/<slug>`). */
  projectData(projectRoot: string): string;
  readonly coral: CoralPaths;
  /** Per-config-dir partition slot (see `claudeConfigSlot`), computed once at
   *  composition. Undefined for the default config dir. Free-function path
   *  helpers that compose their own dir (e.g. `kbRuntimeDir`) read it here
   *  instead of recomputing it. */
  readonly configSlot?: string;
}

export interface Disposable {
  [Symbol.dispose](): void;
}

export interface SpawnEvent {
  child: ChildProcessLike;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export function cloneSpawnEvent(event: SpawnEvent): SpawnEvent {
  return {
    child: event.child,
    command: event.command,
    args: [...event.args],
    ...(event.env ? { env: { ...event.env } } : {}),
  };
}

export type SpawnListener = (event: SpawnEvent) => void;

export interface RuntimeObserver {
  onSpawn(listener: SpawnListener): Disposable;
}

export type RuntimeSpawnOptions = {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  envAdditions?: Record<string, string>;
  inheritEnv?: boolean;
  shell?: boolean;
};

export type DurableLaunchOptions = {
  provider: string;
  command: string;
  args: string[];
  prompt?: string;
  cwd?: string;
  jobDir: string;
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
  waitForExit(handle: DurableLaunchResult): Promise<DurableProcessExit>;
}

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

export interface Runtime {
  readonly flavor: BuildFlavor;
  readonly time: TimePort;
  readonly storage: StoragePort;
  readonly process: ProcessPort;
  readonly ids: IdPort;
  readonly env: EnvPort;
  readonly paths: RuntimePaths;
}

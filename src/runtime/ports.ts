import type { BuildFlavor } from '../infra/build-flavor.js';
import type { CoralPaths } from '../infra/path/compose.js';
import type {
  ChildProcessLike,
  ChildReadableLike,
  ChildStdinLike,
  DirentLike,
  EnvPort,
  StorageData,
  StoragePort,
  TimePort,
  TimerHandle,
} from '../infra/port-types.js';
import type { DurableCliRuntimeRecord, DurableProcessExit } from './durable-runtime.js';

export type {
  ChildProcessLike,
  ChildReadableLike,
  ChildStdinLike,
  DirentLike,
  EnvPort,
  StorageData,
  StoragePort,
  TimePort,
  TimerHandle,
};

export interface RuntimePaths {
  projectSource(projectRoot: string): string;
  readonly coral: CoralPaths;
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

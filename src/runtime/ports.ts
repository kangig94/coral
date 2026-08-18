import type { ProcessIncarnation, ProcessLiveness } from '../infra/node-process.js';
import type { BuildFlavor } from '../infra/build-flavor.js';
import type { CoralPaths } from '../infra/path/index.js';
import type { ChildProcessLike, EnvPort, StoragePort, TimePort } from '../infra/port-types.js';
import { STANDING_PROBE_ERRNOS } from '../infra/process-constants.js';
import type { DurableCliRuntimeRecord, DurableProcessExit } from './durable-runtime.js';

export interface RuntimePaths {
  projectSource(projectRoot: string): string;
  /** Per-project data directory under the composed coral root (`<coralRoot>/projects/<slug>`). */
  projectData(projectRoot: string): string;
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
  detached?: boolean;
};

export type DurableLaunchOptions = {
  provider: string;
  command: string;
  args: string[];
  prompt?: string;
  cwd?: string;
  jobDir: string;
  envAdditions?: Record<string, string>;
  /** Complete child environment; when present, envAdditions is ignored. */
  env?: Record<string, string>;
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
  shell?: boolean;
};

export type ExecResult = {
  stdout: string;
  stderr: string;
  status: number | null;
  error?: Error;
};

/**
 * What an `ExecResult` says about whether the command answered — the three cases its four fields encode
 * between them, named once instead of re-derived per caller.
 *
 * `answered` is the command having run and exited: `status` is its code, and a non-zero one is an answer, not
 * a failure to obtain one. `launch-refused` is the command not starting for a reason that is a standing fact
 * about this machine, so asking again changes nothing. `no-answer` is everything else — the bound elapsed, the
 * system had no process slot, a signal arrived from outside — and it leaves the question exactly as open as it
 * was before the command ran.
 *
 * This exists because the derivation was written four times against the same four fields, in modules that do
 * not own them, and the copies disagreed. Two of the copies had to explain themselves by pointing at a third
 * module's opposite default, which is what a missing owner looks like. The disagreement was real and reachable:
 * on the version that read a codeless error as "it answered", a KB whose disk was busy silently stopped being
 * version-controlled for the daemon's lifetime.
 *
 * The unrecognised shape lands on `no-answer` deliberately. A wrong `no-answer` costs a repeated command; a
 * wrong `answered` is a durable claim nobody observed.
 */
export type ExecOutcome =
  | Readonly<{ kind: 'answered'; status: number }>
  | Readonly<{ kind: 'launch-refused'; code: string }>
  | Readonly<{ kind: 'no-answer'; detail: string }>;

export function classifyExecOutcome(result: ExecResult): ExecOutcome {
  if (result.error !== undefined) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (typeof code === 'string' && STANDING_PROBE_ERRNOS.has(code)) {
      return { kind: 'launch-refused', code };
    }
    return { kind: 'no-answer', detail: code ?? result.error.message };
  }
  // No launch failure, so the command ran — which is not yet the same as it having answered. A null status is
  // a child killed by a signal this process did not ask for (both ports report their own timeout as an error
  // instead), and whatever partial output had arrived is still in `result`; reading it as success is how a
  // killed probe mints an answer out of a truncated line.
  if (result.status === null) {
    return { kind: 'no-answer', detail: 'killed before it exited' };
  }
  return { kind: 'answered', status: result.status };
}

export interface ProcessPort {
  spawn(options: RuntimeSpawnOptions): ChildProcessLike;
  exec(command: string, args: string[], options?: RuntimeExecOptions): Promise<ExecResult>;
  // Sync exec uses spawnSync semantics, including SIGTERM-only timeout handling.
  execSync(command: string, args: string[], options?: RuntimeExecOptions): ExecResult;
  kill(pid: number, signal: NodeJS.Signals | 0): boolean;
  observeLiveness(pid: number): ProcessLiveness;
  readProcessIncarnation(pid: number, platform: NodeJS.Platform): ProcessIncarnation | null;
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

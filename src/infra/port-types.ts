import { STANDING_PROBE_ERRNOS, type StandingProbeErrno } from './process-constants.js';
import type { ProcessIncarnation } from './node-process.js';
import type { RecordedProcessIdentity } from './process-containment.js';

// Canonical port-shape vocabulary. Domains and runtime alias these via
// `runtime/ports.ts`; infra-tier helpers reach here directly because infra
// is the lowest layer (cannot import upward from runtime/).

export interface TimerHandle {
  unref?(): void;
}

export interface TimePort {
  now(): number;
  monotonicNow(): bigint;
  sleep(ms: number, options?: { signal?: AbortSignal }): Promise<void>;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle | null): void;
  setInterval(fn: () => void, ms: number): TimerHandle;
  clearInterval(handle: TimerHandle | null): void;
}

export type ProcessIdentityObservation = Readonly<{
  owner: RecordedProcessIdentity;
  evidence:
    | Readonly<{ kind: 'incarnation'; incarnation: ProcessIncarnation }>
    | Readonly<{ kind: 'pid-absent' }>
    | Readonly<{
        kind: 'unobservable';
        cause: 'incarnation-unavailable' | 'probe-not-available' | 'probe-failed' | 'deadline-expired';
      }>;
}>;

export interface DirentLike {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

export type StorageData = string | Uint8Array;

export type SqliteValue = null | number | bigint | string | Uint8Array;

export interface SqliteStatementPort {
  all(...values: SqliteValue[]): unknown[];
  get(...values: SqliteValue[]): unknown;
  run(...values: SqliteValue[]): { readonly changes: number; readonly lastInsertRowid: number | bigint };
}

export interface SqliteDatabasePort {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatementPort;
  close(): void;
}

export type StorageBigIntStat = {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly uid?: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  isDirectory(): boolean;
  isFile(): boolean;
};

/** What a non-following observation reports about a path, without describing what it may resolve to. */
export type StorageEntryKind = { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean };

/**
 * Whether this process may traverse a directory — the permission a child's `chdir` needs, which neither
 * existence nor readability implies: measured on Node v26.3.1, `statSync` succeeds on a `chmod 000`
 * directory and `readdirSync` fails on an execute-only one that `spawn` enters without complaint.
 *
 * `denied` answers only the question asked, which an absent path answers the same way as an unsearchable
 * one: neither may be traversed. A caller that must tell those apart observes existence separately.
 * `unobserved` must never be treated as evidence that permission was granted or denied.
 */
export type DirectoryTraversability = 'traversable' | 'denied' | 'unobserved';

export interface StoragePort {
  assertReadableSync(path: string): void;
  observeDirectoryTraversabilitySync(path: string): DirectoryTraversability;
  readFile(path: string, encoding: 'utf-8'): Promise<string>;
  readFileSync(path: string, encoding: 'utf-8'): string;
  writeFileSync(
    path: string,
    data: StorageData,
    options?: { encoding?: BufferEncoding; mode?: number; flag?: string },
  ): void;
  renameSync(oldPath: string, newPath: string): void;
  linkSync(existingPath: string, newPath: string): void;
  mkdirSync(path: string, options?: { recursive?: boolean; mode?: number }): void;
  rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  readdirSync(path: string): string[];
  readdirSync(path: string, options: { withFileTypes: true }): DirentLike[];
  readDirectoryBoundedSync(
    path: string,
    limit: number,
  ): { readonly entries: readonly string[]; readonly overflow: boolean };
  statSync(path: string): { size: number; mtimeMs: number; isDirectory(): boolean; isFile(): boolean };
  statSync(path: string, options: { bigint: true }): StorageBigIntStat;
  fstatSync(fd: number, options: { bigint: true }): StorageBigIntStat;
  lstatSync(path: string): StorageEntryKind;
  lstatSync(path: string, options: { bigint: true }): StorageBigIntStat;
  realpathSync(path: string): string;
  existsSync(path: string): boolean;
  openSync(path: string, flags: string, mode?: number): number;
  readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number | null): number;
  writeSync(fd: number, buffer: Buffer, offset: number, length: number, position: number | null): number;
  fdatasyncSync(fd: number): void;
  closeSync(fd: number): void;
  appendFileSync(path: string, data: string): void;
  appendFileDurableSync(path: string, data: string): boolean;
  appendFileWithCanonicalCheckSync(
    path: string,
    data: string,
    options: { canonicalPath: string; maxRetries?: number },
  ): { ok: boolean; retries: number; orphanPath?: string };
  rmdirSync(path: string): void;
  unlinkSync(path: string): void;
  tryExclusiveWriteSync(
    path: string,
    data: StorageData,
    options?: { encoding?: BufferEncoding; mode?: number },
  ): boolean;
  writeAtomicSync(path: string, data: StorageData, options?: { encoding?: BufferEncoding; mode?: number }): boolean;
  writeAtomicDurableSync(
    path: string,
    data: StorageData,
    options?: { encoding?: BufferEncoding; mode?: number },
  ): boolean;
  syncDirectoryDurableSync(path: string): boolean;
  chmodSync(path: string, mode: number): void;
  openSqliteDatabaseSync(path: string, options?: { readOnly?: boolean }): SqliteDatabasePort;
}

export interface EnvPort {
  get(key: string): string | undefined;
  homedir(): string;
  tmpdir(): string;
  pid(): number;
  platform(): string;
  arch(): string;
  cwd(): string;
  fullSnapshot(): Readonly<Record<string, string>>;
  coralSnapshot(): Readonly<Record<string, string>>;
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
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly stdin: ChildStdinLike | null;
  readonly stdout: ChildReadableLike | null;
  readonly stderr: ChildReadableLike | null;
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
  unref?(): void;
}

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
 * The unrecognised shape lands on `no-answer` deliberately. A wrong `no-answer` costs a repeated command; a
 * wrong `answered` is a durable claim nobody observed.
 */
export type ExecOutcome =
  | Readonly<{ kind: 'answered'; status: number }>
  | Readonly<{ kind: 'launch-refused'; code: StandingProbeErrno }>
  | Readonly<{ kind: 'no-answer'; detail: string }>;

/** Adapters must not infer a command or working-directory condition beyond these evidence variants. */
export type SpawnFailureEvidence =
  | Readonly<{ kind: 'command-not-found' }>
  | Readonly<{ kind: 'command-not-executable'; code: Exclude<StandingProbeErrno, 'ENOENT'> }>
  | Readonly<{ kind: 'working-directory-missing' }>
  | Readonly<{ kind: 'working-directory-not-directory' }>
  | Readonly<{ kind: 'working-directory-not-traversable' }>
  | Readonly<{ kind: 'unresolved'; code: StandingProbeErrno }>;

function isStandingProbeErrno(code: string): code is StandingProbeErrno {
  return STANDING_PROBE_ERRNOS.has(code);
}

/**
 * The same three answers for the throwing shape, so a caller that reaches `node:child_process` directly is not
 * left to re-derive the rule.
 *
 * `execFileSync`/`execSync` report by throwing, and Node copies the result onto the error: a command that ran
 * and exited non-zero carries a numeric `status`, while a launch failure or a bound that elapsed carries a
 * string `code` and `status: null`. One site needs this — `infra/project-source.ts`, which sits below the
 * runtime composition (`runtime/real.ts` imports it to build `paths.projectSource`) and so has no `ProcessPort`
 * to read a result from. It kept its own predicate until this existed, which made the rule's fourth spelling.
 */
export function classifyThrownExecOutcome(error: unknown): ExecOutcome {
  if (typeof error !== 'object' || error === null) {
    return { kind: 'no-answer', detail: 'unknown error' };
  }
  const errno = error as NodeJS.ErrnoException & { status?: unknown };
  if (typeof errno.status === 'number') {
    return { kind: 'answered', status: errno.status };
  }
  if (typeof errno.code === 'string' && isStandingProbeErrno(errno.code)) {
    return { kind: 'launch-refused', code: errno.code };
  }
  return { kind: 'no-answer', detail: errno.code ?? errno.message ?? 'unknown error' };
}

export function classifyExecOutcome(result: ExecResult): ExecOutcome {
  if (result.error !== undefined) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (typeof code === 'string' && isStandingProbeErrno(code)) {
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

/**
 * A standing spawn errno cannot establish a command condition until the cwd ambiguity is resolved. Measured
 * on Node v26.3.1: `spawn` reports ENOENT for a missing command and a missing cwd, ENOTDIR when cwd is a file,
 * and EACCES for a cwd without search permission. `statSync` still succeeds without search permission, while
 * `readdirSync` rejects an execute-only directory; only `accessSync(path, X_OK)` matched the child's `chdir`.
 */
export function classifySpawnFailure(
  storage: Pick<StoragePort, 'observeDirectoryTraversabilitySync' | 'statSync'>,
  cwd: string,
  code: StandingProbeErrno,
): SpawnFailureEvidence {
  let directoryObserved = false;
  try {
    if (!storage.statSync(cwd).isDirectory()) return { kind: 'working-directory-not-directory' };
    directoryObserved = true;
  } catch (error: unknown) {
    const cwdCode = (error as NodeJS.ErrnoException | undefined)?.code;
    if (cwdCode === 'ENOENT') return { kind: 'working-directory-missing' };
    if (cwdCode === 'ENOTDIR') return { kind: 'working-directory-not-directory' };
  }

  if (code === 'ENOENT') {
    return directoryObserved ? { kind: 'command-not-found' } : { kind: 'unresolved', code };
  }
  if (code === 'ENOTDIR') {
    return directoryObserved ? { kind: 'command-not-executable', code } : { kind: 'unresolved', code };
  }

  const traversability = storage.observeDirectoryTraversabilitySync(cwd);
  if (traversability === 'denied') return { kind: 'working-directory-not-traversable' };
  if (traversability === 'unobserved' || !directoryObserved) return { kind: 'unresolved', code };
  return { kind: 'command-not-executable', code };
}

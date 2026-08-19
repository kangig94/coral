import { STANDING_PROBE_ERRNOS } from './process-constants.js';

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

export interface DirentLike {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

export type StorageData = string | Uint8Array;

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

export interface StoragePort {
  readFile(path: string, encoding: 'utf-8'): Promise<string>;
  readFileSync(path: string, encoding: 'utf-8'): string;
  writeFileSync(
    path: string,
    data: StorageData,
    options?: { encoding?: BufferEncoding; mode?: number; flag?: string },
  ): void;
  renameSync(oldPath: string, newPath: string): void;
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
  lstatSync(path: string): { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean };
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
  readonly stdin: ChildStdinLike | null;
  readonly stdout: ChildReadableLike | null;
  readonly stderr: ChildReadableLike | null;
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
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
  | Readonly<{ kind: 'launch-refused'; code: string }>
  | Readonly<{ kind: 'no-answer'; detail: string }>;

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
  if (typeof errno.code === 'string' && STANDING_PROBE_ERRNOS.has(errno.code)) {
    return { kind: 'launch-refused', code: errno.code };
  }
  return { kind: 'no-answer', detail: errno.code ?? errno.message ?? 'unknown error' };
}

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

import {
  execFile,
  execFileSync,
  type ChildProcess,
  type ExecFileOptionsWithStringEncoding,
  type ExecFileSyncOptionsWithStringEncoding,
} from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile as readFileAsync } from 'node:fs/promises';
import { z } from 'zod';

import { SIGTERM_GRACE_MS } from './process-constants.js';

/** Every async platform probe must share one deadline derived from this end-to-end allowance. */
export const PROCESS_INCARNATION_PROBE_TIMEOUT_MS = 2_000;

/** Synchronous incarnation probes share one timeout-bearing exec shape. */
const PROBE_EXEC_OPTIONS: ExecFileSyncOptionsWithStringEncoding = {
  encoding: 'utf-8',
  stdio: ['ignore', 'pipe', 'ignore'],
  timeout: PROCESS_INCARNATION_PROBE_TIMEOUT_MS,
};

/**
 * A signature saying `boolean` hides a third outcome from the compiler, so every caller looks total while a
 * third of the behaviour is invisible. Naming the third outcome moves that audit from a person to `tsc`: a
 * caller must now say which of the three it means.
 *
 * `unknown` is not a weaker `absent` and must never be read as one. It is "the question could not be asked" —
 * `EPERM` is a process this caller may not signal, which is still a process, and an unexpected errno is a probe
 * that failed rather than a process that is gone. Only `absent` may finalize anything.
 */
export type ProcessLiveness = 'alive' | 'absent' | 'unknown';

export function observeProcessLiveness(pid: number): ProcessLiveness {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'absent';
    if (code === 'EPERM') return 'alive';
    return 'unknown';
  }
}

/**
 * A process incarnation: opaque, and comparable only by equality.
 *
 * What the kernel actually stores is "this process began at boot-tick N", and that is what this carries.
 * `boot_id` is not decoration: start ticks alone are comparable within one boot, but after a reboot a
 * recorded `pid=1234, ticks=500` can genuinely *match* a fresh low-pid process — a false match at exactly
 * the pids reused earliest in boot, which is the one outcome the containment doctrine forbids.
 *
 * The brand carries part of the enforcement, and it is worth being exact about which part. Subtraction and
 * every other arithmetic operator stop at the type, so "within N seconds" is not expressible; an unbranded
 * string cannot stand in for one, so a value can only enter through a probe or a parse. What it does *not*
 * stop is `<` and `+`, which TypeScript allows on any string. Ordering two of these is meaningless rather
 * than ill-typed, and `tests/invariants/process-incarnation-opacity.test.ts` is what guards the shape the
 * brand cannot: rebuilding an identity from a clock.
 */
export type ProcessIncarnation = string & { readonly __processIncarnation: 'process-incarnation' };

/** Accepted-token and maximum-encoding bounds must share this value. */
export const MAX_PROCESS_INCARNATION_LENGTH = 256;

export function isProcessIncarnation(value: unknown): value is ProcessIncarnation {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_PROCESS_INCARNATION_LENGTH;
}

/** The wire and durable form. Opaque on purpose: readers compare, they never parse. */
export const processIncarnationSchema = z.string().min(1).max(MAX_PROCESS_INCARNATION_LENGTH) as unknown as z.ZodType<
  ProcessIncarnation,
  z.ZodStringDef,
  ProcessIncarnation
>;

function readLinuxBootId(): string | null {
  try {
    const raw = readFileSync('/proc/sys/kernel/random/boot_id', 'utf-8').trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

export function parseLinuxProcessIncarnation(bootIdInput: string, stat: string): ProcessIncarnation | null {
  const bootId = bootIdInput.trim();
  if (bootId.length === 0) return null;
  const closeParen = stat.lastIndexOf(')');
  if (closeParen === -1) return null;
  const fields = stat
    .slice(closeParen + 2)
    .trim()
    .split(/\s+/);
  const startTicks = fields[19];
  if (startTicks === undefined || !/^\d+$/.test(startTicks)) return null;
  return `linux:${bootId}:${startTicks}` as ProcessIncarnation;
}

function probeLinuxProcessIncarnation(pid: number): ProcessIncarnation | null {
  const bootId = readLinuxBootId();
  if (bootId === null) {
    return null;
  }

  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
    return parseLinuxProcessIncarnation(bootId, stat);
  } catch {
    return null;
  }
}

/**
 * Whether an incarnation from this platform is strong enough to authorize a signal.
 *
 * Linux's is boot-relative. `startTicks` counts from boot, so no wall-clock change can move it, and two
 * processes share one only by starting in the same tick — which needs the pid space to wrap inside ~10ms.
 *
 * Darwin's cannot be, and no amount of framing fixes it. macOS exposes no boot-relative start without a
 * native addon: `ps -o lstart=` is wall clock at one-second resolution, and `kern.boottime` is itself derived
 * from calendar time. The boot session id closes the across-reboot half, but *within* one boot a backward
 * clock change — an NTP step, a DST fallback — lets a later process reuse a pid and land on the same
 * displayed second, so two processes produce one token. Equality there would authorize SIGKILL against a
 * stranger, so on Darwin it authorizes nothing.
 *
 * The token stays useful on Darwin for the conservative direction, which is most of what it is for: a false
 * match reads as "still alive", blocking a disappearance claim rather than licensing an action.
 */
export function incarnationMayAuthorizeSignal(platform: NodeJS.Platform): boolean {
  return platform === 'linux';
}

/**
 * This boot's identity on macOS — `kern.bootsessionuuid`, not `kern.boottime`.
 *
 * The two are not interchangeable and the difference is the whole point. `kern.boottime` is *derived* from
 * calendar time, so XNU adjusts it whenever the wall clock is set; a frame that moves with the clock cannot
 * frame a wall-clock start time, because both sides shift together and a later process can land on an earlier
 * one's coordinates. The session UUID is minted once per boot and never moves.
 *
 * Read fresh every time, exactly as `readLinuxBootId` is. The only thing that changes a boot session id
 * is a reboot, and no process survives one, so a successful read is constant for as long as anything can ask.
 * Caching it would be sound.
 *
 * It is not cached for two smaller reasons. Remembering a *failure* is genuinely wrong — a transient `sysctl`
 * error would blind every later probe until restart — so a cache here is a cache of successes only, which is
 * module-level state that outlives the test scripting a different boot around it. And the cost that made it
 * tempting is gone: the hot caller was the health response, which now reads this process's own incarnation
 * once at composition rather than per request. What remains are probes of *other* pids, where the `ps` call
 * has to happen anyway and saving one of two forks buys little.
 */
function readMacBootSessionId(): string | null {
  try {
    const raw = execFileSync('sysctl', ['-n', 'kern.bootsessionuuid'], PROBE_EXEC_OPTIONS).trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/**
 * macOS has no `/proc`, so the start time comes from `ps` at **one-second resolution**. That is a coordinate
 * within a boot, not an identity: the pid space restarts after a reboot at exactly the values a stale record
 * is most likely to name. The boot session id is what makes the pair an identity — the same role `boot_id`
 * plays on Linux, and for the same reason.
 *
 * The residual, stated because it is the reason `incarnationMayAuthorizeSignal` refuses this platform: two
 * processes that hold the same pid *and* the same displayed start second *within one boot* are
 * indistinguishable. The boot session id closes the across-reboot half completely — a UUID minted per boot
 * that no reboot preserves. It does **not** close a clock change. `ps -o lstart=` prints local time and `Date.parse` reads a zone-less string as local, so a
 * backward step — an NTP correction, the autumn DST fallback — makes one displayed string name two instants.
 * The window is then an hour rather than a second, which is why equality here authorizes nothing.
 *
 * Either half unreadable returns null rather than a guess — "could not observe", which every caller already
 * distinguishes from absence.
 */
function probeMacProcessIncarnation(pid: number): ProcessIncarnation | null {
  try {
    const bootSessionId = readMacBootSessionId();
    if (bootSessionId === null) {
      return null;
    }

    const raw = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], PROBE_EXEC_OPTIONS).trim();
    if (!raw) {
      return null;
    }

    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? (`darwin:${bootSessionId}:${parsed}` as ProcessIncarnation) : null;
  } catch {
    return null;
  }
}

function probeWindowsProcessIncarnation(pid: number): ProcessIncarnation | null {
  try {
    const raw = execFileSync(
      'wmic',
      ['process', 'where', `ProcessId=${pid}`, 'get', 'CreationDate', '/value'],
      PROBE_EXEC_OPTIONS,
    );
    const match = raw.match(/CreationDate=(\d{14}\.\d+[+-]\d+)/) ?? raw.match(/CreationDate=(\d{14})/);
    const value = match?.[1];
    return value === undefined ? null : (`win32:${value}` as ProcessIncarnation);
  } catch {
    return null;
  }
}

const PROCESS_INCARNATION_PROBES: ReadonlyMap<string, (pid: number) => ProcessIncarnation | null> = new Map([
  ['linux', probeLinuxProcessIncarnation],
  ['darwin', probeMacProcessIncarnation],
  ['win32', probeWindowsProcessIncarnation],
]);

export function canProbeProcessIncarnation(platform: string): boolean {
  return PROCESS_INCARNATION_PROBES.has(platform);
}

/**
 * `null` is "could not observe an incarnation" — an absent process, an unreadable `/proc` entry, or a
 * platform with no probe. It is never proof of absence on its own, and callers that need absence must
 * pair it with a liveness check.
 */
export function probeProcessIncarnation(pid: number, platform = process.platform): ProcessIncarnation | null {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }

  return PROCESS_INCARNATION_PROBES.get(platform)?.(pid) ?? null;
}

/** The question "is this recorded process still there", bound to the readers that answer it. */
export type RecordedProcessObserver = (
  recorded: Readonly<{ pid: number; incarnation?: ProcessIncarnation }>,
) => ProcessLiveness;

/**
 * Whether the process a record names is still the process that was recorded.
 *
 * Identity decides before liveness. A pid observed `alive` may be a different process wearing the same
 * number, so `alive` alone is never proof the recorded process is still there, and a readable token that
 * disagrees with the recorded one is proof it is gone whatever liveness would say. A record carrying no
 * incarnation has nothing to compare, so the identity reader must not be asked for one: a token held against
 * a record that has none disagrees with it, which would read as absence for a process nobody looked for.
 *
 * Identity is not the only evidence that may finalize. `absent` says nothing holds the pid, and the recorded
 * process cannot be running without one, so a liveness `absent` decides on whichever route reaches it.
 *
 * An unreadable token is not a disagreement, so it falls through to liveness — never to `absent`, and not to
 * `unknown` either, or a host whose identity reader cannot read would settle nothing, ever. The price of that
 * fallback is that such a host treats every record as though it carried no token.
 *
 * A reader that *throws* answers `unknown`, never `absent`: a question that could not be asked has not been
 * answered.
 *
 * The readers are injected rather than reached for, so what crosses to a caller allowed only to conclude is
 * this one function and no capability to signal. The predicate a caller about to *signal* needs is not this
 * one and must not be unified with it: the ambiguity this one is required to return, that one is required to
 * refuse — see observeProcessIdentity in src/infra/process-containment.ts.
 */
export function createRecordedProcessObserver(
  readers: Readonly<{
    readIncarnation: (pid: number) => ProcessIncarnation | null;
    observeLiveness: (pid: number) => ProcessLiveness;
  }>,
): RecordedProcessObserver {
  return (recorded) => {
    try {
      if (recorded.incarnation === undefined) {
        return readers.observeLiveness(recorded.pid);
      }
      const observed = readers.readIncarnation(recorded.pid);
      if (observed === null) {
        return readers.observeLiveness(recorded.pid);
      }
      return observed === recorded.incarnation ? 'alive' : 'absent';
    } catch {
      return 'unknown';
    }
  };
}

// -------------------------------------------------------------------------------------------------------
// The non-blocking sibling of everything above: identity evidence obtained without ever calling
// `execFileSync`/`readFileSync`, for a guardian/reaper answering loop that cannot afford either to stall.
// -------------------------------------------------------------------------------------------------------

type AsyncProbeExecOptions = ExecFileOptionsWithStringEncoding & Readonly<{ signal: AbortSignal }>;

export type ProcessIncarnationProbeTerminator = (child: ChildProcess) => void;

function asyncProbeExecOptions(signal: AbortSignal): AsyncProbeExecOptions {
  return { encoding: 'utf-8', signal };
}

type ProcessIncarnationProbeRegistration = {
  state: 'running' | 'terminating';
  retryTimer: NodeJS.Timeout | null;
  terminate: ProcessIncarnationProbeTerminator;
  settlementWaiters: Set<(hold: ProcessIncarnationProbeHold | null) => void>;
  closed: Promise<void>;
  resolveClosed(): void;
  lease: ProcessIncarnationProbeLease;
};

const processIncarnationProbeChildren = new Map<ChildProcess, ProcessIncarnationProbeRegistration>();

type ProcessIncarnationProbeLease = {
  key: string;
  children: Set<ChildProcess>;
  probeSettled: boolean;
};

const processIncarnationProbeLeases = new Map<string, ProcessIncarnationProbeLease>();

/** A shutdown hold keeps the exact child registered, and only observing its close can settle the hold. */
export type ProcessIncarnationProbeHold = Readonly<{
  child: ChildProcess;
  pid: number | undefined;
  reason: 'termination-failed' | 'close-unobserved';
  exit: 'child-close';
  error?: unknown;
}>;

/** Probe cleanup cannot report settlement while any owned child remains registered. */
export type ProcessIncarnationProbeCleanupDisposition =
  | Readonly<{ disposition: 'settled' }>
  | Readonly<{
      disposition: 'hold';
      unsettled: readonly ProcessIncarnationProbeHold[];
      untilSettled: Promise<void>;
    }>;

function settleProcessIncarnationProbeTermination(
  registration: ProcessIncarnationProbeRegistration,
  hold: ProcessIncarnationProbeHold | null,
): void {
  for (const resolve of registration.settlementWaiters) resolve(hold);
  registration.settlementWaiters.clear();
}

function processIncarnationProbeHold(
  child: ChildProcess,
  reason: ProcessIncarnationProbeHold['reason'],
  error?: unknown,
): ProcessIncarnationProbeHold {
  return {
    child,
    pid: child.pid,
    reason,
    exit: 'child-close',
    ...(error === undefined ? {} : { error }),
  };
}

function releaseProcessIncarnationProbeLease(lease: ProcessIncarnationProbeLease): void {
  if (!lease.probeSettled || lease.children.size > 0) return;
  if (processIncarnationProbeLeases.get(lease.key) === lease) {
    processIncarnationProbeLeases.delete(lease.key);
  }
}

function terminateProcessIncarnationProbeChild(child: ChildProcess): void {
  const registration = processIncarnationProbeChildren.get(child);
  if (registration?.state !== 'running') return;
  registration.state = 'terminating';
  try {
    registration.terminate(child);
  } catch (error: unknown) {
    registration.state = 'running';
    settleProcessIncarnationProbeTermination(
      registration,
      processIncarnationProbeHold(child, 'termination-failed', error),
    );
    throw error;
  }
  if (processIncarnationProbeChildren.get(child) !== registration) return;
  registration.retryTimer = setTimeout(() => {
    if (processIncarnationProbeChildren.get(child) !== registration) return;
    registration.state = 'running';
    registration.retryTimer = null;
    settleProcessIncarnationProbeTermination(registration, processIncarnationProbeHold(child, 'close-unobserved'));
  }, SIGTERM_GRACE_MS);
  registration.retryTimer.unref();
}

/** A probe child may not leave this registry before close, including after its caller's deadline settles. */
export function processIncarnationProbeRegistrySize(): number {
  return processIncarnationProbeChildren.size;
}

/** An aborted cleanup wait reports a hold; only child-close may remove the retained registry entry. */
export async function terminateProcessIncarnationProbes(
  signal?: AbortSignal,
): Promise<ProcessIncarnationProbeCleanupDisposition> {
  const attempts = [...processIncarnationProbeChildren.entries()].map(([child, registration]) => {
    const settled = new Promise<ProcessIncarnationProbeHold | null>((resolve) => {
      let onAbort: (() => void) | null = null;
      const finish = (hold: ProcessIncarnationProbeHold | null): void => {
        registration.settlementWaiters.delete(finish);
        if (onAbort !== null && signal !== undefined) signal.removeEventListener('abort', onAbort);
        resolve(hold);
      };
      registration.settlementWaiters.add(finish);
      if (signal !== undefined) {
        onAbort = () => finish(processIncarnationProbeHold(child, 'close-unobserved'));
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
    });
    if (signal?.aborted !== true) {
      try {
        terminateProcessIncarnationProbeChild(child);
      } catch {
        // A termination this call could not deliver decides nothing about the child: only `close` resolves the
        // settlement promise below, so a throw here must not skip the wait that reports the child as unsettled.
      }
    }
    return settled.then((hold) => (hold === null ? null : { hold, untilSettled: registration.closed }));
  });

  const unsettled = (await Promise.all(attempts)).filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  if (unsettled.length === 0) return { disposition: 'settled' };
  return {
    disposition: 'hold',
    unsettled: unsettled.map(({ hold }) => hold),
    untilSettled: Promise.all(unsettled.map(({ untilSettled }) => untilSettled)).then(() => undefined),
  };
}

function probeDeadlineError(signal: AbortSignal): Error {
  // `AbortSignal.reason` is typed `any`, and a caller may pass a controller whose reason is not an `Error` at
  // all, so the deadline this rejects with is narrowed here rather than at each `reject`.
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  return new Error('Process incarnation probe deadline expired');
}

function execFileAsync(
  file: string,
  args: readonly string[],
  options: AsyncProbeExecOptions,
  terminate: ProcessIncarnationProbeTerminator,
  lease: ProcessIncarnationProbeLease,
): Promise<{ stdout: string; stderr: string }> {
  const { signal, ...execOptions } = options;
  if (signal.aborted) {
    return Promise.reject(probeDeadlineError(signal));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const child = execFile(file, args as string[], execOptions, (error, stdout, stderr) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (error) {
        // `@types/node` builds `ExecFileException` as `Omit<ExecException, 'code'> & Omit<NodeJS.ErrnoException,
        // 'code'>`, and `Omit` drops the `Error` base, so this value is not statically an `Error` however
        // reliably Node supplies one. The wrap is what the type says, not defensive padding.
        reject(error instanceof Error ? error : new Error(error.message));
        return;
      }
      resolve({ stdout, stderr });
    });

    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      try {
        terminateProcessIncarnationProbeChild(child);
      } finally {
        reject(probeDeadlineError(signal));
      }
    };

    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    lease.children.add(child);
    processIncarnationProbeChildren.set(child, {
      state: 'running',
      retryTimer: null,
      terminate,
      settlementWaiters: new Set(),
      closed,
      resolveClosed,
      lease,
    });
    child.on('close', () => {
      signal.removeEventListener('abort', onAbort);
      const registration = processIncarnationProbeChildren.get(child);
      if (registration?.retryTimer !== null && registration?.retryTimer !== undefined) {
        clearTimeout(registration.retryTimer);
      }
      processIncarnationProbeChildren.delete(child);
      if (registration !== undefined) {
        settleProcessIncarnationProbeTermination(registration, null);
        registration.resolveClosed();
        registration.lease.children.delete(child);
        releaseProcessIncarnationProbeLease(registration.lease);
      }
    });
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function processIncarnationProbeSignal(): AbortSignal {
  return AbortSignal.timeout(PROCESS_INCARNATION_PROBE_TIMEOUT_MS);
}

async function readLinuxBootIdAsync(signal: AbortSignal): Promise<string | null> {
  try {
    const raw = (await readFileAsync('/proc/sys/kernel/random/boot_id', { encoding: 'utf-8', signal })).trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

async function probeLinuxProcessIncarnationAsync(pid: number): Promise<ProcessIncarnation | null> {
  const signal = processIncarnationProbeSignal();
  const bootId = await readLinuxBootIdAsync(signal);
  if (bootId === null) {
    return null;
  }

  try {
    const stat = await readFileAsync(`/proc/${pid}/stat`, { encoding: 'utf-8', signal });
    return parseLinuxProcessIncarnation(bootId, stat);
  } catch {
    return null;
  }
}

async function readMacBootSessionIdAsync(
  signal: AbortSignal,
  terminate: ProcessIncarnationProbeTerminator,
  lease: ProcessIncarnationProbeLease,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'sysctl',
      ['-n', 'kern.bootsessionuuid'],
      asyncProbeExecOptions(signal),
      terminate,
      lease,
    );
    const raw = stdout.trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

async function probeMacProcessIncarnationAsync(
  pid: number,
  terminate: ProcessIncarnationProbeTerminator,
  lease: ProcessIncarnationProbeLease,
): Promise<ProcessIncarnation | null> {
  const signal = processIncarnationProbeSignal();
  try {
    const bootSessionId = await readMacBootSessionIdAsync(signal, terminate, lease);
    if (bootSessionId === null) {
      return null;
    }

    const { stdout } = await execFileAsync(
      'ps',
      ['-o', 'lstart=', '-p', String(pid)],
      asyncProbeExecOptions(signal),
      terminate,
      lease,
    );
    const raw = stdout.trim();
    if (!raw) {
      return null;
    }

    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? (`darwin:${bootSessionId}:${parsed}` as ProcessIncarnation) : null;
  } catch {
    return null;
  }
}

async function probeWindowsProcessIncarnationAsync(
  pid: number,
  terminate: ProcessIncarnationProbeTerminator,
  lease: ProcessIncarnationProbeLease,
): Promise<ProcessIncarnation | null> {
  try {
    const { stdout } = await execFileAsync(
      'wmic',
      ['process', 'where', `ProcessId=${pid}`, 'get', 'CreationDate', '/value'],
      asyncProbeExecOptions(processIncarnationProbeSignal()),
      terminate,
      lease,
    );
    const match = stdout.match(/CreationDate=(\d{14}\.\d+[+-]\d+)/) ?? stdout.match(/CreationDate=(\d{14})/);
    const value = match?.[1];
    return value === undefined ? null : (`win32:${value}` as ProcessIncarnation);
  } catch {
    return null;
  }
}

const ASYNC_PROCESS_INCARNATION_PROBES: ReadonlyMap<
  string,
  (
    pid: number,
    terminate: ProcessIncarnationProbeTerminator,
    lease: ProcessIncarnationProbeLease,
  ) => Promise<ProcessIncarnation | null>
> = new Map([
  ['linux', probeLinuxProcessIncarnationAsync],
  ['darwin', probeMacProcessIncarnationAsync],
  ['win32', probeWindowsProcessIncarnationAsync],
]);

/** The non-blocking sibling of `probeProcessIncarnation`: same null-on-unreadable contract, same per-platform
 *  probes, none of them synchronous. */
export async function probeProcessIncarnationAsync(
  pid: number,
  terminate: ProcessIncarnationProbeTerminator,
  platform: string = process.platform,
): Promise<ProcessIncarnation | null> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }

  const probe = ASYNC_PROCESS_INCARNATION_PROBES.get(platform);
  if (probe === undefined) return null;

  const key = `${platform}:${pid}`;
  if (processIncarnationProbeLeases.has(key)) return null;

  const lease: ProcessIncarnationProbeLease = { key, children: new Set(), probeSettled: false };
  processIncarnationProbeLeases.set(key, lease);
  try {
    return await probe(pid, terminate, lease);
  } finally {
    lease.probeSettled = true;
    releaseProcessIncarnationProbeLease(lease);
  }
}

/** The asynchronous three-answer question: the same shape as `RecordedProcessObserver`, resolved instead of
 *  returned, so a caller can await it without blocking the loop it answers on. */
export type AsyncRecordedProcessObserver = (
  recorded: Readonly<{ pid: number; incarnation: ProcessIncarnation }>,
  signal?: AbortSignal,
) => Promise<ProcessLiveness>;

/**
 * The stricter, non-blocking sibling of `createRecordedProcessObserver`. `incarnation` is required here, not
 * optional: there is no call this function accepts that names a record with no incarnation, so there is
 * nothing for a pid-only fallback to apply to — pid-only life cannot prove the admitted holder still owns
 * the pid, which is the whole reason a stricter sibling exists.
 *
 * Liveness (`kill(pid, 0)`, synchronous and free of I/O) is checked first: a genuine `ESRCH` is decisive on
 * its own and short-circuits the identity read, which is bounded but never free. Otherwise the token is read
 * and compared. An unreadable token cannot prove identity; only a second liveness check that finds the pid
 * absent may decide the process disappeared. A readable, mismatched token answers `absent` (pid reuse)
 * regardless of what the liveness check believed. And a liveness check that could not itself
 * conclude alive-or-absent keeps the overall answer `unknown` even when the token happens to read back a
 * match: "liveness ... cannot be observed" is its own trigger for `unknown`, independent of whether identity
 * could be.
 */
export function createAsyncRecordedProcessObserver(
  readers: Readonly<{
    readIncarnation: (pid: number, signal?: AbortSignal) => Promise<ProcessIncarnation | null>;
    observeLiveness: (pid: number) => ProcessLiveness;
  }>,
): AsyncRecordedProcessObserver {
  const readWhileAuthorized = (pid: number, signal: AbortSignal | undefined): Promise<ProcessIncarnation | null> => {
    if (signal === undefined) return readers.readIncarnation(pid);
    if (signal.aborted) return Promise.resolve(null);

    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: ProcessIncarnation | null): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const onAbort = (): void => finish(null);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
      void readers.readIncarnation(pid, signal).then(finish, () => finish(null));
    });
  };

  return async (recorded, signal) => {
    try {
      const liveness = readers.observeLiveness(recorded.pid);
      if (liveness === 'absent') return 'absent';
      const observed = await readWhileAuthorized(recorded.pid, signal);
      if (observed === null) return readers.observeLiveness(recorded.pid) === 'absent' ? 'absent' : 'unknown';
      if (observed !== recorded.incarnation) return 'absent';
      return liveness === 'unknown' ? 'unknown' : 'alive';
    } catch {
      return 'unknown';
    }
  };
}

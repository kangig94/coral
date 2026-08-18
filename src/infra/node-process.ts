import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * Bounds one probe *subprocess*, not one probe: `probeMacProcessIncarnation` issues two in sequence and does
 * not cache the first, so a wedged darwin probe costs twice this.
 *
 * Best-effort, and nothing may rely on more. Node implements a synchronous timeout by sending `killSignal`
 * and then continuing to wait for the child to exit, so a child that blocks or ignores it still overruns.
 * Nothing *can* rely on hardness anyway: every deadline mechanism here is asynchronous, and none of them
 * preempt a synchronous `execFileSync`, which blocks the event loop outright. This makes a wedged probe
 * return; it does not make any caller's deadline enforceable, and the difference is not academic for callers
 * that sweep a recorded set — `docs/todo/containment-observation-deadline.md` owns that analysis, deliberately
 * rather than here, because every fact in it belongs to a module this one cannot see change.
 *
 * 2s matches the bound `env-sanitize.ts` already uses for a synchronous subprocess. There is no measurement
 * behind either number — do not add one to a comment without taking it.
 *
 * What the bound cannot do is the part that makes it safe: it turns a would-be-successful observation into a
 * throw, and every call site's existing `catch` answers `null`. It cannot fabricate a token, so it cannot
 * make an equality check newly pass. That is narrower than "it cannot authorize a signal" — not every signal
 * is equality-gated — so it is the only claim to rely on.
 */
const PROCESS_INCARNATION_PROBE_TIMEOUT_MS = 2_000;

/**
 * The one exec shape the incarnation probes share. Named so the three call sites cannot drift apart on it —
 * a site that quietly loses the timeout is the defect the bound exists to prevent, and
 * `tests/invariants/sync-subprocess-timeout.test.ts` fails when one does.
 */
const PROBE_EXEC_OPTIONS: ExecFileSyncOptionsWithStringEncoding = {
  encoding: 'utf-8',
  stdio: ['ignore', 'pipe', 'ignore'],
  timeout: PROCESS_INCARNATION_PROBE_TIMEOUT_MS,
};

/**
 * What a liveness probe can actually report — three outcomes, because there are three.
 *
 * This was a `boolean` that threw on the third, and the type is the whole point of the change. A signature
 * saying `boolean` hides the third outcome from the compiler, so every caller looks total while a third of the
 * behaviour is invisible; four successive hand audits of the same eighteen call sites each missed different
 * ones, and two of the misses were a coordinator that exits and a job terminalized as failed. Naming the third
 * outcome moves that audit from a person to `tsc`: a caller must now say which of the three it means.
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
 * The previous primitive returned `/proc/stat` btime plus the process's start ticks, floored to seconds.
 * btime is not a constant — the kernel recomputes it on every read as `realtime_now - boottime_now`, and
 * where those two clocks advance at different rates it climbs (measured: 3 seconds per 23 seconds of wall
 * time on a WSL2 host). So that value was the process's identity *plus a noise sample taken at probe
 * time*, with no record of which sample was used. Two processes comparing it disagreed by roughly the
 * age gap between their first probes, which made a live process look like a different one — or, on the
 * paths that read a mismatch as absence, like no process at all.
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
 * brand cannot: rebuilding an identity from a clock. Prose alone could not hold this — the previous shape
 * spread because a comment named an unsound site as the canonical pattern.
 */
export type ProcessIncarnation = string & { readonly __processIncarnation: 'process-incarnation' };

/**
 * The one admission test for the token, so the bound cannot drift between the schema and the hand-written
 * guards on the health and signal-ledger paths that validate the same field without Zod.
 */
export function isProcessIncarnation(value: unknown): value is ProcessIncarnation {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

/** The wire and durable form. Opaque on purpose: readers compare, they never parse. */
export const processIncarnationSchema = z.custom<ProcessIncarnation>(isProcessIncarnation, {
  message: 'must be a process incarnation token',
});

function readLinuxBootId(): string | null {
  try {
    const raw = readFileSync('/proc/sys/kernel/random/boot_id', 'utf-8').trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

function probeLinuxProcessIncarnation(pid: number): ProcessIncarnation | null {
  const bootId = readLinuxBootId();
  if (bootId === null) {
    return null;
  }

  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
    // The comm field is parenthesised and may itself contain spaces and parentheses, so fields are counted
    // from the last ')'. Field 22 (1-based) is starttime, the first field after that point being index 0.
    const closeParen = stat.lastIndexOf(')');
    if (closeParen === -1) {
      return null;
    }

    const fields = stat
      .slice(closeParen + 2)
      .trim()
      .split(/\s+/);
    const startTicks = fields[19];
    if (startTicks === undefined || !/^\d+$/.test(startTicks)) {
      return null;
    }

    return `linux:${bootId}:${startTicks}` as ProcessIncarnation;
  } catch {
    return null;
  }
}

/**
 * This boot's identity on macOS — `kern.bootsessionuuid`, not `kern.boottime`.
 *
 * The two are not interchangeable and the difference is the whole point. `kern.boottime` is *derived* from
 * calendar time, so XNU adjusts it whenever the wall clock is set; a frame that moves with the clock cannot
 * frame a wall-clock start time, because both sides shift together and a later process can land on an earlier
 * one's coordinates. The session UUID is minted once per boot and never moves.
 *
 * Read fresh every time, exactly as `readLinuxBootId` is — but be exact about why, because an earlier version
 * of this comment gave a reason that does not hold. It claimed remembering a value would assert across a
 * boundary this function cannot see. There is no such boundary: the only thing that changes a boot session id
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

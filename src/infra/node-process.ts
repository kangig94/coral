import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
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
    const raw = execFileSync('sysctl', ['-n', 'kern.bootsessionuuid'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
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
 * that no reboot preserves. It does **not** close a clock change, and an earlier version of this comment
 * claimed it did. `ps -o lstart=` prints local time and `Date.parse` reads a zone-less string as local, so a
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

    const raw = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
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
    const raw = execFileSync('wmic', ['process', 'where', `ProcessId=${pid}`, 'get', 'CreationDate', '/value'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
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

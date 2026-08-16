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

/** This boot, as the kernel reports it. macOS has no `boot_id`, and `kern.boottime` is the nearest thing:
 *  it changes on every boot, and it moves if the wall clock is reset — both of which must invalidate every
 *  token derived from a wall-clock start time. Cached because a boot does not happen mid-process. */
let macBootStampCache: string | null | undefined;
function readMacBootStamp(): string | null {
  if (macBootStampCache !== undefined) return macBootStampCache;
  try {
    const raw = execFileSync('sysctl', ['-n', 'kern.boottime'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    // `{ sec = 1700000000, usec = 123456 } Tue Nov 14 ...` — the numbers are the part that identifies a boot.
    const sec = /sec\s*=\s*(\d+)/u.exec(raw)?.[1];
    const usec = /usec\s*=\s*(\d+)/u.exec(raw)?.[1];
    macBootStampCache = sec === undefined ? null : `${sec}.${usec ?? '0'}`;
  } catch {
    macBootStampCache = null;
  }
  return macBootStampCache;
}

/**
 * macOS has no `/proc`, so the start time comes from `ps` at **one-second resolution** and on the wall clock.
 * Neither is enough on its own: a wall-clock start time repeats after a clock reset, and a reboot restarts the
 * pid space at exactly the values a stale record is most likely to name. `kern.boottime` is what makes the
 * pair an identity — the same role `boot_id` plays on Linux, and for the same reason.
 *
 * What remains, stated because equality here authorizes a signal: two processes that hold the same pid within
 * one displayed second of one boot are indistinguishable. Reaching that needs the pid space to wrap inside a
 * second, which is ~100k spawns per second sustained. It is a residual, not a guarantee — and it is why this
 * returns null rather than guessing whenever either half is unreadable.
 */
function probeMacProcessIncarnation(pid: number): ProcessIncarnation | null {
  try {
    const bootStamp = readMacBootStamp();
    if (bootStamp === null) {
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
    return Number.isFinite(parsed) ? (`darwin:${bootStamp}:${parsed}` as ProcessIncarnation) : null;
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

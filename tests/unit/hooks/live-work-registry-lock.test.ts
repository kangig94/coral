import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The flock probe in live-work-registry shells out to `flock -n <lock> -c true`
// via execFileSync. Mock it to drive each lock-liveness branch deterministically,
// with no real subprocess or timing coordination — so the "lock held ⇒ alive" and
// "flock(1) absent ⇒ mtime fallback" paths are covered identically on every OS.
const { execFileSyncMock } = vi.hoisted(() => ({ execFileSyncMock: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: execFileSyncMock }));

// @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
import { hasLiveWork } from '../../../clients/hooks/lib/live-work-registry.mjs';
// @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
import { projectPathKey } from '../../../clients/hooks/lib/plugin-paths.mjs';

const SESSION = 'sess-lock-0001';
const BG_STALE_MS = 60_000; // > BG_MTIME_WINDOW_MS (30s)

let sandbox: string;
let projectDir: string;

// execFileSync stand-ins for each `flock -n` outcome.
function flockHeld(): void {
  // Busy ⇒ flock exits non-zero ⇒ execFileSync throws with a status, no `code`.
  execFileSyncMock.mockImplementation(() => {
    const err = new Error('flock: failed to acquire lock') as NodeJS.ErrnoException & { status?: number };
    err.status = 1;
    throw err;
  });
}
function flockFree(): void {
  // Acquired ⇒ the `-c true` command runs and execFileSync returns normally.
  execFileSyncMock.mockImplementation(() => Buffer.from(''));
}
function flockUnanswered(code: string): void {
  // Killed by its own bound, or never forked — `status` stays null and a string `code` is what arrives.
  execFileSyncMock.mockImplementation(() => {
    const err = new Error(code) as NodeJS.ErrnoException & { status?: number | null };
    err.code = code;
    err.status = null;
    throw err;
  });
}
function flockUnavailable(): void {
  // flock(1) missing ⇒ spawn ENOENT.
  execFileSyncMock.mockImplementation(() => {
    const err = new Error('spawn flock ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  });
}
function flockCannotOpenLockPath(): void {
  // flock launches fine but cannot open lockPath itself (EROFS, or the path replaced by something it cannot
  // read) — measured against a real util-linux flock(1): this exits 66 (EX_NOINPUT), not the plain nonzero
  // exit a busy lock produces, and `execFileSync` reports it the same way as a busy lock (`status`, no `code`).
  execFileSyncMock.mockImplementation(() => {
    const err = new Error('flock: cannot open lock file') as NodeJS.ErrnoException & { status?: number };
    err.status = 66;
    throw err;
  });
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'coral-work-lock-'));
  process.env.CORAL_WORK_ROOT_OVERRIDE = sandbox;
  projectDir = join(sandbox, 'project-root');
  mkdirSync(projectDir, { recursive: true });
  execFileSyncMock.mockReset();
});

afterEach(() => {
  delete process.env.CORAL_WORK_ROOT_OVERRIDE;
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

function bgDir(): string {
  return join(sandbox, 'coral-work', projectPathKey(projectDir), SESSION, 'bg');
}

function writeBgMarker(name: string, ageMs = 0): void {
  const dir = bgDir();
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, '');
  if (ageMs > 0) {
    const seconds = (Date.now() - ageMs) / 1000;
    utimesSync(file, seconds, seconds);
  }
}

function remainingLockIds(): string[] {
  return readdirSync(bgDir())
    .filter((name) => name.endsWith('.lock'))
    .map((name) => name.slice(0, -'.lock'.length));
}

/** Leave one task in the registry, so a second sweep in the same test asks about that task alone. */
function pruneOtherTasks(keepId: string): void {
  for (const name of readdirSync(bgDir())) {
    if (!name.startsWith(`${keepId}.`)) rmSync(join(bgDir(), name), { force: true });
  }
}

describe('live-work-registry: bg lock liveness (flock mocked)', () => {
  it('reports a task whose lock is still held as live, overriding a stale mtime', () => {
    flockHeld();
    writeBgMarker('taskA.started', BG_STALE_MS); // stale — the lock signal must win
    writeBgMarker('taskA.lock', BG_STALE_MS);

    expect(hasLiveWork(projectDir, SESSION, undefined)).toBe(true);
    expect(execFileSyncMock).toHaveBeenCalled();
  });

  it('reports a task whose lock is free as not live, overriding a fresh mtime', () => {
    flockFree();
    writeBgMarker('taskA.started'); // fresh — the lock signal must win
    writeBgMarker('taskA.lock');

    expect(hasLiveWork(projectDir, SESSION, undefined)).toBe(false);
  });

  it('falls back to the mtime window (fresh ⇒ live) when flock(1) is unavailable', () => {
    flockUnavailable();
    writeBgMarker('taskA.started'); // fresh
    writeBgMarker('taskA.lock');

    expect(hasLiveWork(projectDir, SESSION, undefined)).toBe(true);
  });

  it('falls back to the mtime window (stale ⇒ dead) when flock(1) is unavailable', () => {
    flockUnavailable();
    writeBgMarker('taskA.started', BG_STALE_MS);
    writeBgMarker('taskA.lock', BG_STALE_MS);

    expect(hasLiveWork(projectDir, SESSION, undefined)).toBe(false);
  });

  // The mtime window is not independent of these failures. The heartbeat that refreshes the mtime is
  // `touch`/`sleep` in a subshell, so a machine that cannot fork this probe cannot fork the heartbeat either —
  // deferring to the window then reads a timestamp that stopped for the same reason and concludes the task is
  // dead. Un-gating live work, and later unlinking a live task's lock, are both finalizations, so a probe that
  // could not answer authorizes neither.
  it.each([['ETIMEDOUT'], ['EAGAIN'], ['EMFILE']])(
    'keeps a task gated when the lock probe fails with %s, even against a stale mtime',
    (code) => {
      flockUnanswered(code);
      writeBgMarker('task-unanswered.lock', BG_STALE_MS);

      expect(
        hasLiveWork(projectDir, SESSION),
        'the stale mtime is not evidence: the heartbeat needs the same forks this probe just failed to get',
      ).toBe(true);
    },
  );

  it('lets flock decide again on the next call rather than holding forever', () => {
    // The bound is what ends this hold — not a window. One unanswered probe latches nothing.
    flockUnanswered('EAGAIN');
    writeBgMarker('task-recovers.lock', BG_STALE_MS);
    expect(hasLiveWork(projectDir, SESSION)).toBe(true);

    flockFree();

    expect(hasLiveWork(projectDir, SESSION), 'a recovered machine answers, and the answer decides').toBe(false);
  });

  // The other half of the same question, and it took the opposite answer. `EACCES` on `flock` — present but
  // not executable here — is a standing fact about the machine, not about this moment: it does not clear while
  // the session runs, so `true` is not a hold the next hook re-asks its way out of. It is permanent, and it
  // gates ralph and kb for the rest of the session with no event that can end it. Nothing about these errnos
  // stops the heartbeat's `touch` and `sleep`, so the mtime window is independent of them and is the designed
  // fallback, exactly as for a missing binary.
  it.each([['EACCES'], ['EPERM'], ['ENOTDIR']])(
    'falls back to the mtime window when flock is unusable here (%s), rather than gating forever',
    (code) => {
      flockUnanswered(code);
      writeBgMarker('task-standing.started');
      writeBgMarker('task-standing.lock');

      expect(hasLiveWork(projectDir, SESSION), 'a fresh heartbeat still reads as live').toBe(true);

      flockUnanswered(code);
      writeBgMarker('task-standing-stale.started', BG_STALE_MS);
      writeBgMarker('task-standing-stale.lock', BG_STALE_MS);
      pruneOtherTasks('task-standing-stale');

      expect(hasLiveWork(projectDir, SESSION), 'and a stopped one reads as dead, which `true` could never do').toBe(
        false,
      );
    },
  );

  // The failure this pins is distinct from the standing-errno case above: both reach `lockHeld`'s catch with a
  // numeric `status` and no `code`, so a fix that only checked `err?.code` would leave this one routed to the
  // busy branch — permanently "held", since the condition producing it does not clear while the session runs.
  it.each([
    ['fresh heartbeat', 0, true],
    ['stale heartbeat', BG_STALE_MS, false],
  ] as const)(
    'falls back to the mtime window (%s) when flock cannot open lockPath (exit 66), rather than treating it as busy',
    (_label, ageMs, expectedLive) => {
      flockCannotOpenLockPath();
      writeBgMarker('task-open-failure.started', ageMs);
      writeBgMarker('task-open-failure.lock', ageMs);

      expect(hasLiveWork(projectDir, SESSION)).toBe(expectedLive);
    },
  );

  // The budget had no test at all: every assertion above drives a single task, and one task never reaches the
  // deadline. A sweep that runs out of time has looked at nothing, so it prunes nothing and reports live —
  // the same rule as an unanswered probe, applied to tasks that were never asked.
  it('stops probing when the sweep budget is spent, and treats what it never looked at as live', () => {
    for (const id of ['task-1', 'task-2', 'task-3']) {
      writeBgMarker(`${id}.started`, BG_STALE_MS);
      writeBgMarker(`${id}.lock`, BG_STALE_MS);
    }
    expect(remainingLockIds()).toHaveLength(3);

    // Baseline: every probe is cheap, so all three are asked and all three answer "free" ⇒ nothing is live.
    flockFree();
    expect(hasLiveWork(projectDir, SESSION)).toBe(false);
    expect(execFileSyncMock, 'the sweep visits every locked task when it can afford to').toHaveBeenCalledTimes(3);

    // Same registry, one wedged probe. It spends the whole 2s budget on its own, and the deadline is checked
    // before each remaining task rather than only per probe.
    execFileSyncMock.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date());
    execFileSyncMock.mockImplementation(() => {
      vi.advanceTimersByTime(2_500);
      return Buffer.from('');
    });

    const live = hasLiveWork(projectDir, SESSION);

    expect(execFileSyncMock, 'the budget bounds the sweep, not just each probe').toHaveBeenCalledTimes(1);
    expect(live, 'the two tasks nobody looked at were not observed to be gone').toBe(true);

    vi.useRealTimers();
  });

  // A single wedged probe (above) overshoots the budget in one jump, which a deadline checked only before
  // starting a probe would still catch by accident. This drives the case that actually distinguishes the two:
  // several probes each individually under LOCK_PROBE_TIMEOUT_MS (1s), whose cumulative cost still crosses
  // LOCK_PROBE_SWEEP_BUDGET_MS (2s) — the deadline must reserve a probe's worth of headroom, or a probe that
  // starts just under it is allowed to run and carries the sweep past the budget anyway.
  it('accumulates past the sweep budget across several probes that are each individually under the timeout', () => {
    for (const id of ['task-1', 'task-2', 'task-3', 'task-4']) {
      writeBgMarker(`${id}.started`, BG_STALE_MS);
      writeBgMarker(`${id}.lock`, BG_STALE_MS);
    }
    expect(remainingLockIds()).toHaveLength(4);

    vi.useFakeTimers();
    vi.setSystemTime(new Date());
    // 700ms per probe: comfortably under the 1s per-probe timeout on its own, but two of them (1400ms) already
    // exceed the 1000ms of headroom the fix reserves before the 2000ms budget line.
    execFileSyncMock.mockImplementation(() => {
      vi.advanceTimersByTime(700);
      return Buffer.from('');
    });

    const live = hasLiveWork(projectDir, SESSION);

    expect(
      execFileSyncMock,
      'a third probe would start at 1400ms — inside the raw 2000ms budget, but past the reserved deadline',
    ).toHaveBeenCalledTimes(2);
    expect(live, 'the tasks never probed are treated as live, not pruned').toBe(true);

    vi.useRealTimers();
  });

  it('bounds the lock probe, because a hook has no event loop to interrupt a synchronous child with', () => {
    flockFree();
    writeBgMarker('task-bounded.lock');

    hasLiveWork(projectDir, SESSION);

    expect(execFileSyncMock).toHaveBeenCalled();
    const options = execFileSyncMock.mock.calls[0]?.[2] as { timeout?: number } | undefined;
    expect(options?.timeout, 'zero and undefined are both "no bound" to execFileSync').toBeGreaterThan(0);
  });
});

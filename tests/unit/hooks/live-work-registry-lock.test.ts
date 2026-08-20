import type * as NodeFs from 'node:fs';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The flock probe in live-work-registry shells out to `flock -n <lock> -c true`
// via execFileSync. Mock it to drive each lock-liveness branch deterministically,
// with no real subprocess or timing coordination — so the "lock held ⇒ alive" and
// "flock(1) absent ⇒ mtime fallback" paths are covered identically on every OS.
const { execFileSyncMock } = vi.hoisted(() => ({ execFileSyncMock: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: execFileSyncMock }));

// Drives the "lock already gone by probe time" path without needing real concurrent timing: when set, a
// `readdirSync` of the `bg/` dir reports one extra `.lock` name that was never actually written, the same shape
// a concurrent prune leaves in the window between another process's own listing and this call's probe. Every
// other path (including every other `readdirSync` call this file makes, real writes included) passes through
// untouched.
const ghostLock = vi.hoisted(() => ({ name: null as string | null }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return {
    ...actual,
    readdirSync: (path: unknown, options?: unknown) => {
      const names = (actual.readdirSync as (p: unknown, o: unknown) => string[])(path, options);
      if (ghostLock.name && basename(String(path)) === 'bg') return [...names, ghostLock.name];
      return names;
    },
  };
});

// @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
import { hasLiveWork } from '../../../clients/hooks/lib/live-work-registry.mjs';
// @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
import { projectPathKey } from '../../../clients/hooks/lib/plugin-paths.mjs';

const SESSION = 'sess-lock-0001';
const BG_STALE_MS = 60_000; // > BG_MTIME_WINDOW_MS (30s)

let sandbox: string;
let projectDir: string;

function flockHeld(): void {
  // Busy ⇒ flock exits non-zero ⇒ execFileSync throws with a status, no `code`.
  execFileSyncMock.mockImplementation(() => {
    const err = new Error('flock: failed to acquire lock') as NodeJS.ErrnoException & { status?: number };
    err.status = 1;
    throw err;
  });
}
function flockFree(): void {
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
  // flock launches fine but cannot open lockPath itself — measured against a real util-linux flock(1) 2.39.3:
  // an existing lockPath whose permission bits were changed after this task's own readdir listing found it
  // (`EACCES`), or one whose containing directory vanished in that same window (`ENOENT` on the directory,
  // never on the file itself — `flock`'s own `O_CREAT` rules that out), both exit 66 (EX_NOINPUT), not the
  // plain nonzero exit a busy lock produces, and `execFileSync` reports it the same way as a busy lock
  // (`status`, no `code`).
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
  ghostLock.name = null;
});

afterEach(() => {
  delete process.env.CORAL_WORK_ROOT_OVERRIDE;
  ghostLock.name = null;
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

    const result = hasLiveWork(projectDir, SESSION, undefined);

    expect(result.live).toBe(true);
    expect(
      result.notice,
      'a lock genuinely found held is a decisive answer, not a hold worth telling about',
    ).toBeNull();
    expect(execFileSyncMock).toHaveBeenCalled();
  });

  it('reports a task whose lock is free as not live, overriding a fresh mtime', () => {
    flockFree();
    writeBgMarker('taskA.started'); // fresh — the lock signal must win
    writeBgMarker('taskA.lock');

    const result = hasLiveWork(projectDir, SESSION, undefined);

    expect(result.live).toBe(false);
    expect(result.notice, 'a lock genuinely found free is a decisive answer too').toBeNull();
  });

  it('falls back to the mtime window (fresh ⇒ live) when flock(1) is unavailable', () => {
    flockUnavailable();
    writeBgMarker('taskA.started');
    writeBgMarker('taskA.lock');

    const result = hasLiveWork(projectDir, SESSION, undefined);

    expect(result.live).toBe(true);
    expect(
      result.notice,
      'flock(1) being unusable here is exactly the case the direct check could not answer',
    ).not.toBeNull();
  });

  it('falls back to the mtime window (stale ⇒ dead) when flock(1) is unavailable', () => {
    flockUnavailable();
    writeBgMarker('taskA.started', BG_STALE_MS);
    writeBgMarker('taskA.lock', BG_STALE_MS);

    const result = hasLiveWork(projectDir, SESSION, undefined);

    expect(result.live).toBe(false);
    expect(
      result.notice,
      'the fallback concluding "dead" does not erase that the direct probe never got to answer',
    ).not.toBeNull();
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

      const result = hasLiveWork(projectDir, SESSION);

      expect(
        result.live,
        'the stale mtime is not evidence: the heartbeat needs the same forks this probe just failed to get',
      ).toBe(true);
      expect(result.notice, 'a probe that could not ask at all is not a decisive answer').not.toBeNull();
    },
  );

  it('lets flock decide again on the next call rather than holding forever', () => {
    // The bound is what ends this hold — not a window. One unanswered probe latches nothing.
    flockUnanswered('EAGAIN');
    writeBgMarker('task-recovers.lock', BG_STALE_MS);
    const first = hasLiveWork(projectDir, SESSION);
    expect(first.live).toBe(true);
    expect(first.notice, 'the failed attempt is exactly what a notice exists for').not.toBeNull();

    flockFree();

    const second = hasLiveWork(projectDir, SESSION);
    expect(second.live, 'a recovered machine answers, and the answer decides').toBe(false);
    expect(second.notice, 'a decisive free answer needs no notice').toBeNull();
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

      const fresh = hasLiveWork(projectDir, SESSION);
      expect(fresh.live, 'a fresh heartbeat still reads as live').toBe(true);
      expect(
        fresh.notice,
        'flock being unusable here is a standing fact the direct check could not get past',
      ).not.toBeNull();

      flockUnanswered(code);
      writeBgMarker('task-standing-stale.started', BG_STALE_MS);
      writeBgMarker('task-standing-stale.lock', BG_STALE_MS);
      pruneOtherTasks('task-standing-stale');

      const stale = hasLiveWork(projectDir, SESSION);
      expect(stale.live, 'and a stopped one reads as dead, which `true` could never do').toBe(false);
      expect(
        stale.notice,
        'the fallback concluding "dead" is still not the direct check itself answering',
      ).not.toBeNull();
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

      const result = hasLiveWork(projectDir, SESSION);

      expect(result.live).toBe(expectedLive);
      expect(result.notice, 'exit 66 is flock answering about itself, not about the lock').not.toBeNull();
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

    flockFree();
    const baseline = hasLiveWork(projectDir, SESSION);
    expect(baseline.live).toBe(false);
    expect(baseline.notice, 'three decisive probes leave nothing unobserved').toBeNull();
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

    const result = hasLiveWork(projectDir, SESSION);

    expect(execFileSyncMock, 'the budget bounds the sweep, not just each probe').toHaveBeenCalledTimes(1);
    expect(result.live, 'the two tasks nobody looked at were not observed to be gone').toBe(true);
    expect(result.notice, 'tasks the budget left unchecked are exactly the case a notice exists for').not.toBeNull();

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

    const result = hasLiveWork(projectDir, SESSION);

    expect(
      execFileSyncMock,
      'a third probe would start at 1400ms — inside the raw 2000ms budget, but past the reserved deadline',
    ).toHaveBeenCalledTimes(2);
    expect(result.live, 'the tasks never probed are treated as live, not pruned').toBe(true);
    expect(result.notice, 'budget exhaustion is not a decisive answer either').not.toBeNull();

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

  // A `.lock` name can be listed by `readdirSync` and be gone by the time this call gets to probe it — another
  // task's prune running first in the same sweep, or a concurrent Stop hook's own sweep, does exactly this.
  // `ghostLock` reproduces the shape deterministically: `readdirSync` reports a `.lock` name with no file behind
  // it, the same thing a real race leaves. Measured against a real util-linux `flock(1)` 2.39.3, asking `flock`
  // about a missing path would create it and answer "free" about a lock this call had just manufactured; the
  // fix is to never ask.
  it('does not ask flock about a lock file already gone, and settles it from the mtime it already has', () => {
    mkdirSync(bgDir(), { recursive: true });
    ghostLock.name = 'task-ghost.lock';

    const result = hasLiveWork(projectDir, SESSION);

    expect(result.live, 'no marker ever backed the name, so its mtime is 0 — ancient by any window').toBe(false);
    expect(
      result.notice,
      'a lock already gone by the time it is asked about is settled by the mtime this call already took, not left unobserved',
    ).toBeNull();
    expect(
      execFileSyncMock,
      'flock must never be asked about a lock file this call already found missing',
    ).not.toHaveBeenCalled();
  });
});

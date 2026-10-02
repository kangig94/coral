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

  // The mtime window is not independent of these failures. The heartbeat that refreshes the mtime is
  // `touch`/`sleep` in a subshell, so a machine that cannot fork this probe cannot fork the heartbeat either —
  // deferring to the window then reads a timestamp that stopped for the same reason and concludes the task is
  // dead. Un-gating live work, and later unlinking a live task's lock, are both finalizations, so a probe that
  // could not answer authorizes neither.
  it.each([['ETIMEDOUT']])(
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

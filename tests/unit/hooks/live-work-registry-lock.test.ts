import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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

function writeBgMarker(name: string, ageMs = 0): void {
  const dir = join(sandbox, 'coral-work', projectPathKey(projectDir), SESSION, 'bg');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, '');
  if (ageMs > 0) {
    const seconds = (Date.now() - ageMs) / 1000;
    utimesSync(file, seconds, seconds);
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

  it('bounds the lock probe, because a hook has no event loop to interrupt a synchronous child with', () => {
    flockFree();
    writeBgMarker('task-bounded.lock');

    hasLiveWork(projectDir, SESSION);

    expect(execFileSyncMock).toHaveBeenCalled();
    const options = execFileSyncMock.mock.calls[0]?.[2] as { timeout?: number } | undefined;
    expect(options?.timeout, 'zero and undefined are both "no bound" to execFileSync').toBeGreaterThan(0);
  });
});

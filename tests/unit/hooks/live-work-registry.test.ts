import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import type * as NodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `readdirSync` fails for two different reasons the registry must not treat alike: `ENOENT` (the directory was
// never created — a decisive "nothing recorded here") and everything else (`EACCES`, `EIO`, ... — the read was
// refused, which says nothing about what the directory holds). Only the named path below is intercepted; every
// other call, including the test helpers' own `readdirSync`, passes straight through to the real filesystem.
const readdirFixture = vi.hoisted(() => ({ failPath: null as string | null, failCode: 'EACCES' }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return {
    ...actual,
    readdirSync: (path: unknown, options?: unknown) => {
      if (readdirFixture.failPath !== null && String(path) === readdirFixture.failPath) {
        throw Object.assign(new Error('simulated unreadable registry dir'), { code: readdirFixture.failCode });
      }
      return (actual.readdirSync as (p: unknown, o?: unknown) => string[])(path, options);
    },
  };
});

// @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
import * as liveWorkRegistry from '../../../clients/hooks/lib/live-work-registry.mjs';
// @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
import { projectPathKey, sandboxTmpDir } from '../../../clients/hooks/lib/plugin-paths.mjs';

const { beginBgTask, bgWrapperPreamble, hasLiveWork, recordSubagentStart, recordSubagentStop } = liveWorkRegistry;

const SESSION = 'sess-11111111';
const OTHER = 'sess-22222222';

// Windows mirrored from live-work-registry.mjs.
const BG_STALE_MS = 60_000; // > BG_MTIME_WINDOW_MS (30s)
const BG_PAST_TTL_MS = 2 * 60 * 60_000; // > BG_CLEANUP_TTL_MS (1h)

const HAS_FLOCK = ((): boolean => {
  try {
    execFileSync('flock', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

let realTmp: string;
let sandbox: string;
let projectDir: string;
let parentTranscript: string;

beforeEach(() => {
  realTmp = tmpdir();
  sandbox = mkdtempSync(join(realTmp, 'coral-work-'));
  // Redirect the sandbox-writable registry root to an isolated temp dir.
  process.env.CORAL_WORK_ROOT_OVERRIDE = sandbox;
  projectDir = join(sandbox, 'project-root');
  mkdirSync(projectDir, { recursive: true });
  // Parent transcript beside the subagents dir, mirroring Claude's layout.
  parentTranscript = join(sandbox, 'projects', 'slug', `${SESSION}.jsonl`);
  mkdirSync(dirname(parentTranscript), { recursive: true });
  writeFileSync(parentTranscript, '{}');
  readdirFixture.failPath = null;
  readdirFixture.failCode = 'EACCES';
});

afterEach(() => {
  delete process.env.CORAL_WORK_ROOT_OVERRIDE;
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

function sessionRootFor(sessionId: string): string {
  return join(sandboxTmpDir(), 'coral-work', projectPathKey(projectDir), sessionId);
}

function subagentsDirFor(sessionId: string): string {
  return join(sessionRootFor(sessionId), 'subagents');
}

function bgDirFor(sessionId: string): string {
  return join(sessionRootFor(sessionId), 'bg');
}

// Create the subagent transcript at the layout hasLiveWork derives from the
// parent path, optionally aged so it reads as inactive.
function writeSubagentTranscript(sessionParentTranscript: string, agentId: string, ageMs = 0): void {
  const subagentsDir = join(
    dirname(sessionParentTranscript),
    basename(sessionParentTranscript).replace(/\.jsonl$/, ''),
    'subagents',
  );
  mkdirSync(subagentsDir, { recursive: true });
  const file = join(subagentsDir, `agent-${agentId}.jsonl`);
  writeFileSync(file, '{}');
  if (ageMs > 0) {
    const seconds = (Date.now() - ageMs) / 1000;
    utimesSync(file, seconds, seconds);
  }
}

function markerCount(sessionId: string): number {
  try {
    return readdirSync(subagentsDirFor(sessionId)).length;
  } catch {
    return 0;
  }
}

// Write a background-task marker (e.g. `taskA.started`), optionally aged.
function writeBgMarker(sessionId: string, name: string, ageMs = 0): void {
  const dir = bgDirFor(sessionId);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, '');
  if (ageMs > 0) {
    const seconds = (Date.now() - ageMs) / 1000;
    utimesSync(file, seconds, seconds);
  }
}

function bgMarkerCount(sessionId: string): number {
  try {
    return readdirSync(bgDirFor(sessionId)).length;
  } catch {
    return 0;
  }
}

// Run a wrapper preamble around a command in a real shell. A non-zero command
// exit propagates through the wrapper (by design), so the throw is expected. The
// EXIT trap kills the heartbeat subshell; a `sleep 10` child mid-iteration is
// bounded (self-exits within one interval) and never keeps the call open.
function runWrapped(wrapper: string, command: string): void {
  try {
    execFileSync('sh', ['-c', `${wrapper}\n${command}`], { stdio: 'ignore' });
  } catch {
    // non-zero exit is expected — the wrapper preserves the command's exit code
  }
}

describe('live-work-registry: subagents', () => {
  it('reports a started subagent with a fresh transcript as live', () => {
    recordSubagentStart(projectDir, SESSION, 'agentA');
    writeSubagentTranscript(parentTranscript, 'agentA');

    expect(hasLiveWork(projectDir, SESSION, parentTranscript).live).toBe(true);
  });

  it('reports no live subagent after SubagentStop removes the marker', () => {
    recordSubagentStart(projectDir, SESSION, 'agentA');
    writeSubagentTranscript(parentTranscript, 'agentA');
    recordSubagentStop(projectDir, SESSION, 'agentA');

    expect(hasLiveWork(projectDir, SESSION, parentTranscript).live).toBe(false);
    expect(markerCount(SESSION)).toBe(0);
  });

  it('prunes a stale marker whose transcript has not moved within the window', () => {
    recordSubagentStart(projectDir, SESSION, 'agentA');
    writeSubagentTranscript(parentTranscript, 'agentA', 2 * 60 * 60_000); // 2h idle

    expect(hasLiveWork(projectDir, SESSION, parentTranscript).live).toBe(false);
    expect(markerCount(SESSION)).toBe(0); // dead marker pruned
  });

  it('falls back to the marker mtime when the transcript cannot be resolved', () => {
    recordSubagentStart(projectDir, SESSION, 'agentA'); // no transcript written
    expect(hasLiveWork(projectDir, SESSION, parentTranscript).live).toBe(true);
  });

  it('keeps one live subagent counted while pruning a dead sibling', () => {
    recordSubagentStart(projectDir, SESSION, 'live1');
    recordSubagentStart(projectDir, SESSION, 'dead1');
    writeSubagentTranscript(parentTranscript, 'live1');
    writeSubagentTranscript(parentTranscript, 'dead1', 2 * 60 * 60_000);

    expect(hasLiveWork(projectDir, SESSION, parentTranscript).live).toBe(true);
    expect(markerCount(SESSION)).toBe(1); // only the live one remains
  });

  it('does not bleed markers between sessions whose ids share a hyphen prefix', () => {
    // SESSION ('sess-11111111') is a hyphen-prefix of `${SESSION}-fork`.
    const forkSession = `${SESSION}-fork`;
    const forkTranscript = join(sandbox, 'projects', 'slug', `${forkSession}.jsonl`);
    recordSubagentStart(projectDir, forkSession, 'agentA');
    writeSubagentTranscript(forkTranscript, 'agentA');

    expect(markerCount(SESSION)).toBe(0);
    expect(hasLiveWork(projectDir, SESSION, parentTranscript).live).toBe(false);
    expect(hasLiveWork(projectDir, forkSession, forkTranscript).live).toBe(true);
  });

  it("isolates sessions: one session's subagents do not affect another", () => {
    recordSubagentStart(projectDir, SESSION, 'agentA');
    writeSubagentTranscript(parentTranscript, 'agentA');

    const otherTranscript = join(sandbox, 'projects', 'slug', `${OTHER}.jsonl`);
    expect(hasLiveWork(projectDir, OTHER, otherTranscript).live).toBe(false);
    expect(hasLiveWork(projectDir, SESSION, parentTranscript).live).toBe(true);
  });

  it('ignores invalid session or agent identifiers', () => {
    recordSubagentStart(projectDir, 'bad id with spaces', 'agentA');
    recordSubagentStart(projectDir, SESSION, 'bad/agent');

    expect(markerCount(SESSION)).toBe(0);
    expect(hasLiveWork(projectDir, SESSION, parentTranscript).live).toBe(false);
  });
});

describe('live-work-registry: background tasks', () => {
  it('reports a bg task with a fresh heartbeat and no terminal record as live', () => {
    writeBgMarker(SESSION, 'taskA.launched');
    writeBgMarker(SESSION, 'taskA.started');

    expect(hasLiveWork(projectDir, SESSION, parentTranscript).live).toBe(true);
  });

  it('treats a bg task with an .exited record as not live', () => {
    writeBgMarker(SESSION, 'taskA.started');
    writeBgMarker(SESSION, 'taskA.exited.0');

    expect(hasLiveWork(projectDir, SESSION, parentTranscript).live).toBe(false);
  });

  it('treats a bg task with a stale heartbeat and no lock as not live', () => {
    writeBgMarker(SESSION, 'taskA.started', BG_STALE_MS);

    expect(hasLiveWork(projectDir, SESSION, parentTranscript).live).toBe(false);
  });

  it('prunes a dead bg task once past the cleanup TTL', () => {
    writeBgMarker(SESSION, 'taskA.launched', BG_PAST_TTL_MS);
    writeBgMarker(SESSION, 'taskA.started', BG_PAST_TTL_MS);

    expect(hasLiveWork(projectDir, SESSION, parentTranscript).live).toBe(false);
    expect(bgMarkerCount(SESSION)).toBe(0); // swept
  });

  it('keeps a recent terminal record around for exit-code reads', () => {
    writeBgMarker(SESSION, 'taskA.exited.0'); // fresh
    expect(hasLiveWork(projectDir, SESSION, parentTranscript).live).toBe(false);
    expect(bgMarkerCount(SESSION)).toBe(1); // not swept yet
  });

  it('recognizes a negative exit code as a terminal record', () => {
    writeBgMarker(SESSION, 'taskA.started');
    writeBgMarker(SESSION, 'taskA.exited.-1');

    expect(hasLiveWork(projectDir, SESSION, parentTranscript).live).toBe(false);
  });

  it('keeps a live bg task while pruning a dead sibling past the TTL', () => {
    writeBgMarker(SESSION, 'liveTask.started'); // fresh ⇒ live
    writeBgMarker(SESSION, 'deadTask.launched', BG_PAST_TTL_MS);
    writeBgMarker(SESSION, 'deadTask.started', BG_PAST_TTL_MS);

    expect(hasLiveWork(projectDir, SESSION, parentTranscript).live).toBe(true);
    expect(bgMarkerCount(SESSION)).toBe(1); // only the live task's marker remains
  });

  it.skipIf(!HAS_FLOCK)('treats a free lock as not live even with a fresh heartbeat', () => {
    // A .lock file that no process holds: flock -n acquires it ⇒ dead, overriding
    // the fresh mtime that the flock-absent fallback would read as live.
    writeBgMarker(SESSION, 'taskA.started');
    writeBgMarker(SESSION, 'taskA.lock');

    expect(hasLiveWork(projectDir, SESSION, parentTranscript).live).toBe(false);
  });

  it('reports live when a subagent is idle-dead but a bg task is fresh', () => {
    recordSubagentStart(projectDir, SESSION, 'agentA');
    writeSubagentTranscript(parentTranscript, 'agentA', 2 * 60 * 60_000); // dead
    writeBgMarker(SESSION, 'taskA.started'); // fresh ⇒ live

    expect(hasLiveWork(projectDir, SESSION, parentTranscript).live).toBe(true);
    expect(markerCount(SESSION)).toBe(0); // dead subagent still pruned
  });
});

describe('live-work-registry: an unreadable registry directory is unobserved, not empty', () => {
  it('still reports no live work when a registry directory was simply never created (ENOENT stays decisive)', () => {
    // Neither writeBgMarker nor recordSubagentStart has run, so neither directory exists yet.
    const result = hasLiveWork(projectDir, SESSION, parentTranscript);
    expect(result.live).toBe(false);
    expect(result.notice, 'a decisive absence carries nothing to say').toBeNull();
  });

  it('treats an unreadable subagents directory as live, not as "no subagents", and names it in the notice', () => {
    recordSubagentStart(projectDir, SESSION, 'agentA');
    readdirFixture.failPath = subagentsDirFor(SESSION);

    const result = hasLiveWork(projectDir, SESSION, parentTranscript);
    expect(
      result.live,
      'a readdirSync failure that is not ENOENT is unobserved state; it must not un-gate ralph/kb on nothing',
    ).toBe(true);
    expect(result.notice).toMatch(/subagents/u);
  });

  it('treats an unreadable bg directory as live, not as "no bg tasks", and names it in the notice', () => {
    writeBgMarker(SESSION, 'taskA.started');
    readdirFixture.failPath = bgDirFor(SESSION);

    const result = hasLiveWork(projectDir, SESSION, parentTranscript);
    expect(
      result.live,
      'a readdirSync failure that is not ENOENT is unobserved state; it must not un-gate ralph/kb on nothing',
    ).toBe(true);
    expect(result.notice).toMatch(/\bbg\b/u);
  });

  // Every non-ENOENT errno reaching this point is already abnormal, so none of them stay quiet — unlike the
  // flock probe's own errno set, a missed member here is a silent permanent gate, not a cheap wasted fork, so
  // there is no errno worth filtering the notice on. `EIO` is deliberately included alongside the standing set:
  // the previous design held it exempt as "transient", and that was exactly the gap this replaces.
  it.each([['EACCES'], ['EPERM'], ['ENOTDIR'], ['EIO'], ['ELOOP']])(
    'names the errno in the notice so the hold is visible, not just held (%s)',
    (code) => {
      writeBgMarker(SESSION, 'taskA.started');
      readdirFixture.failPath = bgDirFor(SESSION);
      readdirFixture.failCode = code;

      const result = hasLiveWork(projectDir, SESSION, parentTranscript);
      expect(result.live).toBe(true);
      expect(result.notice, 'a hold with nothing that says why it is held is what this replaces').toMatch(
        new RegExp(code, 'u'),
      );
    },
  );

  it('reports once, naming both subagents/ and bg/, when the shared session root itself is unreadable', () => {
    // A permissions change on the root fails a read of either child dir identically — the failure is reported
    // against the root, before either child is touched, rather than as two near-identical lines for one cause.
    writeBgMarker(SESSION, 'taskA.started'); // creates the session root as a side effect
    readdirFixture.failPath = sessionRootFor(SESSION);

    const result = hasLiveWork(projectDir, SESSION, parentTranscript);
    expect(result.live).toBe(true);
    expect(result.notice).toMatch(/subagents/u);
    expect(result.notice).toMatch(/\bbg\b/u);
  });
});

describe('live-work-registry: bg task wrapper (beginBgTask)', () => {
  it('records a .launched marker and reports the fresh task as live', () => {
    const task = beginBgTask(projectDir, SESSION);
    expect(task).not.toBeNull();
    expect(bgMarkerCount(SESSION)).toBe(1); // <id>.launched
    expect(hasLiveWork(projectDir, SESSION, parentTranscript).live).toBe(true);
  });

  it('returns null and writes nothing for an invalid session id', () => {
    expect(beginBgTask(projectDir, 'bad id with spaces')).toBeNull();
    expect(bgMarkerCount(SESSION)).toBe(0);
  });

  it('the wrapper records .started and the exit code, and reads as terminal', () => {
    const task = beginBgTask(projectDir, SESSION);
    runWrapped(task.wrapper, 'exit 7');

    const bgDir = bgDirFor(SESSION);
    expect(existsSync(join(bgDir, `${task.id}.started`))).toBe(true);
    expect(existsSync(join(bgDir, `${task.id}.exited.7`))).toBe(true);
    expect(hasLiveWork(projectDir, SESSION, parentTranscript).live).toBe(false);
  });

  it('records exit code 0 for a clean command', () => {
    const task = beginBgTask(projectDir, SESSION);
    runWrapped(task.wrapper, 'true');

    expect(existsSync(join(bgDirFor(SESSION), `${task.id}.exited.0`))).toBe(true);
  });

  it('runs the user command even when the registry dir cannot be created (fail-open under dash)', () => {
    // Parent is a FILE, so the wrapper's `mkdir -p` and lock creation both fail.
    // The wrapper must still let the user command run and preserve its exit code —
    // guards the regression where a `:`-based redirect guard fatally aborted dash.
    const blocker = join(sandbox, 'blocker-file');
    writeFileSync(blocker, '');
    const wrapper = bgWrapperPreamble(join(blocker, 'bg'), 'deadbeefdeadbeef');
    const sentinel = join(sandbox, 'ran.marker');

    let status = 0;
    try {
      execFileSync('sh', ['-c', `${wrapper}\ntouch '${sentinel}'; exit 4`], { stdio: 'ignore' });
    } catch (err) {
      status = (err as { status?: number }).status ?? -1;
    }

    expect(existsSync(sentinel)).toBe(true); // user command ran despite the registry failure
    expect(status).toBe(4); // and kept its own exit code
  });
});

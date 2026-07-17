import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
import { hasLiveWork, recordSubagentStart, recordSubagentStop } from '../../../clients/hooks/lib/live-work-registry.mjs';
// @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
import { projectSlug, sandboxTmpDir } from '../../../clients/hooks/lib/plugin-paths.mjs';

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
});

afterEach(() => {
  delete process.env.CORAL_WORK_ROOT_OVERRIDE;
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

function subagentsDirFor(sessionId: string): string {
  return join(sandboxTmpDir(), 'coral-work', projectSlug(projectDir), sessionId, 'subagents');
}

function bgDirFor(sessionId: string): string {
  return join(sandboxTmpDir(), 'coral-work', projectSlug(projectDir), sessionId, 'bg');
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

describe('live-work-registry: subagents', () => {
  it('reports a started subagent with a fresh transcript as live', () => {
    recordSubagentStart(projectDir, SESSION, 'agentA');
    writeSubagentTranscript(parentTranscript, 'agentA');

    expect(hasLiveWork(projectDir, SESSION, parentTranscript)).toBe(true);
  });

  it('reports no live subagent after SubagentStop removes the marker', () => {
    recordSubagentStart(projectDir, SESSION, 'agentA');
    writeSubagentTranscript(parentTranscript, 'agentA');
    recordSubagentStop(projectDir, SESSION, 'agentA');

    expect(hasLiveWork(projectDir, SESSION, parentTranscript)).toBe(false);
    expect(markerCount(SESSION)).toBe(0);
  });

  it('prunes a stale marker whose transcript has not moved within the window', () => {
    recordSubagentStart(projectDir, SESSION, 'agentA');
    writeSubagentTranscript(parentTranscript, 'agentA', 2 * 60 * 60_000); // 2h idle

    expect(hasLiveWork(projectDir, SESSION, parentTranscript)).toBe(false);
    expect(markerCount(SESSION)).toBe(0); // dead marker pruned
  });

  it('falls back to the marker mtime when the transcript cannot be resolved', () => {
    recordSubagentStart(projectDir, SESSION, 'agentA'); // no transcript written
    expect(hasLiveWork(projectDir, SESSION, parentTranscript)).toBe(true);
  });

  it('keeps one live subagent counted while pruning a dead sibling', () => {
    recordSubagentStart(projectDir, SESSION, 'live1');
    recordSubagentStart(projectDir, SESSION, 'dead1');
    writeSubagentTranscript(parentTranscript, 'live1');
    writeSubagentTranscript(parentTranscript, 'dead1', 2 * 60 * 60_000);

    expect(hasLiveWork(projectDir, SESSION, parentTranscript)).toBe(true);
    expect(markerCount(SESSION)).toBe(1); // only the live one remains
  });

  it('does not bleed markers between sessions whose ids share a hyphen prefix', () => {
    // SESSION ('sess-11111111') is a hyphen-prefix of `${SESSION}-fork`.
    const forkSession = `${SESSION}-fork`;
    const forkTranscript = join(sandbox, 'projects', 'slug', `${forkSession}.jsonl`);
    recordSubagentStart(projectDir, forkSession, 'agentA');
    writeSubagentTranscript(forkTranscript, 'agentA');

    expect(markerCount(SESSION)).toBe(0);
    expect(hasLiveWork(projectDir, SESSION, parentTranscript)).toBe(false);
    expect(hasLiveWork(projectDir, forkSession, forkTranscript)).toBe(true);
  });

  it('isolates sessions: one session\'s subagents do not affect another', () => {
    recordSubagentStart(projectDir, SESSION, 'agentA');
    writeSubagentTranscript(parentTranscript, 'agentA');

    const otherTranscript = join(sandbox, 'projects', 'slug', `${OTHER}.jsonl`);
    expect(hasLiveWork(projectDir, OTHER, otherTranscript)).toBe(false);
    expect(hasLiveWork(projectDir, SESSION, parentTranscript)).toBe(true);
  });

  it('ignores invalid session or agent identifiers', () => {
    recordSubagentStart(projectDir, 'bad id with spaces', 'agentA');
    recordSubagentStart(projectDir, SESSION, 'bad/agent');

    expect(markerCount(SESSION)).toBe(0);
    expect(hasLiveWork(projectDir, SESSION, parentTranscript)).toBe(false);
  });
});

describe('live-work-registry: background tasks', () => {
  it('reports a bg task with a fresh heartbeat and no terminal record as live', () => {
    writeBgMarker(SESSION, 'taskA.launched');
    writeBgMarker(SESSION, 'taskA.started');

    expect(hasLiveWork(projectDir, SESSION, parentTranscript)).toBe(true);
  });

  it('treats a bg task with an .exited record as not live', () => {
    writeBgMarker(SESSION, 'taskA.started');
    writeBgMarker(SESSION, 'taskA.exited.0');

    expect(hasLiveWork(projectDir, SESSION, parentTranscript)).toBe(false);
  });

  it('treats a bg task with a stale heartbeat and no lock as not live', () => {
    writeBgMarker(SESSION, 'taskA.started', BG_STALE_MS);

    expect(hasLiveWork(projectDir, SESSION, parentTranscript)).toBe(false);
  });

  it('prunes a dead bg task once past the cleanup TTL', () => {
    writeBgMarker(SESSION, 'taskA.launched', BG_PAST_TTL_MS);
    writeBgMarker(SESSION, 'taskA.started', BG_PAST_TTL_MS);

    expect(hasLiveWork(projectDir, SESSION, parentTranscript)).toBe(false);
    expect(bgMarkerCount(SESSION)).toBe(0); // swept
  });

  it('keeps a recent terminal record around for exit-code reads', () => {
    writeBgMarker(SESSION, 'taskA.exited.0'); // fresh
    expect(hasLiveWork(projectDir, SESSION, parentTranscript)).toBe(false);
    expect(bgMarkerCount(SESSION)).toBe(1); // not swept yet
  });

  it('recognizes a negative exit code as a terminal record', () => {
    writeBgMarker(SESSION, 'taskA.started');
    writeBgMarker(SESSION, 'taskA.exited.-1');

    expect(hasLiveWork(projectDir, SESSION, parentTranscript)).toBe(false);
  });

  it('keeps a live bg task while pruning a dead sibling past the TTL', () => {
    writeBgMarker(SESSION, 'liveTask.started'); // fresh ⇒ live
    writeBgMarker(SESSION, 'deadTask.launched', BG_PAST_TTL_MS);
    writeBgMarker(SESSION, 'deadTask.started', BG_PAST_TTL_MS);

    expect(hasLiveWork(projectDir, SESSION, parentTranscript)).toBe(true);
    expect(bgMarkerCount(SESSION)).toBe(1); // only the live task's marker remains
  });

  it.skipIf(!HAS_FLOCK)('treats a free lock as not live even with a fresh heartbeat', () => {
    // A .lock file that no process holds: flock -n acquires it ⇒ dead, overriding
    // the fresh mtime that the flock-absent fallback would read as live.
    writeBgMarker(SESSION, 'taskA.started');
    writeBgMarker(SESSION, 'taskA.lock');

    expect(hasLiveWork(projectDir, SESSION, parentTranscript)).toBe(false);
  });

  it('reports live when a subagent is idle-dead but a bg task is fresh', () => {
    recordSubagentStart(projectDir, SESSION, 'agentA');
    writeSubagentTranscript(parentTranscript, 'agentA', 2 * 60 * 60_000); // dead
    writeBgMarker(SESSION, 'taskA.started'); // fresh ⇒ live

    expect(hasLiveWork(projectDir, SESSION, parentTranscript)).toBe(true);
    expect(markerCount(SESSION)).toBe(0); // dead subagent still pruned
  });
});

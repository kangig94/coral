import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
import { hasLiveSubagent, recordStart, recordStop } from '../../../hooks/lib/subagent-registry.mjs';
// @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
import { projectTmpDir } from '../../../hooks/lib/plugin-paths.mjs';

const SESSION = 'sess-11111111';
const OTHER = 'sess-22222222';

let realTmp: string;
let sandbox: string;
let projectDir: string;
let parentTranscript: string;

beforeEach(() => {
  realTmp = tmpdir();
  sandbox = mkdtempSync(join(realTmp, 'coral-registry-'));
  process.env.TMPDIR = sandbox;
  projectDir = join(sandbox, 'project-root');
  mkdirSync(projectDir, { recursive: true });
  // Parent transcript beside the subagents dir, mirroring Claude's layout.
  parentTranscript = join(sandbox, 'projects', 'slug', `${SESSION}.jsonl`);
  mkdirSync(dirname(parentTranscript), { recursive: true });
  writeFileSync(parentTranscript, '{}');
});

afterEach(() => {
  process.env.TMPDIR = realTmp;
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

// Create the subagent transcript at the layout hasLiveSubagent derives from the
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
    return readdirSync(join(projectTmpDir(projectDir), 'live-subagents', sessionId)).length;
  } catch {
    return 0;
  }
}

describe('subagent-registry', () => {
  it('reports a started subagent with a fresh transcript as live', () => {
    recordStart(projectDir, SESSION, 'agentA');
    writeSubagentTranscript(parentTranscript, 'agentA');

    expect(hasLiveSubagent(projectDir, SESSION, parentTranscript)).toBe(true);
  });

  it('reports no live subagent after SubagentStop removes the marker', () => {
    recordStart(projectDir, SESSION, 'agentA');
    writeSubagentTranscript(parentTranscript, 'agentA');
    recordStop(projectDir, SESSION, 'agentA');

    expect(hasLiveSubagent(projectDir, SESSION, parentTranscript)).toBe(false);
    expect(markerCount(SESSION)).toBe(0);
  });

  it('prunes a stale marker whose transcript has not moved within the window', () => {
    recordStart(projectDir, SESSION, 'agentA');
    writeSubagentTranscript(parentTranscript, 'agentA', 2 * 60 * 60_000); // 2h idle

    expect(hasLiveSubagent(projectDir, SESSION, parentTranscript)).toBe(false);
    expect(markerCount(SESSION)).toBe(0); // dead marker pruned
  });

  it('falls back to the marker mtime when the transcript cannot be resolved', () => {
    recordStart(projectDir, SESSION, 'agentA'); // no transcript written
    expect(hasLiveSubagent(projectDir, SESSION, parentTranscript)).toBe(true);
  });

  it('keeps one live subagent counted while pruning a dead sibling', () => {
    recordStart(projectDir, SESSION, 'live1');
    recordStart(projectDir, SESSION, 'dead1');
    writeSubagentTranscript(parentTranscript, 'live1');
    writeSubagentTranscript(parentTranscript, 'dead1', 2 * 60 * 60_000);

    expect(hasLiveSubagent(projectDir, SESSION, parentTranscript)).toBe(true);
    expect(markerCount(SESSION)).toBe(1); // only the live one remains
  });

  it('does not bleed markers between sessions whose ids share a hyphen prefix', () => {
    // SESSION ('sess-11111111') is a hyphen-prefix of `${SESSION}-fork`.
    const forkSession = `${SESSION}-fork`;
    const forkTranscript = join(sandbox, 'projects', 'slug', `${forkSession}.jsonl`);
    recordStart(projectDir, forkSession, 'agentA');
    writeSubagentTranscript(forkTranscript, 'agentA');

    expect(markerCount(SESSION)).toBe(0);
    expect(hasLiveSubagent(projectDir, SESSION, parentTranscript)).toBe(false);
    expect(hasLiveSubagent(projectDir, forkSession, forkTranscript)).toBe(true);
  });

  it('isolates sessions: one session\'s subagents do not affect another', () => {
    recordStart(projectDir, SESSION, 'agentA');
    writeSubagentTranscript(parentTranscript, 'agentA');

    const otherTranscript = join(sandbox, 'projects', 'slug', `${OTHER}.jsonl`);
    expect(hasLiveSubagent(projectDir, OTHER, otherTranscript)).toBe(false);
    expect(hasLiveSubagent(projectDir, SESSION, parentTranscript)).toBe(true);
  });

  it('ignores invalid session or agent identifiers', () => {
    recordStart(projectDir, 'bad id with spaces', 'agentA');
    recordStart(projectDir, SESSION, 'bad/agent');

    expect(markerCount(SESSION)).toBe(0);
    expect(hasLiveSubagent(projectDir, SESSION, parentTranscript)).toBe(false);
  });
});

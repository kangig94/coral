import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  discussBaseDirForSource,
  discussDiscoveryPathForSource,
  discussSourcesPath,
  discussSummaryIndexPathForSource,
  resolveProjectSource,
} from '../../infra/paths.js';

// JOBS_DIR is the module-level constant tmpdir()/coral-jobs — not overridable without
// mocking the paths module. Tests write unique job IDs here and clean up in afterEach.
// Risk: if a test worker is killed before cleanup, a test-* directory remains in the
// production jobs path. This is acceptable because job IDs are unique and the directory
// contains only test fixtures, not real job state.
const jobsDir = join(tmpdir(), 'coral-jobs');
import {
  readDiscussDiscoveryForSource,
  readDiscussEventLog,
  readDiscussSnapshot,
  readDiscussSources,
  readDiscussState,
  readDiscussSummaryIndexForSource,
  readProgressLog,
  readStatusRecord,
} from '../readers.js';

let testJobId: string;
let testJobDir: string;
let fixtureDir: string;
let testSource: string;
let discussSourcesBackup: string | null;
let cleanupPaths: string[];

const NOW = '2026-01-01T00:00:00Z';

function trackCleanup(path: string): string {
  cleanupPaths.push(path);
  return path;
}

function writeJsonFixture(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value));
}

function writeTextFixture(filePath: string, value: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, value);
}

function fixturePath(name: string): string {
  return join(fixtureDir, name);
}

function makePersistedDiscussState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: 'session-1',
    topic: 'Discuss topic',
    status: 'bidding',
    step: 1,
    epoch: 0,
    max_epochs: 3,
    quota_per_epoch: 2,
    cold_start: false,
    agents: {
      alice: {
        persona: 'Analyst',
        display_name: 'Alice',
        participation: 'required',
        quota_remaining: 2,
        total_speaks: 0,
        fallback_used: false,
        banned: false,
      },
    },
    current_bids: { alice: null },
    current_thoughts: { alice: 'Ready to bid' },
    pending_bidders: ['alice'],
    current_speaker: null,
    speaker_type: null,
    epoch_summary_written: null,
    created_at: NOW,
    last_activity_at: NOW,
    last_speech_step: 0,
    pending_since_ts: null,
    bid_release_step: 0,
    end_reason_content: null,
    transcript: [],
    bid_threshold: 0.5,
    min_bid_delay_ms: 0,
    ...overrides,
  };
}

function makePersistedDiscussSnapshot(
  overrides: { state?: Record<string, unknown>; runtime?: Record<string, unknown> } & Record<string, unknown> = {},
): Record<string, unknown> {
  const { state, runtime, ...rest } = overrides;
  return {
    schemaVersion: 2,
    sessionId: 'session-1',
    projectRoot: '/tmp/project',
    updatedAt: NOW,
    lastAppliedSeq: 0,
    state: state ?? makePersistedDiscussState(),
    runtime: runtime ?? {
      controlPhase: 'idle',
      carryForwardMustAnswer: [],
      followUpQueue: [],
      agentRuns: {
        alice: {
          provider: 'openai',
          model: 'gpt-5',
        },
      },
    },
    ...rest,
  };
}

function makeDiscoverySession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: 'session-1',
    topic: 'Discuss topic',
    sessionDir: '/tmp/discuss/session-1',
    createdAt: NOW,
    ...overrides,
  };
}

function makeSummaryIndexRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: 'session-1',
    projectRoot: '/tmp/project',
    topic: 'Discuss topic',
    status: 'bidding',
    createdAt: NOW,
    agentCount: 1,
    updatedAt: NOW,
    lastSeq: 0,
    ...overrides,
  };
}

beforeEach(() => {
  testJobId = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  testJobDir = join(jobsDir, testJobId);
  mkdirSync(testJobDir, { recursive: true });
  fixtureDir = mkdtempSync(join(tmpdir(), 'coral-readers-'));
  testSource = `tests/${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  cleanupPaths = [fixtureDir, discussBaseDirForSource(testSource)];
  discussSourcesBackup = existsSync(discussSourcesPath()) ? readFileSync(discussSourcesPath(), 'utf-8') : null;
});

afterEach(() => {
  rmSync(testJobDir, { recursive: true, force: true });
  for (const cleanupPath of cleanupPaths) {
    rmSync(cleanupPath, { recursive: true, force: true });
  }

  if (discussSourcesBackup === null) {
    rmSync(discussSourcesPath(), { force: true });
  } else {
    mkdirSync(dirname(discussSourcesPath()), { recursive: true });
    writeFileSync(discussSourcesPath(), discussSourcesBackup);
  }
});

describe('readStatusRecord', () => {
  const validStatus = {
    jobId: 'j1',
    sessionId: 's1',
    provider: 'codex',
    projectRoot: '/tmp/project',
    backendNamespace: 'ns',
    phase: 'completed',
    launch: { state: 'ready', updatedAt: '2026-01-01T00:00:00Z' },
  };

  it('returns a valid status record with all required fields', () => {
    writeFileSync(join(testJobDir, 'status.json'), JSON.stringify(validStatus));
    const result = readStatusRecord(testJobId);
    expect(result).not.toBeNull();
    expect(result!.jobId).toBe('j1');
    expect(result!.sessionId).toBe('s1');
    expect(result!.provider).toBe('codex');
    expect(result!.projectRoot).toBe('/tmp/project');
    expect(result!.backendNamespace).toBe('ns');
    expect(result!.phase).toBe('completed');
    expect(result!.launch.state).toBe('ready');
    expect(result!.launch.updatedAt).toBe('2026-01-01T00:00:00Z');
  });

  it('returns null for missing file', () => {
    expect(readStatusRecord(testJobId)).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    writeFileSync(join(testJobDir, 'status.json'), 'not json');
    expect(readStatusRecord(testJobId)).toBeNull();
  });

  it('returns null for valid JSON with wrong shape (string)', () => {
    writeFileSync(join(testJobDir, 'status.json'), '"just a string"');
    expect(readStatusRecord(testJobId)).toBeNull();
  });

  it('returns null for valid JSON with missing required fields', () => {
    writeFileSync(join(testJobDir, 'status.json'), JSON.stringify({ jobId: 'j1' }));
    expect(readStatusRecord(testJobId)).toBeNull();
  });

  it('returns null for valid JSON with wrong nested shape (launch as string)', () => {
    writeFileSync(
      join(testJobDir, 'status.json'),
      JSON.stringify({ ...validStatus, launch: 'not an object' }),
    );
    expect(readStatusRecord(testJobId)).toBeNull();
  });

  it('accepts and preserves additional fields (forward compatibility)', () => {
    const extended = { ...validStatus, futureField: true };
    writeFileSync(join(testJobDir, 'status.json'), JSON.stringify(extended));
    const result = readStatusRecord(testJobId);
    expect(result).not.toBeNull();
    expect(result!.jobId).toBe('j1');
    expect(result!).toHaveProperty('futureField', true);
  });
});

describe('readProgressLog', () => {
  const validLine = {
    jobId: 'j1',
    sessionId: 's1',
    eventId: 1,
    type: 'progress',
    ts: '2026-01-01T00:00:00Z',
    message: 'working',
  };

  it('returns valid progress entries with all required fields', () => {
    writeFileSync(join(testJobDir, 'progress.jsonl'), JSON.stringify(validLine) + '\n');
    const result = readProgressLog(testJobId);
    expect(result).toHaveLength(1);
    expect(result[0].jobId).toBe('j1');
    expect(result[0].sessionId).toBe('s1');
    expect(result[0].eventId).toBe(1);
    expect(result[0].type).toBe('progress');
    expect(result[0].ts).toBe('2026-01-01T00:00:00Z');
    expect(result[0].message).toBe('working');
  });

  it('returns empty array for missing file', () => {
    expect(readProgressLog(testJobId)).toEqual([]);
  });

  it('skips lines with invalid JSON', () => {
    const content = [JSON.stringify(validLine), 'not json', JSON.stringify({ ...validLine, eventId: 2 })].join('\n');
    writeFileSync(join(testJobDir, 'progress.jsonl'), content);
    const result = readProgressLog(testJobId);
    expect(result).toHaveLength(2);
  });

  it('skips lines with wrong shape (missing required fields)', () => {
    const badLine = { jobId: 'j1' }; // missing sessionId, eventId, type, ts
    const content = [JSON.stringify(validLine), JSON.stringify(badLine)].join('\n');
    writeFileSync(join(testJobDir, 'progress.jsonl'), content);
    const result = readProgressLog(testJobId);
    expect(result).toHaveLength(1);
    expect(result[0].eventId).toBe(1);
  });

  it('skips lines where eventId is not a number', () => {
    const badLine = { ...validLine, eventId: 'not-a-number' };
    const content = [JSON.stringify(validLine), JSON.stringify(badLine)].join('\n');
    writeFileSync(join(testJobDir, 'progress.jsonl'), content);
    const result = readProgressLog(testJobId);
    expect(result).toHaveLength(1);
  });

  it('accepts and preserves additional fields (forward compatibility)', () => {
    const extended = { ...validLine, futureField: 'data' };
    writeFileSync(join(testJobDir, 'progress.jsonl'), JSON.stringify(extended) + '\n');
    const result = readProgressLog(testJobId);
    expect(result).toHaveLength(1);
    expect(result[0].jobId).toBe('j1');
    expect(result[0]).toHaveProperty('futureField', 'data');
  });

  it('returns empty array for empty file', () => {
    writeFileSync(join(testJobDir, 'progress.jsonl'), '');
    expect(readProgressLog(testJobId)).toEqual([]);
  });

  it('returns empty array for whitespace-only file', () => {
    writeFileSync(join(testJobDir, 'progress.jsonl'), '\n\n  \n');
    expect(readProgressLog(testJobId)).toEqual([]);
  });
});

describe('readDiscussState', () => {
  it('preserves the lenient boundary for minimal persisted discuss state files', () => {
    const statePath = fixturePath('lenient-state.json');
    writeJsonFixture(statePath, {
      session_id: 'session-1',
      topic: 'Legacy topic',
      status: 'legacy-status',
      agents: [],
      futureField: true,
    });

    const result = readDiscussState(statePath);
    expect(result).not.toBeNull();
    expect(result!.session_id).toBe('session-1');
    expect(result!.topic).toBe('Legacy topic');
    expect(result!.status).toBe('legacy-status');
    expect(Array.isArray((result as unknown as { agents: unknown }).agents)).toBe(true);
    expect(result!).toHaveProperty('futureField', true);
  });

  it('rejects discuss state files that miss the lenient minimum shape', () => {
    const statePath = fixturePath('invalid-lenient-state.json');
    writeJsonFixture(statePath, {
      session_id: 'session-1',
      topic: 'Legacy topic',
      status: 'legacy-status',
      agents: 'not-a-record',
    });

    expect(readDiscussState(statePath)).toBeNull();
  });
});

describe('readDiscussEventLog', () => {
  it('skips malformed lines and invalid payloads while preserving valid boundary payloads', () => {
    const logPath = fixturePath('discuss-event-log.jsonl');
    writeTextFixture(
      logPath,
      [
        JSON.stringify({
          v: 1,
          sessionId: 'session-1',
          projectRoot: '/tmp/project',
          topic: 'Discuss topic',
          seq: 1,
          kind: 'bidding.opened',
          ts: NOW,
          payload: [],
        }),
        'not json',
        JSON.stringify({
          v: 1,
          sessionId: 'session-1',
          projectRoot: '/tmp/project',
          topic: 'Discuss topic',
          seq: 2,
          kind: 'bidding.opened',
          ts: NOW,
          payload: null,
        }),
        JSON.stringify({
          v: 1,
          sessionId: 'session-1',
          projectRoot: '/tmp/project',
          topic: 'Discuss topic',
          seq: 3,
          kind: 'bid.submitted',
          ts: NOW,
          payload: {
            agent: 'alice',
            score: 10,
            thought: 'Ready',
          },
        }),
        JSON.stringify({
          v: 1,
          sessionId: 'session-1',
          projectRoot: '/tmp/project',
          topic: 'Discuss topic',
          seq: 4,
          kind: 'bid.submitted',
          ts: NOW,
          payload: {
            agent: 'alice',
            score: '10',
            thought: 'Wrong type',
          },
        }),
      ].join('\n'),
    );

    const result = readDiscussEventLog(logPath);
    expect(result).toHaveLength(2);
    expect(result.map((event) => event.kind)).toEqual(['bidding.opened', 'bid.submitted']);
    expect(Array.isArray((result[0] as unknown as { payload: unknown }).payload)).toBe(true);
    expect(result[1].payload).toMatchObject({
      agent: 'alice',
      score: 10,
      thought: 'Ready',
    });
  });
});

describe('readDiscussSnapshot', () => {
  it('accepts a strict persisted discuss snapshot that matches runtime and speaking invariants', () => {
    const snapshotPath = fixturePath('snapshot-valid.json');
    writeJsonFixture(
      snapshotPath,
      makePersistedDiscussSnapshot({
        state: makePersistedDiscussState({
          status: 'speaking',
          current_speaker: 'alice',
          speaker_type: 'quota',
          pending_bidders: [],
        }),
      }),
    );

    const result = readDiscussSnapshot(snapshotPath);
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe('session-1');
    expect(result!.state.status).toBe('speaking');
    expect(result!.runtime.agentRuns).toHaveProperty('alice');
  });

  it('rejects persisted discuss snapshots that violate speaking-state constraints', () => {
    const snapshotPath = fixturePath('snapshot-invalid-speaking.json');
    writeJsonFixture(
      snapshotPath,
      makePersistedDiscussSnapshot({
        state: makePersistedDiscussState({
          status: 'speaking',
          current_speaker: null,
          speaker_type: null,
        }),
      }),
    );

    expect(readDiscussSnapshot(snapshotPath)).toBeNull();
  });

  it('rejects persisted discuss snapshots when snapshot and runtime agent identities drift', () => {
    const snapshotPath = fixturePath('snapshot-invalid-runtime.json');
    writeJsonFixture(
      snapshotPath,
      makePersistedDiscussSnapshot({
        runtime: {
          controlPhase: 'idle',
          carryForwardMustAnswer: [],
          followUpQueue: [],
          agentRuns: {
            bob: {
              provider: 'openai',
              model: 'gpt-5',
            },
          },
        },
      }),
    );

    expect(readDiscussSnapshot(snapshotPath)).toBeNull();
  });

  it('rejects persisted discuss snapshots when state.session_id does not match sessionId', () => {
    const snapshotPath = fixturePath('snapshot-invalid-session-id.json');
    writeJsonFixture(
      snapshotPath,
      makePersistedDiscussSnapshot({
        state: makePersistedDiscussState({
          session_id: 'other-session',
        }),
      }),
    );

    expect(readDiscussSnapshot(snapshotPath)).toBeNull();
  });
});

describe('readDiscussDiscoveryForSource', () => {
  it('accepts discovery metadata with the current source envelope', () => {
    writeJsonFixture(discussDiscoveryPathForSource(testSource), {
      source: testSource,
      updatedAt: NOW,
      sessions: [makeDiscoverySession()],
    });

    const result = readDiscussDiscoveryForSource(testSource);
    expect(result).not.toBeNull();
    expect(result!.source).toBe(testSource);
    expect(result!.sessions).toHaveLength(1);
    expect(result!.sessions[0].sessionId).toBe('session-1');
  });

  it('accepts legacy discovery metadata that uses projectRoot instead of source', () => {
    writeJsonFixture(discussDiscoveryPathForSource(testSource), {
      projectRoot: '/tmp/project',
      updatedAt: NOW,
      sessions: [makeDiscoverySession()],
    });

    const result = readDiscussDiscoveryForSource(testSource);
    expect(result).not.toBeNull();
    expect(result!.source).toBe(testSource);
    expect(result!.sessions[0].topic).toBe('Discuss topic');
  });

  it('rejects discovery metadata when a present source mismatches the requested source', () => {
    writeJsonFixture(discussDiscoveryPathForSource(testSource), {
      source: 'wrong/source',
      projectRoot: '/tmp/project',
      updatedAt: NOW,
      sessions: [makeDiscoverySession()],
    });

    expect(readDiscussDiscoveryForSource(testSource)).toBeNull();
  });
});

describe('readDiscussSummaryIndexForSource', () => {
  it('accepts summary index metadata with the current source envelope', () => {
    writeJsonFixture(discussSummaryIndexPathForSource(testSource), {
      source: testSource,
      updatedAt: NOW,
      sessions: [makeSummaryIndexRow()],
    });

    const result = readDiscussSummaryIndexForSource(testSource);
    expect(result).not.toBeNull();
    expect(result!.source).toBe(testSource);
    expect(result!.sessions).toHaveLength(1);
    expect(result!.sessions[0].sessionId).toBe('session-1');
  });

  it('accepts legacy summary index metadata that uses projectRoot instead of source', () => {
    writeJsonFixture(discussSummaryIndexPathForSource(testSource), {
      projectRoot: '/tmp/project',
      updatedAt: NOW,
      sessions: [makeSummaryIndexRow()],
    });

    const result = readDiscussSummaryIndexForSource(testSource);
    expect(result).not.toBeNull();
    expect(result!.source).toBe(testSource);
    expect(result!.sessions[0].status).toBe('bidding');
  });
});

describe('readDiscussSources', () => {
  it('accepts the current sources registry and ignores invalid legacy projectRoots data', () => {
    writeJsonFixture(discussSourcesPath(), {
      updatedAt: NOW,
      sources: [testSource, testSource, 'other/source'],
      projectRoots: 'not-an-array',
    });

    expect(readDiscussSources()).toEqual([testSource, 'other/source']);
  });

  it('accepts the legacy projectRoots registry when current sources are absent or invalid', () => {
    const legacyProjectRoot = trackCleanup(mkdtempSync(join(tmpdir(), 'coral-legacy-project-')));
    writeJsonFixture(discussSourcesPath(), {
      updatedAt: NOW,
      sources: 'not-an-array',
      projectRoots: [legacyProjectRoot, legacyProjectRoot],
    });

    expect(readDiscussSources()).toEqual([resolveProjectSource(legacyProjectRoot)]);
  });
});

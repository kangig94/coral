import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  currentBuildFlavor,
  discussBaseDirForSource,
  discussDiscoveryPathForSource,
  discussSourcesPath,
  discussSummaryIndexPathForSource,
  resolveProjectSource,
} from '../../infra/paths.js';
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
import { openStoreDatabase } from '../../store/db.js';
import { storePaths } from '../../store/paths.js';
import { createRealRuntime } from '../../runtime/real.js';

const originalHome = process.env.HOME;

let testJobId: string;
let fixtureDir: string;
let testSource: string;
let testHomeDir: string;
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

const nodeStoreStorage = createRealRuntime().storage;

function withWritableStore(write: (db: ReturnType<typeof openStoreDatabase>) => void): void {
  const db = openStoreDatabase({
    path: storePaths(currentBuildFlavor()).dbFile,
    storage: nodeStoreStorage,
  });

  try {
    write(db);
  } finally {
    db.close();
  }
}

function makeLaunchBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: 's1',
    provider: 'codex',
    projectRoot: '/tmp/project',
    backendNamespace: 'ns',
    pool: 'default',
    enqueueSequence: 0,
    providerAction: 'exec',
    request: {
      prompt: 'hello',
      cwd: '/tmp/project',
      bypassPermissions: false,
      coralEnv: {},
    },
    createdAt: NOW,
    ...overrides,
  };
}

function insertJobEvent(
  db: ReturnType<typeof openStoreDatabase>,
  {
    jobId = testJobId,
    type,
    body,
    ts = NOW,
  }: {
    jobId?: string;
    type: string;
    body: string | Record<string, unknown>;
    ts?: string;
  },
): number {
  const payload = typeof body === 'string' ? Buffer.from(body, 'utf-8') : Buffer.from(JSON.stringify(body), 'utf-8');
  const result = db
    .prepare(
      `INSERT INTO events (
         ts,
         type,
         stream_kind,
         stream_id,
         namespace,
         project,
         refs,
         body_version,
         body
       ) VALUES (?, ?, 'job', ?, 'ns', '/tmp/project', ?, 1, ?)`,
    )
    .run(ts, type, jobId, JSON.stringify({ jobId }), payload);
  return Number(result.lastInsertRowid);
}

function seedJobProjection(
  options: {
    jobId?: string;
    phase?: string;
    launchBody?: string | Record<string, unknown> | null;
    events?: Array<{ type: string; body: string | Record<string, unknown>; ts?: string }>;
  } = {},
): void {
  const jobId = options.jobId ?? testJobId;
  withWritableStore((db) => {
    let lastSeq = 0;
    if (options.launchBody !== null) {
      lastSeq = insertJobEvent(db, {
        jobId,
        type: 'job.launch.requested',
        body: options.launchBody ?? makeLaunchBody(),
      });
    }
    for (const event of options.events ?? []) {
      lastSeq = insertJobEvent(db, { jobId, ...event });
    }

    db.prepare(
      `INSERT INTO projection_jobs (
         job_id,
         phase,
         terminal,
         diagnostics,
         parent_job_id,
         workflow_slot,
         last_seq
       ) VALUES (?, ?, NULL, NULL, NULL, NULL, ?)`,
    ).run(jobId, options.phase ?? 'running', lastSeq);
  });
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
  testHomeDir = mkdtempSync(join(tmpdir(), 'coral-readers-home-'));
  process.env.HOME = testHomeDir;
  fixtureDir = mkdtempSync(join(tmpdir(), 'coral-readers-'));
  testSource = `tests/${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  cleanupPaths = [fixtureDir, testHomeDir, discussBaseDirForSource(testSource)];
});

afterEach(() => {
  for (const cleanupPath of cleanupPaths) {
    rmSync(cleanupPath, { recursive: true, force: true });
  }
  process.env.HOME = originalHome;
});

describe('readStatusRecord', () => {
  it('returns a valid status record with all required fields', () => {
    seedJobProjection({ phase: 'completed' });
    const result = readStatusRecord(testJobId);
    expect(result).not.toBeNull();
    expect(result!.jobId).toBe(testJobId);
    expect(result!.sessionId).toBe('s1');
    expect(result!.provider).toBe('codex');
    expect(result!.projectRoot).toBe('/tmp/project');
    expect(result!.backendNamespace).toBe('ns');
    expect(result!.phase).toBe('completed');
    expect(result!.launch.state).toBe('ready');
    expect(result!.launch.updatedAt).toBe(NOW);
  });

  it('returns null when the projection store has no matching job', () => {
    expect(readStatusRecord(testJobId)).toBeNull();
  });

  it('returns null when the launch event body is invalid JSON', () => {
    seedJobProjection({ launchBody: 'not json' });
    expect(readStatusRecord(testJobId)).toBeNull();
  });

  it('returns null when the launch event body has the wrong shape', () => {
    seedJobProjection({ launchBody: { jobId: 'wrong-shape' } });
    expect(readStatusRecord(testJobId)).toBeNull();
  });

  it('returns null when the projection exists without a launch request event', () => {
    seedJobProjection({ launchBody: null });
    expect(readStatusRecord(testJobId)).toBeNull();
  });

  it('returns null when the launch request body contains unexpected fields under the journal schema', () => {
    seedJobProjection({ launchBody: { ...makeLaunchBody(), futureField: true } });
    expect(readStatusRecord(testJobId)).toBeNull();
  });
});

describe('readProgressLog', () => {
  it('returns valid progress entries with all required fields', () => {
    seedJobProjection({
      phase: 'running',
      events: [{ type: 'job.progress.emitted', body: { kind: 'message', message: 'working' } }],
    });
    const result = readProgressLog(testJobId);
    expect(result).toHaveLength(1);
    expect(result[0].jobId).toBe(testJobId);
    expect(result[0].sessionId).toBe('s1');
    expect(result[0].eventId).toBe(1);
    expect(result[0].type).toBe('progress');
    expect(result[0].ts).toBe(NOW);
    expect(result[0].message).toBe('working');
  });

  it('returns empty array when the projection store has no matching job', () => {
    expect(readProgressLog(testJobId)).toEqual([]);
  });

  it('returns an empty array when a progress event body is invalid JSON', () => {
    seedJobProjection({
      phase: 'running',
      events: [{ type: 'job.progress.emitted', body: 'not json' }],
    });
    expect(readProgressLog(testJobId)).toEqual([]);
  });

  it('returns an empty array when a progress event body has the wrong shape', () => {
    seedJobProjection({
      phase: 'running',
      events: [{ type: 'job.progress.emitted', body: { message: 'working' } }],
    });
    expect(readProgressLog(testJobId)).toEqual([]);
  });

  it('skips non-message job progress events that do not surface to the client', () => {
    seedJobProjection({
      phase: 'running',
      events: [{ type: 'job.progress.emitted', body: { kind: 'stale_status_schema' } }],
    });
    expect(readProgressLog(testJobId)).toEqual([]);
  });

  it('returns an empty array when a progress event body contains unexpected fields', () => {
    seedJobProjection({
      phase: 'running',
      events: [{ type: 'job.progress.emitted', body: { kind: 'message', message: 'working', futureField: 'data' } }],
    });
    expect(readProgressLog(testJobId)).toEqual([]);
  });

  it('returns terminal records from journal events when present', () => {
    seedJobProjection({
      phase: 'completed',
      events: [
        {
          type: 'job.terminal.recorded',
          body: {
            outcome: { kind: 'completed' },
            durationMs: 1,
            content: 'done',
          },
        },
      ],
    });

    expect(readProgressLog(testJobId)).toEqual([
      {
        jobId: testJobId,
        sessionId: 's1',
        seq: 2,
        perJobIndex: 1,
        eventId: 1,
        type: 'terminal',
        ts: NOW,
        result: {
          content: 'done',
          durationMs: 1,
          outcome: { kind: 'completed' },
        },
      },
    ]);
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

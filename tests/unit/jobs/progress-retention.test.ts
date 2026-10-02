import { decideSessionCreate } from '#src/discuss/state-machine.js';
import { toJournalInput } from '#src/discuss/event-registry.js';
import { sessionControllerFromProfile } from '#src/sessions/entry.js';
import { afterEach, describe, expect, it } from 'vitest';
import { pruneJobProgress } from '#src/jobs/progress-retention.js';
import { getEventsSince } from '#src/store/event-queries.js';
import { createRetentionFixture, RETENTION_CUTOFF } from '#tests/helpers/storage-retention.js';
import { initTestJob, seedTestSessionProjection } from '#tests/helpers/session.js';
import { commitJobInput, commitJobTerminal } from '#tests/helpers/job-commits.js';
import { rebuildProjections } from '#tests/helpers/rebuild-projections.js';
import { TEST_PROVIDER_SCOPE } from '#tests/helpers/provider-credentials.js';

const fixtures: ReturnType<typeof createRetentionFixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});
function fixture() {
  const f = createRetentionFixture();
  fixtures.push(f);
  return f;
}
function launch(f: ReturnType<typeof fixture>, id: string) {
  initTestJob(f.store, {
    jobId: id,
    sessionId: `session-${id}`,
    provider: 'codex',
    projectRoot: '/workspace',
    backendNamespace: 'test-ns',
  });
  return f.store.appendProgress(id, `session-${id}`, 'progress');
}
function terminal(f: ReturnType<typeof fixture>, id: string) {
  return commitJobTerminal(f.store, id, `session-${id}`, {
    content: 'terminal result',
    outcome: { kind: 'completed' },
    durationMs: 1,
  });
}
function rebuild(f: ReturnType<typeof fixture>) {
  rebuildProjections({ db: f.db, cutoffSeq: 1_000_000, reducers: f.reducers, bodyCodec: f.store.bodyCodec });
}
function projections(f: ReturnType<typeof fixture>) {
  return ['jobs', 'sessions', 'discuss', 'workflows'].map((name) =>
    f.db.prepare(`SELECT * FROM projection_${name} ORDER BY 1`).all(),
  );
}
async function prune(f: ReturnType<typeof fixture>) {
  return pruneJobProgress({ db: f.db, readCtx: f.store, cutoff: RETENTION_CUTOFF, afterSeq: 0, budget: f.budget });
}

describe('progress retention', () => {
  it('rebuilds every projection identically and renders terminal/results with cursor gaps', async () => {
    const f = fixture();
    f.setNow(1);
    const first = launch(f, 'expired');
    const end = terminal(f, 'expired');
    const session = seedTestSessionProjection(f.db, {
      sessionId: 'retained-session',
      provider: 'codex',
      projectRoot: '/workspace',
    });
    f.db.prepare('DELETE FROM projection_sessions WHERE session_id = ?').run(session.sessionId);
    commitJobInput(f.store, {
      type: 'session.opened',
      stream: { kind: 'session', id: session.sessionId },
      body: {
        entry: session,
        controller: sessionControllerFromProfile(session.controllerProfile),
        scope_key: 'test-scope',
      },
    });
    commitJobInput(f.store, {
      type: 'workflow.plan.declared',
      stream: { kind: 'workflow', id: 'workflow' },
      body: {
        plan: { slots: [{ slotId: 'workflow:0:0', provider: 'codex', instruction: 'test slot', dependencies: [] }] },
        providerScope: TEST_PROVIDER_SCOPE,
      },
    });
    const created = decideSessionCreate(
      {
        topic: 'retention replay',
        agents: [{ name: 'critic', persona: 'Critic', participation: 'required' }],
        min_bid_delay_ms: 0,
      },
      { sessionId: 'discussion', projectRoot: '/workspace', topic: 'retention replay' },
      1,
      '1970-01-01T00:00:00.001Z',
      { providerScope: TEST_PROVIDER_SCOPE },
    );
    if (!created.ok) throw new Error('discussion fixture rejected');
    for (const event of created.value) commitJobInput(f.store, toJournalInput(event));
    rebuild(f);
    const before = projections(f);
    const max = f.db.prepare('SELECT MAX(seq) AS seq FROM events').get();
    await prune(f);
    expect(f.db.prepare('SELECT seq FROM events WHERE seq = ?').get(first)).toBeUndefined();
    expect(f.store.readJobEvents('expired')).toEqual([
      expect.objectContaining({
        type: 'terminal',
        seq: end,
        result: expect.objectContaining({ content: 'terminal result' }),
      }),
    ]);
    expect(f.store.readStatus('expired')?.phase).toBe('completed');
    expect(f.runtime.storage.readFileSync(f.store.ensureResultArtifact('expired'), 'utf-8')).toContain(
      'terminal result',
    );
    const page = getEventsSince(f.db, first, {}, 1000, f.store);
    expect(page.events[0].seq).toBe(end);
    expect(page.nextCursor).toBeGreaterThanOrEqual(end);
    expect(f.db.prepare('SELECT MAX(seq) AS seq FROM events').get()).toEqual(max);
    rebuild(f);
    expect(projections(f)).toEqual(before);
    expect(f.outcomes).toContainEqual({ kind: 'deleted', subject: 'progress:expired', count: 1 });
  });

  it('keeps live and recent jobs, fault diagnostics and referenced progress evidence', async () => {
    const f = fixture();
    f.setNow(1);
    const live = launch(f, 'live');
    const referenced = launch(f, 'fault');
    commitJobInput(f.store, {
      type: 'job.progress.emitted',
      stream: { kind: 'job', id: 'fault' },
      body: { kind: 'missing_launch_record' },
    });
    commitJobTerminal(f.store, 'fault', 'session-fault', {
      content: 'fault',
      outcome: { kind: 'failed', causeRef: { stream: { kind: 'job', id: 'fault' }, seq: referenced } },
      durationMs: 1,
    });
    f.setNow(RETENTION_CUTOFF);
    const recent = launch(f, 'recent');
    terminal(f, 'recent');
    rebuild(f);
    const before = projections(f);
    await prune(f);
    for (const seq of [live, referenced, recent])
      expect(f.db.prepare('SELECT seq FROM events WHERE seq = ?').get(seq)).toBeDefined();
    expect(f.store.readStatus('fault')?.result?.outcome.kind).toBe('failed');
    expect(f.outcomes).toContainEqual({
      kind: 'kept',
      subject: 'progress:fault',
      reason: 'diagnostics-or-causal-evidence',
    });
    rebuild(f);
    expect(projections(f)).toEqual(before);
  });

  it('keeps unknown terminals and stops deletion when its injected budget is exhausted', async () => {
    const f = fixture();
    f.setNow(1);
    const seq = launch(f, 'unknown');
    terminal(f, 'unknown');
    f.db.prepare("UPDATE events SET body = ? WHERE type = 'job.terminal.recorded'").run(Buffer.from('{}'));
    await prune(f);
    expect(f.db.prepare('SELECT seq FROM events WHERE seq = ?').get(seq)).toBeDefined();
    f.budget.canContinue = () => false;
    expect(await prune(f)).toBe(0);
  });

  it('keeps causation targets and deletes large histories across bounded batches', async () => {
    const f = fixture();
    f.setNow(1);
    const referenced = launch(f, 'large');
    for (let i = 0; i < 1005; i += 1) f.store.appendProgress('large', 'session-large', `message ${i}`);
    const end = terminal(f, 'large');
    f.db.prepare('UPDATE events SET causation_seq = ? WHERE seq = ?').run(referenced, end);
    await prune(f);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'job.progress.emitted'").get()).toEqual({
      n: 1,
    });
    expect(f.db.prepare('SELECT seq FROM events WHERE seq = ?').get(referenced)).toBeDefined();
  });
});

import { decideSessionCreate } from '#src/discuss/state-machine.js';
import { toJournalInput } from '#src/discuss/event-registry.js';
import { sessionControllerFromProfile } from '#src/sessions/entry.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pruneJobProgress } from '#src/jobs/progress-retention.js';
import { getEventsSince } from '#src/store/event-queries.js';
import { createRetentionFixture, RETENTION_CUTOFF } from '#tests/helpers/storage-retention.js';
import { initTestJob, seedTestSessionProjection } from '#tests/helpers/session.js';
import { commitJobInput, commitJobTerminal } from '#tests/helpers/job-commits.js';
import { rebuildProjections } from '#tests/helpers/rebuild-projections.js';
import { TEST_PROVIDER_SCOPE } from '#tests/helpers/provider-credentials.js';
import { ensureRetentionIndexes } from '#src/store/retention-indexes.js';

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
  it.each(['terminal', 'message'] as const)(
    'prunes both jobs when %s text mentions causeRef, including quoted JSON',
    async (location) => {
      const f = fixture();
      f.setNow(1);
      launch(f, 'mentioned');
      f.store.appendProgress('mentioned', 'session-mentioned', location === 'message' ? 'causeRef' : 'ordinary');
      commitJobTerminal(f.store, 'mentioned', 'session-mentioned', {
        content: location === 'terminal' ? 'causeRef' : 'ordinary',
        outcome: { kind: 'completed' },
        durationMs: 1,
      });
      launch(f, 'unrelated');
      commitJobTerminal(f.store, 'unrelated', 'session-unrelated', {
        content: 'Example: {"causeRef":{"seq":1}}',
        outcome: { kind: 'completed' },
        durationMs: 1,
      });
      const oldPredicate = `CASE WHEN json_valid(body) THEN
        (length(CAST(body AS TEXT)) - length(replace(CAST(body AS TEXT), '"causeRef"', ''))) / 10 >
        ((json_type(body, '$.causeRef') IS NOT NULL) +
         (json_type(body, '$.reason.causeRef') IS NOT NULL) +
         (json_type(body, '$.terminal.outcome.causeRef') IS NOT NULL)) ELSE 1 END`;
      f.db.exec(`CREATE INDEX IF NOT EXISTS events_retention_unknown_cause ON events(seq) WHERE ${oldPredicate}`);
      const oldIndex = f.db
        .prepare("SELECT sql FROM sqlite_master WHERE name = 'events_retention_unknown_cause'")
        .get();
      expect(
        f.db
          .prepare(`SELECT seq FROM events INDEXED BY events_retention_unknown_cause WHERE ${oldPredicate} LIMIT 1`)
          .get(),
      ).toBeDefined();
      ensureRetentionIndexes(f.db);
      await prune(f);
      expect(f.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'job.progress.emitted'").get()).toEqual({
        n: 0,
      });
      expect(f.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'events_retention_unknown_cause'").get()).toEqual(
        oldIndex,
      );
    },
  );

  it('holds progress globally for an invalid body', async () => {
    const f = fixture();
    f.setNow(1);
    const seq = launch(f, 'old');
    terminal(f, 'old');
    f.db
      .prepare(
        "INSERT INTO events(ts, type, stream_kind, stream_id, body) VALUES (?, 'future.event', 'workflow', 'invalid', ?)",
      )
      .run(new Date(1).toISOString(), Buffer.from('{invalid'));
    await prune(f);
    expect(f.db.prepare('SELECT seq FROM events WHERE seq = ?').get(seq)).toBeDefined();
  });

  it('rebuilds every projection identically and renders terminal/results with cursor gaps', async () => {
    const f = fixture();
    f.setNow(1);
    const first = launch(f, 'expired');
    const end = terminal(f, 'expired');
    f.store.publishTerminalResult('expired');
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
      pending: false,
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

  it.each(['direct', 'reason', 'terminal', 'unknown-nesting'])(
    'protects %s causal shapes with indexed transaction checks',
    async (shape) => {
      const f = fixture();
      f.setNow(1);
      launch(f, 'old');
      const seq = f.store.appendProgress('old', 'session-old', 'evidence');
      terminal(f, 'old');
      const causeRef = { stream: { kind: 'job', id: 'old' }, seq };
      const bodies = {
        direct: { causeRef },
        reason: { reason: { causeRef } },
        terminal: { terminal: { outcome: { causeRef } } },
        'unknown-nesting': { future: { causeRef } },
      };
      f.db
        .prepare(
          "INSERT INTO events(ts, type, stream_kind, stream_id, body) VALUES (?, 'future.event', 'workflow', 'reference', ?)",
        )
        .run(new Date(1).toISOString(), Buffer.from(JSON.stringify(bodies[shape as keyof typeof bodies])));
      await prune(f);
      expect(f.db.prepare('SELECT seq FROM events WHERE seq = ?').get(seq)).toBeDefined();
      const plans = [
        'causation_seq = 1',
        "CASE WHEN json_valid(body) THEN json_extract(body, '$.terminal.outcome.causeRef.seq') END = 1",
      ].map((predicate) => f.db.prepare(`EXPLAIN QUERY PLAN SELECT seq FROM events WHERE ${predicate} LIMIT 1`).all());
      expect(JSON.stringify(plans)).not.toContain('SCAN events');
    },
  );

  it('resumes inside an interrupted job without revisiting its retained progress prefix', async () => {
    const f = fixture();
    f.setNow(1);
    launch(f, 'large');
    for (let i = 0; i < 130; i += 1) f.store.appendProgress('large', 'session-large', `message ${i}`);
    terminal(f, 'large');
    let checks = 0;
    f.budget.canContinue = () => ++checks < 10;
    expect(await prune(f)).toBeGreaterThan(0);
    const checkpoint = f.db.prepare("SELECT value FROM meta WHERE key = 'storage-retention.progress.v1'").get() as {
      value: string;
    };
    expect(JSON.parse(checkpoint.value).progressSeq).toBeGreaterThan(0);
    expect(JSON.parse(checkpoint.value).ceiling).toBe(
      f.db
        .prepare<[], { seq: number }>("SELECT MAX(seq) AS seq FROM events WHERE type = 'job.terminal.recorded'")
        .get()!.seq,
    );
    f.budget.canContinue = () => true;
    await prune(f);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'job.progress.emitted'").get()).toEqual({
      n: 0,
    });
  });

  it.each(['causeRef', 'causation_seq'])(
    'rechecks a late %s reference in the deleting transaction',
    async (reference) => {
      const f = fixture();
      f.setNow(1);
      launch(f, 'old');
      launch(f, 'other');
      let target = 0;
      for (let i = 0; i < 1005; i += 1) target = f.store.appendProgress('old', 'session-old', `message ${i}`);
      terminal(f, 'old');
      const pruning = prune(f);
      if (reference === 'causeRef') {
        commitJobTerminal(f.store, 'other', 'session-other', {
          content: 'failed',
          outcome: { kind: 'failed', causeRef: { stream: { kind: 'job', id: 'old' }, seq: target } },
          durationMs: 1,
        });
      } else {
        terminal(f, 'other');
        f.db
          .prepare("UPDATE events SET causation_seq = ? WHERE stream_id = 'other' AND type = 'job.terminal.recorded'")
          .run(target);
      }
      await pruning;
      expect(f.db.prepare('SELECT seq FROM events WHERE seq = ?').get(target)).toBeDefined();
      await prune(f);
      expect(f.db.prepare('SELECT seq FROM events WHERE seq = ?').get(target)).toBeDefined();
      expect(f.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'job.progress.emitted'").get()).toEqual({
        n: 1,
      });
    },
  );

  it('does no synchronous journal work with an exhausted budget', async () => {
    const f = fixture();
    f.setNow(1);
    const prepare = vi.spyOn(f.db, 'prepare');
    f.budget.canContinue = () => false;
    await prune(f);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('revisits an expired prefix while at least a thousand terminals arrive per cycle', async () => {
    const f = fixture();
    f.setNow(RETENTION_CUTOFF);
    launch(f, 'prefix');
    terminal(f, 'prefix');
    const templates = f.db
      .prepare(
        "SELECT ts, type, body FROM events WHERE stream_id = 'prefix' AND type IN ('job.progress.emitted', 'job.terminal.recorded') ORDER BY seq",
      )
      .all() as { ts: string; type: string; body: Uint8Array }[];
    const insert = f.db.prepare(
      "INSERT INTO events(ts, type, stream_kind, stream_id, body) VALUES (?, ?, 'job', ?, ?)",
    );
    const append = (start: number, count: number, ts: string) => {
      f.db.exec('BEGIN IMMEDIATE');
      for (let i = start; i < start + count; i += 1)
        for (const row of templates) insert.run(ts, row.type, `arrival-${i}`, row.body);
      f.db.exec('COMMIT');
    };
    append(0, 1000, new Date(RETENTION_CUTOFF).toISOString());
    await prune(f);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'job.progress.emitted'").get()).toEqual({
      n: 1001,
    });
    const expiredCutoff = RETENTION_CUTOFF + 30 * 86_400_000;
    for (let cycle = 0; cycle < 3; cycle += 1) {
      append(1000 + cycle * 1001, 1001, new Date(expiredCutoff).toISOString());
      await pruneJobProgress({ db: f.db, readCtx: f.store, cutoff: expiredCutoff, afterSeq: 0, budget: f.budget });
    }
    expect(
      f.db.prepare("SELECT seq FROM events WHERE stream_id = 'prefix' AND type = 'job.progress.emitted'").get(),
    ).toBeUndefined();
    expect(
      f.db.prepare("SELECT seq FROM events WHERE stream_id = 'arrival-1000' AND type = 'job.progress.emitted'").get(),
    ).toBeDefined();
  });

  it('accepts an old cursor without a ceiling and starts a fresh capture', async () => {
    const f = fixture();
    f.setNow(1);
    const seq = launch(f, 'prefix');
    const end = terminal(f, 'prefix');
    f.db
      .prepare('INSERT INTO meta(key, value) VALUES (?, ?)')
      .run('storage-retention.progress.v1', JSON.stringify({ afterSeq: end, progressSeq: seq, futureField: true }));
    await prune(f);
    expect(f.db.prepare('SELECT seq FROM events WHERE seq = ?').get(seq)).toBeUndefined();
    expect(
      f.db
        .prepare("SELECT value FROM meta WHERE key = 'storage-retention.quarantine.v1.storage-retention.progress.v1'")
        .get(),
    ).toBeUndefined();
    const meta = f.db.prepare("SELECT value FROM meta WHERE key = 'storage-retention.progress.v1'").get() as {
      value: string;
    };
    expect(JSON.parse(meta.value)).toMatchObject({ afterSeq: 0, progressSeq: 0, futureField: true });
  });

  it('continues the terminal scan after a restart instead of repeating the first thousand', async () => {
    const f = fixture();
    f.setNow(1);
    launch(f, 'first');
    terminal(f, 'first');
    const source = f.db.prepare("SELECT ts, body FROM events WHERE type = 'job.terminal.recorded'").get() as {
      ts: string;
      body: Uint8Array;
    };
    const insert = f.db.prepare(
      "INSERT INTO events(type, stream_kind, stream_id, ts, body) VALUES ('job.terminal.recorded', 'job', ?, ?, ?)",
    );
    for (let i = 0; i < 999; i += 1) insert.run(`prefix-${i}`, source.ts, source.body);
    launch(f, 'tail');
    const target = f.store.appendProgress('tail', 'session-tail', 'tail progress');
    terminal(f, 'tail');
    await prune(f);
    await prune(f);
    expect(f.db.prepare('SELECT seq FROM events WHERE seq = ?').get(target)).toBeUndefined();
  });

  it('restores SQLite settings before yielding and bounds each deletion batch when a commit exhausts its budget', async () => {
    const f = fixture();
    f.setNow(1);
    f.setNow(1);
    launch(f, 'many');
    for (let i = 0; i < 130; i += 1) f.store.appendProgress('many', 'session-many', 'message');
    terminal(f, 'many');
    const exec = f.db.exec.bind(f.db);
    let aborted = false;
    let deletes = 0;
    const prepare = f.db.prepare.bind(f.db);
    vi.spyOn(f.db, 'prepare').mockImplementation((sql) => {
      if (sql.startsWith('DELETE FROM events')) {
        deletes += 1;
        expect(sql.match(/\?/gu)?.length).toBeLessThanOrEqual(64);
      }
      return prepare(sql);
    });
    vi.spyOn(f.db, 'exec').mockImplementation((sql) => {
      if (sql === 'COMMIT' && !aborted) {
        expect(f.db.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 25 });
        expect(f.db.prepare('PRAGMA wal_autocheckpoint').get()).toEqual({ wal_autocheckpoint: 1000 });
        aborted = true;
      }
      exec(sql);
    });
    expect(
      await pruneJobProgress({
        db: f.db,
        readCtx: f.store,
        cutoff: RETENTION_CUTOFF,
        afterSeq: 0,
        budget: { record: () => {}, canContinue: () => !aborted },
      }),
    ).toBeGreaterThan(0);
    expect(deletes).toBe(1);
    expect(f.db.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 0 });
    expect(f.db.prepare('PRAGMA wal_autocheckpoint').get()).toEqual({ wal_autocheckpoint: 1000 });
  });
});

import { describe, expect, it } from 'vitest';

import { appendJobTerminalRecorded } from '#src/jobs/terminal/recording.js';
import { jobTerminalRecordedBodySchema } from '#src/jobs/terminal/result.js';
import { managed } from '#src/providers/capability.js';
import { defineProvider } from '#src/providers/registry.js';
import { ProviderRegistry } from '#src/providers/registry.js';
import { sessionsRegistry } from '#src/sessions/events.js';
import type { ProviderSession } from '#src/sessions/entry.js';
import { createLifecycleReactor } from '#src/sessions/lifecycle-reactor.js';
import { SessionManager } from '#src/sessions/shell.js';
import { commit, type CommitEventsFn } from '#src/store/append.js';
import { composeReducers, defineDomainEvent, type DomainEventRegistry } from '#src/store/reducers.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { TEST_CLAUDE_BINDING } from '#tests/helpers/provider-credentials.js';
import { fixtureProviderBindingCodec } from '#tests/helpers/provider-binding.js';
import { prepareFixtureExecutionPlan } from '#tests/helpers/scripted-provider.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';

async function* noopProvider() {}

const terminalCodecRegistry: DomainEventRegistry = {
  streamKind: 'job',
  entries: [defineDomainEvent({ type: 'job.terminal.recorded', schema: jobTerminalRecordedBodySchema })],
};

function applyMinimalSchema(db: ReturnType<typeof newRawDatabase>): void {
  db.exec(`
    CREATE TABLE events (
      seq INTEGER PRIMARY KEY,
      ts TEXT NOT NULL,
      type TEXT NOT NULL,
      stream_kind TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      namespace TEXT,
      project TEXT,
      correlation_id TEXT,
      causation_seq INTEGER,
      refs TEXT,
      body_version INTEGER NOT NULL DEFAULT 1,
      body BLOB NOT NULL
    );
    CREATE INDEX events_stream ON events(stream_kind, stream_id, seq);
    CREATE INDEX events_type ON events(type, seq);
    CREATE TABLE projection_jobs (
      job_id TEXT PRIMARY KEY,
      phase TEXT NOT NULL,
      terminal TEXT,
      diagnostics TEXT,
      session_id TEXT,
      provider TEXT,
      project_root TEXT NOT NULL,
      backend_namespace TEXT NOT NULL,
      bundle_hash TEXT,
      job_kind TEXT NOT NULL,
      parent_workflow_job_id TEXT,
      workflow_slot TEXT,
      created_at TEXT NOT NULL,
      last_seq INTEGER NOT NULL
    );
    CREATE TABLE projection_sessions (
      session_id TEXT PRIMARY KEY,
      controller TEXT NOT NULL,
      resumable INTEGER NOT NULL,
      conversation_ref TEXT,
      scope_key TEXT NOT NULL,
      entry TEXT NOT NULL,
      last_seq INTEGER NOT NULL
    );
  `);
}

function createHarness(): {
  readonly runtime: SimulationRuntime;
  readonly db: ReturnType<typeof newRawDatabase>;
  readonly sessionManager: SessionManager;
  readonly reactor: ReturnType<typeof createLifecycleReactor>;
  readonly coordinatorCommit: CommitEventsFn;
  readonly discardCalls: Array<readonly string[]>;
} {
  const runtime = new SimulationRuntime();
  const db = newRawDatabase(':memory:');
  applyMinimalSchema(db);
  const providerRegistry = new ProviderRegistry();
  const discardCalls: Array<readonly string[]> = [];
  providerRegistry.register(
    defineProvider({
      name: 'claude',
      transport: 'standalone',
      run: noopProvider,
      prepareExecutionPlan: prepareFixtureExecutionPlan,
    })
      .binding(fixtureProviderBindingCodec('claude'))
      .artifacts(
        managed({
          discardArtifacts: async ({ handles }) => {
            discardCalls.push([...handles]);
            return { kind: 'discarded' };
          },
        }),
      )
      .build(),
  );
  const reducers = composeReducers(terminalCodecRegistry, sessionsRegistry);
  const bodyCodec = createEventBodyCodec();
  const reactorRef: { current?: ReturnType<typeof createLifecycleReactor> } = {};
  const coordinatorCommit: CommitEventsFn = (cb) => {
    const appended = commit(db, cb, {
      now: () => new Date(runtime.time.now()),
      reducers,
      bodyCodec,
      providers: permissiveProviderLookupPort,
    });
    reactorRef.current?.observe(appended);
    return appended;
  };
  const reactor = createLifecycleReactor({
    db: () => db,
    readCtx: { schemas: reducers.schemas, bodyCodec },
    providers: providerRegistry,
    runtime,
    time: runtime.time,
    commitEvents: coordinatorCommit,
  });
  reactorRef.current = reactor;
  return {
    runtime,
    db,
    reactor,
    coordinatorCommit,
    discardCalls,
    sessionManager: new SessionManager('/tmp/project', runtime, coordinatorCommit, undefined, db),
  };
}

async function openClaimedSession(
  sessionManager: SessionManager,
  jobId: string,
): Promise<{ readonly sessionId: string; readonly version: number }> {
  const session = sessionManager.allocate({
    binding: TEST_CLAUDE_BINDING,
    name: 'claude-session',
    cwd: '/tmp/project',
    projectRoot: '/tmp/project',
    backendNamespace: 'test-ns',
    retention: 'discard_provider_artifacts_on_terminal',
  });
  await expect(sessionManager.claimForJobAtomic(session.sessionId, jobId, session.version)).resolves.toBe(true);
  const claimed = sessionManager.get('claude', session.sessionId);
  if (claimed === null) throw new Error('expected claimed session');
  return { sessionId: session.sessionId, version: claimed.version };
}

async function recordArtifact(sessionManager: SessionManager, sessionId: string, jobId: string): Promise<void> {
  const claimed = sessionManager.get('claude', sessionId);
  if (claimed === null) throw new Error('expected claimed session');
  await expect(
    sessionManager.recordArtifactHandleAtomic(sessionId, {
      expectedActiveJobId: jobId,
      expectedVersion: claimed.version,
      handle: `/tmp/${jobId}.jsonl`,
      identity: { kind: 'test-artifact', jobId },
      sourceJobId: jobId,
    }),
  ).resolves.toMatchObject({ ok: true });
}

function appendTerminal(commitEvents: CommitEventsFn, jobId: string, sessionId: string): void {
  commitEvents((c) => {
    appendJobTerminalRecorded(c, {
      jobId,
      sessionId,
      namespace: 'test-ns',
      project: '/tmp/project',
      terminal: { content: 'done', durationMs: 0, outcome: { kind: 'completed' } },
    });
    return undefined;
  });
}

describe('continuation lease retention integration', () => {
  it('keeps artifacts while stale-aborted session is resumed and discards after resumed release', async () => {
    const { runtime, db, sessionManager, reactor, coordinatorCommit, discardCalls } = createHarness();

    try {
      const session = await openClaimedSession(sessionManager, 'job-stale');
      await recordArtifact(sessionManager, session.sessionId, 'job-stale');
      sessionManager.recordContinuationLease({
        sessionId: session.sessionId,
        jobId: 'job-stale',
        workflowId: 'workflow-1',
        workflowSlotId: 'workflow-1:0:0',
        replacementGeneration: 1,
        reason: 'stale_recovery',
        expiresAt: new Date(runtime.time.now() + 60_000).toISOString(),
      });
      appendTerminal(coordinatorCommit, 'job-stale', session.sessionId);
      sessionManager.releaseJob(session.sessionId, 'job-stale');
      await reactor.waitForIdle();

      expect(discardCalls).toEqual([]);

      const afterStaleRelease = sessionManager.get('claude', session.sessionId);
      if (afterStaleRelease === null) throw new Error('expected released session');
      const claimedEntries: ProviderSession[] = [];
      coordinatorCommit((c) => {
        claimedEntries.push(
          sessionManager.appendContinuationReplacementClaim(c, {
            sessionId: session.sessionId,
            staleJobId: 'job-stale',
            resumedJobId: 'job-resumed',
            workflowId: 'workflow-1',
            workflowSlotId: 'workflow-1:0:0',
            replacementGeneration: 1,
            expectedVersion: afterStaleRelease.version,
          }),
        );
        return undefined;
      });
      const claimedEntry = claimedEntries[0];
      if (claimedEntry === undefined) throw new Error('expected committed replacement claim');
      sessionManager.observeCommittedEntry(claimedEntry);
      coordinatorCommit((c) => {
        appendJobTerminalRecorded(c, {
          jobId: 'job-resumed',
          sessionId: session.sessionId,
          namespace: 'test-ns',
          project: '/tmp/project',
          terminal: { content: 'done', durationMs: 0, outcome: { kind: 'completed' } },
        });
        return undefined;
      });
      sessionManager.releaseJob(session.sessionId, 'job-resumed');
      await reactor.waitForIdle();

      expect(discardCalls).toEqual([['/tmp/job-stale.jsonl']]);
    } finally {
      reactor.dispose();
      db.close();
    }
  });

  it('becomes discard eligible after a rejected resume clears the lease', async () => {
    const { runtime, db, sessionManager, reactor, coordinatorCommit, discardCalls } = createHarness();

    try {
      const session = await openClaimedSession(sessionManager, 'job-rejected-resume');
      await recordArtifact(sessionManager, session.sessionId, 'job-rejected-resume');
      sessionManager.recordContinuationLease({
        sessionId: session.sessionId,
        jobId: 'job-rejected-resume',
        workflowId: 'workflow-1',
        workflowSlotId: 'workflow-1:0:0',
        replacementGeneration: 1,
        reason: 'stale_recovery',
        expiresAt: new Date(runtime.time.now() + 60_000).toISOString(),
      });
      appendTerminal(coordinatorCommit, 'job-rejected-resume', session.sessionId);
      sessionManager.releaseJob(session.sessionId, 'job-rejected-resume');
      await reactor.waitForIdle();
      expect(discardCalls).toEqual([]);

      await expect(
        sessionManager.clearContinuationLease({
          sessionId: session.sessionId,
          jobId: 'job-rejected-resume',
          outcome: 'resume_rejected',
        }),
      ).resolves.toBe(true);

      await reactor.waitForIdle();
      expect(discardCalls).toEqual([['/tmp/job-rejected-resume.jsonl']]);
    } finally {
      reactor.dispose();
      db.close();
    }
  });

  it('becomes discard eligible after a launch failure clears a claimed lease', async () => {
    const { runtime, db, sessionManager, reactor, coordinatorCommit, discardCalls } = createHarness();

    try {
      const session = await openClaimedSession(sessionManager, 'job-launch-failure-stale');
      await recordArtifact(sessionManager, session.sessionId, 'job-launch-failure-stale');
      sessionManager.recordContinuationLease({
        sessionId: session.sessionId,
        jobId: 'job-launch-failure-stale',
        workflowId: 'workflow-1',
        workflowSlotId: 'workflow-1:0:0',
        replacementGeneration: 1,
        reason: 'stale_recovery',
        expiresAt: new Date(runtime.time.now() + 60_000).toISOString(),
      });
      appendTerminal(coordinatorCommit, 'job-launch-failure-stale', session.sessionId);
      sessionManager.releaseJob(session.sessionId, 'job-launch-failure-stale');
      await reactor.waitForIdle();
      expect(discardCalls).toEqual([]);

      const afterStaleRelease = sessionManager.get('claude', session.sessionId);
      if (afterStaleRelease === null) throw new Error('expected released session');
      const claimedEntries: ProviderSession[] = [];
      coordinatorCommit((c) => {
        claimedEntries.push(
          sessionManager.appendContinuationReplacementClaim(c, {
            sessionId: session.sessionId,
            staleJobId: 'job-launch-failure-stale',
            resumedJobId: 'job-launch-failed-resume',
            workflowId: 'workflow-1',
            workflowSlotId: 'workflow-1:0:0',
            replacementGeneration: 1,
            expectedVersion: afterStaleRelease.version,
          }),
        );
        return undefined;
      });
      const claimedEntry = claimedEntries[0];
      if (claimedEntry === undefined) throw new Error('expected committed replacement claim');
      sessionManager.observeCommittedEntry(claimedEntry);
      await expect(
        sessionManager.clearContinuationLease({
          sessionId: session.sessionId,
          jobId: 'job-launch-failed-resume',
          outcome: 'launch_failed',
        }),
      ).resolves.toBe(true);
      await reactor.waitForIdle();
      expect(discardCalls).toEqual([]);

      sessionManager.releaseJob(session.sessionId, 'job-launch-failed-resume');
      await reactor.waitForIdle();
      expect(discardCalls).toEqual([['/tmp/job-launch-failure-stale.jsonl']]);
    } finally {
      reactor.dispose();
      db.close();
    }
  });
});

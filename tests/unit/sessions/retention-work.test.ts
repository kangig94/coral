import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { TypedEventBus } from '#src/coordinator/event-bus.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { JobStore } from '#src/jobs/store.js';
import { managed } from '#src/providers/capability.js';
import {
  type DiscardOutcome,
  type ProviderArtifactDiscardReconciliation,
  type ProviderManagedArtifactCapability,
  ProviderArtifactProtocolInvariantError,
} from '#src/providers/contract.js';
import { defineProvider, ProviderRegistry } from '#src/providers/registry.js';
import type { ProviderSession } from '#src/sessions/entry.js';
import { createLifecycleReactor } from '#src/sessions/lifecycle-reactor.js';
import {
  archiveProviderArtifactsForJob,
  deriveProviderArtifactActionDescriptor,
  ProviderArtifactArchiveInvariantError,
  type ProviderArtifactActionDescriptor,
} from '#src/sessions/provider-artifact-archive.js';
import { readProjectionProviderSession } from '#src/sessions/projections.js';
import {
  RETENTION_ATTEMPT_OBLIGATION,
  sessionRetentionWorkKey,
  type RecoverySessionRetentionWork,
  type RetentionDiscardContinuation,
} from '#src/sessions/retention-work.js';
import { sessionsRegistry } from '#src/sessions/events.js';
import { SessionManager } from '#src/sessions/shell.js';
import { commit, type CommitEventsFn } from '#src/store/append.js';
import type { Database } from '#src/store/db.js';
import { decodeEventBody } from '#src/store/body-codec.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { composeReducers } from '#src/store/reducers.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { commitJobTerminal } from '#tests/helpers/job-commits.js';
import { fixtureProviderBindingCodec, type FixtureProviderAccess } from '#tests/helpers/provider-binding.js';
import { TEST_CODEX_BINDING } from '#tests/helpers/provider-credentials.js';
import { prepareFixtureExecutionPlan, type FixtureExecutionPlan } from '#tests/helpers/scripted-provider.js';
import { initTestJob } from '#tests/helpers/session.js';
import { openTestStoreDb } from '#tests/helpers/store-db.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';

const NOW = '2026-06-11T00:00:00.000Z';
const openDbs = new Set<Database>();

afterEach(() => {
  for (const db of openDbs) db.close();
  openDbs.clear();
});

type ArtifactActionOptions = Parameters<
  ProviderManagedArtifactCapability<FixtureProviderAccess>['discardArtifacts']
>[0];

type ArtifactActionCall = {
  readonly kind: 'discard' | 'reconcile';
  readonly actionId: string;
  readonly payloadHash: string;
};

type SettlementHarness = {
  readonly runtime: SimulationRuntime;
  readonly db: Database;
  readonly namespace: string;
  readonly projectRoot: string;
  readonly progressStore: JobStore;
  readonly sessionManager: SessionManager;
  readonly commitEvents: CommitEventsFn;
  readonly capabilityCalls: ArtifactActionCall[];
  readonly providerEffects: ArtifactActionOptions[];
  readonly logs: string[];
  readonly signal: AbortSignal;
  reactor: ReturnType<typeof createLifecycleReactor>;
  restart(): ReturnType<typeof createLifecycleReactor>;
};

function createArtifactRuntime(): SimulationRuntime {
  const runtime = new SimulationRuntime();
  vi.spyOn(runtime.time, 'sleep').mockImplementation(async (ms) => {
    runtime.time.tick(ms);
  });
  return runtime;
}

function createSettlementHarness(
  options: {
    discardArtifacts?: (input: ArtifactActionOptions) => Promise<DiscardOutcome>;
    reconcileDiscard?: (input: ArtifactActionOptions) => Promise<ProviderArtifactDiscardReconciliation>;
  } = {},
): SettlementHarness {
  const runtime = createArtifactRuntime();
  const db = openTestStoreDb(runtime, ':memory:');
  openDbs.add(db);
  const namespace = 'retention-settlement-ns';
  const projectRoot = '/workspace/retention-settlement';
  const providerRegistry = new ProviderRegistry();
  const capabilityCalls: ArtifactActionCall[] = [];
  const providerEffects: ArtifactActionOptions[] = [];
  const rawCapability = managed<FixtureProviderAccess>({
    discardArtifacts: async (input) => {
      providerEffects.push(input);
      return options.discardArtifacts?.(input) ?? { kind: 'discarded' };
    },
    ...(options.reconcileDiscard === undefined
      ? {}
      : { reconcileDiscard: (input: ArtifactActionOptions) => options.reconcileDiscard!(input) }),
  });
  const capability: ProviderManagedArtifactCapability<FixtureProviderAccess> = {
    ...rawCapability,
    discardArtifacts: async (input) => {
      capabilityCalls.push({ kind: 'discard', actionId: input.actionId, payloadHash: input.payloadHash });
      return rawCapability.discardArtifacts(input);
    },
    reconcileDiscard: async (input) => {
      capabilityCalls.push({ kind: 'reconcile', actionId: input.actionId, payloadHash: input.payloadHash });
      return rawCapability.reconcileDiscard(input);
    },
  };
  providerRegistry.register(
    defineProvider<FixtureExecutionPlan, FixtureProviderAccess>({
      name: 'codex',
      transport: 'standalone',
      run: async function* () {},
      prepareExecutionPlan: prepareFixtureExecutionPlan,
    })
      .binding(fixtureProviderBindingCodec('codex'))
      .artifacts(capability)
      .build(),
  );

  const reducers = composeReducers(jobsRegistry, sessionsRegistry);
  const bodyCodec = createEventBodyCodec();
  const logs: string[] = [];
  const signal = new AbortController().signal;
  const commitEvents: CommitEventsFn = (callback) =>
    commit(db, callback, {
      now: () => new Date(runtime.time.now()),
      reducers,
      bodyCodec,
      providers: permissiveProviderLookupPort,
    });
  const createReactor = () =>
    createLifecycleReactor({
      db: () => db,
      readCtx: { schemas: reducers.schemas, streamKinds: reducers.streamKinds, bodyCodec },
      providers: providerRegistry,
      runtime,
      time: runtime.time,
      commitEvents,
      signal,
      log: (message) => logs.push(message),
    });
  const harness: SettlementHarness = {
    runtime,
    db,
    namespace,
    projectRoot,
    progressStore: new JobStore(namespace, runtime, bodyCodec, {
      db,
      eventBus: new TypedEventBus(),
      reducers,
      providers: permissiveProviderLookupPort,
    }),
    sessionManager: new SessionManager(projectRoot, runtime, commitEvents, undefined, db),
    commitEvents,
    capabilityCalls,
    providerEffects,
    logs,
    signal,
    reactor: createReactor(),
    restart: () => {
      harness.reactor = createReactor();
      return harness.reactor;
    },
  };
  return harness;
}

async function seedRetentionWork(
  harness: SettlementHarness,
  options: {
    jobId: string;
    handle: string;
    retention?: 'retain' | 'discard_provider_artifacts_on_terminal';
    nativeContent?: string;
  },
): Promise<{ sessionId: string; entry: ProviderSession }> {
  if (options.nativeContent !== undefined) {
    harness.runtime.storage.mkdirSync(join(options.handle, '..'), { recursive: true });
    harness.runtime.storage.writeFileSync(options.handle, options.nativeContent, { encoding: 'utf-8' });
  }
  const allocated = harness.sessionManager.allocate({
    binding: TEST_CODEX_BINDING,
    name: `session-${options.jobId}`,
    cwd: harness.projectRoot,
    projectRoot: harness.projectRoot,
    backendNamespace: harness.namespace,
    retention: options.retention ?? 'discard_provider_artifacts_on_terminal',
  });
  await expect(
    harness.sessionManager.claimForJobAtomic(allocated.sessionId, options.jobId, allocated.version),
  ).resolves.toBe(true);
  const claimed = harness.sessionManager.get('codex', allocated.sessionId);
  if (claimed === null) throw new Error(`Expected claimed session ${allocated.sessionId}.`);
  await expect(
    harness.sessionManager.recordArtifactHandleAtomic(allocated.sessionId, {
      expectedActiveJobId: options.jobId,
      expectedVersion: claimed.version,
      handle: options.handle,
      identity: { kind: 'test-artifact', handle: options.handle },
      sourceJobId: options.jobId,
    }),
  ).resolves.toMatchObject({ ok: true });
  initTestJob(harness.progressStore, {
    jobId: options.jobId,
    sessionId: allocated.sessionId,
    provider: 'codex',
    projectRoot: harness.projectRoot,
    backendNamespace: harness.namespace,
    initialPhase: 'running',
    jobKind: 'provider',
  });
  commitJobTerminal(harness.progressStore, options.jobId, allocated.sessionId, {
    content: 'done',
    durationMs: 0,
    outcome: { kind: 'completed' },
  });
  harness.sessionManager.releaseJob(allocated.sessionId, options.jobId);
  const entry = readProjectionProviderSession(harness.db, allocated.sessionId);
  if (entry === null) throw new Error(`Expected released session ${allocated.sessionId}.`);
  return { sessionId: allocated.sessionId, entry };
}

type RetentionEventBody = {
  readonly sessionId: string;
  readonly attempt: number;
  readonly handles: readonly string[];
  readonly outcome?: string;
};

function readRetentionEvents(
  harness: SettlementHarness,
  sessionId: string,
): Array<{ type: string; body: RetentionEventBody }> {
  const rows = harness.db
    .prepare(
      `SELECT type, body
         FROM events
        WHERE stream_kind = 'session'
          AND stream_id = ?
          AND type IN (
            'session.retention.discard.requested',
            'session.retention.discard.completed',
            'session.retention.discard.failed'
          )
        ORDER BY seq ASC`,
    )
    .all(sessionId) as Array<{ type: string; body: Buffer }>;
  return rows.map((row) => ({ type: row.type, body: decodeEventBody(row.body) as RetentionEventBody }));
}

function readContinuation(harness: SettlementHarness, sessionId: string, jobId: string): RetentionDiscardContinuation {
  const row = harness.db
    .prepare(
      `SELECT continuation_key
         FROM recovery_quarantine
        WHERE boundary_id = 'session-retention-work'
          AND subject_key = ?`,
    )
    .get(sessionRetentionWorkKey(sessionId, jobId)) as { continuation_key: string } | undefined;
  if (row === undefined) throw new Error(`Expected retention continuation for ${sessionId}/${jobId}.`);
  return JSON.parse(row.continuation_key) as RetentionDiscardContinuation;
}

type ArchiveManifestFixture = {
  readonly archiveActionId: string;
  readonly archivedAt: string;
  readonly artifacts: Array<{
    readonly status: 'archived' | 'missing' | 'failed';
    readonly archivePath?: string;
    readonly sourceSha256?: string;
    readonly archiveSha256?: string;
  }>;
};

function manifestPath(runtime: SimulationRuntime, descriptor: ProviderArtifactActionDescriptor): string {
  return join(
    runtime.paths.coral.exports.jobsRoot,
    descriptor.jobId,
    'provider-artifacts',
    descriptor.provider,
    'actions',
    descriptor.archiveActionId,
    'manifest.json',
  );
}

function readManifest(
  runtime: SimulationRuntime,
  descriptor: ProviderArtifactActionDescriptor,
): ArchiveManifestFixture {
  return JSON.parse(runtime.storage.readFileSync(manifestPath(runtime, descriptor), 'utf-8')) as ArchiveManifestFixture;
}

function actionRecordPath(runtime: SimulationRuntime, actionId: string): string {
  const file = createHash('sha256').update(actionId, 'utf-8').digest('hex');
  return join(runtime.paths.coral.exports.jobsRoot, '.provider-artifact-discard', `${file}.json`);
}

function recoveryWork(
  entry: ProviderSession,
  jobId: string,
  sourceRevision: string,
  descriptor: ProviderArtifactActionDescriptor,
): RecoverySessionRetentionWork {
  const terminalCauseRef = { stream: { kind: 'job' as const, id: jobId }, seq: 1 };
  const continuation: RetentionDiscardContinuation = {
    v: 1,
    sessionId: entry.sessionId,
    jobId,
    sourceRevision,
    attempt: 1,
    handles: descriptor.handles.map(({ handle }) => handle),
    descriptor,
    terminalCauseRef,
    completedObligationIds: [RETENTION_ATTEMPT_OBLIGATION],
    stage: 'requested',
  };
  return {
    sessionId: entry.sessionId,
    jobId,
    entry,
    recovery: {
      subject: {
        key: sessionRetentionWorkKey(entry.sessionId, jobId),
        revision: { kind: 'fingerprint', value: sourceRevision },
      },
      sourceRevision,
      terminalCauseRef,
      archivedAt: descriptor.archivedAt,
      continuation,
    },
  };
}

describe('sessions retention-work', () => {
  it('rejects a corrupted foreign archive before provider discard without downgrading its record', async () => {
    const harness = createSettlementHarness();
    const jobId = 'job-corrupted-foreign-archive';
    const handle = '/tmp/provider/corrupted-foreign-archive.jsonl';
    const { entry } = await seedRetentionWork(harness, {
      jobId,
      handle,
      nativeContent: 'foreign archive\n',
    });
    const foreign = deriveProviderArtifactActionDescriptor({
      entry,
      jobId,
      handles: [handle],
      sourceRevision: 'foreign-archive-revision-a',
      archivedAt: NOW,
    });
    await archiveProviderArtifactsForJob({ runtime: harness.runtime, descriptor: foreign });
    const foreignRecord = readManifest(harness.runtime, foreign).artifacts[0];
    if (foreignRecord?.archivePath === undefined) throw new Error('Expected archived fixture path.');
    harness.runtime.storage.writeFileSync(foreignRecord.archivePath, 'corrupted archive\n', { encoding: 'utf-8' });
    harness.runtime.storage.unlinkSync(handle);

    const adopting = deriveProviderArtifactActionDescriptor({
      entry,
      jobId,
      handles: [handle],
      sourceRevision: 'foreign-archive-revision-b',
      archivedAt: '2026-06-11T00:00:01.000Z',
    });

    await expect(
      harness.reactor.enforceRetention(recoveryWork(entry, jobId, 'foreign-archive-revision-b', adopting)),
    ).rejects.toBeInstanceOf(ProviderArtifactArchiveInvariantError);
    expect(harness.capabilityCalls).toEqual([]);
    expect(harness.providerEffects).toEqual([]);
    expect(readManifest(harness.runtime, foreign).artifacts[0]).toEqual(foreignRecord);
  });

  it('restarts after archive publication with the exact action ids and stable archivedAt', async () => {
    let discardFails = true;
    let reconciliation: ProviderArtifactDiscardReconciliation = { kind: 'unknown' };
    const harness = createSettlementHarness({
      discardArtifacts: async (input) => {
        if (discardFails) throw new Error('fixture crash after archive publication');
        for (const handle of input.handles) input.runtime.storage.unlinkSync(handle);
        return { kind: 'discarded' };
      },
      reconcileDiscard: async () => reconciliation,
    });
    const jobId = 'job-crash-after-archive';
    const handle = '/tmp/provider/crash-after-archive.jsonl';
    const { sessionId } = await seedRetentionWork(harness, {
      jobId,
      handle,
      nativeContent: 'archive published\n',
    });

    await harness.reactor.scanStartup(harness.signal);
    const continuation = readContinuation(harness, sessionId, jobId);
    const publishedManifest = readManifest(harness.runtime, continuation.descriptor);
    expect(continuation.stage).toBe('discard-pending');
    expect(readRetentionEvents(harness, sessionId).map(({ type }) => type)).toEqual([
      'session.retention.discard.requested',
    ]);

    discardFails = false;
    reconciliation = { kind: 'not-applied' };
    const callsBeforeRestart = harness.capabilityCalls.length;
    harness.restart();
    await harness.reactor.scanStartup(harness.signal);
    const retryCalls = harness.capabilityCalls.slice(callsBeforeRestart);
    const retriedManifest = readManifest(harness.runtime, continuation.descriptor);

    expect(retryCalls.map(({ kind }) => kind)).toEqual(['reconcile', 'discard']);
    expect(retryCalls.every(({ actionId }) => actionId === continuation.descriptor.discardActionId)).toBe(true);
    expect(retriedManifest.archiveActionId).toBe(continuation.descriptor.archiveActionId);
    expect(retriedManifest.archivedAt).toBe(continuation.descriptor.archivedAt);
    expect(retriedManifest).toEqual(publishedManifest);
    expect(readRetentionEvents(harness, sessionId).map(({ type }) => type)).toEqual([
      'session.retention.discard.requested',
      'session.retention.discard.completed',
    ]);
  });

  it('reconciles after native discard before replay and does not double-discard', async () => {
    const harness = createSettlementHarness({
      discardArtifacts: async (input) => {
        for (const handle of input.handles) input.runtime.storage.unlinkSync(handle);
        return { kind: 'discarded' };
      },
    });
    const jobId = 'job-crash-after-native-discard';
    const handle = '/tmp/provider/crash-after-native-discard.jsonl';
    const { sessionId, entry } = await seedRetentionWork(harness, {
      jobId,
      handle,
      nativeContent: 'native discard crash\n',
    });
    harness.db.exec(`
      CREATE TRIGGER crash_after_native_discard
      BEFORE UPDATE ON recovery_quarantine
      WHEN NEW.boundary_id = 'session-retention-work'
       AND json_extract(NEW.continuation_key, '$.stage') = 'discard-applied'
      BEGIN
        SELECT RAISE(ABORT, 'fixture crash before applied continuation checkpoint');
      END;
    `);

    await expect(harness.reactor.enforceRetention({ sessionId, jobId, entry })).rejects.toThrow(
      'fixture crash before applied continuation checkpoint',
    );
    expect(harness.runtime.storage.existsSync(handle)).toBe(false);
    expect(harness.providerEffects).toHaveLength(1);
    expect(readContinuation(harness, sessionId, jobId).stage).toBe('discard-pending');

    harness.db.exec('DROP TRIGGER crash_after_native_discard');
    const callsBeforeRestart = harness.capabilityCalls.length;
    harness.restart();
    await harness.reactor.scanStartup(harness.signal);

    expect(harness.capabilityCalls.slice(callsBeforeRestart).map(({ kind }) => kind)).toEqual(['reconcile']);
    expect(harness.providerEffects).toHaveLength(1);
    expect(readRetentionEvents(harness, sessionId).map(({ type }) => type)).toEqual([
      'session.retention.discard.requested',
      'session.retention.discard.completed',
    ]);
  });

  it('fails closed on a verified archive hash conflict before provider effect', async () => {
    const harness = createSettlementHarness();
    const jobId = 'job-verified-archive-conflict';
    const handle = '/tmp/provider/verified-archive-conflict.jsonl';
    const { entry } = await seedRetentionWork(harness, {
      jobId,
      handle,
      nativeContent: 'verified archive\n',
    });
    const sourceRevision = 'verified-archive-conflict-revision';
    const descriptor = deriveProviderArtifactActionDescriptor({
      entry,
      jobId,
      handles: [handle],
      sourceRevision,
      archivedAt: NOW,
    });
    await archiveProviderArtifactsForJob({ runtime: harness.runtime, descriptor });
    const archivedPath = readManifest(harness.runtime, descriptor).artifacts[0]?.archivePath;
    if (archivedPath === undefined) throw new Error('Expected archived fixture path.');
    harness.runtime.storage.writeFileSync(archivedPath, 'tampered archive\n', { encoding: 'utf-8' });

    await expect(
      harness.reactor.enforceRetention(recoveryWork(entry, jobId, sourceRevision, descriptor)),
    ).rejects.toBeInstanceOf(ProviderArtifactArchiveInvariantError);
    expect(harness.capabilityCalls).toEqual([]);
    expect(harness.providerEffects).toEqual([]);
  });

  it('rejects a changed provider payload under one action id before another provider effect', async () => {
    const harness = createSettlementHarness();
    const jobId = 'job-provider-action-conflict';
    const handle = '/tmp/provider/provider-action-conflict.jsonl';
    const { sessionId } = await seedRetentionWork(harness, {
      jobId,
      handle,
      retention: 'retain',
      nativeContent: 'provider action conflict\n',
    });
    await harness.reactor.discardSessionArtifacts(sessionId);
    const actionId = harness.capabilityCalls.find(({ kind }) => kind === 'discard')?.actionId;
    if (actionId === undefined) throw new Error('Expected provider discard action.');
    const recordPath = actionRecordPath(harness.runtime, actionId);
    const record = JSON.parse(harness.runtime.storage.readFileSync(recordPath, 'utf-8')) as Record<string, unknown>;
    harness.runtime.storage.writeFileSync(recordPath, `${JSON.stringify({ ...record, payloadHash: 'conflict' })}\n`, {
      encoding: 'utf-8',
    });

    await expect(harness.reactor.discardSessionArtifacts(sessionId)).rejects.toBeInstanceOf(
      ProviderArtifactProtocolInvariantError,
    );
    expect(harness.providerEffects).toHaveLength(1);
  });
});

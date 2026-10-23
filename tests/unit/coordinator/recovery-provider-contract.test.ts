import { executionHarness, openedJob, requestedExecution } from '#tests/helpers/job-executions.js';
import { ExecutionFinisher, readExecutionFinishingState } from '#src/jobs/finishing.js';
import { testJobConversation } from '#tests/helpers/session.js';
import { TEST_CODEX_BINDING } from '#tests/helpers/provider-credentials.js';
import { JobStore } from '#src/jobs/store.js';
import { ConversationManager } from '#src/jobs/conversation/shell.js';
import { AbortRegistry } from '#src/jobs/shell/abort-registry.js';
import type { ProcessIncarnation, ProcessLiveness } from '#src/infra/node-process.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import {
  planInterruptedAppServerRecovery,
  planInterruptedDurableRecovery,
  type ProviderOperationCarrierRecord,
} from '#src/coordinator/services/recovery/interrupted-plan.js';
import {
  performInterruptedAppServerRecovery,
  performInterruptedDurableRecovery,
  reapProviderOperationCarrier,
} from '#src/coordinator/services/recovery/interrupted-performer.js';
import type { AppServerRuntime, JobLaunch } from '#src/jobs/records.js';
import type { ProviderRecoveryAuthority } from '#src/jobs/reconcile/contracts.js';
import { createMonotonicClock } from '#src/infra/monotonic-clock.js';
import { ProcessContainmentError } from '#src/infra/process-containment.js';
import type {
  BoundProvider,
  BoundProviderAppServerCapability,
  BoundProviderRecovery,
} from '#src/providers/bound-provider-contract.js';
import type { HostRef } from '#src/providers/contract.js';
import type { JobConversation } from '#src/jobs/conversation/entry.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { bindingSuccess } from '#src/providers/contracts/binding.js';
import { validatedTestContinuityBlob } from '#tests/helpers/session.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { openTestStoreDb } from '#tests/helpers/store-db.js';
import {
  finalizeInterruptedDurableRecovery,
  RecoveryOwnershipReleaseError,
} from '#src/coordinator/services/recovery/interrupted-finalizer.js';
import { LaunchCoordinator } from '#src/coordinator/live/admission.js';
import { insertProviderOperation, readProviderOperation } from '#src/store/provider-operation-journal.js';

import { providerOperationRecord } from '../store/provider-operation-fixtures.js';

const TEST_PROJECT = mkdtempSync(join(tmpdir(), 'coral-recovery-provider-contract-'));

afterAll(() => rmSync(TEST_PROJECT, { recursive: true, force: true }));

const launchRecord = {
  jobId: 'ed778316-48fd-50c8-90a1-ce885a4b6f2c',
  owner: { kind: 'provider-session', id: 'ed778316-48fd-50c8-90a1-ce885a4b6f2c' },
  execution: 1,
  provider: 'fixture',
  projectRoot: TEST_PROJECT,
  backendNamespace: 'namespace',
  jobKind: 'provider',
  pool: 'default',
  enqueueSequence: 1,
  providerAction: 'exec',
  request: { prompt: 'test', cwd: TEST_PROJECT, bypassPermissions: false, coralEnv: {} },
  createdAt: '2026-07-22T00:00:00.000Z',
} as const satisfies JobLaunch;

const persistedHostRef = {
  provider: 'fixture',
  fingerprint: '0'.repeat(64),
  instanceId: 'instance-1',
  leaseMode: 'shared',
} as const satisfies HostRef;

const waitingRuntime = {
  transport: 'app-server',
  startTime: '2026-07-22T00:00:00.000Z',
  providerMeta: { provider: 'fixture', leaseState: 'waiting' },
} as const satisfies AppServerRuntime;

const acquiredRuntime = {
  ...waitingRuntime,
  providerMeta: { ...waitingRuntime.providerMeta, leaseState: 'acquired', hostRef: persistedHostRef },
} as const satisfies AppServerRuntime;

const durableRuntime = {
  transport: 'durable-cli',
  pid: 42,
  stdoutPath: '/jobs/job-recovery-contract/stdout',
  stderrPath: '/jobs/job-recovery-contract/stderr',
  startTime: '2026-07-22T00:00:00.000Z',
} as const;

const session = testJobConversation(launchRecord.jobId, {
  provider: 'fixture',
  binding: { ...TEST_CODEX_BINDING, provider: 'fixture' },
  execution: 1,
  open: true,
  projectRoot: TEST_PROJECT,
  cwd: fixtureCanonicalWorkDir(TEST_PROJECT),
  providerContinuity: validatedTestContinuityBlob({ checkpoint: 'persisted' }),
});

const providerOperationCarrier = providerOperationRecord('executing') as ProviderOperationCarrierRecord;

function recovery(): BoundProviderRecovery {
  return {
    finalizeInterrupted: (result: { resumable: boolean }) =>
      result.resumable ? { kind: 'preserve' } : { kind: 'clear_non_resumable' },
    finalizeFromArtifacts: vi.fn(),
  } as unknown as BoundProviderRecovery;
}

function serviceWithCapability(appServer: BoundProviderAppServerCapability, boundRecovery = recovery()) {
  const bound = {
    name: 'fixture',
    appServer,
    recovery: boundRecovery,
  } as unknown as BoundProvider;
  const reapCarrier = vi.fn(async () => {});
  return {
    reapCarrier,
    decide: (
      runtimeRecord: AppServerRuntime,
      nextSession: JobConversation = session,
      providerOperation: ProviderOperationCarrierRecord | null = null,
    ) => {
      const authority = {
        launchRecord,
        session: nextSession,
        boundProvider: bound,
      } as unknown as ProviderRecoveryAuthority;
      const plan = planInterruptedAppServerRecovery(
        authority,
        runtimeRecord,
        'restart',
        {
          recovery: bound.recovery !== undefined,
        },
        providerOperation,
      );
      return performInterruptedAppServerRecovery(plan, bound, {
        reapCarrier,
      });
    },
  };
}

function capability(): BoundProviderAppServerCapability {
  return {
    supportsInterrupt: false,
    send: vi.fn(async () => ({
      state: 'refused' as const,
      code: 'transport_unsupported' as const,
      reason: 'test refusal',
    })),
    openReplacement: vi.fn(),
    interrupt: vi.fn(async () => ({ kind: 'not-accepted' as const, reason: 'test refusal' })),
  };
}

describe('interrupted recovery planning', () => {
  const authority = {
    launchRecord,
    session,
    boundProvider: { name: 'fixture' },
  } as unknown as ProviderRecoveryAuthority;

  it('plans an interruption with the captured session version and persisted continuity', () => {
    const plan = planInterruptedAppServerRecovery(authority, acquiredRuntime, 'restart', { recovery: true }, null);
    expect(plan).toMatchObject({
      kind: 'interrupted',
      continuity: { checkpoint: 'persisted' },
    });
  });

  it('makes missing recovery capability an explicit unsupported plan', () => {
    expect(
      planInterruptedAppServerRecovery(authority, acquiredRuntime, 'handoff', { recovery: false }, null),
    ).toMatchObject({ kind: 'unsupported', reason: 'handoff' });
  });

  it('classifies a committed provider-operation carrier as detached', () => {
    const plan = planInterruptedAppServerRecovery(
      authority,
      acquiredRuntime,
      'restart',
      { recovery: true },
      providerOperationCarrier,
    );

    expect(plan).toMatchObject({
      kind: 'carrier-detached',
      carrier: providerOperationCarrier,
      continuity: { checkpoint: 'persisted' },
    });
  });

  it('plans an interruption when no provider-operation carrier is committed', () => {
    const plan = planInterruptedAppServerRecovery(authority, acquiredRuntime, 'restart', { recovery: true }, null);

    expect(plan).toMatchObject({ kind: 'interrupted' });
  });

  it.each([
    [
      'persisted terminal',
      {
        exit: { exitCode: 0, signal: null, endTime: '2026-07-22T00:01:00.000Z' },
        terminal: { content: 'done', durationMs: 1, outcome: { kind: 'completed' } },
        cancelled: true,
      },
      true,
      'durable-persisted',
    ],
    [
      'exit with recovery capability',
      { exit: { exitCode: 0, signal: null, endTime: '2026-07-22T00:01:00.000Z' }, terminal: null, cancelled: false },
      true,
      'durable-artifacts',
    ],
    [
      'exit without recovery capability',
      { exit: { exitCode: 1, signal: null, endTime: '2026-07-22T00:01:00.000Z' }, terminal: null, cancelled: false },
      false,
      'durable-unsupported',
    ],
    ['cancelled without exit', { exit: null, terminal: null, cancelled: true }, true, 'durable-aborted'],
    [
      'lost wrapper with recovery capability',
      { exit: null, terminal: null, cancelled: false },
      true,
      'durable-wrapper-lost',
    ],
    [
      'lost wrapper without recovery capability',
      { exit: null, terminal: null, cancelled: false },
      false,
      'durable-unsupported',
    ],
  ] as const)('plans %s deterministically', (_label, observation, hasRecovery, expectedKind) => {
    expect(
      planInterruptedDurableRecovery(authority, durableRuntime, observation, { recovery: hasRecovery }),
    ).toMatchObject({ kind: expectedKind, launchRecord: expect.objectContaining({ execution: 1 }) });
  });

  it('routes durable exit evidence to provider artifact interpretation', async () => {
    const finalizeFromArtifacts = vi.fn<BoundProviderRecovery['finalizeFromArtifacts']>(async () => ({
      terminal: {
        kind: 'terminal' as const,
        terminal: { content: 'recovered', durationMs: 60_000, outcome: { kind: 'completed' as const } },
        diagnostics: {},
      },
      continuity: {
        conversationRef: 'thread-recovered',
        resumable: true,
        providerContinuity: { threadId: 'thread-recovered' },
      },
      artifactHandles: [
        {
          handle: '/provider/thread-recovered.jsonl',
          identity: { kind: 'fixture', threadId: 'thread-recovered' },
        },
      ],
    }));
    const boundProvider = {
      name: 'fixture',
      decodeContinuity: (raw: unknown) => bindingSuccess(validatedTestContinuityBlob(raw as Record<string, unknown>)),
      recovery: {
        finalizeFromArtifacts,
      },
    } as unknown as BoundProvider;
    const plan = planInterruptedDurableRecovery(
      { ...authority, boundProvider },
      durableRuntime,
      {
        exit: { exitCode: 0, signal: null, endTime: '2026-07-22T00:01:00.000Z' },
        terminal: null,
        cancelled: false,
      },
      { recovery: true },
    );
    const runtime = new SimulationRuntime();

    await expect(
      performInterruptedDurableRecovery(plan, boundProvider, {
        time: runtime.time,
        storage: runtime.storage,
      }),
    ).resolves.toMatchObject({
      kind: 'durable-resolved',
      terminal: { kind: 'provider' },
      mutation: {
        kind: 'set_resumable',
        conversationRef: 'thread-recovered',
        providerContinuity: { threadId: 'thread-recovered' },
      },
      artifactHandles: [{ handle: '/provider/thread-recovered.jsonl' }],
    });
    expect(finalizeFromArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({
        stdoutPath: durableRuntime.stdoutPath,
        stderrPath: durableRuntime.stderrPath,
        fallbackConversationRef: undefined,
        storage: runtime.storage,
      }),
    );
    expect(finalizeFromArtifacts.mock.calls[0]?.[0]).not.toHaveProperty('source');
  });
});

describe('interrupted provider recovery', () => {
  it('finalizes waiting work without attaching or minting credentials', async () => {
    const appServer = capability();
    const boundRecovery = recovery();
    await expect(
      serviceWithCapability(appServer, boundRecovery).decide(waitingRuntime, {
        ...session,
        providerContinuity: null,
      } as JobConversation),
    ).resolves.toMatchObject({ kind: 'resolved', mutation: { kind: 'clear_non_resumable' } });
    expect(appServer.openReplacement).not.toHaveBeenCalled();
    expect(boundRecovery.finalizeFromArtifacts).not.toHaveBeenCalled();
  });

  it('preserves acquired work without provider I/O', async () => {
    const appServer = capability();
    const boundRecovery = recovery();
    const fixture = serviceWithCapability(appServer, boundRecovery);

    await expect(fixture.decide(acquiredRuntime)).resolves.toMatchObject({
      kind: 'resolved',
      mutation: { kind: 'preserve' },
    });
    expect(appServer.openReplacement).not.toHaveBeenCalled();
    expect(boundRecovery.finalizeFromArtifacts).not.toHaveBeenCalled();
    expect(fixture.reapCarrier).not.toHaveBeenCalled();
  });

  it('confirms the carrier and finalizes without provider I/O when a saga carrier exists', async () => {
    const appServer = capability();
    const boundRecovery = recovery();
    const fixture = serviceWithCapability(appServer, boundRecovery);

    await expect(fixture.decide(acquiredRuntime, session, providerOperationCarrier)).resolves.toMatchObject({
      kind: 'resolved',
      mutation: { kind: 'preserve' },
    });

    expect(fixture.reapCarrier).toHaveBeenCalledTimes(1);
    expect(fixture.reapCarrier).toHaveBeenCalledWith(providerOperationCarrier);
    expect(appServer.openReplacement).not.toHaveBeenCalled();
    expect(boundRecovery.finalizeFromArtifacts).not.toHaveBeenCalled();
  });

  it('leaves the session unfinalized when the carrier reap cannot confirm absence', async () => {
    const finalizeInterrupted = vi.fn();
    const boundRecovery = {
      finalizeInterrupted,
      finalizeFromArtifacts: vi.fn(),
    } as unknown as BoundProviderRecovery;
    const fixture = serviceWithCapability(capability(), boundRecovery);
    fixture.reapCarrier.mockRejectedValueOnce(
      new ProcessContainmentError('process_containment_reap_failed', 'absence not confirmed'),
    );

    await expect(fixture.decide(acquiredRuntime, session, providerOperationCarrier)).rejects.toBeInstanceOf(
      ProcessContainmentError,
    );
    expect(finalizeInterrupted).not.toHaveBeenCalled();
  });
});

describe('interrupted recovery settlement ownership', () => {
  function finalizerFixture(options: { releaseError?: Error } = {}) {
    const runtime = new SimulationRuntime();
    const journal = executionHarness();
    const stream = { kind: 'job', id: launchRecord.jobId } as const;
    journal.append(
      {
        ...openedJob({
          owner: launchRecord.owner,
          projectRoot: TEST_PROJECT,
          conversation: {
            provider: session.provider,
            binding: session.binding,
            cwd: session.cwd,
            name: session.name,
            bypassPermissions: false,
            retention: 'retain',
          },
        }),
        stream,
      },
      { ...requestedExecution(1), stream },
    );
    const store = new JobStore('namespace', runtime, journal.ctx.bodyCodec, {
      db: journal.db,
      reducers: journal.ctx.reducers,
      providers: journal.ctx.providers,
    });
    const conversationManager = new ConversationManager(
      TEST_PROJECT,
      runtime,
      (write) => store.commit(write),
      journal.db,
    );
    const abortRegistry = new AbortRegistry();
    abortRegistry.register(launchRecord.jobId, 1);
    const remove = vi.spyOn(abortRegistry, 'remove');
    const releaseError = options.releaseError;
    if (releaseError !== undefined)
      remove.mockImplementation(() => {
        throw releaseError;
      });
    const launchCoordinator = new LaunchCoordinator({ runtime });
    const launchPermit = launchCoordinator.restoreActiveLaunch(
      launchRecord.jobId,
      launchRecord.provider,
      launchRecord.owner,
      launchRecord.pool,
    );
    const executionFinisher = new ExecutionFinisher({
      time: runtime.time,
      commit: (write) => store.commit(write),
      read: (address) => readExecutionFinishingState(journal.db, address, store),
      quiesce: async (address) =>
        !abortRegistry.has(address.jobId, address.execution) &&
        launchCoordinator.reservationFor(address.jobId) === null,
      retentionAction: async () => ({ attempt: 0, handles: [] }),
      settleRetention: async () => ({ kind: 'completed', outcome: 'skipped_no_handles' }),
    });
    const plan = planInterruptedDurableRecovery(
      { launchRecord, session, boundProvider: { name: 'fixture' } as BoundProvider },
      durableRuntime,
      { exit: { exitCode: 0, signal: null, endTime: '2026-07-22T00:01:00.000Z' }, terminal: null, cancelled: false },
      { recovery: true },
    );
    const performed = {
      kind: 'durable-resolved',
      terminal: { kind: 'direct', value: { content: 'recovered', durationMs: 60_000, outcome: { kind: 'completed' } } },
      mutation: { kind: 'preserve' },
      artifactHandles: [{ handle: '/derived/report', identity: { kind: 'fixture' }, sourceJobId: launchRecord.jobId }],
    } as const;
    const status = store.readStatus(launchRecord.jobId);
    if (status === null) throw new Error('Expected an open execution');
    return {
      journal,
      store,
      status,
      plan,
      performed,
      abortRegistry,
      remove,
      launchCoordinator,
      launchPermit,
      finish: async () => {
        runtime.time.tick(500);
        await executionFinisher.finish(launchRecord);
      },
      deps: {
        runtime,
        conversationManager,
        executionFinisher,
        abortRegistry,
        launchAdmission: launchCoordinator,
        launchPermit,
      },
    };
  }

  it('persists artifact handles before accepting the recovered outcome and releasing ownership', async () => {
    const fixture = finalizerFixture();
    try {
      await finalizeInterruptedDurableRecovery(fixture.plan, fixture.performed, fixture.status, fixture.deps);
      await fixture.finish();
      const effects = fixture.journal
        .events()
        .filter((event) =>
          ['job.artifact.recorded', 'job.execution.outcome.accepted', 'job.execution.ended'].includes(event.type),
        );
      expect(effects.map((event) => event.type)).toEqual([
        'job.artifact.recorded',
        'job.execution.outcome.accepted',
        'job.execution.ended',
      ]);
      expect(effects[0]?.body).toMatchObject({ execution: 1, handle: '/derived/report' });
      expect(fixture.remove).toHaveBeenCalledWith(launchRecord.jobId, 1);
      expect(fixture.launchPermit.reservationId).not.toBe('');
      expect(fixture.launchCoordinator.reservationFor(launchRecord.jobId)).toBeNull();
    } finally {
      fixture.journal.db.close();
    }
  });

  it('deduplicates already recorded artifact evidence for the same execution', async () => {
    const fixture = finalizerFixture();
    try {
      await fixture.deps.conversationManager.recordArtifactHandleAtomic(launchRecord.jobId, {
        execution: 1,
        handle: '/derived/report',
        identity: { kind: 'fixture' },
      });
      await finalizeInterruptedDurableRecovery(fixture.plan, fixture.performed, fixture.status, fixture.deps);
      await fixture.finish();
      expect(fixture.journal.events().filter((event) => event.type === 'job.artifact.recorded')).toHaveLength(1);
      expect(fixture.store.readStatus(launchRecord.jobId)?.phase).toBe('completed');
    } finally {
      fixture.journal.db.close();
    }
  });

  it('surfaces incomplete process-local release as fatal after durable settlement', async () => {
    const fixture = finalizerFixture({ releaseError: new Error('abort registry unavailable') });
    try {
      await expect(
        finalizeInterruptedDurableRecovery(fixture.plan, fixture.performed, fixture.status, fixture.deps),
      ).rejects.toBeInstanceOf(RecoveryOwnershipReleaseError);
      expect(fixture.store.readStatus(launchRecord.jobId)?.finishing).toBe(true);
      expect(fixture.journal.events().filter((event) => event.type === 'job.execution.outcome.accepted')).toHaveLength(
        1,
      );
      expect(fixture.journal.events().filter((event) => event.type === 'job.execution.ended')).toHaveLength(0);
      expect(fixture.launchCoordinator.reservationFor(launchRecord.jobId)).toMatchObject({ kind: 'active' });
    } finally {
      fixture.journal.db.close();
    }
  });
});

describe('provider-operation carrier reap', () => {
  const carrierClockScope = Symbol('carrier-reap-test');

  function fakeClock() {
    let elapsedMs = 0;
    return createMonotonicClock(carrierClockScope, {
      readMilliseconds: () => BigInt(elapsedMs),
      // Advances a virtual clock rather than waiting in real time, so the ~51s default budget costs nothing.
      sleep: async (ms) => {
        elapsedMs += ms;
      },
    });
  }

  function seededDb() {
    const db = openTestStoreDb(new SimulationRuntime(), ':memory:');
    insertProviderOperation(db, providerOperationCarrier);
    return db;
  }

  it('reaps exactly the recorded proxy group and provider root — never the guardian or reaper — then retires the saga', async () => {
    const db = seededDb();
    const state = { groupAlive: true, providerRootAlive: true };
    const signals: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];
    const process = {
      observeLiveness: (pid: number): ProcessLiveness => {
        if (pid === -providerOperationCarrier.locator.containment.processGroupId) {
          return state.groupAlive ? 'alive' : 'absent';
        }
        if (pid === providerOperationCarrier.locator.proxy.pid) {
          return state.groupAlive ? 'alive' : 'absent';
        }
        if (pid === providerOperationCarrier.providerRoot.pid) {
          return state.providerRootAlive ? 'alive' : 'absent';
        }
        return 'absent';
      },
      observeRecordedProcessAsync: async (identity: { pid: number; incarnation: ProcessIncarnation }) => {
        const liveness = process.observeLiveness(identity.pid);
        if (liveness !== 'alive') return liveness;
        if (
          identity.pid === providerOperationCarrier.locator.proxy.pid &&
          identity.incarnation === providerOperationCarrier.locator.proxy.incarnation
        ) {
          return 'alive';
        }
        if (
          identity.pid === providerOperationCarrier.providerRoot.pid &&
          identity.incarnation === providerOperationCarrier.providerRoot.incarnation
        ) {
          return 'alive';
        }
        return 'absent';
      },
      kill: (pid: number, signal: NodeJS.Signals | 0): boolean => {
        signals.push({ pid, signal });
        if (signal === 'SIGKILL') {
          if (pid === -providerOperationCarrier.locator.containment.processGroupId) state.groupAlive = false;
          if (pid === providerOperationCarrier.providerRoot.pid) state.providerRootAlive = false;
        }
        return true;
      },
    };

    try {
      await reapProviderOperationCarrier(providerOperationCarrier, {
        process,
        platform: 'linux',
        db,
        clock: fakeClock(),
        signal: new AbortController().signal,
        readProcessIncarnation: (pid) => {
          if (pid === providerOperationCarrier.locator.proxy.pid && state.groupAlive) {
            return providerOperationCarrier.locator.proxy.incarnation;
          }
          if (pid === providerOperationCarrier.providerRoot.pid && state.providerRootAlive) {
            return providerOperationCarrier.providerRoot.incarnation;
          }
          return null;
        },
      });

      const signalledPids = new Set(signals.map((entry) => entry.pid));
      expect(signalledPids).toEqual(
        new Set([
          -providerOperationCarrier.locator.containment.processGroupId,
          providerOperationCarrier.providerRoot.pid,
        ]),
      );
      expect(signalledPids.has(providerOperationCarrier.locator.guardian.pid)).toBe(false);
      expect(signalledPids.has(providerOperationCarrier.locator.reaper.pid)).toBe(false);
      expect(readProviderOperation(db, providerOperationCarrier.operation)).toBeNull();
    } finally {
      db.close();
    }
  });

  it('leaves the saga in place when absence cannot be confirmed', async () => {
    const db = seededDb();
    const process = {
      observeLiveness: () => 'alive' as const,
      observeRecordedProcessAsync: async () => 'unknown' as const,
      kill: () => true,
    };

    try {
      await expect(
        reapProviderOperationCarrier(providerOperationCarrier, {
          process,
          platform: 'linux',
          db,
          clock: fakeClock(),
          signal: new AbortController().signal,
          // Alive with no verifiable incarnation is the ambiguous case `reapRecordedContainment` refuses to
          // signal past — the recorded set can never be confirmed absent, so this must stay fatal.
          readProcessIncarnation: () => null,
        }),
      ).rejects.toBeInstanceOf(ProcessContainmentError);

      expect(readProviderOperation(db, providerOperationCarrier.operation)).toEqual(providerOperationCarrier);
    } finally {
      db.close();
    }
  });
});

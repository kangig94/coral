import { describe, expect, it, vi } from 'vitest';

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
import type { ProviderSession } from '#src/sessions/entry.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { bindingSuccess } from '#src/providers/contracts/binding.js';
import { validatedTestContinuityBlob } from '#tests/helpers/session.js';
import { openTestStoreDb } from '#tests/helpers/store-db.js';
import {
  finalizeInterruptedAppServerRecovery,
  RecoveryOwnershipReleaseError,
} from '#src/coordinator/services/recovery/interrupted-finalizer.js';
import { insertProviderOperation, readProviderOperation } from '#src/store/provider-operation-journal.js';

import { providerOperationRecord } from '../store/provider-operation-fixtures.js';

const launchRecord = {
  jobId: 'job-recovery-contract',
  owner: { kind: 'provider-session', id: 'session-recovery-contract' },
  sessionId: 'session-recovery-contract',
  provider: 'fixture',
  projectRoot: '/project',
  backendNamespace: 'namespace',
  jobKind: 'provider',
  pool: 'default',
  enqueueSequence: 1,
  providerAction: 'exec',
  request: { prompt: 'test', cwd: '/project', bypassPermissions: false, coralEnv: {} },
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

const session = {
  sessionId: 'session-recovery-contract',
  projectRoot: '/project',
  conversationRef: undefined,
  providerContinuity: { checkpoint: 'persisted' },
  artifactHandles: [],
  version: 1,
} as unknown as ProviderSession;

const providerOperationCarrier = providerOperationRecord('executing') as ProviderOperationCarrierRecord;

function recovery(): BoundProviderRecovery {
  return {
    finalizeInterrupted: (result: { resumable: boolean }) =>
      result.resumable ? { kind: 'preserve' } : { kind: 'clear_non_resumable' },
    finalizeFromArtifacts: vi.fn(),
  } as unknown as BoundProviderRecovery;
}

function managed(hostRef: HostRef) {
  return {
    hostRef,
    close: vi.fn(),
  };
}

function serviceWithCapability(appServer: BoundProviderAppServerCapability, boundRecovery = recovery()) {
  const runtime = new SimulationRuntime();
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
      nextSession: ProviderSession = session,
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
          probe: bound.appServer?.supportsProbe === true,
        },
        providerOperation,
      );
      return performInterruptedAppServerRecovery(plan, bound, {
        time: runtime.time,
        env: runtime.env,
        storage: runtime.storage,
        jobDir: () => '/jobs/job-recovery-contract',
        reapCarrier,
      });
    },
  };
}

function capability(overrides: Partial<BoundProviderAppServerCapability> = {}): BoundProviderAppServerCapability {
  return {
    supportsInterrupt: false,
    supportsProbe: true,
    openReplacement: vi.fn(),
    interrupt: vi.fn(async () => ({ kind: 'not-accepted' as const, reason: 'test refusal' })),
    probe: vi.fn(async () => ({ kind: 'probed' as const, result: { resumable: true } })),
    ...overrides,
  };
}

describe('interrupted recovery planning', () => {
  const authority = {
    launchRecord,
    session,
    boundProvider: { name: 'fixture' },
  } as unknown as ProviderRecoveryAuthority;

  it('selects one deterministic effect route without consulting provider state', () => {
    const first = planInterruptedAppServerRecovery(
      authority,
      acquiredRuntime,
      'restart',
      { recovery: true, probe: false },
      null,
    );
    const second = planInterruptedAppServerRecovery(
      authority,
      acquiredRuntime,
      'restart',
      { recovery: true, probe: false },
      null,
    );

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      kind: 'artifacts',
      expectedSessionVersion: 1,
      continuity: { checkpoint: 'persisted' },
    });
    expect(Object.isFrozen(first)).toBe(true);
  });

  it('makes missing recovery capability an explicit unsupported plan', () => {
    expect(
      planInterruptedAppServerRecovery(authority, acquiredRuntime, 'handoff', { recovery: false, probe: true }, null),
    ).toMatchObject({ kind: 'unsupported', reason: 'handoff' });
  });

  it('never routes a committed provider-operation carrier through the unsupported, waiting, or artifacts arms', () => {
    expect(
      planInterruptedAppServerRecovery(
        authority,
        acquiredRuntime,
        'restart',
        { recovery: false, probe: true },
        providerOperationCarrier,
      ),
    ).toMatchObject({ kind: 'unsupported' });
    expect(
      planInterruptedAppServerRecovery(
        authority,
        waitingRuntime,
        'restart',
        { recovery: true, probe: true },
        providerOperationCarrier,
      ),
    ).toMatchObject({ kind: 'waiting' });
    expect(
      planInterruptedAppServerRecovery(
        authority,
        acquiredRuntime,
        'restart',
        { recovery: true, probe: false },
        providerOperationCarrier,
      ),
    ).toMatchObject({ kind: 'artifacts' });
  });

  it('classifies a committed provider-operation carrier as detached ahead of probe', () => {
    const plan = planInterruptedAppServerRecovery(
      authority,
      acquiredRuntime,
      'restart',
      { recovery: true, probe: true },
      providerOperationCarrier,
    );

    expect(plan).toMatchObject({
      kind: 'carrier-detached',
      carrier: providerOperationCarrier,
      continuity: { checkpoint: 'persisted' },
    });
  });

  it('plans a probe when no provider-operation carrier is committed, unchanged from before', () => {
    const plan = planInterruptedAppServerRecovery(
      authority,
      acquiredRuntime,
      'restart',
      { recovery: true, probe: true },
      null,
    );

    expect(plan).toMatchObject({ kind: 'probe', hostRef: persistedHostRef });
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
    ).toMatchObject({ kind: expectedKind, expectedSessionVersion: 1 });
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

describe('interrupted provider HostRef recovery', () => {
  it('delegates waiting work without attaching or minting credentials', async () => {
    const appServer = capability();
    await expect(
      serviceWithCapability(appServer).decide(waitingRuntime, {
        ...session,
        providerContinuity: null,
      } as ProviderSession),
    ).resolves.toMatchObject({ probeOutcome: 'waiting' });
    expect(appServer.probe).not.toHaveBeenCalled();
    expect(appServer.openReplacement).not.toHaveBeenCalled();
  });

  it('probes the persisted HostRef without compiling a replacement when attachment succeeds', async () => {
    const probe = vi.fn(async () => ({ kind: 'probed' as const, result: { resumable: true } }));
    const openReplacement = vi.fn();
    const fixture = serviceWithCapability(capability({ probe, openReplacement }));
    await expect(fixture.decide(acquiredRuntime)).resolves.toMatchObject({
      probeOutcome: 'verified',
    });
    expect(probe).toHaveBeenCalledWith(
      persistedHostRef,
      session.providerContinuity,
      expect.objectContaining({
        jobId: 'job-recovery-contract',
        request: expect.objectContaining({
          action: 'exec',
          sessionId: 'session-recovery-contract',
          cwd: '/project',
        }),
      }),
    );
    expect(openReplacement).not.toHaveBeenCalled();
  });

  it('opens exactly one replacement only after a stale attachment', async () => {
    const replacementRef = { ...persistedHostRef, instanceId: 'instance-2' };
    const replacement = managed(replacementRef);
    const probe = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'stale' })
      .mockResolvedValueOnce({ kind: 'probed', result: { resumable: true } });
    const openReplacement = vi.fn(async (_input: unknown) => replacement);
    const fixture = serviceWithCapability(capability({ probe, openReplacement }));
    await expect(fixture.decide(acquiredRuntime)).resolves.toMatchObject({
      probeOutcome: 'verified',
    });
    expect(openReplacement).toHaveBeenCalledTimes(1);
    expect(openReplacement.mock.calls[0]?.[0]).not.toHaveProperty('protectedEnv');
    expect(probe).toHaveBeenCalledTimes(2);
    expect(replacement.close).toHaveBeenCalledTimes(1);
  });

  it('closes the only replacement and reports missing when its probe is non-resumable', async () => {
    const replacement = managed({ ...persistedHostRef, instanceId: 'instance-non-resumable' });
    const probe = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'stale' })
      .mockResolvedValueOnce({ kind: 'probed', result: { resumable: false } });
    const openReplacement = vi.fn(async () => replacement);

    await expect(
      serviceWithCapability(capability({ probe, openReplacement })).decide(acquiredRuntime),
    ).resolves.toMatchObject({
      probeOutcome: 'missing',
      mutation: { kind: 'clear_non_resumable' },
    });
    expect(openReplacement).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(replacement.close).toHaveBeenCalledTimes(1);
  });

  it('closes the only replacement and reports unavailable when its attachment is stale again', async () => {
    const replacement = managed({ ...persistedHostRef, instanceId: 'instance-stale' });
    const probe = vi.fn().mockResolvedValueOnce({ kind: 'stale' }).mockResolvedValueOnce({ kind: 'stale' });
    const openReplacement = vi.fn(async () => replacement);

    await expect(
      serviceWithCapability(capability({ probe, openReplacement })).decide(acquiredRuntime),
    ).resolves.toMatchObject({
      probeOutcome: 'unavailable',
      mutation: { kind: 'clear_non_resumable' },
    });
    expect(openReplacement).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(replacement.close).toHaveBeenCalledTimes(1);
  });

  it('closes the only replacement and reports unavailable when its probe throws', async () => {
    const replacement = managed({ ...persistedHostRef, instanceId: 'instance-throwing' });
    const probe = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'stale' })
      .mockRejectedValueOnce(new Error('replacement probe failed'));
    const openReplacement = vi.fn(async () => replacement);

    await expect(
      serviceWithCapability(capability({ probe, openReplacement })).decide(acquiredRuntime),
    ).resolves.toMatchObject({
      probeOutcome: 'unavailable',
      mutation: { kind: 'clear_non_resumable' },
    });
    expect(openReplacement).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(replacement.close).toHaveBeenCalledTimes(1);
  });

  it('classifies a provider probe failure as unavailable without opening a replacement', async () => {
    const openReplacement = vi.fn();
    const probe = vi.fn(async () => {
      throw new Error('provider probe failed');
    });
    await expect(
      serviceWithCapability(capability({ probe, openReplacement })).decide(acquiredRuntime),
    ).resolves.toMatchObject({
      probeOutcome: 'unavailable',
    });
    expect(openReplacement).not.toHaveBeenCalled();
  });

  it('confirms the carrier and finalizes without probing or opening a replacement when a saga carrier exists', async () => {
    const probe = vi.fn(async () => ({ kind: 'probed' as const, result: { resumable: true } }));
    const openReplacement = vi.fn();
    const fixture = serviceWithCapability(capability({ probe, openReplacement }));

    await expect(fixture.decide(acquiredRuntime, session, providerOperationCarrier)).resolves.toMatchObject({
      probeOutcome: 'unavailable',
    });

    expect(fixture.reapCarrier).toHaveBeenCalledTimes(1);
    expect(fixture.reapCarrier).toHaveBeenCalledWith(providerOperationCarrier);
    expect(probe).not.toHaveBeenCalled();
    expect(openReplacement).not.toHaveBeenCalled();
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
  const status = {
    jobId: launchRecord.jobId,
    owner: launchRecord.owner,
    sessionId: launchRecord.sessionId,
    provider: launchRecord.provider,
    projectRoot: launchRecord.projectRoot,
    backendNamespace: launchRecord.backendNamespace,
    jobKind: launchRecord.jobKind,
    phase: 'running',
    updatedAt: launchRecord.createdAt,
    lastSeq: 1,
  } as const;

  function finalizerFixture(options: { releaseError?: Error; artifactNextVersion?: number } = {}) {
    const runtime = new SimulationRuntime();
    const finalizeJobContinuityAtomic = vi.fn(async () => true);
    // Crash-discovered artifact handles are persisted before the session is finalized, so finalize
    // must use the exact version returned by that write or idempotent replay.
    const recordArtifactHandleAtomic = vi.fn(async () => ({
      ok: true as const,
      nextVersion: options.artifactNextVersion ?? session.version + 1,
    }));
    const abortRegistry = {
      remove: vi.fn(() => {
        if (options.releaseError !== undefined) throw options.releaseError;
      }),
    };
    const launchAdmission = { releaseLaunch: vi.fn() };
    const jobPools = new Map([[launchRecord.jobId, launchRecord.pool]]);
    const plan = planInterruptedAppServerRecovery(
      {
        launchRecord,
        session,
        boundProvider: { name: 'fixture' } as BoundProvider,
      } as ProviderRecoveryAuthority,
      waitingRuntime,
      'restart',
      { recovery: true, probe: false },
      null,
    );
    const performed = {
      kind: 'resolved',
      mutation: { kind: 'preserve' },
      probeOutcome: 'waiting',
      recoveryConversationRef: undefined,
      artifactHandles: [{ handle: '/derived/report', identity: { kind: 'fixture' }, sourceJobId: launchRecord.jobId }],
    } as const;
    return {
      plan,
      performed,
      finalizeJobContinuityAtomic,
      recordArtifactHandleAtomic,
      abortRegistry,
      launchAdmission,
      jobPools,
      deps: {
        runtime,
        sessionManager: { finalizeJobContinuityAtomic, recordArtifactHandleAtomic },
        abortRegistry,
        launchAdmission,
        jobPools,
      },
    };
  }

  it('persists artifact handles before final settlement with the exact returned CAS version', async () => {
    const fixture = finalizerFixture();

    await finalizeInterruptedAppServerRecovery(fixture.plan, fixture.performed, status, fixture.deps as never);

    expect(fixture.recordArtifactHandleAtomic).toHaveBeenCalledOnce();
    expect(fixture.recordArtifactHandleAtomic).toHaveBeenCalledWith(
      session.sessionId,
      expect.objectContaining({
        expectedActiveJobId: launchRecord.jobId,
        expectedVersion: session.version,
        handle: '/derived/report',
        sourceJobId: launchRecord.jobId,
      }),
    );
    expect(fixture.finalizeJobContinuityAtomic).toHaveBeenCalledOnce();
    expect(fixture.finalizeJobContinuityAtomic).toHaveBeenCalledWith(
      session.sessionId,
      expect.objectContaining({
        expectedActiveJobId: launchRecord.jobId,
        // The artifact write advanced the session, so finalize must CAS on the post-write version.
        expectedVersion: session.version + 1,
        appendBeforeRelease: expect.any(Function),
      }),
    );
    expect(fixture.recordArtifactHandleAtomic.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.finalizeJobContinuityAtomic.mock.invocationCallOrder[0],
    );
    expect(fixture.abortRegistry.remove).toHaveBeenCalledWith(launchRecord.jobId);
    expect(fixture.launchAdmission.releaseLaunch).toHaveBeenCalledWith(launchRecord.jobId, launchRecord.pool);
  });

  it('uses an unchanged artifact replay version for the final settlement CAS', async () => {
    const fixture = finalizerFixture({ artifactNextVersion: session.version });

    await finalizeInterruptedAppServerRecovery(fixture.plan, fixture.performed, status, fixture.deps as never);

    expect(fixture.recordArtifactHandleAtomic).toHaveBeenCalledWith(
      session.sessionId,
      expect.objectContaining({ expectedVersion: session.version }),
    );
    expect(fixture.finalizeJobContinuityAtomic).toHaveBeenCalledWith(
      session.sessionId,
      expect.objectContaining({ expectedVersion: session.version }),
    );
  });

  it('surfaces incomplete process-local release as fatal after durable settlement', async () => {
    const fixture = finalizerFixture({ releaseError: new Error('abort registry unavailable') });

    await expect(
      finalizeInterruptedAppServerRecovery(fixture.plan, fixture.performed, status, fixture.deps as never),
    ).rejects.toBeInstanceOf(RecoveryOwnershipReleaseError);
    expect(fixture.finalizeJobContinuityAtomic).toHaveBeenCalledOnce();
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
      isAlive: (pid: number): boolean => {
        if (pid === -providerOperationCarrier.locator.containment.processGroupId) return state.groupAlive;
        if (pid === providerOperationCarrier.providerRoot.pid) return state.providerRootAlive;
        return false;
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
        readProcessStartedAtSeconds: (pid) => {
          if (pid === providerOperationCarrier.locator.proxy.pid && state.groupAlive) {
            return providerOperationCarrier.locator.proxy.processStartedAtSeconds;
          }
          if (pid === providerOperationCarrier.providerRoot.pid && state.providerRootAlive) {
            return providerOperationCarrier.providerRoot.processStartedAtSeconds;
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
    const process = { isAlive: () => true, kill: () => true };

    try {
      await expect(
        reapProviderOperationCarrier(providerOperationCarrier, {
          process,
          platform: 'linux',
          db,
          clock: fakeClock(),
          // Alive with no verifiable start time is the ambiguous case `reapRecordedContainment` refuses to
          // signal past — the recorded set can never be confirmed absent, so this must stay fatal.
          readProcessStartedAtSeconds: () => null,
        }),
      ).rejects.toBeInstanceOf(ProcessContainmentError);

      expect(readProviderOperation(db, providerOperationCarrier.operation)).toEqual(providerOperationCarrier);
    } finally {
      db.close();
    }
  });
});

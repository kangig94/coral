import { readFileSync } from 'node:fs';
import type { Server, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import { createCoordinatorShutdownSignalHandler } from '#src/coordinator/bootstrap.js';
import { createLifecycle, isLifecycleShutdownTerminal } from '#src/coordinator/lifecycle.js';
import {
  HANDOFF_DRAIN_TIMEOUT_MS,
  SHUTDOWN_DRAIN_TIMEOUT_MS,
  childTerminationRemainder,
  runShutdownSequence,
} from '#src/coordinator/shutdown.js';
import {
  createShutdownSettlementLedger,
  type ProcessExitRemainder,
  type ProcessExitRemainderAcceptance,
  type ShutdownAuthorityReleaseBoundary,
  type ShutdownObligation,
} from '#src/coordinator/shutdown-settlement.js';
import type {
  ProviderProxyAuthorityRegistry,
  ProviderProxySetAuthority,
} from '#src/coordinator/live/provider-proxy/authority.js';
import type { DurableProcessRetention } from '#src/coordinator/live/durable-transport.js';
import type { IpcListener } from '#src/transport/ipc/server.js';
import type { Runtime } from '#src/runtime/ports.js';
import { VirtualTime } from '#tools/simulation/core/virtual-time.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { unexercisedProviderHostControls } from '#tests/helpers/provider-host-controls.js';

type CallLog = string[];

interface Harness {
  time: VirtualTime;
  runtime: Runtime;
  callLog: CallLog;
  logLines: string[];
  closeIpcCalled: () => boolean;
  ctx: Parameters<typeof runShutdownSequence>[0];
}

function buildHarness(opts: {
  hooksOnShutdown?: (signal: AbortSignal) => Promise<void>;
  closeIpcServerFn?: (listener: IpcListener) => Promise<void>;
  stopStoreEpochSweepFn?: () => Promise<void>;
  reason?: Parameters<typeof runShutdownSequence>[0]['reason'];
  providerProxyAuthority?: ProviderProxyAuthorityRegistry;
  stopProviderOperationReconciler?: NonNullable<
    Parameters<typeof runShutdownSequence>[0]['stopProviderOperationReconciler']
  >;
  acceptProcessExitRemainder?: (remainder: ProcessExitRemainder) => ProcessExitRemainderAcceptance;
}): Harness {
  const time = new VirtualTime();
  const callLog: CallLog = [];
  const logLines: string[] = [];

  const runtime = {
    time,
    paths: { coral: { coordinator: { runDir: '/tmp/coral' } } },
    storage: {
      existsSync: () => false,
      mkdirSync: () => {},
      openSqliteDatabaseSync: () => ({
        exec: () => {},
        close: () => {},
      }),
      readFileSync: () => {
        throw new Error('unexpected read');
      },
      writeAtomicSync: () => true,
      writeAtomicDurableSync: () => true,
    },
  } as unknown as Runtime;

  const server = {
    closeAllConnections: () => {
      callLog.push('server.closeAllConnections');
    },
  } as unknown as Server;

  const ipcServer = { server: {}, sockets: new Set(), socketPath: '/tmp/x' } as unknown as IpcListener;
  const storeServices = {};

  let closeIpcResolved = false;
  const closeIpcServerFn =
    opts.closeIpcServerFn ??
    (async (_listener: IpcListener): Promise<void> => {
      callLog.push('closeIpcServerFn:start');
      closeIpcResolved = true;
      await Promise.resolve();
      callLog.push('closeIpcServerFn:resolved');
    });

  const ctx: Parameters<typeof runShutdownSequence>[0] = {
    reason: opts.reason ?? 'replaced', // → mode='handoff' → drain=HANDOFF_DRAIN_TIMEOUT_MS
    state: { ownershipCheckerTeardown: null },
    teardownRecoveryCoordinator: async () => {
      callLog.push('teardownRecoveryCoordinator');
    },
    runtimeState: {
      setLifecycle: (s) => {
        callLog.push(`setLifecycle:${s}`);
      },
      components: {
        register: () => {},
        initAll: () => {},
        disposeAll: async () => {
          callLog.push('components.disposeAll');
        },
        list: () => [],
        status: () => null,
      },
    },
    idleTimer: {
      stopWatching: () => {
        callLog.push('idleTimer.stopWatching');
      },
    } as never,
    closeServerFn: async (_s: Server) => {
      callLog.push('closeServerFn');
    },
    closeIpcServerFn: async (listener: IpcListener) => {
      await closeIpcServerFn(listener);
    },
    waitForInflightDrain: async () => {
      callLog.push('waitForInflightDrain');
    },
    server,
    ipcServer,
    streamResponses: new Set<ServerResponse>(),
    runtime,
    markJobsAsErrorFn: () => {},
    providerHostManager: {
      // Mode is 'handoff', so .shutdown() is not called — only drainForHandoff().
      drainForHandoff: async () => {
        callLog.push('drainForHandoff');
        return {
          kind: 'provider-hosts-quiesced',
          liveProxySets: opts.providerProxyAuthority?.liveSets() ?? [],
          acquisitionCleanupHolds: [],
          closingHosts: [],
        };
      },
      shutdown: async () => ({
        kind: 'provider-hosts-quiesced',
        liveProxySets: opts.providerProxyAuthority?.liveSets() ?? [],
        acquisitionCleanupHolds: [],
        closingHosts: [],
      }),
    } as never,
    providerProxyAuthority: opts.providerProxyAuthority,
    ...(opts.stopProviderOperationReconciler === undefined
      ? {}
      : { stopProviderOperationReconciler: opts.stopProviderOperationReconciler }),
    storeServicesRef: {
      tryGet: () => storeServices,
      get: () => storeServices,
      set: () => {},
      clear: () => {},
    } as never,
    settlePendingLaunchesFn: () => ({ kind: 'all-pending-launches-settled' }),
    terminateRegisteredChildrenFn: () => ({ kind: 'all-children-observed-absent' }),
    handoffQuiescePorts: () => [],
    disposeLifecycleReactor: () => {
      callLog.push('lifecycleReactor.dispose');
    },
    hooks: {
      onShutdown: async (_mode, signal) => {
        if (opts.hooksOnShutdown) {
          await opts.hooksOnShutdown(signal);
        }
      },
    },
    discussStores: new Map(),
    ...(opts.stopStoreEpochSweepFn === undefined ? {} : { stopStoreEpochSweepFn: opts.stopStoreEpochSweepFn }),
    log: (msg) => {
      logLines.push(msg);
    },
    ...(opts.acceptProcessExitRemainder === undefined
      ? {}
      : { acceptProcessExitRemainder: opts.acceptProcessExitRemainder }),
  };

  return {
    time,
    runtime,
    callLog,
    logLines,
    closeIpcCalled: () => closeIpcResolved,
    ctx,
  };
}

function retainedChild(
  jobId: string,
  pid: number,
  publication: DurableProcessRetention['publication'],
): DurableProcessRetention {
  return {
    kind: 'recorded-wrapper-group',
    provider: 'codex',
    jobId,
    jobDir: `/tmp/coral/jobs/${jobId}`,
    publication,
    containment: { pid, incarnation: testIncarnation(jobId), processGroupId: pid, childRoot: null },
  };
}

async function flush(rounds = 16): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

const rejectingHook = async (): Promise<void> => {
  throw new Error('hook failed');
};

function buildRemainderWriteRefusalHarness(
  write: () => boolean,
  withdrawal: Readonly<{ kind: 'removed' }> | Readonly<{ kind: 'refused'; detail: string }> = { kind: 'removed' },
  hooksOnShutdown: () => Promise<void> = async () => {},
) {
  const harness = buildHarness({ hooksOnShutdown });
  const order: string[] = [];
  const logLines: string[] = [];
  const runtime = {
    ...harness.runtime,
    storage: {
      ...harness.runtime.storage,
      existsSync: () => false,
      writeAtomicDurableSync: () => {
        order.push('record');
        return write();
      },
    },
  } as Runtime;
  let lifecycle: 'running' | 'draining' | 'stopped' = 'running';
  const runtimeState = {
    ...harness.ctx.runtimeState,
    getLifecycle: () => lifecycle,
    setLifecycle: (next: typeof lifecycle) => {
      lifecycle = next;
      if (next === 'stopped') order.push('stopped');
    },
  };
  const onStopped = vi.fn((exitCode: number) => {
    order.push(`exit:${exitCode}`);
  });
  const removeBackendInfoIfOwnerFn = vi.fn(() => {
    order.push('withdraw');
    return withdrawal;
  });
  const controller = createLifecycle(
    {
      identity: {
        pluginRoot: '/plugin',
        instanceId: 'remainder-write-refusal',
        log: (message: string) => logLines.push(message),
      },
      runtime,
      storeFormat: {},
      backendPid: 4_242,
      runtimeState,
      idleTimer: { ...harness.ctx.idleTimer, inflightRequests: 0 },
      storeServicesRef: harness.ctx.storeServicesRef,
      createStoreServicesFromDbFn: () => ({}),
      streamResponses: harness.ctx.streamResponses,
      discussStores: harness.ctx.discussStores,
      eventBus: {},
      launchCoordinator: {},
      providerRegistry: {},
      server: harness.ctx.server,
      getExecutionService: () => ({}),
      getRecoveryService: () => ({}),
      listExecutionServices: () => [],
      getDiscussStoreForSource: () => {
        throw new Error('unexpected discuss store lookup');
      },
      knownDiscussSources: () => new Set(),
      getDiscussContext: () => {
        throw new Error('unexpected discuss context lookup');
      },
      writeBackendInfoFn: () => {},
      removeBackendInfoIfOwnerFn,
      cleanupStaleJobsFn: () => {},
      markJobsAsErrorFn: harness.ctx.markJobsAsErrorFn,
      settlePendingLaunchesFn: harness.ctx.settlePendingLaunchesFn,
      terminateRegisteredChildrenFn: harness.ctx.terminateRegisteredChildrenFn,
      providerHostManager: harness.ctx.providerHostManager,
      handoffQuiescePorts: () => [],
      createKbHealthComponentFn: () => ({}),
      registerBuiltInProvidersFn: () => {},
      recoverPersistedDiscussFn: async () => [],
      hooks: harness.ctx.hooks,
      closeServerFn: harness.ctx.closeServerFn,
      listenFn: async () => ({ host: '127.0.0.1', port: 43123 }),
      ipcServer: harness.ctx.ipcServer,
      closeIpcServerFn: harness.ctx.closeIpcServerFn,
      disposeLifecycleReactor: harness.ctx.disposeLifecycleReactor,
      onStopped,
    } as never,
    async () => [],
  );

  return { controller, logLines, onStopped, order, removeBackendInfoIfOwnerFn };
}

type ShutdownSequenceHold = Extract<Awaited<ReturnType<typeof runShutdownSequence>>, { disposition: 'held' }>;
type ShutdownSequenceUnaccepted = Extract<
  Awaited<ReturnType<typeof runShutdownSequence>>,
  { disposition: 'unaccepted' }
>;
type ShutdownSequenceLoss = Exclude<Awaited<ReturnType<typeof runShutdownSequence>>, { disposition: 'settled' }>;

function requireHeld(disposition: Awaited<ReturnType<typeof runShutdownSequence>>): ShutdownSequenceHold {
  expect(disposition.disposition).toBe('held');
  if (disposition.disposition !== 'held') throw new Error('expected held shutdown finalization');
  return disposition;
}

function requireUnaccepted(disposition: Awaited<ReturnType<typeof runShutdownSequence>>): ShutdownSequenceUnaccepted {
  expect(disposition.disposition).toBe('unaccepted');
  if (disposition.disposition !== 'unaccepted') throw new Error('expected unaccepted shutdown finalization');
  return disposition;
}

function failureDetail(disposition: ShutdownSequenceLoss): string {
  return disposition.undischarged
    .map(({ label, settlement }) => `${label}: ${settlement.cause}: ${settlement.detail}`)
    .join(' | ');
}

function heldFailureDetail(held: ShutdownSequenceHold): string {
  return failureDetail(held);
}

describe('runShutdownSequence drain budget', () => {
  it('does not rerun a timed-out destructive sweep before transferring its process-exit remainder', async () => {
    let finishSweep!: () => void;
    const sweepSettlement = new Promise<void>((resolve) => {
      finishSweep = resolve;
    });
    const acceptProcessExitRemainder = vi.fn<(remainder: ProcessExitRemainder) => ProcessExitRemainderAcceptance>(
      (remainder) => ({
        kind: 'accepted',
        remainder,
        requestExit: () => undefined,
      }),
    );
    const harness = buildHarness({
      stopStoreEpochSweepFn: async () => {
        harness.callLog.push('storeEpochSweep.stop');
        await sweepSettlement;
        harness.callLog.push('storeEpochSweep.joined');
      },
      acceptProcessExitRemainder,
    });

    let sequence: ReturnType<typeof runShutdownSequence> | undefined;
    const recordExitCode = vi.fn();
    const onRepeatedSignal = vi.fn();
    const handleSignal = createCoordinatorShutdownSignalHandler({
      shutdown: () => (sequence ??= runShutdownSequence(harness.ctx)),
      recordExitCode,
      onRepeatedSignal,
    });
    handleSignal('sigterm');
    await flush();

    expect(harness.callLog).toEqual(['setLifecycle:draining', 'idleTimer.stopWatching', 'storeEpochSweep.stop']);
    expect(harness.closeIpcCalled()).toBe(false);

    handleSignal('sigint');
    expect(recordExitCode).toHaveBeenCalledWith(1);
    expect(onRepeatedSignal).toHaveBeenCalledOnce();
    for (let advanced = 0; advanced <= HANDOFF_DRAIN_TIMEOUT_MS + 100; advanced += 100) {
      harness.time.tick(100);
      await flush();
    }
    expect(acceptProcessExitRemainder).not.toHaveBeenCalled();
    expect(harness.closeIpcCalled()).toBe(false);

    if (sequence === undefined) throw new Error('shutdown signal did not start the sequence');
    const held = requireHeld(await sequence);
    expect(held.retryAfter).toBeInstanceOf(Promise);
    const executeAdvertisedExit = held.retry;
    expect(executeAdvertisedExit).toBeTypeOf('function');

    harness.time.tick(50);
    await held.retryAfter;
    await expect(executeAdvertisedExit()).resolves.toMatchObject({
      disposition: 'delegated',
      undischarged: expect.arrayContaining([expect.objectContaining({ label: 'store epoch sweep cancellation' })]),
    });
    expect(acceptProcessExitRemainder).toHaveBeenCalledOnce();
    expect(harness.callLog.filter((entry) => entry === 'storeEpochSweep.stop')).toHaveLength(1);
    expect(harness.closeIpcCalled()).toBe(true);
    finishSweep();
    await flush();
  });

  it('runs provider-host recovery before closing provider-operation mutation admission', async () => {
    const order: string[] = [];
    const mutationSettlement = new Promise<void>(() => {});
    const stopProviderOperationReconciler = vi.fn(() => {
      order.push('mutation-admission-close');
      return {
        kind: 'holding' as const,
        pendingMutations: ['provider-operation:job-1:operation-1'],
        exit: 'admitted-provider-operation-mutation-settlement' as const,
        retryAfter: mutationSettlement,
      };
    });
    const harness = buildHarness({ stopProviderOperationReconciler });
    const drainForHandoff = harness.ctx.providerHostManager.drainForHandoff;
    harness.ctx.providerHostManager = {
      ...harness.ctx.providerHostManager,
      drainForHandoff: async (signal) => {
        order.push('provider-host-recovery');
        return drainForHandoff(signal);
      },
    };
    const sequence = runShutdownSequence(harness.ctx);

    for (let advanced = 0; advanced <= HANDOFF_DRAIN_TIMEOUT_MS + 100; advanced += 100) {
      harness.time.tick(100);
      await flush();
    }

    const held = requireHeld(await sequence);
    expect(heldFailureDetail(held)).toContain('provider operation mutation drain:');
    expect(held.retainedAuthority.cleanupObligations).toEqual(
      expect.arrayContaining(['provider operation mutation drain', 'provider-operation:job-1:operation-1']),
    );
    expect(stopProviderOperationReconciler).toHaveBeenCalledOnce();
    expect(order).toEqual(['provider-host-recovery', 'mutation-admission-close']);
  });

  it('requires mutation drain before later finalization and authority release', async () => {
    let settleMutation!: () => void;
    const mutationSettlement = new Promise<void>((resolve) => {
      settleMutation = resolve;
    });
    let observeAdmissionClose!: () => void;
    const admissionCloseStarted = new Promise<void>((resolve) => {
      observeAdmissionClose = resolve;
    });
    let stopAttempts = 0;
    const stopProviderOperationReconciler = vi.fn(() => {
      stopAttempts += 1;
      observeAdmissionClose();
      return stopAttempts === 1
        ? {
            kind: 'holding' as const,
            pendingMutations: ['provider-operation:job-1:operation-1'],
            exit: 'admitted-provider-operation-mutation-settlement' as const,
            retryAfter: mutationSettlement,
          }
        : { kind: 'drained' as const };
    });
    const harness = buildHarness({ stopProviderOperationReconciler });
    const sequence = runShutdownSequence(harness.ctx);
    await admissionCloseStarted;

    expect(stopProviderOperationReconciler).toHaveBeenCalledOnce();
    expect(harness.callLog).not.toContain('components.disposeAll');
    expect(harness.closeIpcCalled()).toBe(false);

    settleMutation();
    await expect(sequence).resolves.toEqual({ disposition: 'settled' });
    expect(stopProviderOperationReconciler).toHaveBeenCalledTimes(2);
    expect(harness.callLog).toContain('components.disposeAll');
    expect(harness.closeIpcCalled()).toBe(true);
  });

  it('names authority-null representation and mutation-admission losses before releasing authority', async () => {
    let settleRepresentationRelease!: (disposition: { kind: 'released' }) => void;
    const representationReleaseSettlement = new Promise<{ kind: 'released' }>((resolve) => {
      settleRepresentationRelease = resolve;
    });
    const stopProviderOperationReconciler = vi.fn(() => ({ kind: 'drained' as const }));
    const harness = buildHarness({ stopProviderOperationReconciler });
    const receipt = {
      kind: 'provider-hosts-quiesced' as const,
      liveProxySets: [],
      acquisitionCleanupHolds: [],
      closingHosts: [],
    };
    harness.ctx.providerHostManager = {
      drainForHandoff: async () => receipt,
      shutdown: async () => receipt,
      cleanupObligations: () => ({
        ...receipt,
        representationReleaseHolds: [
          {
            label: 'provider proxy representation release authority-null',
            proxyInstanceId: 'authority-null',
            pendingOperations: ['provider-operation:job-1:operation-1'],
            disposition: {
              kind: 'operational-retry-owned' as const,
              exit: 'provider-proxy-set-release-retry' as const,
            },
            exit: 'provider-proxy-representation-release-settlement' as const,
            settlement: representationReleaseSettlement,
          },
        ],
      }),
    };

    const terminal = requireUnaccepted(await runShutdownSequence(harness.ctx));

    expect(stopProviderOperationReconciler).not.toHaveBeenCalled();
    expect(terminal.undischarged).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'provider host drain for handoff' }),
        expect.objectContaining({ label: 'provider operation mutation drain' }),
      ]),
    );
    expect(harness.closeIpcCalled()).toBe(true);
    settleRepresentationRelease({ kind: 'released' });
    await flush();
    expect(stopProviderOperationReconciler).not.toHaveBeenCalled();
  });

  it('names a fatal representation release as a terminal loss without retaining authority', async () => {
    const authorityCalls: string[] = [];
    const set = fakeSet('release-pending', authorityCalls);
    const fatalError = new Error('fatal release remains operator-owned') as never;
    const successor = {
      owner: 'operator-command' as const,
      acceptance: 'pending' as const,
      inspectCommand: 'coral-cli backend status' as const,
      actionCommand: 'coral-cli backend provider-proxy-set abandon release-pending-token',
    };
    const representationReleaseSettlement = Promise.resolve({
      kind: 'fatal-successor-pending' as const,
      error: fatalError,
      successor,
      operatorDispositionRecording: { kind: 'recorded' as const },
    });
    const harness = buildHarness({ providerProxyAuthority: { liveSets: () => [set] } });
    const receipt = {
      kind: 'provider-hosts-quiesced' as const,
      liveProxySets: [set],
      acquisitionCleanupHolds: [],
      closingHosts: [],
    };
    harness.ctx.providerHostManager = {
      drainForHandoff: async () => receipt,
      shutdown: async () => receipt,
      cleanupObligations: () => ({
        ...receipt,
        representationReleaseHolds: [
          {
            label: 'provider proxy representation release release-pending',
            proxyInstanceId: 'release-pending',
            pendingOperations: ['provider-operation:job-1:operation-1'],
            disposition: {
              kind: 'fatal-successor-pending' as const,
              exit: 'provider-proxy-set-operator-abandonment' as const,
              error: fatalError,
              successor,
              operatorDispositionRecording: { kind: 'recorded' as const },
            },
            exit: 'provider-proxy-representation-release-settlement' as const,
            settlement: representationReleaseSettlement,
          },
        ],
      }),
    };

    const terminal = requireUnaccepted(await runShutdownSequence(harness.ctx));

    expect(terminal.undischarged).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          settlement: expect.objectContaining({
            detail: expect.stringContaining('disposition=fatal-successor-pending'),
          }),
        }),
      ]),
    );
    expect(harness.closeIpcCalled()).toBe(true);
  });

  it('returns a hold within drainTimeout + small slack when an async-cooperative finalizer hangs', async () => {
    // Hooks.onShutdown never resolves and ignores the abort signal — the
    // budget timer must end the race for `runShutdownSequence` to return.
    let hookSignal: AbortSignal | null = null;
    const harness = buildHarness({
      hooksOnShutdown: (signal) => {
        hookSignal = signal;
        return new Promise<void>(() => {});
      },
    });
    const startedAt = harness.time.now();

    let completed = false;
    const sequence = runShutdownSequence(harness.ctx).finally(() => {
      completed = true;
    });

    // Drive virtual time forward enough to fire all budget timers.
    // The bounded steps consume `HANDOFF_DRAIN_TIMEOUT_MS` worth of virtual
    // time in aggregate when each finalizer hangs; each step's race expires
    // back-to-back as the deadline draws closer.
    for (let advanced = 0; advanced <= HANDOFF_DRAIN_TIMEOUT_MS + 100; advanced += 100) {
      harness.time.tick(100);
      await flush();
      if (completed) break;
    }
    const held = requireHeld(await sequence);

    expect(completed).toBe(true);
    const elapsed = harness.time.now() - startedAt;
    expect(elapsed).toBeLessThanOrEqual(HANDOFF_DRAIN_TIMEOUT_MS + 100);

    // Warn line for the hanging hooks.onShutdown finalizer must be present.
    const warnedHooks = harness.logLines.some((line) => line.includes('hooks.onShutdown: exceeded drain budget'));
    expect(warnedHooks).toBe(true);
    expect(hookSignal).not.toBeNull();
    expect((hookSignal as unknown as AbortSignal).aborted).toBe(true);
    expect(heldFailureDetail(held)).toContain('hooks.onShutdown: timed-out');

    expect(harness.closeIpcCalled()).toBe(false);
  });

  it('delegates a rejected process-exit finalizer after releasing authority', async () => {
    let attempts = 0;
    const requestExit = vi.fn();
    const harness = buildHarness({
      hooksOnShutdown: async () => {
        attempts += 1;
        throw new Error('hook unavailable');
      },
      acceptProcessExitRemainder: (remainder) => ({ kind: 'accepted', remainder, requestExit }),
    });

    const disposition = await runShutdownSequence(harness.ctx);

    expect(disposition).toMatchObject({
      disposition: 'delegated',
      undischarged: [
        {
          label: 'hooks.onShutdown',
          remainder: { owner: 'process-exit' },
          settlement: { cause: 'rejected', detail: expect.stringContaining('hook unavailable') },
        },
      ],
    });
    expect(harness.closeIpcCalled()).toBe(true);
    expect(attempts).toBe(1);
    expect(requestExit).not.toHaveBeenCalled();
  });

  it('releases authority and names the loss when no process-exit owner accepts a rejected finalizer', async () => {
    const harness = buildHarness({
      hooksOnShutdown: async () => {
        throw new Error('hook unavailable');
      },
    });

    const terminal = requireUnaccepted(await runShutdownSequence(harness.ctx));

    expect(terminal.undischarged).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'hooks.onShutdown' }),
        expect.objectContaining({ label: 'process-exit-remainder-acceptance' }),
      ]),
    );
    expect(harness.closeIpcCalled()).toBe(true);
  });

  it('releases authority and names the loss when process exit refuses a rejected finalizer', async () => {
    const harness = buildHarness({
      hooksOnShutdown: async () => {
        throw new Error('hook unavailable');
      },
      acceptProcessExitRemainder: () => ({ kind: 'refused', detail: 'exit owner unavailable' }),
    });

    const terminal = requireUnaccepted(await runShutdownSequence(harness.ctx));

    expect(terminal.undischarged).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'hooks.onShutdown' }),
        expect.objectContaining({ label: 'process-exit-remainder-acceptance' }),
      ]),
    );
    expect(harness.closeIpcCalled()).toBe(true);
    expect(harness.logLines).toContain('process-exit remainder acceptance refused: exit owner unavailable\n');
  });

  it('reports a recovery teardown timeout without rerunning its in-flight settlement', async () => {
    const harness = buildHarness({ hooksOnShutdown: async () => {} });
    let settleTeardown!: () => void;
    let activeTeardown: Promise<void> | null = null;
    let teardownStarts = 0;
    harness.ctx.teardownRecoveryCoordinator = () => {
      if (activeTeardown !== null) return activeTeardown;
      teardownStarts += 1;
      activeTeardown = new Promise<void>((resolve) => {
        settleTeardown = resolve;
      });
      return activeTeardown;
    };

    const sequence = runShutdownSequence(harness.ctx);
    await flush(64);
    expect(teardownStarts).toBe(1);
    harness.time.tick(HANDOFF_DRAIN_TIMEOUT_MS);
    await flush(64);
    const held = requireHeld(await sequence);

    expect(heldFailureDetail(held)).toContain('recovery coordinator teardown: timed-out');
    expect(harness.closeIpcCalled()).toBe(false);
    expect(teardownStarts).toBe(1);
    settleTeardown();
    await flush(64);
    await expect(held.retry()).resolves.toMatchObject({ disposition: 'unaccepted' });
    expect(harness.closeIpcCalled()).toBe(true);
    expect(teardownStarts).toBe(1);
  });

  it('reports kb child shutdown timeout instead of treating it as success', async () => {
    const harness = buildHarness({ hooksOnShutdown: async () => {} });
    let kbSignal: AbortSignal | undefined;
    harness.ctx.kbDaemonSupervisor = {
      dispose: (_reason: string, options?: { signal?: AbortSignal }) => {
        kbSignal = options?.signal;
        return new Promise<void>(() => {});
      },
    } as never;

    const sequence = runShutdownSequence(harness.ctx);
    await flush(64);
    harness.time.tick(HANDOFF_DRAIN_TIMEOUT_MS);
    await flush(64);
    const held = requireHeld(await sequence);

    expect(heldFailureDetail(held)).toContain('kb child shutdown: timed-out');
    expect(held.retainedAuthority.cleanupObligations).toContain('kb child shutdown');
    expect(kbSignal?.aborted).toBe(true);
    expect(harness.closeIpcCalled()).toBe(false);
  });

  it('names an unclosed KB daemon as a terminal loss', async () => {
    const harness = buildHarness({ hooksOnShutdown: async () => {} });
    const retryAfter = new Promise<void>(() => undefined);
    harness.ctx.kbDaemonSupervisor = {
      dispose: vi.fn(async () => ({
        kind: 'holding' as const,
        snapshot: {} as never,
        reason: 'KB daemon process 183 has not been observed absent',
        exit: 'kb-daemon-process-close' as const,
        retryAfter,
        retry: async () => {
          throw new Error('retry requires process close');
        },
      })),
    } as never;

    const sequence = runShutdownSequence(harness.ctx);
    for (let advanced = 0; advanced <= HANDOFF_DRAIN_TIMEOUT_MS + 100; advanced += 100) {
      harness.time.tick(100);
      await flush();
    }
    const terminal = requireUnaccepted(await sequence);

    expect(terminal.undischarged).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: 'kb child shutdown' })]),
    );
    expect(harness.closeIpcCalled()).toBe(true);
  });

  it('holds hard shutdown when provider-host containment exceeds the lifecycle deadline', async () => {
    const stopProviderOperationReconciler = vi.fn(() => ({ kind: 'drained' as const }));
    const harness = buildHarness({
      hooksOnShutdown: async () => {},
      stopProviderOperationReconciler,
    });
    harness.ctx.reason = 'test-teardown';
    let providerSignal: AbortSignal | undefined;
    harness.ctx.providerHostManager = {
      drainForHandoff: async () => ({
        kind: 'provider-hosts-quiesced',
        liveProxySets: [],
        acquisitionCleanupHolds: [],
        closingHosts: [],
      }),
      shutdown: (signal?: AbortSignal) => {
        providerSignal = signal;
        return new Promise<void>(() => {});
      },
    } as never;
    harness.ctx.settlePendingLaunchesFn = () => {
      harness.callLog.push('settlePendingLaunchesFn');
      return { kind: 'all-pending-launches-settled' };
    };
    harness.ctx.terminateRegisteredChildrenFn = () => {
      harness.callLog.push('terminateRegisteredChildrenFn');
      return { kind: 'all-children-observed-absent' };
    };

    const sequence = runShutdownSequence(harness.ctx);
    for (let i = 0; i <= SHUTDOWN_DRAIN_TIMEOUT_MS + 100; i += 100) {
      harness.time.tick(100);
      await flush();
    }
    const held = requireHeld(await sequence);

    const sawExceeded = harness.logLines.some((l) => l.includes('provider host shutdown: exceeded drain budget'));
    expect(sawExceeded).toBe(true);
    expect(heldFailureDetail(held)).toContain('provider host shutdown: timed-out');
    expect(heldFailureDetail(held)).toContain('child termination: budget-exhausted');
    expect(providerSignal?.aborted).toBe(true);
    expect(stopProviderOperationReconciler).not.toHaveBeenCalled();
    expect(harness.callLog).not.toContain('settlePendingLaunchesFn');
    expect(harness.closeIpcCalled()).toBe(false);
  });

  it('names cleanup obligations from an independent snapshot after provider-host shutdown rejects', async () => {
    const harness = buildHarness({ reason: 'test-teardown', hooksOnShutdown: async () => {} });
    const stopAndReap = vi.fn(async () => ({ disappearanceReceipt: 'gone:retained-proxy' }));
    const retry = vi.fn(async () => ({ kind: 'absence-confirmed' as const, strandedArtifacts: [] }));
    const retainedSet = fakeSet('retained-proxy', harness.callLog, { stopAndReap });
    let shutdownAttempts = 0;
    harness.ctx.providerHostManager = {
      drainForHandoff: async () => ({
        kind: 'provider-hosts-quiesced',
        liveProxySets: [],
        acquisitionCleanupHolds: [],
        closingHosts: [],
      }),
      shutdown: async () => {
        shutdownAttempts += 1;
        if (shutdownAttempts === 1) throw new Error('injected provider close failure');
        return {
          kind: 'provider-hosts-quiesced',
          liveProxySets: [retainedSet],
          acquisitionCleanupHolds: [],
          closingHosts: [],
        };
      },
      cleanupObligations: () => ({
        liveProxySets: [retainedSet],
        acquisitionCleanupHolds: [
          {
            kind: 'provider_proxy_acquisition_pending_cleanup',
            owner: 'provider-host-manager',
            target: 'retained-pending-acquisition',
            reason: 'provider host manager stopped before acquisition settled',
            recoveryCapability: { retry },
          },
        ] as never,
        representationReleaseHolds: [],
        closingHosts: [],
      }),
    };

    const terminal = requireUnaccepted(await runShutdownSequence(harness.ctx));

    expect(failureDetail(terminal)).toContain('provider host shutdown: rejected:');

    expect(stopAndReap).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
    expect(harness.closeIpcCalled()).toBe(true);
  });

  it('releases authority when crash terminalization rejects', async () => {
    let acceptedRemainder: ProcessExitRemainder | null = null;
    const harness = buildHarness({
      hooksOnShutdown: async () => {},
      acceptProcessExitRemainder: (remainder) => {
        acceptedRemainder = remainder;
        return { kind: 'accepted', remainder, requestExit: () => undefined };
      },
    });
    harness.ctx.reason = 'test-teardown';
    let terminalizationSignal: AbortSignal | undefined;
    harness.ctx.markJobsAsErrorFn = (_message, signal) => {
      terminalizationSignal = signal;
      harness.callLog.push('markJobsAsErrorFn');
      throw new Error('injected crash terminalization failure');
    };
    harness.ctx.providerHostManager = {
      drainForHandoff: async () => ({
        kind: 'provider-hosts-quiesced',
        liveProxySets: [],
        acquisitionCleanupHolds: [],
        closingHosts: [],
      }),
      shutdown: async () => {
        harness.callLog.push('providerHostManager.shutdown');
        return { kind: 'provider-hosts-quiesced', liveProxySets: [], acquisitionCleanupHolds: [], closingHosts: [] };
      },
    } as never;
    harness.ctx.settlePendingLaunchesFn = () => {
      harness.callLog.push('settlePendingLaunchesFn');
      return { kind: 'all-pending-launches-settled' };
    };
    harness.ctx.terminateRegisteredChildrenFn = () => {
      harness.callLog.push('terminateRegisteredChildrenFn');
      return { kind: 'all-children-observed-absent' };
    };

    const disposition = await runShutdownSequence(harness.ctx);

    expect(terminalizationSignal).toBeInstanceOf(AbortSignal);
    expect(harness.callLog).toContain('providerHostManager.shutdown');
    expect(harness.callLog).toContain('settlePendingLaunchesFn');
    expect(harness.callLog).toContain('terminateRegisteredChildrenFn');
    expect(harness.callLog.indexOf('settlePendingLaunchesFn')).toBeLessThan(
      harness.callLog.indexOf('terminateRegisteredChildrenFn'),
    );
    expect(harness.callLog.indexOf('terminateRegisteredChildrenFn')).toBeLessThan(
      harness.callLog.indexOf('markJobsAsErrorFn'),
    );
    expect(harness.logLines).toContainEqual(expect.stringContaining('crashed job terminalization settlement failed'));
    expect(harness.closeIpcCalled()).toBe(true);
    expect(disposition).toMatchObject({
      disposition: 'delegated',
      undischarged: [
        {
          label: 'crashed job terminalization',
          remainder: { owner: 'successor-recovery', evidence: { kind: 'startup-liveness-recovery' } },
          settlement: { cause: 'rejected', detail: expect.stringContaining('injected crash terminalization failure') },
        },
      ],
    });
    expect(disposition).not.toHaveProperty('owner');
    expect(acceptedRemainder).not.toHaveProperty('owner');
  });

  it('does not terminalize jobs when child containment remains unresolved', async () => {
    const harness = buildHarness({ reason: 'test-teardown', hooksOnShutdown: async () => {} });
    harness.ctx.markJobsAsErrorFn = vi.fn();
    harness.ctx.terminateRegisteredChildrenFn = async () => ({
      kind: 'children-unresolved-at-deadline',
      processes: [{ kind: 'target-alive', pid: 4_242, stage: 'after-sigkill' }],
      cleanupHandles: 1,
      retainedProcesses: [],
      cleanupFailures: 0,
      owner: 'launch-coordinator',
    });

    const terminal = requireUnaccepted(await runShutdownSequence(harness.ctx));

    expect(harness.ctx.markJobsAsErrorFn).not.toHaveBeenCalled();
    expect(failureDetail(terminal)).toContain('child termination: unconfirmed');
    expect(harness.closeIpcCalled()).toBe(true);
  });

  it('keeps pending launch settlement and registered child termination as separate obligations', async () => {
    const harness = buildHarness({ reason: 'test-teardown', hooksOnShutdown: async () => {} });
    const stages: string[] = [];
    harness.ctx.markJobsAsErrorFn = vi.fn();
    harness.ctx.settlePendingLaunchesFn = async () => {
      stages.push('settlePendingLaunchesFn');
      return {
        kind: 'pending-launches-unresolved-at-deadline',
        pendingLaunches: 1,
        retainedLaunches: [
          {
            kind: 'awaiting-wrapper-identity',
            owner: 'process-exit',
            provider: 'codex',
            jobId: 'pending-job',
            jobDir: '/tmp/coral/jobs/pending-job',
          },
        ],
        owner: 'launch-coordinator',
      };
    };
    harness.ctx.terminateRegisteredChildrenFn = async () => {
      stages.push('terminateRegisteredChildrenFn');
      return {
        kind: 'children-unresolved-at-deadline',
        processes: [{ kind: 'target-alive', pid: 4_242, stage: 'after-sigkill' }],
        cleanupHandles: 1,
        retainedProcesses: [
          {
            kind: 'recorded-wrapper-group',
            provider: 'claude',
            jobId: 'published-job',
            jobDir: '/tmp/coral/jobs/published-job',
            publication: {
              kind: 'durably-published',
              owner: 'successor-recovery',
              evidence: {
                kind: 'durable-cli-runtime',
                jobId: 'published-job',
                pid: 4_242,
                leaderIncarnation: testIncarnation('published-child'),
              },
            },
            containment: {
              pid: 4_242,
              incarnation: testIncarnation('published-child'),
              processGroupId: 4_242,
              childRoot: null,
            },
          },
        ],
        cleanupFailures: 0,
        owner: 'launch-coordinator',
      };
    };

    const terminal = requireUnaccepted(await runShutdownSequence(harness.ctx));
    const detail = failureDetail(terminal);

    expect(stages).toEqual(['settlePendingLaunchesFn', 'terminateRegisteredChildrenFn']);
    expect(detail).toContain('pending launch settlement: unconfirmed');
    expect(detail).toContain('child termination: unconfirmed');
    expect(detail).not.toContain('coral-cli abort jobs');
    expect(terminal.undischarged).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'pending launch settlement' }),
        expect.objectContaining({ label: 'child termination' }),
      ]),
    );
    expect(harness.ctx.markJobsAsErrorFn).not.toHaveBeenCalled();
    expect(harness.closeIpcCalled()).toBe(true);
  });

  it('derives successor-recovery when every retained child is durably published', async () => {
    const harness = buildHarness({ reason: 'test-teardown', hooksOnShutdown: async () => {} });
    const evidence = {
      kind: 'durable-cli-runtime',
      jobId: 'published-job',
      pid: 4_242,
      leaderIncarnation: testIncarnation('published-child'),
    } as const;
    harness.ctx.terminateRegisteredChildrenFn = async () => ({
      kind: 'children-unresolved-at-deadline',
      processes: [{ kind: 'target-alive', pid: 4_242, stage: 'after-sigkill' }],
      cleanupHandles: 1,
      retainedProcesses: [
        retainedChild('published-job', 4_242, { kind: 'durably-published', owner: 'successor-recovery', evidence }),
      ],
      cleanupFailures: 0,
      owner: 'launch-coordinator',
    });

    const terminal = requireUnaccepted(await runShutdownSequence(harness.ctx));

    expect(terminal.undischarged).toContainEqual(
      expect.objectContaining({
        label: 'child termination',
        remainder: {
          owner: 'successor-recovery',
          evidence: { kind: 'startup-adoption', processes: [evidence] },
        },
      }),
    );
    expect(failureDetail(terminal)).toContain('codex:/tmp/coral/jobs/published-job pgid 4242 durably-published');
  });

  it('keeps child termination on process exit when any retained child is observed unpublished', async () => {
    const harness = buildHarness({ reason: 'test-teardown', hooksOnShutdown: async () => {} });
    harness.ctx.terminateRegisteredChildrenFn = async () => ({
      kind: 'children-unresolved-at-deadline',
      processes: [],
      cleanupHandles: 2,
      retainedProcesses: [
        retainedChild('published-job', 4_242, {
          kind: 'durably-published',
          owner: 'successor-recovery',
          evidence: {
            kind: 'durable-cli-runtime',
            jobId: 'published-job',
            pid: 4_242,
            leaderIncarnation: testIncarnation('published-child'),
          },
        }),
        retainedChild('unpublished-job', 4_243, {
          kind: 'observed-unpublished',
          owner: 'process-exit',
          publicationLoss: 'runtime publication failed: SQLITE_BUSY',
        }),
      ],
      cleanupFailures: 0,
      owner: 'launch-coordinator',
    });

    const terminal = requireUnaccepted(await runShutdownSequence(harness.ctx));

    expect(terminal.undischarged).toContainEqual(
      expect.objectContaining({ label: 'child termination', remainder: { owner: 'process-exit' } }),
    );
    expect(failureDetail(terminal)).toContain(
      'codex:/tmp/coral/jobs/unpublished-job pgid 4243 observed-unpublished: runtime publication failed: SQLITE_BUSY',
    );
  });

  it('keeps child termination on process exit when its disposition was never observed', () => {
    expect(childTerminationRemainder(null)).toEqual({ owner: 'process-exit' });
    expect(childTerminationRemainder({ kind: 'all-children-observed-absent' })).toEqual({ owner: 'process-exit' });
  });

  it('holds hard shutdown and names a durable child that remains alive at the deadline', async () => {
    const harness = buildHarness({ reason: 'test-teardown', hooksOnShutdown: async () => {} });
    harness.ctx.terminateRegisteredChildrenFn = async () => ({
      kind: 'children-unresolved-at-deadline',
      processes: [{ kind: 'target-alive', pid: 4_242, stage: 'after-sigkill' }],
      cleanupHandles: 1,
      retainedProcesses: [],
      cleanupFailures: 0,
      owner: 'launch-coordinator',
    });

    const detail = await shutdownFailureDetail(harness.ctx);

    expect(detail).toContain('child termination: unconfirmed');
    expect(detail).toContain('pid 4242: target-alive after-sigkill');
  });

  it('holds hard shutdown and names unavailable signal authority at the deadline', async () => {
    const harness = buildHarness({ reason: 'test-teardown', hooksOnShutdown: async () => {} });
    harness.ctx.terminateRegisteredChildrenFn = async () => ({
      kind: 'children-unresolved-at-deadline',
      processes: [
        {
          kind: 'signal-refused',
          pid: 4_243,
          reason: 'recorded-incarnation-unavailable',
        },
      ],
      cleanupHandles: 1,
      retainedProcesses: [],
      cleanupFailures: 0,
      owner: 'launch-coordinator',
    });

    const detail = await shutdownFailureDetail(harness.ctx);

    expect(detail).toContain('child termination: unconfirmed');
    expect(detail).toContain('pid 4243: recorded-incarnation-unavailable');
  });

  it('continues remaining hard teardown when child liveness is unobservable', async () => {
    const harness = buildHarness({ reason: 'test-teardown', hooksOnShutdown: async () => {} });
    harness.ctx.terminateRegisteredChildrenFn = async () => ({
      kind: 'children-unresolved-at-deadline',
      processes: [{ kind: 'target-unobservable', pid: 4_244, stage: 'after-sigkill' }],
      cleanupHandles: 1,
      retainedProcesses: [],
      cleanupFailures: 0,
      owner: 'launch-coordinator',
    });
    harness.ctx.hooks = {
      onShutdown: async () => {
        harness.callLog.push('hooks.onShutdown');
      },
    };
    harness.ctx.discussStores.set('retained', {
      dispose: () => {
        harness.callLog.push('discuss.dispose');
      },
    } as never);

    const terminal = requireUnaccepted(await runShutdownSequence(harness.ctx));
    expect(harness.callLog).toContain('discuss.dispose');
    expect(failureDetail(terminal)).toContain('child termination:');
    expect(harness.closeIpcCalled()).toBe(true);
  });

  it('emits a budget-exhausted skip log for finalizers reached after the deadline', async () => {
    const harness = buildHarness({});
    harness.ctx.providerHostManager = {
      drainForHandoff: () => new Promise<void>(() => {}),
      shutdown: async () => ({
        kind: 'provider-hosts-quiesced',
        liveProxySets: [],
        acquisitionCleanupHolds: [],
        closingHosts: [],
      }),
    } as never;

    const sequence = runShutdownSequence(harness.ctx);
    for (let i = 0; i <= HANDOFF_DRAIN_TIMEOUT_MS + 100; i += 200) {
      harness.time.tick(200);
      await flush();
    }
    const held = requireHeld(await sequence);

    const sawExceeded = harness.logLines.some((l) =>
      l.includes('provider host drain for handoff: exceeded drain budget'),
    );
    const sawSkipped = harness.logLines.some((l) => l.includes('hooks.onShutdown: skipped (drain budget exhausted)'));
    expect(sawExceeded).toBe(true);
    expect(sawSkipped).toBe(true);
    expect(heldFailureDetail(held)).toContain('provider host drain for handoff: timed-out');
    expect(harness.closeIpcCalled()).toBe(false);
  });

  it('returns a hold when a wrapped finalizer expires without settling', async () => {
    const harness = buildHarness({
      hooksOnShutdown: () => new Promise<void>(() => {}),
    });

    const order: string[] = [];
    const origHooks = harness.ctx.hooks.onShutdown;
    harness.ctx.hooks = {
      onShutdown: async (_mode, signal) => {
        order.push('hooks:start');
        await origHooks('hard', signal);
        order.push('hooks:resolved');
      },
    };
    const origDrain = harness.ctx.providerHostManager.drainForHandoff;
    harness.ctx.providerHostManager = {
      drainForHandoff: async () => {
        order.push('drainForHandoff:start');
        const receipt = await origDrain();
        order.push('drainForHandoff:resolved');
        return receipt;
      },
      shutdown: async () => ({
        kind: 'provider-hosts-quiesced',
        liveProxySets: [],
        acquisitionCleanupHolds: [],
        closingHosts: [],
      }),
    } as never;
    harness.ctx.closeIpcServerFn = async (_l: IpcListener) => {
      order.push('closeIpc');
    };

    const sequence = runShutdownSequence(harness.ctx);
    for (let i = 0; i <= HANDOFF_DRAIN_TIMEOUT_MS + 100; i += 100) {
      harness.time.tick(100);
      await flush();
    }
    const held = requireHeld(await sequence);

    expect(order).toContain('hooks:start');
    expect(order).not.toContain('closeIpc');
    expect(heldFailureDetail(held)).toContain('hooks.onShutdown: timed-out');
  });

  it('returns a hold after a synchronous finalizer exhausts the budget', async () => {
    const harness = buildHarness({});
    harness.ctx.hooks = {
      onShutdown: async () => {
        harness.time.tick(HANDOFF_DRAIN_TIMEOUT_MS + 5_000);
      },
    };

    const sequence = runShutdownSequence(harness.ctx);
    for (let i = 0; i < 10; i += 1) {
      await flush();
      harness.time.tick(100);
    }
    const held = requireHeld(await sequence);

    expect(heldFailureDetail(held)).toContain('lifecycle reactor dispose: budget-exhausted');
    expect(harness.closeIpcCalled()).toBe(false);
  });

  it('lifecycle finalizes synchronously after a settled shutdown sequence', () => {
    const lifecyclePath = fileURLToPath(new URL('../../../src/coordinator/lifecycle.ts', import.meta.url));
    const source = readFileSync(lifecyclePath, 'utf-8');
    const sequenceResolution = source.indexOf('state.shutdownRetry = null;');
    const finalization = source.indexOf(
      "return finalizeStoppedLifecycle({ disposition: 'finalized' });",
      sequenceResolution,
    );

    expect(sequenceResolution).toBeGreaterThan(-1);
    expect(finalization).toBeGreaterThan(sequenceResolution);
    expect(source.slice(sequenceResolution, finalization)).not.toContain('await');
  });

  it('cancels a discharged row timeout before a later row exhausts the sequence budget', async () => {
    const time = new VirtualTime();
    const logLines: string[] = [];
    const dischargedTask = vi.fn(async () => ({ confirmed: true as const }));
    const discharged: ShutdownObligation = {
      label: 'completed finalizer',
      task: dischargedTask,
      retainedAuthority: () => ({}),
      remainder: () => ({ owner: 'process-exit' }),
    };
    const later: ShutdownObligation = {
      label: 'later cleanup',
      task: async () => ({ confirmed: true }),
      retainedAuthority: () => ({ cleanupObligations: ['later cleanup'] }),
      remainder: () => ({ owner: 'process-exit' }),
    };
    const authorityToken = {};
    const authorityRelease: ShutdownAuthorityReleaseBoundary = {
      label: 'authority release',
      prepare: () => Promise.resolve({ confirmed: true, token: authorityToken }),
      commit: () => Promise.resolve({ confirmed: true }),
      retainedAuthority: () => ({ cleanupObligations: ['authority release'] }),
      hold: () => ({ reason: 'required-shutdown-step-unsettled', exit: 'shutdown-budget-exhaustion' }),
    };
    const ledger = createShutdownSettlementLedger({
      budgetMs: 1_000,
      time,
      log: (line) => logLines.push(line),
      pollMs: 50,
    });

    await expect(ledger.run(discharged)).resolves.toEqual({ kind: 'discharged' });
    time.tick(1_001);
    await expect(ledger.run(later)).resolves.toMatchObject({ kind: 'declined', cause: 'budget-exhausted' });
    const held = requireHeld(await ledger.gate(authorityRelease));

    expect(dischargedTask).toHaveBeenCalledOnce();
    expect(logLines).not.toContainEqual(expect.stringContaining('completed finalizer: exceeded drain budget'));
    expect(heldFailureDetail(held)).not.toContain('completed finalizer');
    expect(heldFailureDetail(held)).toContain('later cleanup: budget-exhausted');
  });

  it('uses monotonic time for the initial budget and every retry budget', async () => {
    const scheduler = new VirtualTime();
    const wallNow = vi.fn(() => {
      throw new Error('wall time must not drive settlement budgets');
    });
    const time = {
      now: wallNow,
      monotonicNow: () => scheduler.monotonicNow(),
      sleep: scheduler.sleep.bind(scheduler),
    };
    let attempts = 0;
    const retrying: ShutdownObligation = {
      label: 'retrying finalizer',
      task: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('retry required');
        return { confirmed: true };
      },
      retainedAuthority: () => ({ cleanupObligations: ['retrying finalizer'] }),
      remainder: () => ({ owner: 'process-exit' }),
    };
    const authorityToken = {};
    const boundary: ShutdownAuthorityReleaseBoundary = {
      label: 'authority release',
      prepare: () => Promise.resolve({ confirmed: true, token: authorityToken }),
      commit: () => Promise.resolve({ confirmed: true }),
      retainedAuthority: () => ({ ipcSocket: true, cleanupObligations: ['authority release'] }),
      hold: () => ({ reason: 'required-shutdown-step-unsettled', exit: 'shutdown-budget-exhaustion' }),
    };
    const ledger = createShutdownSettlementLedger({ budgetMs: 900, time, log: () => {}, pollMs: 50 });

    await expect(ledger.run(retrying)).resolves.toMatchObject({ kind: 'declined', cause: 'rejected' });
    const terminal = requireUnaccepted(await ledger.gate(boundary));

    expect(failureDetail(terminal)).toContain('retrying finalizer: rejected:');
    expect(attempts).toBe(1);
    expect(wallNow).not.toHaveBeenCalled();
  });

  it('disposes the lifecycle reactor before releasing the IPC socket', async () => {
    const harness = buildHarness({
      hooksOnShutdown: async () => {},
    });
    harness.ctx.closeIpcServerFn = async () => {
      harness.callLog.push('closeIpcServerFn:start');
    };

    await runShutdownSequence(harness.ctx);

    expect(harness.callLog).toContain('lifecycleReactor.dispose');
    expect(harness.callLog.indexOf('lifecycleReactor.dispose')).toBeLessThan(
      harness.callLog.indexOf('closeIpcServerFn:start'),
    );
  });

  it('releases hard-mode IPC and provider control after naming unresolved child cleanup', async () => {
    const authorityCalls: string[] = [];
    const set = fakeSet('hard-held', authorityCalls);
    const harness = buildHarness({ reason: 'test-teardown', hooksOnShutdown: async () => {} });
    harness.ctx.providerHostManager = {
      drainForHandoff: async () => ({
        kind: 'provider-hosts-quiesced',
        liveProxySets: [],
        acquisitionCleanupHolds: [],
        closingHosts: [],
      }),
      shutdown: async () => ({
        kind: 'provider-hosts-quiesced',
        liveProxySets: [set],
        acquisitionCleanupHolds: [],
        closingHosts: [],
      }),
    };
    harness.ctx.closeIpcServerFn = async () => {
      authorityCalls.push('closeIpc');
    };
    let childCleanupAttempts = 0;
    harness.ctx.terminateRegisteredChildrenFn = async () => {
      childCleanupAttempts += 1;
      return childCleanupAttempts === 1
        ? {
            kind: 'children-unresolved-at-deadline',
            processes: [{ kind: 'target-alive', pid: 4_242, stage: 'after-sigkill' }],
            cleanupHandles: 1,
            retainedProcesses: [
              {
                kind: 'recorded-wrapper-group',
                provider: 'claude',
                jobId: 'hard-held-job',
                jobDir: '/tmp/coral/jobs/hard-held-job',
                publication: {
                  kind: 'durably-published',
                  owner: 'successor-recovery',
                  evidence: {
                    kind: 'durable-cli-runtime',
                    jobId: 'hard-held-job',
                    pid: 4_242,
                    leaderIncarnation: testIncarnation('hard-held-child'),
                  },
                },
                containment: {
                  pid: 4_242,
                  incarnation: testIncarnation('hard-held-child'),
                  processGroupId: 4_242,
                  childRoot: null,
                },
              },
            ],
            cleanupFailures: 0,
            owner: 'launch-coordinator',
          }
        : { kind: 'all-children-observed-absent' };
    };

    const terminal = requireUnaccepted(await runShutdownSequence(harness.ctx));

    expect(failureDetail(terminal)).toContain('child termination: unconfirmed:');
    expect(childCleanupAttempts).toBe(1);
    expect(authorityCalls).toEqual(['reap:hard-held', 'heartbeats:hard-held', 'control:hard-held', 'closeIpc']);
  });

  it('releases handoff IPC and provider control after naming a failed host drain', async () => {
    const authorityCalls: string[] = [];
    const set = fakeSet('handoff-held', authorityCalls);
    const harness = buildHarness({ reason: 'replaced', hooksOnShutdown: async () => {} });
    let drainAttempts = 0;
    harness.ctx.providerHostManager = {
      drainForHandoff: async () => {
        drainAttempts += 1;
        if (drainAttempts === 1) throw new Error('drain unavailable');
        return {
          kind: 'provider-hosts-quiesced',
          liveProxySets: [set],
          acquisitionCleanupHolds: [],
          closingHosts: [],
        };
      },
      shutdown: async () => ({
        kind: 'provider-hosts-quiesced',
        liveProxySets: [],
        acquisitionCleanupHolds: [],
        closingHosts: [],
      }),
      cleanupObligations: () => ({
        liveProxySets: [set],
        acquisitionCleanupHolds: [],
        representationReleaseHolds: [],
        closingHosts: [],
      }),
    };
    harness.ctx.closeIpcServerFn = async () => {
      authorityCalls.push('closeIpc');
    };

    const terminal = requireUnaccepted(await runShutdownSequence(harness.ctx));

    expect(failureDetail(terminal)).toContain('provider host drain for handoff: rejected:');
    expect(drainAttempts).toBe(1);
    expect(authorityCalls).toEqual(['heartbeats:handoff-held', 'control:handoff-held', 'closeIpc']);
  });

  it('names declined app-server quiescence and releases authority without an operator action', async () => {
    const authorityCalls: string[] = [];
    const harness = buildHarness({
      reason: 'replaced',
      hooksOnShutdown: async () => {},
    });
    harness.ctx.handoffQuiescePorts = () => [
      { quiesceAppServerJobsForHandoff: async () => Promise.reject(new Error('quiescence unavailable')) },
    ];
    harness.ctx.closeIpcServerFn = async () => {
      authorityCalls.push('closeIpc');
    };

    const terminal = requireUnaccepted(await runShutdownSequence(harness.ctx));
    expect(failureDetail(terminal)).toContain(
      'app-server handoff quiesce: unconfirmed: port 1: Error: quiescence unavailable',
    );
    expect(authorityCalls).toEqual(['closeIpc']);
  });

  it('retries only unresolved provider-control capabilities', async () => {
    const authorityCalls: string[] = [];
    let firstControlAttempts = 0;
    const first = fakeSet('first', authorityCalls, {
      initiateControlClose: async () => {
        firstControlAttempts += 1;
        authorityCalls.push('control:first');
        if (firstControlAttempts === 1) throw new Error('injected first control failure');
      },
    });
    const second = fakeSet('second', authorityCalls);
    const harness = buildHarness({
      reason: 'replaced',
      hooksOnShutdown: async () => {},
      providerProxyAuthority: registryOf([first, second]),
    });
    harness.ctx.closeIpcServerFn = async () => {
      authorityCalls.push('closeIpc');
    };

    const held = await runShutdownSequence(harness.ctx);

    expect(held).toMatchObject({
      disposition: 'held',
      retainedAuthority: { providerControlProxyInstanceIds: ['first'], ipcSocket: true },
    });
    if (held.disposition !== 'held') throw new Error('expected held shutdown finalization');
    await expect(held.retry()).resolves.toEqual({ disposition: 'settled' });
    expect(authorityCalls.filter((call) => call === 'heartbeats:first')).toHaveLength(1);
    expect(authorityCalls.filter((call) => call === 'heartbeats:second')).toHaveLength(1);
    expect(authorityCalls.filter((call) => call === 'control:first')).toHaveLength(2);
    expect(authorityCalls.filter((call) => call === 'control:second')).toHaveLength(1);
    expect(authorityCalls.filter((call) => call === 'closeIpc')).toHaveLength(1);
  });

  it('joins an in-flight authority release instead of invoking it again after timeout', async () => {
    let settleControl!: () => void;
    const controlSettlement = new Promise<void>((resolve) => {
      settleControl = resolve;
    });
    const authorityCalls: string[] = [];
    const set = fakeSet('slow-control', authorityCalls, {
      initiateControlClose: () => {
        authorityCalls.push('control:slow-control');
        return controlSettlement;
      },
    });
    const harness = buildHarness({
      reason: 'replaced',
      hooksOnShutdown: async () => {},
      providerProxyAuthority: registryOf([set]),
    });
    harness.ctx.closeIpcServerFn = async () => {
      authorityCalls.push('closeIpc');
    };

    const sequence = runShutdownSequence(harness.ctx);
    for (let attempt = 0; attempt < 10 && !authorityCalls.includes('control:slow-control'); attempt += 1) {
      await flush();
    }
    expect(authorityCalls).toContain('control:slow-control');
    harness.time.tick(HANDOFF_DRAIN_TIMEOUT_MS);
    await flush();
    const held = await sequence;
    if (held.disposition !== 'held') throw new Error('expected held shutdown finalization');

    const retry = held.retry();
    await flush();
    expect(authorityCalls.filter((call) => call === 'control:slow-control')).toHaveLength(1);
    settleControl();
    await expect(retry).resolves.toEqual({ disposition: 'settled' });
    expect(authorityCalls.filter((call) => call === 'control:slow-control')).toHaveLength(1);
    expect(authorityCalls.filter((call) => call === 'closeIpc')).toHaveLength(1);
    expect(harness.callLog.filter((call) => call === 'lifecycleReactor.dispose')).toHaveLength(1);
  });

  it('snapshots handoff cleanup obligations as named losses after drain failure', async () => {
    const authorityCalls: string[] = [];
    const retainedSet = fakeSet('handoff-drain-held', authorityCalls);
    const retryAcquisition = vi.fn(async () => ({ kind: 'absence-confirmed' as const, strandedArtifacts: [] }));
    const acquisitionHold = {
      kind: 'provider_proxy_acquisition_pending_cleanup' as const,
      owner: 'provider-host-manager' as const,
      target: 'pending-handoff-acquisition',
      reason: 'drain failed before acquisition settled',
      recoveryCapability: { retry: retryAcquisition },
    };
    const harness = buildHarness({ reason: 'replaced', hooksOnShutdown: async () => {} });
    let drainAttempts = 0;
    harness.ctx.providerHostManager = {
      drainForHandoff: async () => {
        drainAttempts += 1;
        if (drainAttempts === 1) throw new Error('injected drain failure');
        return {
          kind: 'provider-hosts-quiesced',
          liveProxySets: [retainedSet],
          acquisitionCleanupHolds: [acquisitionHold],
          closingHosts: [],
        };
      },
      shutdown: async () => ({
        kind: 'provider-hosts-quiesced',
        liveProxySets: [],
        acquisitionCleanupHolds: [],
        closingHosts: [],
      }),
      cleanupObligations: () => ({
        liveProxySets: [retainedSet],
        acquisitionCleanupHolds: [acquisitionHold],
        representationReleaseHolds: [],
        closingHosts: [],
      }),
    };
    harness.ctx.closeIpcServerFn = async () => {
      authorityCalls.push('closeIpc');
    };

    const terminal = requireUnaccepted(await runShutdownSequence(harness.ctx));

    expect(failureDetail(terminal)).toContain('provider host drain for handoff: rejected:');
    expect(retryAcquisition).not.toHaveBeenCalled();
    expect(authorityCalls).toEqual(['heartbeats:handoff-drain-held', 'control:handoff-drain-held', 'closeIpc']);
  });
});

describe('settlement ledger exit gate', () => {
  it('does not rerun a timed-out non-abort-aware obligation', async () => {
    const time = new VirtualTime();
    let settleTask!: (confirmation: { confirmed: true }) => void;
    const taskSettlement = new Promise<{ confirmed: true }>((resolve) => {
      settleTask = resolve;
    });
    const task = vi.fn(() => taskSettlement);
    const obligation: ShutdownObligation = {
      label: 'deferred finalizer',
      task,
      retainedAuthority: () => ({ cleanupObligations: ['deferred finalizer'] }),
      remainder: () => ({ owner: 'process-exit' }),
    };
    const authorityToken = {};
    const authorityRelease: ShutdownAuthorityReleaseBoundary = {
      label: 'authority release',
      prepare: () => Promise.resolve({ confirmed: true, token: authorityToken }),
      commit: () => Promise.resolve({ confirmed: true }),
      retainedAuthority: () => ({ ipcSocket: true, cleanupObligations: ['authority release'] }),
      hold: () => ({ reason: 'required-shutdown-step-unsettled', exit: 'shutdown-budget-exhaustion' }),
    };
    const ledger = createShutdownSettlementLedger({ budgetMs: 100, time, log: () => {}, pollMs: 10 });

    const initial = ledger.run(obligation);
    await flush();
    time.tick(100);
    await expect(initial).resolves.toMatchObject({ kind: 'declined', cause: 'timed-out' });
    const held = requireHeld(await ledger.gate(authorityRelease));
    const terminal = requireUnaccepted(await held.retry());

    expect(task).toHaveBeenCalledOnce();
    expect(failureDetail(terminal)).toContain('deferred finalizer: timed-out: exceeded 100ms');
    settleTask({ confirmed: true });
    await flush();
    expect(task).toHaveBeenCalledOnce();
  });

  it('prepares and commits authority release before reporting an unaccepted remainder', async () => {
    const time = new VirtualTime();
    const authorityPreparationTask = vi.fn(async () => ({ confirmed: true as const, token: {} }));
    const authorityReleaseTask = vi.fn(async () => ({ confirmed: true as const }));
    const blocked: ShutdownObligation = {
      label: 'commit-started recovery finalization',
      task: async () => {
        throw new Error('still committing');
      },
      retainedAuthority: () => ({ ipcSocket: true, cleanupObligations: ['commit-started finalization'] }),
      remainder: () => ({ owner: 'process-exit' }),
    };
    const authorityRelease: ShutdownAuthorityReleaseBoundary = {
      label: 'authority release',
      prepare: authorityPreparationTask,
      commit: authorityReleaseTask,
      retainedAuthority: () => ({ ipcSocket: true, cleanupObligations: ['authority release'] }),
      hold: () => ({ reason: 'required-shutdown-step-unsettled', exit: 'shutdown-budget-exhaustion' }),
    };
    const ledger = createShutdownSettlementLedger({ budgetMs: 1_000, time, log: () => {}, pollMs: 50 });

    await expect(ledger.run(blocked)).resolves.toMatchObject({ kind: 'declined', cause: 'rejected' });
    const terminal = requireUnaccepted(await ledger.gate(authorityRelease));

    expect(authorityPreparationTask).toHaveBeenCalledOnce();
    expect(authorityReleaseTask).toHaveBeenCalledOnce();
    expect(failureDetail(terminal)).toContain('commit-started recovery finalization: rejected:');
  });

  it('retries only the boundary before transferring the exact final process-exit remainder', async () => {
    const time = new VirtualTime();
    const retryOrder: string[] = [];
    const hangingTask = vi.fn(() => {
      retryOrder.push('process-exit');
      return new Promise<never>(() => {});
    });
    const laterTask = vi.fn(async () => {
      retryOrder.push('later');
      return { confirmed: true as const };
    });
    const authorityReleaseTask = vi.fn(async () => {
      retryOrder.push('commit');
      return { confirmed: true as const };
    });
    const hanging: ShutdownObligation = {
      label: 'process-exit finalizer',
      task: hangingTask,
      retainedAuthority: () => ({ cleanupObligations: ['process-exit finalizer'] }),
      remainder: () => ({ owner: 'process-exit' }),
    };
    const later: ShutdownObligation = {
      label: 'later finalizer',
      task: laterTask,
      retainedAuthority: () => ({ cleanupObligations: ['later finalizer'] }),
      remainder: () => ({ owner: 'process-exit' }),
    };
    const authorityToken = {};
    const authorityPrepareTask = vi.fn(() => {
      retryOrder.push('prepare');
      return Promise.resolve({ confirmed: true as const, token: authorityToken });
    });
    const authorityRelease: ShutdownAuthorityReleaseBoundary = {
      label: 'authority release',
      prepare: authorityPrepareTask,
      commit: authorityReleaseTask,
      retainedAuthority: () => ({ ipcSocket: true, cleanupObligations: ['authority release'] }),
      hold: () => ({ reason: 'required-shutdown-step-unsettled', exit: 'shutdown-budget-exhaustion' }),
    };
    const requestExit = vi.fn();
    let offeredRemainder: ProcessExitRemainder | null = null;
    const ledger = createShutdownSettlementLedger({
      budgetMs: 900,
      time,
      log: () => {},
      pollMs: 50,
      acceptProcessExitRemainder: (remainder) => {
        retryOrder.push('accept');
        offeredRemainder = remainder;
        return { kind: 'accepted', remainder, requestExit };
      },
    });

    const firstAttempt = ledger.run(hanging);
    await flush();
    time.tick(900);
    await expect(firstAttempt).resolves.toMatchObject({ kind: 'declined', cause: 'timed-out' });
    await expect(ledger.run(later)).resolves.toMatchObject({ kind: 'declined', cause: 'budget-exhausted' });
    const held = requireHeld(await ledger.gate(authorityRelease));
    retryOrder.length = 0;

    const retry = held.retry();
    await flush();
    expect(laterTask).not.toHaveBeenCalled();
    expect(authorityPrepareTask).toHaveBeenCalledOnce();
    expect(hangingTask).toHaveBeenCalledOnce();
    expect(authorityReleaseTask).toHaveBeenCalledOnce();
    expect(retryOrder).toEqual(['prepare', 'commit', 'accept']);
    const retried = await retry;

    expect(retried).toMatchObject({
      disposition: 'delegated',
      undischarged: expect.arrayContaining([
        expect.objectContaining({ label: 'process-exit finalizer', remainder: { owner: 'process-exit' } }),
        expect.objectContaining({ label: 'later finalizer', remainder: { owner: 'process-exit' } }),
      ]),
    });
    if (retried.disposition !== 'delegated') throw new Error('expected delegated shutdown');
    expect(laterTask).not.toHaveBeenCalled();
    expect(authorityReleaseTask).toHaveBeenCalledOnce();
    expect(retried.acceptance.remainder).toBe(offeredRemainder);
    expect(retried.undischarged).toEqual(retried.acceptance.remainder.undischarged);
    expect(retried.undischarged[0]?.settlement).toEqual({ cause: 'timed-out', detail: 'exceeded 900ms' });
    expect(retryOrder).toEqual(['prepare', 'commit', 'accept']);
    expect(requestExit).not.toHaveBeenCalled();
  });

  it('retries only authority preparation and commit before accepting the final remainder', async () => {
    const time = new VirtualTime();
    const processExitTask = vi.fn(async () => {
      throw new Error('process finalizer unavailable');
    });
    const processExit: ShutdownObligation = {
      label: 'process-exit finalizer',
      task: processExitTask,
      retainedAuthority: () => ({ cleanupObligations: ['process-exit finalizer'] }),
      remainder: () => ({ owner: 'process-exit' }),
    };
    const tokens = [{}, {}];
    const commit = vi
      .fn<ShutdownAuthorityReleaseBoundary['commit']>()
      .mockResolvedValueOnce({ confirmed: false, detail: 'IPC release pending' })
      .mockResolvedValueOnce({ confirmed: true });
    const prepare = vi.fn<ShutdownAuthorityReleaseBoundary['prepare']>(() => {
      const token = tokens.shift();
      if (token === undefined) throw new Error('unexpected authority preparation');
      return Promise.resolve({ confirmed: true, token });
    });
    const boundary: ShutdownAuthorityReleaseBoundary = {
      label: 'authority release',
      prepare,
      commit,
      retainedAuthority: () => ({ ipcSocket: true, cleanupObligations: ['authority release'] }),
      hold: () => ({ reason: 'required-shutdown-step-unsettled', exit: 'shutdown-budget-exhaustion' }),
    };
    const requestExit = vi.fn();
    const accept = vi.fn(
      (remainder: ProcessExitRemainder): ProcessExitRemainderAcceptance => ({
        kind: 'accepted',
        remainder,
        requestExit,
      }),
    );
    const ledger = createShutdownSettlementLedger({
      budgetMs: 900,
      time,
      log: () => {},
      pollMs: 50,
      acceptProcessExitRemainder: accept,
    });

    await expect(ledger.run(processExit)).resolves.toMatchObject({ kind: 'declined', cause: 'rejected' });
    const held = requireHeld(await ledger.gate(boundary));

    expect(held).toMatchObject({
      disposition: 'held',
      retainedAuthority: {
        ipcSocket: true,
        cleanupObligations: ['process-exit finalizer', 'authority release'],
      },
    });
    expect(accept).not.toHaveBeenCalled();

    const delegated = await held.retry();

    expect(delegated).toMatchObject({ disposition: 'delegated' });
    if (delegated.disposition !== 'delegated') throw new Error('expected delegated shutdown');
    expect(delegated.undischarged).toEqual(delegated.acceptance.remainder.undischarged);
    expect(delegated.undischarged).not.toContainEqual(expect.objectContaining({ label: 'authority release' }));
    expect(processExitTask).toHaveBeenCalledOnce();
    expect(accept).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenCalledTimes(2);
    expect(requestExit).not.toHaveBeenCalled();
  });

  it('retains authority without soliciting process-exit ownership when preparation fails', async () => {
    const time = new VirtualTime();
    const processExit: ShutdownObligation = {
      label: 'process-exit finalizer',
      task: async () => {
        throw new Error('process finalizer unavailable');
      },
      retainedAuthority: () => ({ cleanupObligations: ['process-exit finalizer'] }),
      remainder: () => ({ owner: 'process-exit' }),
    };
    const accept = vi.fn<(remainder: ProcessExitRemainder) => ProcessExitRemainderAcceptance>();
    const commit = vi.fn<ShutdownAuthorityReleaseBoundary['commit']>();
    const boundary: ShutdownAuthorityReleaseBoundary = {
      label: 'authority release',
      prepare: () => Promise.resolve({ confirmed: false, detail: 'authority snapshot unavailable' }),
      commit,
      retainedAuthority: () => ({ ipcSocket: true, cleanupObligations: ['authority release'] }),
      hold: () => ({ reason: 'required-shutdown-step-unsettled', exit: 'shutdown-budget-exhaustion' }),
    };
    const ledger = createShutdownSettlementLedger({
      budgetMs: 900,
      time,
      log: () => {},
      pollMs: 50,
      acceptProcessExitRemainder: accept,
    });

    await expect(ledger.run(processExit)).resolves.toMatchObject({ kind: 'declined', cause: 'rejected' });
    const held = requireHeld(await ledger.gate(boundary));

    expect(held.retainedAuthority).toMatchObject({
      ipcSocket: true,
      cleanupObligations: ['process-exit finalizer', 'authority release'],
    });
    expect(accept).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it('names an acceptance identity mismatch and still releases authority', async () => {
    const time = new VirtualTime();
    const logLines: string[] = [];
    const obligation: ShutdownObligation = {
      label: 'startup recovery handoff',
      task: async () => {
        throw new Error('successor not accepted');
      },
      retainedAuthority: () => ({ cleanupObligations: ['startup recovery handoff'] }),
      remainder: () => ({ owner: 'successor-recovery', evidence: { kind: 'startup-store-recovery' } }),
    };
    const commit = vi.fn<ShutdownAuthorityReleaseBoundary['commit']>(async () => ({ confirmed: true }));
    const boundary: ShutdownAuthorityReleaseBoundary = {
      label: 'authority release',
      prepare: () => Promise.resolve({ confirmed: true, token: {} }),
      commit,
      retainedAuthority: () => ({ ipcSocket: true, cleanupObligations: ['authority release'] }),
      hold: () => ({ reason: 'required-shutdown-step-unsettled', exit: 'shutdown-budget-exhaustion' }),
    };
    const ledger = createShutdownSettlementLedger({
      budgetMs: 900,
      time,
      log: (message) => logLines.push(message),
      pollMs: 50,
      acceptProcessExitRemainder: (remainder) => ({
        kind: 'accepted',
        remainder: { undischarged: remainder.undischarged },
        requestExit: () => undefined,
      }),
    });

    await ledger.run(obligation);
    const terminal = requireUnaccepted(await ledger.gate(boundary));

    expect(terminal.undischarged).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'startup recovery handoff',
          remainder: { owner: 'successor-recovery', evidence: { kind: 'startup-store-recovery' } },
        }),
        expect.objectContaining({ label: 'process-exit-remainder-acceptance' }),
      ]),
    );
    expect(commit).toHaveBeenCalledOnce();
    expect(logLines).toContain('process-exit remainder acceptance did not identify the offered remainder\n');
  });

  it('settles a clean boundary retry without offering a nonterminal boundary failure', async () => {
    const time = new VirtualTime();
    const commit = vi
      .fn<ShutdownAuthorityReleaseBoundary['commit']>()
      .mockResolvedValueOnce({ confirmed: false, detail: 'IPC release pending' })
      .mockResolvedValueOnce({ confirmed: true });
    const boundary: ShutdownAuthorityReleaseBoundary = {
      label: 'authority release',
      prepare: () => Promise.resolve({ confirmed: true, token: {} }),
      commit,
      retainedAuthority: () => ({ ipcSocket: true, cleanupObligations: ['authority release'] }),
      hold: () => ({ reason: 'required-shutdown-step-unsettled', exit: 'shutdown-budget-exhaustion' }),
    };
    const offeredRemainders: ProcessExitRemainder[] = [];
    const accept = vi.fn((remainder: ProcessExitRemainder): ProcessExitRemainderAcceptance => {
      offeredRemainders.push(remainder);
      return { kind: 'accepted', remainder, requestExit: () => undefined };
    });
    const ledger = createShutdownSettlementLedger({
      budgetMs: 900,
      time,
      log: () => {},
      pollMs: 50,
      acceptProcessExitRemainder: accept,
    });

    const held = requireHeld(await ledger.gate(boundary));

    await expect(held.retry()).resolves.toEqual({ disposition: 'settled' });
    expect(accept).not.toHaveBeenCalled();
    expect(offeredRemainders).toEqual([]);
    expect(commit).toHaveBeenCalledTimes(2);
  });

  it('delegates a declined successor-recovery obligation after verified acceptance', async () => {
    const time = new VirtualTime();
    const authorityToken = {};
    const authorityPreparationTask = vi.fn<ShutdownAuthorityReleaseBoundary['prepare']>().mockResolvedValue({
      confirmed: true,
      token: authorityToken,
    });
    const authorityReleaseTask = vi.fn(async () => ({ confirmed: true as const }));
    const successorRecovery: ShutdownObligation = {
      label: 'startup recovery handoff',
      task: async () => {
        throw new Error('successor not accepted');
      },
      retainedAuthority: () => ({ cleanupObligations: ['startup recovery handoff'] }),
      remainder: () => ({ owner: 'successor-recovery', evidence: { kind: 'startup-store-recovery' } }),
    };
    const authorityRelease: ShutdownAuthorityReleaseBoundary = {
      label: 'authority release',
      prepare: authorityPreparationTask,
      commit: authorityReleaseTask,
      retainedAuthority: () => ({ ipcSocket: true, cleanupObligations: ['authority release'] }),
      hold: () => ({ reason: 'required-shutdown-step-unsettled', exit: 'shutdown-budget-exhaustion' }),
    };
    let offeredRemainder: ProcessExitRemainder | null = null;
    const accept = vi.fn((remainder: ProcessExitRemainder): ProcessExitRemainderAcceptance => {
      offeredRemainder = remainder;
      return { kind: 'accepted', remainder, requestExit: () => undefined };
    });
    const ledger = createShutdownSettlementLedger({
      budgetMs: 900,
      time,
      log: () => {},
      pollMs: 50,
      acceptProcessExitRemainder: accept,
    });

    await expect(ledger.run(successorRecovery)).resolves.toMatchObject({ kind: 'declined', cause: 'rejected' });
    const delegated = await ledger.gate(authorityRelease);

    expect(delegated).toMatchObject({
      disposition: 'delegated',
      undischarged: [
        {
          label: 'startup recovery handoff',
          remainder: { owner: 'successor-recovery', evidence: { kind: 'startup-store-recovery' } },
          settlement: { cause: 'rejected', detail: expect.stringContaining('successor not accepted') },
        },
      ],
    });
    if (delegated.disposition !== 'delegated') throw new Error('expected delegated shutdown');
    expect(authorityPreparationTask).toHaveBeenCalledOnce();
    expect(authorityReleaseTask).toHaveBeenCalledOnce();
    expect(accept).toHaveBeenCalledOnce();
    expect(delegated.acceptance.remainder).toBe(offeredRemainder);
    expect(delegated.undischarged).toEqual(delegated.acceptance.remainder.undischarged);
    expect(delegated).not.toHaveProperty('owner');
    expect(delegated.acceptance.remainder).not.toHaveProperty('owner');
  });

  it('turns the third declined authority-release commit into a named terminal loss', async () => {
    const time = new VirtualTime();
    const prepare = vi.fn<ShutdownAuthorityReleaseBoundary['prepare']>(async () => ({
      confirmed: true,
      token: {},
    }));
    const commit = vi.fn<ShutdownAuthorityReleaseBoundary['commit']>(async () => ({
      confirmed: false,
      detail: 'authority release permanently declined',
    }));
    const boundary: ShutdownAuthorityReleaseBoundary = {
      label: 'authority release',
      prepare,
      commit,
      retainedAuthority: () => ({ ipcSocket: true }),
      hold: () => ({ reason: 'required-shutdown-step-unsettled', exit: 'shutdown-budget-exhaustion' }),
    };
    const accept = vi.fn(
      (remainder: ProcessExitRemainder): ProcessExitRemainderAcceptance => ({
        kind: 'accepted',
        remainder,
        requestExit: () => undefined,
      }),
    );
    const ledger = createShutdownSettlementLedger({
      budgetMs: 900,
      time,
      log: () => {},
      pollMs: 50,
      acceptProcessExitRemainder: accept,
    });

    const first = requireHeld(await ledger.gate(boundary));
    const second = requireHeld(await first.retry());
    const exhausted = await second.retry();

    expect(exhausted).toMatchObject({
      disposition: 'delegated',
      undischarged: [{ label: 'authority release', remainder: { owner: 'process-exit' } }],
    });
    if (exhausted.disposition !== 'delegated') throw new Error('expected delegated shutdown');
    expect(exhausted.undischarged).toEqual(exhausted.acceptance.remainder.undischarged);
    expect(prepare).toHaveBeenCalledTimes(3);
    expect(commit).toHaveBeenCalledTimes(3);
    expect(accept).toHaveBeenCalledOnce();
  });

  it('turns the third declined authority preparation into a named terminal loss', async () => {
    const time = new VirtualTime();
    const prepare = vi.fn<ShutdownAuthorityReleaseBoundary['prepare']>(async () => ({
      confirmed: false,
      detail: 'authority snapshot unavailable',
    }));
    const commit = vi.fn<ShutdownAuthorityReleaseBoundary['commit']>();
    const boundary: ShutdownAuthorityReleaseBoundary = {
      label: 'authority release',
      prepare,
      commit,
      retainedAuthority: () => ({ ipcSocket: true }),
      hold: () => ({ reason: 'required-shutdown-step-unsettled', exit: 'shutdown-budget-exhaustion' }),
    };
    const ledger = createShutdownSettlementLedger({ budgetMs: 900, time, log: () => {}, pollMs: 50 });

    const first = requireHeld(await ledger.gate(boundary));
    const second = requireHeld(await first.retry());
    const exhausted = await second.retry();

    expect(exhausted).toMatchObject({
      disposition: 'unaccepted',
      undischarged: expect.arrayContaining([
        expect.objectContaining({ label: 'authority release', remainder: { owner: 'process-exit' } }),
      ]),
    });
    expect(prepare).toHaveBeenCalledTimes(3);
    expect(commit).not.toHaveBeenCalled();
  });

  it('names a refused remainder acceptance without rerunning obligations', async () => {
    const time = new VirtualTime();
    const task = vi.fn(async () => {
      throw new Error('cleanup unavailable');
    });
    const obligation: ShutdownObligation = {
      label: 'process-exit finalizer',
      task,
      retainedAuthority: () => ({ cleanupObligations: ['process-exit finalizer'] }),
      remainder: () => ({ owner: 'process-exit' }),
    };
    const boundary: ShutdownAuthorityReleaseBoundary = {
      label: 'authority release',
      prepare: async () => ({ confirmed: true, token: {} }),
      commit: async () => ({ confirmed: true }),
      retainedAuthority: () => ({ ipcSocket: true }),
      hold: () => ({ reason: 'required-shutdown-step-unsettled', exit: 'shutdown-budget-exhaustion' }),
    };
    const accept = vi.fn<(remainder: ProcessExitRemainder) => ProcessExitRemainderAcceptance>(() => ({
      kind: 'refused',
      detail: 'exit owner unavailable',
    }));
    const ledger = createShutdownSettlementLedger({
      budgetMs: 900,
      time,
      log: () => {},
      pollMs: 50,
      acceptProcessExitRemainder: accept,
    });

    await ledger.run(obligation);
    const terminal = await ledger.gate(boundary);
    await ledger.run(obligation);

    expect(terminal).toMatchObject({
      disposition: 'unaccepted',
      undischarged: [
        { label: 'process-exit finalizer', remainder: { owner: 'process-exit' } },
        { label: 'process-exit-remainder-acceptance', remainder: { owner: 'process-exit' } },
      ],
    });
    expect(task).toHaveBeenCalledOnce();
    expect(accept).toHaveBeenCalledOnce();
  });
});

/** One live set whose every step the test drives. Defaults are the healthy path. */
function fakeSet(
  proxyInstanceId: string,
  callLog: CallLog,
  overrides: Partial<ProviderProxySetAuthority> = {},
): ProviderProxySetAuthority {
  return {
    proxyInstanceId,
    providerHosts: unexercisedProviderHostControls,
    stopAndReap: async () => {
      callLog.push(`reap:${proxyInstanceId}`);
      return { disappearanceReceipt: `gone:${proxyInstanceId}` };
    },
    commitContainment: async () => {
      callLog.push(`reap:${proxyInstanceId}`);
      return { kind: 'containment-absent', disappearanceReceipt: `gone:${proxyInstanceId}` };
    },
    stopHeartbeats: () => {
      callLog.push(`heartbeats:${proxyInstanceId}`);
    },
    initiateControlClose: async () => {
      callLog.push(`control:${proxyInstanceId}`);
    },
    ...overrides,
  };
}

function registryOf(sets: readonly ProviderProxySetAuthority[]): ProviderProxyAuthorityRegistry {
  return { liveSets: () => sets };
}

async function shutdownFailureDetail(ctx: Parameters<typeof runShutdownSequence>[0]): Promise<string> {
  const disposition = await runShutdownSequence(ctx);
  if (disposition.disposition === 'settled') throw new Error('expected shutdown losses');
  return failureDetail(disposition);
}

function buildBoundaryExhaustionHarness(instanceId: string) {
  const finalizationOrder: string[] = [];
  const initiateControlClose = vi.fn(() => {
    finalizationOrder.push('boundary');
    return new Promise<never>(() => {});
  });
  const authority = registryOf([fakeSet('hung-control', [], { initiateControlClose })]);
  const harness = buildHarness({ hooksOnShutdown: async () => {}, providerProxyAuthority: authority });
  const remainderDocuments: string[] = [];
  let remainderDocument: string | null = null;
  const lifecycleRuntime = {
    ...harness.runtime,
    storage: {
      ...harness.runtime.storage,
      existsSync: () => remainderDocument !== null,
      readFileSync: () => {
        if (remainderDocument === null) throw new Error('remainder document is absent');
        return remainderDocument;
      },
      writeAtomicDurableSync: (_path: string, data: string) => {
        finalizationOrder.push('record');
        remainderDocument = data;
        remainderDocuments.push(data);
        return true;
      },
    },
  } as Runtime;
  let lifecycle: 'running' | 'draining' | 'stopped' = 'running';
  const runtimeState = {
    ...harness.ctx.runtimeState,
    getLifecycle: () => lifecycle,
    setLifecycle: (next: typeof lifecycle) => {
      lifecycle = next;
      if (next === 'stopped') finalizationOrder.push('stopped');
    },
  };
  const onStopped = vi.fn((exitCode: number) => {
    finalizationOrder.push(`exit:${exitCode}`);
  });
  const logLines: string[] = [];
  const controller = createLifecycle(
    {
      identity: {
        pluginRoot: '/plugin',
        instanceId,
        log: (message: string) => logLines.push(message),
      },
      runtime: lifecycleRuntime,
      storeFormat: {},
      backendPid: 4_242,
      runtimeState,
      idleTimer: harness.ctx.idleTimer,
      storeServicesRef: harness.ctx.storeServicesRef,
      createStoreServicesFromDbFn: () => ({}),
      streamResponses: harness.ctx.streamResponses,
      discussStores: harness.ctx.discussStores,
      eventBus: {},
      launchCoordinator: {},
      providerRegistry: {},
      server: harness.ctx.server,
      getExecutionService: () => ({}),
      getRecoveryService: () => ({}),
      listExecutionServices: () => [],
      getDiscussStoreForSource: () => {
        throw new Error('unexpected discuss store lookup');
      },
      knownDiscussSources: () => new Set(),
      getDiscussContext: () => {
        throw new Error('unexpected discuss context lookup');
      },
      writeBackendInfoFn: () => {},
      removeBackendInfoIfOwnerFn: () => {
        finalizationOrder.push('withdraw');
        return { kind: 'refused', detail: 'discovery read denied' };
      },
      cleanupStaleJobsFn: () => {},
      markJobsAsErrorFn: harness.ctx.markJobsAsErrorFn,
      settlePendingLaunchesFn: harness.ctx.settlePendingLaunchesFn,
      terminateRegisteredChildrenFn: harness.ctx.terminateRegisteredChildrenFn,
      providerHostManager: harness.ctx.providerHostManager,
      providerProxyAuthority: authority,
      handoffQuiescePorts: () => [],
      createKbHealthComponentFn: () => ({}),
      registerBuiltInProvidersFn: () => {},
      recoverPersistedDiscussFn: async () => [],
      hooks: harness.ctx.hooks,
      closeServerFn: harness.ctx.closeServerFn,
      listenFn: async () => ({ host: '127.0.0.1', port: 43123 }),
      ipcServer: harness.ctx.ipcServer,
      closeIpcServerFn: harness.ctx.closeIpcServerFn,
      disposeLifecycleReactor: harness.ctx.disposeLifecycleReactor,
      onStopped,
      acceptProcessExitRemainder: (remainder: ProcessExitRemainder) => ({
        kind: 'accepted',
        remainder,
        requestExit: onStopped,
      }),
    } as never,
    async () => [],
  );
  return {
    controller,
    finalizationOrder,
    harness,
    initiateControlClose,
    lifecycle: () => lifecycle,
    logLines,
    onStopped,
    remainderDocuments,
  };
}

describe('required provider-proxy shutdown steps', () => {
  it('runs a provider-proxy lifecycle fatal in handoff mode', async () => {
    const stopAndReap = vi.fn(async () => ({ disappearanceReceipt: 'gone:healthy' }));
    const harness = buildHarness({
      reason: 'provider-proxy-lifecycle-fatal',
      providerProxyAuthority: registryOf([fakeSet('healthy', [], { stopAndReap })]),
      hooksOnShutdown: async () => new Promise<void>(() => {}),
    });
    harness.ctx.settlePendingLaunchesFn = vi.fn(() => ({ kind: 'all-pending-launches-settled' }) as const);
    harness.ctx.terminateRegisteredChildrenFn = vi.fn(() => ({ kind: 'all-children-observed-absent' }) as const);
    harness.ctx.markJobsAsErrorFn = vi.fn();

    let completed = false;
    const sequence = runShutdownSequence(harness.ctx).then((disposition) => {
      completed = true;
      return disposition;
    });
    await flush(64);

    for (let elapsed = 0; elapsed <= SHUTDOWN_DRAIN_TIMEOUT_MS + 100; elapsed += 100) {
      harness.time.tick(100);
      await flush();
    }

    expect(completed).toBe(false);

    for (let elapsed = SHUTDOWN_DRAIN_TIMEOUT_MS + 200; elapsed <= HANDOFF_DRAIN_TIMEOUT_MS + 100; elapsed += 100) {
      harness.time.tick(100);
      await flush();
    }

    await expect(sequence).resolves.toMatchObject({ disposition: 'held' });
    expect(stopAndReap).not.toHaveBeenCalled();
    expect(harness.ctx.settlePendingLaunchesFn).not.toHaveBeenCalled();
    expect(harness.ctx.terminateRegisteredChildrenFn).not.toHaveBeenCalled();
    expect(harness.ctx.markJobsAsErrorFn).not.toHaveBeenCalled();
  });

  it('hands hooks.onShutdown the handoff mode for a provider-proxy lifecycle fatal', async () => {
    const harness = buildHarness({ reason: 'provider-proxy-lifecycle-fatal', hooksOnShutdown: async () => {} });
    const modes: string[] = [];
    harness.ctx.hooks = {
      onShutdown: async (mode) => {
        modes.push(mode);
      },
    };

    await runShutdownSequence(harness.ctx);

    expect(modes).toEqual(['handoff']);
  });

  it('carries a provider-proxy lifecycle fatal through a clean drain', async () => {
    const accept = vi.fn(
      (remainder: ProcessExitRemainder): ProcessExitRemainderAcceptance => ({
        kind: 'accepted',
        remainder,
        requestExit: () => undefined,
      }),
    );
    const harness = buildHarness({
      reason: 'provider-proxy-lifecycle-fatal',
      hooksOnShutdown: async () => {},
      acceptProcessExitRemainder: accept,
    });
    harness.ctx.incident = {
      kind: 'provider-proxy-lifecycle-fatal',
      error: new Error('corrupt provider-proxy lifecycle evidence'),
    };

    const terminal = await runShutdownSequence(harness.ctx);

    expect(terminal).toMatchObject({
      disposition: 'delegated',
      undischarged: [
        {
          label: 'provider proxy lifecycle fatal incident',
          remainder: { owner: 'process-exit' },
          settlement: {
            cause: 'rejected',
            detail: expect.stringContaining('corrupt provider-proxy lifecycle evidence'),
          },
        },
      ],
    });
    if (terminal.disposition !== 'delegated') throw new Error('expected delegated shutdown');
    expect(terminal.undischarged).toEqual(terminal.acceptance.remainder.undischarged);
    expect(accept).toHaveBeenCalledOnce();
  });

  it('retries every acquisition cleanup hold once and reports a surviving hold as unconfirmed', async () => {
    const retry = vi.fn(async (signal: AbortSignal) => {
      expect(signal.aborted).toBe(false);
      return { kind: 'held' as const, reason: 'guardian is still alive' };
    });
    const hold = {
      kind: 'provider_proxy_acquisition_held' as const,
      owner: 'provider-host-manager' as const,
      cut: 'guardian-spawned',
      reason: 'cleanup deadline elapsed',
      strandedArtifacts: [],
      setAddress: {
        buildSetId: '11111111-1111-4111-8111-111111111111',
        hostFingerprint: 'a'.repeat(64),
        proxyInstanceId: '22222222-2222-4222-8222-222222222222',
      },
      guardianIdentity: {
        pid: 4242,
        incarnation: testIncarnation('shutdown-hold'),
        processGroupId: 4242,
      },
      recoverySubject: {
        guardianIdentity: {
          pid: 4242,
          incarnation: testIncarnation('shutdown-hold'),
          processGroupId: 4242,
        },
        reaper: { kind: 'possible-unidentified' as const },
        constructionContainmentSettled: false,
        proxy: { kind: 'possible-unidentified' as const },
      },
      recoveryCapability: { retry },
    };
    const harness = buildHarness({ reason: 'test-teardown' });
    harness.ctx.markJobsAsErrorFn = vi.fn();
    harness.ctx.providerHostManager = {
      drainForHandoff: async () => ({
        kind: 'provider-hosts-quiesced',
        liveProxySets: [],
        acquisitionCleanupHolds: [],
        closingHosts: [],
      }),
      shutdown: async () => ({
        kind: 'provider-hosts-quiesced',
        liveProxySets: [],
        acquisitionCleanupHolds: [hold],
        closingHosts: [],
      }),
    };

    expect(await shutdownFailureDetail(harness.ctx)).toMatch(
      /provider host shutdown: .*acquisition guardian pid 4242: guardian is still alive/u,
    );
    expect(retry).toHaveBeenCalledOnce();
    expect(harness.ctx.markJobsAsErrorFn).not.toHaveBeenCalled();
  });

  it('reaps every live set on a hard shutdown before terminating owned children', async () => {
    const callLog: CallLog = [];
    const harness = buildHarness({
      reason: 'test-teardown',
      hooksOnShutdown: async () => {},
      providerProxyAuthority: registryOf([fakeSet('p1', callLog), fakeSet('p2', callLog)]),
    });
    harness.ctx.settlePendingLaunchesFn = () => {
      callLog.push('settlePendingLaunchesFn');
      return { kind: 'all-pending-launches-settled' };
    };
    harness.ctx.terminateRegisteredChildrenFn = () => {
      callLog.push('terminateRegisteredChildrenFn');
      return { kind: 'all-children-observed-absent' };
    };

    await runShutdownSequence(harness.ctx);

    // The detached sets outlive this coordinator, so they must be reaped by identity before the handle-based
    // termination that only reaches children this process still owns.
    expect(callLog).toEqual([
      'reap:p1',
      'reap:p2',
      'settlePendingLaunchesFn',
      'terminateRegisteredChildrenFn',
      'heartbeats:p1',
      'heartbeats:p2',
      'control:p1',
      'control:p2',
    ]);
  });

  it('reaps a set whose acquisition is still in flight when shutdown starts and only settles during host shutdown', async () => {
    // The defect this reproduces: an acquisition started before shutdown, still mid-handshake when shutdown
    // takes its `liveSets()` reading, and settling into `liveSets()` only once `providerHostManager.shutdown`
    // itself returns. A snapshot read before that call is stale by construction — it can only ever see `[]`
    // for a set that has not settled yet — so the required reap step must read `liveSets()` after that call,
    // not before it.
    const callLog: CallLog = [];
    let live: readonly ProviderProxySetAuthority[] = [];
    const harness = buildHarness({
      reason: 'test-teardown',
      hooksOnShutdown: async () => {},
      providerProxyAuthority: { liveSets: () => live },
    });
    harness.ctx.providerHostManager = {
      drainForHandoff: async () => ({
        kind: 'provider-hosts-quiesced',
        liveProxySets: [],
        acquisitionCleanupHolds: [],
        closingHosts: [],
      }),
      shutdown: async () => {
        // The acquisition settles here — during `providerHostManager.shutdown()` itself, after whatever
        // reading of `liveSets()` happened before this call started.
        live = [fakeSet('late', callLog)];
        return {
          kind: 'provider-hosts-quiesced',
          liveProxySets: live,
          acquisitionCleanupHolds: [],
          closingHosts: [],
        };
      },
    } as never;
    harness.ctx.settlePendingLaunchesFn = () => {
      callLog.push('settlePendingLaunchesFn');
      return { kind: 'all-pending-launches-settled' };
    };
    harness.ctx.terminateRegisteredChildrenFn = () => {
      callLog.push('terminateRegisteredChildrenFn');
      return { kind: 'all-children-observed-absent' };
    };

    await runShutdownSequence(harness.ctx);

    // The late-settling set must still go through the required reap step, not be silently skipped because an
    // earlier, now-stale reading of `liveSets()` reported nothing live.
    expect(callLog).toEqual([
      'reap:late',
      'settlePendingLaunchesFn',
      'terminateRegisteredChildrenFn',
      'heartbeats:late',
      'control:late',
    ]);
  });

  it('names the loss when a reap completes without confirming disappearance', async () => {
    const callLog: CallLog = [];
    const harness = buildHarness({
      reason: 'test-teardown',
      hooksOnShutdown: async () => {},
      providerProxyAuthority: registryOf([
        fakeSet('p1', callLog, { stopAndReap: async () => ({ unconfirmed: 'a recorded root is still alive' }) }),
      ]),
    });

    // "The reap RPC returned" is not "the containment is gone"; reporting clean success here would leave a
    // live provider carrier behind a shutdown that claimed to have removed it.
    const terminal = requireUnaccepted(await runShutdownSequence(harness.ctx));
    expect(failureDetail(terminal)).toMatch(/unconfirmed: p1: a recorded root is still alive/u);
    expect(harness.closeIpcCalled()).toBe(true);
  });

  it('names a rejected reap without retrying the declined row', async () => {
    const callLog: CallLog = [];
    let reapAttempts = 0;
    const harness = buildHarness({
      reason: 'test-teardown',
      hooksOnShutdown: async () => {},
      providerProxyAuthority: registryOf([
        fakeSet('p1', callLog, {
          stopAndReap: async () => {
            reapAttempts += 1;
            if (reapAttempts === 1) throw new Error('signal refused');
            return { disappearanceReceipt: 'gone:p1' };
          },
        }),
        fakeSet('p2', callLog),
      ]),
    });

    const terminal = requireUnaccepted(await runShutdownSequence(harness.ctx));
    expect(failureDetail(terminal)).toMatch(/p1: .*signal refused/u);
    expect(callLog).toContain('reap:p2');
    expect(reapAttempts).toBe(1);
    expect(harness.closeIpcCalled()).toBe(true);
  });

  it('retains the IPC socket when provider control cannot be released', async () => {
    const callLog: CallLog = [];
    let controlAttempts = 0;
    const harness = buildHarness({
      hooksOnShutdown: async () => {},
      providerProxyAuthority: registryOf([
        fakeSet('p1', callLog, {
          initiateControlClose: async () => {
            controlAttempts += 1;
            if (controlAttempts === 1) throw new Error('control gone');
          },
        }),
      ]),
    });
    harness.ctx.closeIpcServerFn = async () => {
      callLog.push('closeIpcServerFn:start');
    };

    const held = requireHeld(await runShutdownSequence(harness.ctx));
    expect(heldFailureDetail(held)).toMatch(/control p1: .*control gone/u);
    expect(callLog).not.toContain('closeIpcServerFn:start');
    await expect(held.retry()).resolves.toEqual({ disposition: 'settled' });
    expect(controlAttempts).toBe(2);
    expect(callLog).toContain('closeIpcServerFn:start');
  });

  it('bounds the retry wake when provider control close never settles', async () => {
    const harness = buildHarness({
      hooksOnShutdown: async () => {},
      providerProxyAuthority: registryOf([
        fakeSet('hung-control', [], {
          initiateControlClose: () => new Promise<never>(() => {}),
        }),
      ]),
      acceptProcessExitRemainder: (remainder) => ({
        kind: 'accepted',
        remainder,
        requestExit: () => undefined,
      }),
    });

    const sequence = runShutdownSequence(harness.ctx);
    await flush(64);
    harness.time.tick(HANDOFF_DRAIN_TIMEOUT_MS);
    await flush(64);
    const held = requireHeld(await sequence);
    let woke = false;
    void held.retryAfter.then(() => {
      woke = true;
    });

    harness.time.tick(49);
    await flush();
    expect(woke).toBe(false);
    harness.time.tick(1);
    await flush();
    expect(woke).toBe(true);
  });

  it.each([
    {
      label: 'returns false',
      write: () => false,
      expectedDetail: 'record publication returned false',
    },
    {
      label: 'throws',
      write: () => {
        throw new Error('remainder storage unavailable');
      },
      expectedDetail: 'remainder storage unavailable',
    },
  ])(
    'withdraws discovery and requests nonzero exit when the remainder write $label',
    async ({ write, expectedDetail }) => {
      const harness = buildRemainderWriteRefusalHarness(write, { kind: 'removed' }, rejectingHook);

      await expect(harness.controller.shutdown('replaced')).resolves.toMatchObject({
        disposition: 'finalized-with-losses',
        undischarged: expect.arrayContaining([expect.objectContaining({ label: 'hooks.onShutdown' })]),
      });

      expect(harness.removeBackendInfoIfOwnerFn).toHaveBeenCalledOnce();
      expect(harness.onStopped).toHaveBeenCalledWith(1);
      expect(harness.order).toEqual(['stopped', 'record', 'withdraw', 'exit:1']);
      expect(harness.logLines.some((line) => line.includes('shutdown remainder write refused'))).toBe(true);
      expect(harness.logLines.some((line) => line.includes(expectedDetail))).toBe(true);
    },
  );

  it('a fully discharged shutdown writes no remainder record', async () => {
    const harness = buildRemainderWriteRefusalHarness(() => true);

    await expect(harness.controller.shutdown('replaced')).resolves.toEqual({ disposition: 'finalized' });

    expect(harness.order).toEqual(['stopped', 'withdraw', 'exit:0']);
    expect(harness.onStopped).toHaveBeenCalledWith(0);
  });

  it('writes a withdrawal loss as the only entry of an otherwise clean shutdown', async () => {
    const harness = buildRemainderWriteRefusalHarness(() => true, { kind: 'refused', detail: 'unlink denied' });

    const first = await harness.controller.shutdown('replaced');
    expect(first).toEqual({
      disposition: 'finalized-with-losses',
      undischarged: [
        {
          label: 'backend discovery withdrawal',
          remainder: { owner: 'process-exit' },
          settlement: { cause: 'rejected', detail: 'unlink denied' },
        },
      ],
    });

    expect(harness.order).toEqual(['stopped', 'withdraw', 'record', 'exit:1']);
    expect(harness.logLines).toContain('backend discovery withdrawal refused (unlink denied)\n');
    await expect(harness.controller.shutdown('replaced')).resolves.toBe(first);
    expect(harness.order).toEqual(['stopped', 'withdraw', 'record', 'exit:1']);
  });

  it('rewrites a withdrawal loss after the original remainder publication was refused', async () => {
    const harness = buildRemainderWriteRefusalHarness(
      () => false,
      { kind: 'refused', detail: 'unlink denied' },
      rejectingHook,
    );

    await expect(harness.controller.shutdown('replaced')).resolves.toMatchObject({
      disposition: 'finalized-with-losses',
      undischarged: expect.arrayContaining([
        expect.objectContaining({ label: 'hooks.onShutdown' }),
        expect.objectContaining({ label: 'backend discovery withdrawal' }),
      ]),
    });

    expect(harness.order).toEqual(['stopped', 'record', 'withdraw', 'record', 'exit:1']);
    expect(harness.logLines.filter((line) => line.includes('shutdown remainder write refused'))).toHaveLength(2);
    expect(harness.logLines).toContain('backend discovery withdrawal refused (unlink denied)\n');
  });

  it('consumes a refused withdrawal-loss rewrite without delaying exit', async () => {
    let writes = 0;
    const harness = buildRemainderWriteRefusalHarness(
      () => {
        writes += 1;
        return writes === 1;
      },
      { kind: 'refused', detail: 'unlink denied' },
      rejectingHook,
    );

    await expect(harness.controller.shutdown('replaced')).resolves.toMatchObject({
      disposition: 'finalized-with-losses',
    });

    expect(harness.order).toEqual(['stopped', 'record', 'withdraw', 'record', 'exit:1']);
    expect(harness.logLines.filter((line) => line.includes('shutdown remainder write refused'))).toEqual([
      'shutdown remainder write refused (record publication returned false)\n',
    ]);
  });

  it('exhausts a never-settling control close through the production lifecycle continuation', async () => {
    const {
      controller,
      finalizationOrder,
      harness,
      initiateControlClose,
      lifecycle,
      logLines,
      onStopped,
      remainderDocuments,
    } = buildBoundaryExhaustionHarness('boundary-exhaustion');

    const initial = controller.shutdown('replaced');
    await flush(64);
    harness.time.tick(HANDOFF_DRAIN_TIMEOUT_MS);
    await flush(64);
    const held = await initial;
    expect(isLifecycleShutdownTerminal(held)).toBe(false);
    if (isLifecycleShutdownTerminal(held)) throw new Error('expected the initial boundary attempt to remain held');
    expect(held.recovery.automaticRetry).toEqual({ status: 'scheduled', attemptsStarted: 1, attemptLimit: 3 });

    harness.time.tick(50);
    await flush(64);
    harness.time.tick(HANDOFF_DRAIN_TIMEOUT_MS / 2);
    await flush(64);
    const second = await controller.waitForShutdown();
    expect(isLifecycleShutdownTerminal(second)).toBe(false);
    if (isLifecycleShutdownTerminal(second)) throw new Error('expected the second boundary attempt to remain held');
    expect(second.recovery.automaticRetry).toEqual({ status: 'scheduled', attemptsStarted: 2, attemptLimit: 3 });
    harness.time.tick(50);
    await flush(64);
    harness.time.tick(HANDOFF_DRAIN_TIMEOUT_MS / 2);
    await flush(64);
    const exhausted = await controller.waitForShutdown();

    expect(exhausted).toMatchObject({
      disposition: 'finalized-with-losses',
      undischarged: expect.arrayContaining([
        expect.objectContaining({
          label: 'provider control and IPC authority release',
          remainder: { owner: 'process-exit' },
        }),
        expect.objectContaining({
          label: 'backend discovery withdrawal',
          remainder: { owner: 'process-exit' },
        }),
      ]),
    });
    expect(initiateControlClose).toHaveBeenCalledOnce();
    expect(onStopped).toHaveBeenCalledWith(1);
    expect(lifecycle()).toBe('stopped');
    expect(finalizationOrder).toEqual(['boundary', 'stopped', 'record', 'withdraw', 'record', 'exit:1']);
    expect(remainderDocuments).toHaveLength(2);
    const rewritten = JSON.parse(remainderDocuments[1] ?? '{}') as {
      instanceId?: string;
      entries?: Array<{ label?: string }>;
    };
    expect(rewritten).toEqual(
      expect.objectContaining({
        instanceId: 'boundary-exhaustion',
        entries: expect.arrayContaining([expect.objectContaining({ label: 'backend discovery withdrawal' })]),
      }),
    );
    expect(logLines).toContain('backend discovery withdrawal refused (discovery read denied)\n');
  });

  it('never offers abandonment: not-held around a shutdown, not-offered while the boundary is held', async () => {
    const { controller, harness } = buildBoundaryExhaustionHarness('abandon-never-offered');
    const subject = 'provider-control-and-ipc-authority-release' as const;

    expect(controller.abandonShutdownObligation({ subject })).toEqual({ kind: 'not-held', subject });

    const initial = controller.shutdown('replaced');
    await flush(64);
    harness.time.tick(HANDOFF_DRAIN_TIMEOUT_MS);
    await flush(64);
    const held = await initial;
    expect(isLifecycleShutdownTerminal(held)).toBe(false);
    expect(controller.abandonShutdownObligation({ subject })).toEqual({ kind: 'not-offered', subject });

    for (const attempt of [1, 2]) {
      harness.time.tick(50);
      await flush(64);
      harness.time.tick(HANDOFF_DRAIN_TIMEOUT_MS / 2);
      await flush(64);
      if (attempt === 1) {
        expect(controller.abandonShutdownObligation({ subject })).toEqual({ kind: 'not-offered', subject });
      }
    }
    const exhausted = await controller.waitForShutdown();
    expect(isLifecycleShutdownTerminal(exhausted)).toBe(true);
    expect(controller.abandonShutdownObligation({ subject })).toEqual({ kind: 'not-held', subject });
  });

  it("a sigint landing between attempts records the ledger's original reason", async () => {
    const { controller, harness, remainderDocuments } = buildBoundaryExhaustionHarness('interrupted-drain');

    const initial = controller.shutdown('replaced');
    await flush(64);
    harness.time.tick(HANDOFF_DRAIN_TIMEOUT_MS);
    await flush(64);
    expect(isLifecycleShutdownTerminal(await initial)).toBe(false);

    const interrupted = controller.shutdown('sigint');
    await flush(64);
    harness.time.tick(HANDOFF_DRAIN_TIMEOUT_MS / 2);
    await flush(64);
    expect(isLifecycleShutdownTerminal(await interrupted)).toBe(false);

    harness.time.tick(50);
    await flush(64);
    harness.time.tick(HANDOFF_DRAIN_TIMEOUT_MS / 2);
    await flush(64);
    const exhausted = await controller.waitForShutdown();

    expect(exhausted).toMatchObject({ disposition: 'finalized-with-losses' });
    const written = JSON.parse(remainderDocuments.at(-1) ?? '{}') as Record<string, unknown>;
    expect(written).toEqual(
      expect.objectContaining({ instanceId: 'interrupted-drain', reason: 'replaced', mode: 'handoff' }),
    );
  });

  it('stops every heartbeat before initiating any close', async () => {
    const callLog: CallLog = [];
    const harness = buildHarness({
      hooksOnShutdown: async () => {},
      providerProxyAuthority: registryOf([fakeSet('p1', callLog), fakeSet('p2', callLog)]),
    });
    harness.ctx.closeIpcServerFn = async () => {
      callLog.push('closeIpcServerFn:start');
    };

    await runShutdownSequence(harness.ctx);

    // A heartbeat landing mid-release would renew the very lease this shutdown is giving up.
    const released = callLog.filter((entry) => /^(heartbeats|control):/u.test(entry) || entry.startsWith('closeIpc'));
    expect(released).toEqual(['heartbeats:p1', 'heartbeats:p2', 'control:p1', 'control:p2', 'closeIpcServerFn:start']);
  });

  it('keeps releasing every other trigger when a heartbeat stop throws synchronously', async () => {
    const callLog: CallLog = [];
    let heartbeatAttempts = 0;
    const harness = buildHarness({
      hooksOnShutdown: async () => {},
      providerProxyAuthority: registryOf([
        fakeSet('p-throws', callLog, {
          stopHeartbeats: () => {
            heartbeatAttempts += 1;
            if (heartbeatAttempts === 1) throw new Error('heartbeat scheduler already disposed');
            callLog.push('heartbeats:p-throws');
          },
        }),
        fakeSet('p2', callLog),
      ]),
    });
    harness.ctx.closeIpcServerFn = async () => {
      callLog.push('closeIpcServerFn:start');
    };

    const held = requireHeld(await runShutdownSequence(harness.ctx));
    expect(heldFailureDetail(held)).toMatch(/heartbeats p-throws: .*heartbeat scheduler already disposed/u);
    expect(callLog).toContain('heartbeats:p2');
    expect(callLog).toContain('control:p-throws');
    expect(callLog).toContain('control:p2');
    expect(callLog).not.toContain('closeIpcServerFn:start');
    await expect(held.retry()).resolves.toEqual({ disposition: 'settled' });
    expect(heartbeatAttempts).toBe(2);
    expect(callLog).toContain('closeIpcServerFn:start');
  });

  it('skips the required provider-proxy steps entirely when there are no live sets', async () => {
    const callLog: CallLog = [];
    const harness = buildHarness({
      hooksOnShutdown: async () => {},
      providerProxyAuthority: registryOf([]),
    });
    harness.ctx.closeIpcServerFn = async () => {
      callLog.push('closeIpcServerFn:start');
    };

    await runShutdownSequence(harness.ctx);

    // No live set means the required proxy steps (reap and release boundary) have nothing to do; the
    // plain (non-required) IPC close path runs instead.
    expect(callLog.some((entry) => /^(heartbeats|control|reap):/u.test(entry))).toBe(false);
    expect(callLog).toContain('closeIpcServerFn:start');
  });

  it('returns a retryable hold when the controls close but the IPC release rejects', async () => {
    const callLog: CallLog = [];
    let ipcAttempts = 0;
    const harness = buildHarness({
      hooksOnShutdown: async () => {},
      providerProxyAuthority: registryOf([fakeSet('p1', callLog)]),
      closeIpcServerFn: async () => {
        ipcAttempts += 1;
        if (ipcAttempts === 1) throw new Error('socket stuck');
      },
    });

    const held = requireHeld(await runShutdownSequence(harness.ctx));
    expect(heldFailureDetail(held)).toMatch(
      /provider control and IPC authority release: .*IPC socket: .*socket stuck/u,
    );
    expect(callLog).toContain('control:p1');
    await expect(held.retry()).resolves.toEqual({ disposition: 'settled' });
    expect(ipcAttempts).toBe(2);
  });
});

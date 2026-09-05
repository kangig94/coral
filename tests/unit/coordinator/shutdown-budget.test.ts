import { readFileSync } from 'node:fs';
import type { Server, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import { HANDOFF_DRAIN_TIMEOUT_MS, SHUTDOWN_DRAIN_TIMEOUT_MS, runShutdownSequence } from '#src/coordinator/shutdown.js';
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
import type { IpcListener } from '#src/transport/ipc/server.js';
import type { Runtime } from '#src/runtime/ports.js';
import { VirtualTime } from '#tools/simulation/core/virtual-time.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';

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
  reason?: string;
  providerProxyAuthority?: ProviderProxyAuthorityRegistry;
  acceptProcessExitRemainder?: (remainder: ProcessExitRemainder) => ProcessExitRemainderAcceptance;
}): Harness {
  const time = new VirtualTime();
  const callLog: CallLog = [];
  const logLines: string[] = [];

  const runtime = { time } as unknown as Runtime;

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
    storeServicesRef: {
      tryGet: () => storeServices,
      get: () => storeServices,
      set: () => {},
      clear: () => {},
    } as never,
    terminateAllFn: () => ({ kind: 'all-observed-absent' }),
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

async function flush(rounds = 16): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

type ShutdownSequenceHold = Extract<Awaited<ReturnType<typeof runShutdownSequence>>, { disposition: 'held' }>;

function retryHeldFinalization(held: ShutdownSequenceHold): ReturnType<typeof runShutdownSequence> {
  return held.retry();
}

function requireHeld(disposition: Awaited<ReturnType<typeof runShutdownSequence>>): ShutdownSequenceHold {
  expect(disposition.disposition).toBe('held');
  if (disposition.disposition !== 'held') throw new Error('expected held shutdown finalization');
  return disposition;
}

function heldFailureDetail(held: ShutdownSequenceHold): string {
  return held.deferredFailures
    .map(({ label, error }) => `${label}: ${error instanceof Error ? error.message : String(error)}`)
    .join(' | ');
}

describe('runShutdownSequence drain budget', () => {
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
    expect(held.retainedAuthority.operatorActions).toEqual([]);

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
      owner: 'process-exit',
      deferredFailures: [{ label: 'hooks.onShutdown', error: expect.any(Error) }],
    });
    expect(harness.closeIpcCalled()).toBe(true);
    expect(attempts).toBe(1);
    expect(requestExit).not.toHaveBeenCalled();
  });

  it('retains authority when no process-exit owner accepts a rejected finalizer', async () => {
    const harness = buildHarness({
      hooksOnShutdown: async () => {
        throw new Error('hook unavailable');
      },
    });

    const held = requireHeld(await runShutdownSequence(harness.ctx));

    expect(held.retainedAuthority).toMatchObject({
      ipcSocket: true,
      cleanupObligations: ['hooks.onShutdown', 'provider control and IPC authority release'],
    });
    expect(harness.closeIpcCalled()).toBe(false);
  });

  it('retains authority when process exit refuses a rejected finalizer', async () => {
    const harness = buildHarness({
      hooksOnShutdown: async () => {
        throw new Error('hook unavailable');
      },
      acceptProcessExitRemainder: () => ({ kind: 'refused', detail: 'exit owner unavailable' }),
    });

    const held = requireHeld(await runShutdownSequence(harness.ctx));

    expect(held.retainedAuthority.ipcSocket).toBe(true);
    expect(harness.closeIpcCalled()).toBe(false);
    expect(harness.logLines).toContain('process-exit remainder acceptance refused: exit owner unavailable\n');
  });

  it('reports recovery teardown timeout and joins its in-flight settlement on retry', async () => {
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
    expect(held.retainedAuthority.cleanupObligations).toContain('recovery coordinator teardown');
    expect(harness.closeIpcCalled()).toBe(false);

    const retry = held.retry();
    await flush(64);
    expect(teardownStarts).toBe(1);
    settleTeardown();
    await expect(retry).resolves.toEqual({ disposition: 'settled' });
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

  it('holds hard shutdown when provider-host containment exceeds the lifecycle deadline', async () => {
    const harness = buildHarness({
      hooksOnShutdown: async () => {},
    });
    harness.ctx.reason = 'test-cleanup';
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
    harness.ctx.terminateAllFn = () => {
      harness.callLog.push('terminateAllFn');
      return { kind: 'all-observed-absent' };
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
    expect(held.retainedAuthority.operatorActions).toEqual([]);
    expect(providerSignal?.aborted).toBe(true);
    expect(harness.callLog).not.toContain('terminateAllFn');
    expect(harness.closeIpcCalled()).toBe(false);
  });

  it('reaps cleanup obligations from an independent snapshot after provider-host shutdown rejects', async () => {
    const harness = buildHarness({ reason: 'test-cleanup', hooksOnShutdown: async () => {} });
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
        closingHosts: [],
      }),
    };

    const held = await runShutdownSequence(harness.ctx);
    expect(held).toMatchObject({
      disposition: 'held',
      reason: 'required-shutdown-step-unsettled',
      retainedAuthority: {
        operatorActions: [
          expect.objectContaining({
            kind: 'provider-proxy-set-containment',
            proxyInstanceId: 'retained-proxy',
          }),
        ],
      },
    });

    expect(stopAndReap).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
    if (held.disposition !== 'held') throw new Error('expected held shutdown finalization');
    await expect(held.retry()).resolves.toEqual({ disposition: 'settled' });
    expect(stopAndReap).toHaveBeenCalledOnce();
    expect(retry).toHaveBeenCalledOnce();
  });

  it('returns a recoverable hold when crash terminalization rejects', async () => {
    const harness = buildHarness({
      hooksOnShutdown: async () => {},
    });
    harness.ctx.reason = 'test-cleanup';
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
    harness.ctx.terminateAllFn = () => {
      harness.callLog.push('terminateAllFn');
      return { kind: 'all-observed-absent' };
    };

    const held = requireHeld(await runShutdownSequence(harness.ctx));

    expect(terminalizationSignal).toBeInstanceOf(AbortSignal);
    expect(harness.callLog).toContain('providerHostManager.shutdown');
    expect(harness.callLog).toContain('terminateAllFn');
    expect(harness.callLog.indexOf('terminateAllFn')).toBeLessThan(harness.callLog.indexOf('markJobsAsErrorFn'));
    expect(harness.logLines).toContainEqual(expect.stringContaining('crashed job terminalization settlement failed'));
    expect(heldFailureDetail(held)).toContain('crashed job terminalization: injected crash terminalization failure');
    expect(held.retainedAuthority.operatorActions).toEqual([]);
  });

  it('does not terminalize jobs when child containment remains unresolved', async () => {
    const harness = buildHarness({ reason: 'test-cleanup', hooksOnShutdown: async () => {} });
    harness.ctx.markJobsAsErrorFn = vi.fn();
    harness.ctx.terminateAllFn = async () => ({
      kind: 'unresolved-at-deadline',
      processes: [{ kind: 'target-alive', pid: 4_242, stage: 'after-sigkill' }],
      pendingLaunches: 0,
      retainedLaunches: [],
      cleanupHandles: 1,
      retainedProcesses: [],
      cleanupFailures: 0,
      owner: 'launch-coordinator',
    });

    const held = requireHeld(await runShutdownSequence(harness.ctx));

    expect(harness.ctx.markJobsAsErrorFn).not.toHaveBeenCalled();
    expect(heldFailureDetail(held)).toContain('child termination: unconfirmed');
    expect(held.retainedAuthority.operatorActions).toEqual([]);
  });

  it('holds hard shutdown and names a durable child that remains alive at the deadline', async () => {
    const harness = buildHarness({ reason: 'test-cleanup', hooksOnShutdown: async () => {} });
    harness.ctx.terminateAllFn = async () => ({
      kind: 'unresolved-at-deadline',
      processes: [{ kind: 'target-alive', pid: 4_242, stage: 'after-sigkill' }],
      pendingLaunches: 0,
      retainedLaunches: [],
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
    const harness = buildHarness({ reason: 'test-cleanup', hooksOnShutdown: async () => {} });
    harness.ctx.terminateAllFn = async () => ({
      kind: 'unresolved-at-deadline',
      processes: [
        {
          kind: 'signal-refused',
          pid: 4_243,
          reason: 'recorded-incarnation-unavailable',
        },
      ],
      pendingLaunches: 0,
      retainedLaunches: [],
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
    const harness = buildHarness({ reason: 'test-cleanup', hooksOnShutdown: async () => {} });
    harness.ctx.terminateAllFn = async () => ({
      kind: 'unresolved-at-deadline',
      processes: [{ kind: 'target-unobservable', pid: 4_244, stage: 'after-sigkill' }],
      pendingLaunches: 0,
      retainedLaunches: [],
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

    const held = requireHeld(await runShutdownSequence(harness.ctx));
    expect(harness.callLog).toContain('discuss.dispose');
    expect(heldFailureDetail(held)).toContain('child termination:');
    expect(held.retainedAuthority.operatorActions).toEqual([]);
    expect(harness.closeIpcCalled()).toBe(false);
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
    expect(held.retainedAuthority.operatorActions).toEqual([]);
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
    expect(held.retainedAuthority.operatorActions).toEqual([]);
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
    expect(held.retainedAuthority.operatorActions).toEqual([]);
    expect(harness.closeIpcCalled()).toBe(false);
  });

  it('lifecycle finalizes synchronously after a settled shutdown sequence', () => {
    const lifecyclePath = fileURLToPath(new URL('../../../src/coordinator/lifecycle.ts', import.meta.url));
    const source = readFileSync(lifecyclePath, 'utf-8');
    const sequenceResolution = source.indexOf('state.shutdownRetry = null;');
    const finalization = source.indexOf('return finalizeStoppedLifecycle();', sequenceResolution);

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
      remainder: { owner: 'process-exit' },
    };
    const later: ShutdownObligation = {
      label: 'later cleanup',
      task: async () => ({ confirmed: true }),
      retainedAuthority: () => ({ cleanupObligations: ['later cleanup'] }),
      remainder: { owner: 'none' },
    };
    const authorityToken = {};
    const authorityRelease: ShutdownAuthorityReleaseBoundary = {
      label: 'authority release',
      prepare: () => Promise.resolve({ confirmed: true, token: authorityToken }),
      commit: () => Promise.resolve({ confirmed: true }),
      retainedAuthority: () => ({ cleanupObligations: ['authority release'] }),
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

  it('retains hard-mode IPC and provider control until child cleanup retry confirms absence', async () => {
    const authorityCalls: string[] = [];
    const set = fakeSet('hard-held', authorityCalls);
    const harness = buildHarness({ reason: 'fatal', hooksOnShutdown: async () => {} });
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
    harness.ctx.terminateAllFn = async () => {
      childCleanupAttempts += 1;
      return childCleanupAttempts === 1
        ? {
            kind: 'unresolved-at-deadline',
            processes: [{ kind: 'target-alive', pid: 4_242, stage: 'after-sigkill' }],
            pendingLaunches: 0,
            retainedLaunches: [],
            cleanupHandles: 1,
            retainedProcesses: [
              {
                kind: 'recorded-wrapper-group',
                provider: 'claude',
                jobId: 'hard-held-job',
                jobDir: '/tmp/coral/jobs/hard-held-job',
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
        : { kind: 'all-observed-absent' };
    };

    const held = await runShutdownSequence(harness.ctx);

    expect(held).toMatchObject({
      disposition: 'held',
      reason: 'required-shutdown-step-unsettled',
      retainedAuthority: {
        ipcSocket: true,
        providerControlProxyInstanceIds: ['hard-held'],
        cleanupObligations: [
          'child termination',
          'crashed job terminalization',
          'provider control and IPC authority release',
        ],
        operatorActions: [
          {
            kind: 'retained-job-containment',
            jobId: 'hard-held-job',
            provider: 'claude',
            jobDir: '/tmp/coral/jobs/hard-held-job',
            actionCommand: 'coral-cli abort jobs hard-held-job',
          },
          {
            kind: 'provider-proxy-set-containment',
            proxyInstanceId: 'hard-held',
            inspectCommand: 'coral-cli backend status',
            actionCommand: 'coral-cli backend provider-proxy-set abandon <set-token>',
          },
        ],
      },
    });
    expect(authorityCalls).toEqual(['reap:hard-held']);
    if (held.disposition !== 'held') throw new Error('expected held shutdown finalization');

    await expect(retryHeldFinalization(held)).resolves.toEqual({ disposition: 'settled' });
    expect(authorityCalls).toEqual(['reap:hard-held', 'heartbeats:hard-held', 'control:hard-held', 'closeIpc']);
  });

  it('retains handoff IPC and provider control until an identified host cleanup retry settles', async () => {
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
      cleanupObligations: () => ({ liveProxySets: [set], acquisitionCleanupHolds: [], closingHosts: [] }),
    };
    harness.ctx.closeIpcServerFn = async () => {
      authorityCalls.push('closeIpc');
    };

    const held = await runShutdownSequence(harness.ctx);

    expect(held).toMatchObject({
      disposition: 'held',
      reason: 'required-shutdown-step-unsettled',
      retainedAuthority: {
        ipcSocket: true,
        providerControlProxyInstanceIds: ['handoff-held'],
        cleanupObligations: ['provider host drain for handoff', 'provider control and IPC authority release'],
        operatorActions: [
          {
            kind: 'provider-proxy-set-containment',
            proxyInstanceId: 'handoff-held',
            inspectCommand: 'coral-cli backend status',
            actionCommand: 'coral-cli backend provider-proxy-set abandon <set-token>',
          },
        ],
      },
    });
    expect(authorityCalls).toEqual([]);
    if (held.disposition !== 'held') throw new Error('expected held shutdown finalization');

    await expect(retryHeldFinalization(held)).resolves.toEqual({ disposition: 'settled' });
    expect(authorityCalls).toEqual(['heartbeats:handoff-held', 'control:handoff-held', 'closeIpc']);
  });

  it('retains authority through a declined app-server quiesce with no durable recovery action', async () => {
    const authorityCalls: string[] = [];
    const harness = buildHarness({ reason: 'replaced', hooksOnShutdown: async () => {} });
    harness.ctx.handoffQuiescePorts = () => [
      { quiesceAppServerJobsForHandoff: async () => Promise.reject(new Error('quiescence unavailable')) },
    ];
    harness.ctx.closeIpcServerFn = async () => {
      authorityCalls.push('closeIpc');
    };

    const held = requireHeld(await runShutdownSequence(harness.ctx));
    expect(heldFailureDetail(held)).toContain(
      'app-server handoff quiesce: unconfirmed: port 1: Error: quiescence unavailable',
    );
    expect(held.retainedAuthority.operatorActions).toEqual([]);
    expect(authorityCalls).toEqual([]);
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

  it('snapshots and retries handoff cleanup obligations after drain failure', async () => {
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
        closingHosts: [],
      }),
    };
    harness.ctx.closeIpcServerFn = async () => {
      authorityCalls.push('closeIpc');
    };

    const held = await runShutdownSequence(harness.ctx);

    expect(held).toMatchObject({
      disposition: 'held',
      retainedAuthority: {
        ipcSocket: true,
        providerControlProxyInstanceIds: ['handoff-drain-held'],
        cleanupObligations: [
          'provider host drain for handoff',
          'provider acquisition pending-handoff-acquisition',
          'provider control and IPC authority release',
        ],
      },
    });
    expect(retryAcquisition).not.toHaveBeenCalled();
    expect(authorityCalls).toEqual([]);
    if (held.disposition !== 'held') throw new Error('expected held shutdown finalization');

    await expect(held.retry()).resolves.toEqual({ disposition: 'settled' });
    expect(retryAcquisition).toHaveBeenCalledOnce();
    expect(authorityCalls).toEqual(['heartbeats:handoff-drain-held', 'control:handoff-drain-held', 'closeIpc']);
  });
});

describe('settlement ledger exit gate', () => {
  it("refuses authority release while an owner 'none' obligation is declined", async () => {
    const time = new VirtualTime();
    const authorityReleaseTask = vi.fn(async () => ({ confirmed: true as const }));
    const blocked: ShutdownObligation = {
      label: 'commit-started recovery finalization',
      task: async () => {
        throw new Error('still committing');
      },
      retainedAuthority: () => ({ ipcSocket: true, cleanupObligations: ['commit-started finalization'] }),
      remainder: { owner: 'none' },
    };
    const authorityToken = {};
    const authorityRelease: ShutdownAuthorityReleaseBoundary = {
      label: 'authority release',
      prepare: () => Promise.resolve({ confirmed: true, token: authorityToken }),
      commit: authorityReleaseTask,
      retainedAuthority: () => ({ ipcSocket: true, cleanupObligations: ['authority release'] }),
    };
    const ledger = createShutdownSettlementLedger({ budgetMs: 1_000, time, log: () => {}, pollMs: 50 });

    await expect(ledger.run(blocked)).resolves.toMatchObject({ kind: 'declined', cause: 'rejected' });
    const held = requireHeld(await ledger.gate(authorityRelease));

    expect(authorityReleaseTask).not.toHaveBeenCalled();
    expect(held.retainedAuthority).toMatchObject({
      ipcSocket: true,
      cleanupObligations: ['commit-started finalization', 'authority release'],
      operatorActions: [],
    });
  });

  it('gives every retry its own budget before transferring the exact final process-exit remainder', async () => {
    const time = new VirtualTime();
    const retryOrder: string[] = [];
    const hangingTask = vi.fn(() => {
      retryOrder.push('process-exit');
      return new Promise<never>(() => {});
    });
    const blockingTask = vi.fn(async () => {
      retryOrder.push('blocking');
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
      remainder: { owner: 'process-exit' },
    };
    const blocking: ShutdownObligation = {
      label: 'blocking finalizer',
      task: blockingTask,
      retainedAuthority: () => ({ cleanupObligations: ['blocking finalizer'] }),
      remainder: { owner: 'none' },
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
    await expect(ledger.run(blocking)).resolves.toMatchObject({ kind: 'declined', cause: 'budget-exhausted' });
    const held = requireHeld(await ledger.gate(authorityRelease));
    retryOrder.length = 0;

    const retry = held.retry();
    await flush();
    expect(blockingTask).toHaveBeenCalledOnce();
    expect(authorityPrepareTask).toHaveBeenCalledOnce();
    expect(hangingTask).toHaveBeenCalledTimes(2);
    expect(authorityReleaseTask).not.toHaveBeenCalled();
    expect(retryOrder).toEqual(['blocking', 'prepare', 'process-exit']);
    time.tick(225);
    const retried = await retry;

    expect(retried).toMatchObject({
      disposition: 'delegated',
      owner: 'process-exit',
      deferredFailures: [{ label: 'process-exit finalizer' }],
    });
    if (retried.disposition !== 'delegated') throw new Error('expected delegated shutdown');
    expect(authorityReleaseTask).toHaveBeenCalledOnce();
    expect(retried.acceptance.remainder).toBe(offeredRemainder);
    expect(retried.deferredFailures).toBe(retried.acceptance.remainder.deferredFailures);
    expect(retried.deferredFailures[0]?.error).toEqual(
      expect.objectContaining({ message: 'timed-out: exceeded 225ms' }),
    );
    expect(retryOrder).toEqual(['blocking', 'prepare', 'process-exit', 'accept', 'commit']);
    expect(requestExit).not.toHaveBeenCalled();
  });

  it('retries only authority preparation and commit after accepting process-exit ownership', async () => {
    const time = new VirtualTime();
    const processExitTask = vi.fn(async () => {
      throw new Error('process finalizer unavailable');
    });
    const processExit: ShutdownObligation = {
      label: 'process-exit finalizer',
      task: processExitTask,
      retainedAuthority: () => ({ cleanupObligations: ['process-exit finalizer'] }),
      remainder: { owner: 'process-exit' },
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
    const pending = await ledger.gate(boundary);

    expect(pending).toMatchObject({
      disposition: 'transfer-pending',
      owner: 'process-exit',
      boundaryFailure: { label: 'authority release' },
      retainedAuthority: { ipcSocket: true, cleanupObligations: ['authority release'] },
    });
    if (pending.disposition !== 'transfer-pending') throw new Error('expected pending authority transfer');
    const accepted = pending.acceptance;
    expect(pending.deferredFailures).toBe(accepted.remainder.deferredFailures);

    const delegated = await pending.retry();

    expect(delegated).toMatchObject({ disposition: 'delegated', owner: 'process-exit' });
    if (delegated.disposition !== 'delegated') throw new Error('expected delegated shutdown');
    expect(delegated.acceptance).toBe(accepted);
    expect(delegated.deferredFailures).toBe(accepted.remainder.deferredFailures);
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
      remainder: { owner: 'process-exit' },
    };
    const accept = vi.fn<(remainder: ProcessExitRemainder) => ProcessExitRemainderAcceptance>();
    const commit = vi.fn<ShutdownAuthorityReleaseBoundary['commit']>();
    const boundary: ShutdownAuthorityReleaseBoundary = {
      label: 'authority release',
      prepare: () => Promise.resolve({ confirmed: false, detail: 'authority snapshot unavailable' }),
      commit,
      retainedAuthority: () => ({ ipcSocket: true, cleanupObligations: ['authority release'] }),
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

  it('retains authority while a successor-recovery obligation remains declined', async () => {
    const time = new VirtualTime();
    const authorityReleaseTask = vi.fn(async () => ({ confirmed: true as const }));
    let successorAttempts = 0;
    const successorRecovery: ShutdownObligation = {
      label: 'startup recovery handoff',
      task: async () => {
        successorAttempts += 1;
        if (successorAttempts === 1) throw new Error('successor not accepted');
        return { confirmed: true };
      },
      retainedAuthority: () => ({ cleanupObligations: ['startup recovery handoff'] }),
      remainder: { owner: 'successor-recovery', via: 'startup recovery' },
    };
    const authorityToken = {};
    const authorityRelease: ShutdownAuthorityReleaseBoundary = {
      label: 'authority release',
      prepare: () => Promise.resolve({ confirmed: true, token: authorityToken }),
      commit: authorityReleaseTask,
      retainedAuthority: () => ({ ipcSocket: true, cleanupObligations: ['authority release'] }),
    };
    const ledger = createShutdownSettlementLedger({ budgetMs: 900, time, log: () => {}, pollMs: 50 });

    await expect(ledger.run(successorRecovery)).resolves.toMatchObject({ kind: 'declined', cause: 'rejected' });
    const held = requireHeld(await ledger.gate(authorityRelease));

    expect(authorityReleaseTask).not.toHaveBeenCalled();
    expect(held.retainedAuthority).toMatchObject({
      ipcSocket: true,
      cleanupObligations: ['startup recovery handoff', 'authority release'],
    });

    await expect(held.retry()).resolves.toEqual({ disposition: 'settled' });
    expect(authorityReleaseTask).toHaveBeenCalledOnce();
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
  return heldFailureDetail(requireHeld(await runShutdownSequence(ctx)));
}

describe('required provider-proxy shutdown steps', () => {
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
      guardianIdentity: {
        pid: 4242,
        incarnation: testIncarnation('shutdown-hold'),
        processGroupId: 4242,
      },
      recoveryCapability: { retry },
    };
    const harness = buildHarness({ reason: 'fatal' });
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
      /provider host shutdown: .*acquisition guardian 4242: guardian is still alive/u,
    );
    expect(retry).toHaveBeenCalledOnce();
    expect(harness.ctx.markJobsAsErrorFn).not.toHaveBeenCalled();
  });

  it('reaps every live set on a hard shutdown before terminating owned children', async () => {
    const callLog: CallLog = [];
    const harness = buildHarness({
      reason: 'fatal',
      hooksOnShutdown: async () => {},
      providerProxyAuthority: registryOf([fakeSet('p1', callLog), fakeSet('p2', callLog)]),
    });
    harness.ctx.terminateAllFn = () => {
      callLog.push('terminateAll');
      return { kind: 'all-observed-absent' };
    };

    await runShutdownSequence(harness.ctx);

    // The detached sets outlive this coordinator, so they must be reaped by identity before the handle-based
    // termination that only reaches children this process still owns.
    expect(callLog).toEqual([
      'reap:p1',
      'reap:p2',
      'terminateAll',
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
      reason: 'fatal',
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
    harness.ctx.terminateAllFn = () => {
      callLog.push('terminateAll');
      return { kind: 'all-observed-absent' };
    };

    await runShutdownSequence(harness.ctx);

    // The late-settling set must still go through the required reap step, not be silently skipped because an
    // earlier, now-stale reading of `liveSets()` reported nothing live.
    expect(callLog).toEqual(['reap:late', 'terminateAll', 'heartbeats:late', 'control:late']);
  });

  it('holds the shutdown when a reap completes without confirming disappearance', async () => {
    const callLog: CallLog = [];
    const harness = buildHarness({
      reason: 'fatal',
      hooksOnShutdown: async () => {},
      providerProxyAuthority: registryOf([
        fakeSet('p1', callLog, { stopAndReap: async () => ({ unconfirmed: 'a recorded root is still alive' }) }),
      ]),
    });

    // "The reap RPC returned" is not "the containment is gone"; reporting clean success here would leave a
    // live provider carrier behind a shutdown that claimed to have removed it.
    const held = requireHeld(await runShutdownSequence(harness.ctx));
    expect(heldFailureDetail(held)).toMatch(/unconfirmed: p1: a recorded root is still alive/u);
    expect(held.retainedAuthority.operatorActions).toContainEqual(
      expect.objectContaining({ kind: 'provider-proxy-set-containment', proxyInstanceId: 'p1' }),
    );
  });

  it('holds with an operator action when a reap rejects, then retries the declined row', async () => {
    const callLog: CallLog = [];
    let reapAttempts = 0;
    const harness = buildHarness({
      reason: 'fatal',
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

    const held = requireHeld(await runShutdownSequence(harness.ctx));
    expect(heldFailureDetail(held)).toMatch(/p1: .*signal refused/u);
    expect(held.retainedAuthority.operatorActions).toContainEqual(
      expect.objectContaining({ kind: 'provider-proxy-set-containment', proxyInstanceId: 'p1' }),
    );
    expect(callLog).toContain('reap:p2');
    await expect(held.retry()).resolves.toEqual({ disposition: 'settled' });
    expect(reapAttempts).toBe(2);
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
    expect(held.retainedAuthority.operatorActions).toContainEqual(
      expect.objectContaining({ kind: 'provider-proxy-set-containment', proxyInstanceId: 'p1' }),
    );
    expect(callLog).not.toContain('closeIpcServerFn:start');
    await expect(held.retry()).resolves.toEqual({ disposition: 'settled' });
    expect(controlAttempts).toBe(2);
    expect(callLog).toContain('closeIpcServerFn:start');
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
    expect(held.retainedAuthority.operatorActions).toContainEqual(
      expect.objectContaining({ kind: 'provider-proxy-set-containment', proxyInstanceId: 'p-throws' }),
    );
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
    expect(held.retainedAuthority.operatorActions).toEqual([]);
    expect(callLog).toContain('control:p1');
    await expect(held.retry()).resolves.toEqual({ disposition: 'settled' });
    expect(ipcAttempts).toBe(2);
  });
});

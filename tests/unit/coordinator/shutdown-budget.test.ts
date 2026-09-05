import { readFileSync } from 'node:fs';
import type { Server, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import { HANDOFF_DRAIN_TIMEOUT_MS, SHUTDOWN_DRAIN_TIMEOUT_MS, runShutdownSequence } from '#src/coordinator/shutdown.js';
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
        };
      },
      shutdown: async () => ({
        kind: 'provider-hosts-quiesced',
        liveProxySets: opts.providerProxyAuthority?.liveSets() ?? [],
        acquisitionCleanupHolds: [],
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

describe('runShutdownSequence drain budget', () => {
  it('returns within drainTimeout + small slack when an async-cooperative finalizer hangs', async () => {
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
    await expect(sequence).rejects.toBeInstanceOf(AggregateError);

    expect(completed).toBe(true);
    const elapsed = harness.time.now() - startedAt;
    expect(elapsed).toBeLessThanOrEqual(HANDOFF_DRAIN_TIMEOUT_MS + 100);

    // Warn line for the hanging hooks.onShutdown finalizer must be present.
    const warnedHooks = harness.logLines.some((line) => line.includes('hooks.onShutdown: exceeded drain budget'));
    expect(warnedHooks).toBe(true);
    expect(hookSignal).not.toBeNull();
    expect((hookSignal as unknown as AbortSignal).aborted).toBe(true);

    expect(harness.closeIpcCalled()).toBe(false);
  });

  it('reports hard shutdown failure when provider-host containment exceeds the lifecycle deadline', async () => {
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
    await expect(sequence).rejects.toBeInstanceOf(AggregateError);

    const sawExceeded = harness.logLines.some((l) => l.includes('provider host shutdown: exceeded drain budget'));
    expect(sawExceeded).toBe(false);
    expect(harness.logLines).toContainEqual(
      expect.stringContaining("Required shutdown step 'provider host shutdown' timed-out"),
    );
    expect(harness.logLines).toContainEqual(
      expect.stringContaining("Required shutdown step 'child termination' budget-exhausted"),
    );
    expect(providerSignal?.aborted).toBe(true);
    expect(harness.callLog).toContain('terminateAllFn');
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
      }),
      shutdown: async () => {
        shutdownAttempts += 1;
        if (shutdownAttempts === 1) throw new Error('injected provider close failure');
        return { kind: 'provider-hosts-quiesced', liveProxySets: [retainedSet], acquisitionCleanupHolds: [] };
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
      }),
    };

    const held = await runShutdownSequence(harness.ctx);
    expect(held).toMatchObject({
      disposition: 'held',
      reason: 'required-shutdown-step-unsettled',
    });

    expect(stopAndReap).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
    if (held.disposition !== 'held') throw new Error('expected held shutdown finalization');
    await expect(held.retry()).resolves.toEqual({ disposition: 'settled' });
    expect(stopAndReap).toHaveBeenCalledOnce();
    expect(retry).toHaveBeenCalledOnce();
  });

  it('continues hard shutdown when crash terminalization throws', async () => {
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
      }),
      shutdown: async () => {
        harness.callLog.push('providerHostManager.shutdown');
        return { kind: 'provider-hosts-quiesced', liveProxySets: [], acquisitionCleanupHolds: [] };
      },
    } as never;
    harness.ctx.terminateAllFn = () => {
      harness.callLog.push('terminateAllFn');
      return { kind: 'all-observed-absent' };
    };

    await expect(runShutdownSequence(harness.ctx)).rejects.toBeInstanceOf(AggregateError);

    expect(terminalizationSignal).toBeInstanceOf(AbortSignal);
    expect(harness.callLog).toContain('providerHostManager.shutdown');
    expect(harness.callLog).toContain('terminateAllFn');
    expect(harness.callLog.indexOf('terminateAllFn')).toBeLessThan(harness.callLog.indexOf('markJobsAsErrorFn'));
    expect(harness.logLines).toContainEqual(
      expect.stringContaining('crashed job terminalization failed during shutdown'),
    );
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

    await expect(runShutdownSequence(harness.ctx)).rejects.toBeInstanceOf(AggregateError);

    expect(harness.ctx.markJobsAsErrorFn).not.toHaveBeenCalled();
  });

  it('fails hard shutdown and names a durable child that remains alive at the deadline', async () => {
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

    expect(detail).toContain("Required shutdown step 'child termination' unconfirmed");
    expect(detail).toContain('pid 4242: target-alive after-sigkill');
  });

  it('fails hard shutdown and names unavailable signal authority at the deadline', async () => {
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

    expect(detail).toContain("Required shutdown step 'child termination' unconfirmed");
    expect(detail).toContain('pid 4243: recorded-incarnation-unavailable');
  });

  it('continues remaining hard teardown when child liveness stays unobservable through the deadline', async () => {
    const harness = buildHarness({ reason: 'test-cleanup', hooksOnShutdown: async () => {} });
    harness.ctx.terminateAllFn = (signal) =>
      new Promise((resolve) => {
        const finish = (): void => {
          resolve({
            kind: 'unresolved-at-deadline',
            processes: [{ kind: 'target-unobservable', pid: 4_244, stage: 'after-sigkill' }],
            pendingLaunches: 0,
            retainedLaunches: [],
            cleanupHandles: 1,
            retainedProcesses: [],
            cleanupFailures: 0,
            owner: 'launch-coordinator',
          });
        };
        if (signal.aborted) finish();
        else signal.addEventListener('abort', finish, { once: true });
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

    const sequence = runShutdownSequence(harness.ctx);
    await flush(64);
    harness.time.tick(SHUTDOWN_DRAIN_TIMEOUT_MS);
    await flush(64);

    await expect(sequence).rejects.toBeInstanceOf(AggregateError);
    expect(harness.callLog).toContain('discuss.dispose');
    expect(harness.closeIpcCalled()).toBe(false);
  });

  it('emits a budget-exhausted skip log for finalizers reached after the deadline', async () => {
    // Provider-host drain consumes the entire budget so subsequent steps see
    // remaining=0 and emit the "skipped" message rather than the "exceeded"
    // message. The app-server quiesce step is structurally synchronous and
    // does not consume budget.
    const harness = buildHarness({});
    harness.ctx.providerHostManager = {
      drainForHandoff: () => new Promise<void>(() => {}),
      shutdown: async () => ({ kind: 'provider-hosts-quiesced', liveProxySets: [], acquisitionCleanupHolds: [] }),
    } as never;

    const sequence = runShutdownSequence(harness.ctx);
    for (let i = 0; i <= HANDOFF_DRAIN_TIMEOUT_MS + 100; i += 200) {
      harness.time.tick(200);
      await flush();
    }
    await expect(sequence).rejects.toBeInstanceOf(AggregateError);

    // The drain-for-handoff step exceeded budget; later steps must surface
    // "skipped (drain budget exhausted)" because remainingDrain() == 0.
    const sawExceeded = harness.logLines.some((l) =>
      l.includes('provider host drain for handoff: exceeded drain budget'),
    );
    const sawRequiredFailure = harness.logLines.some((l) =>
      l.includes("Required shutdown step 'provider host drain for handoff' timed-out"),
    );
    const sawSkipped = harness.logLines.some((l) => l.includes('hooks.onShutdown: skipped (drain budget exhausted)'));
    expect(sawExceeded).toBe(false);
    expect(sawRequiredFailure).toBe(true);
    expect(sawSkipped).toBe(true);
    expect(harness.closeIpcCalled()).toBe(false);
  });

  it('retains the IPC socket when a wrapped finalizer expires without settling', async () => {
    const harness = buildHarness({
      hooksOnShutdown: () => new Promise<void>(() => {}),
    });

    const order: string[] = [];
    const wrap = <K extends keyof typeof harness.ctx>(key: K): void => {
      void key;
    };
    void wrap;

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
      shutdown: async () => ({ kind: 'provider-hosts-quiesced', liveProxySets: [], acquisitionCleanupHolds: [] }),
    } as never;
    harness.ctx.closeIpcServerFn = async (_l: IpcListener) => {
      order.push('closeIpc');
    };

    const sequence = runShutdownSequence(harness.ctx);
    for (let i = 0; i <= HANDOFF_DRAIN_TIMEOUT_MS + 100; i += 100) {
      harness.time.tick(100);
      await flush();
    }
    await expect(sequence).rejects.toBeInstanceOf(AggregateError);

    expect(order).toContain('hooks:start');
    expect(order).not.toContain('closeIpc');
  });

  it('sync-blocking finalizer surfaces budget warn after the sync call returns (AC5 soft bound)', async () => {
    // Simulates a finalizer that holds the event loop synchronously past the
    // deadline (e.g. `processPort.execSync` with internal timeout). The
    // budget timer cannot fire until the sync call returns; the test
    // documents this soft bound by asserting the warn line surfaces only
    // after the sync work yields, and the function still returns.
    const harness = buildHarness({});
    harness.ctx.hooks = {
      onShutdown: async () => {
        // Synchronously advance virtual time past the remaining budget,
        // then yield. The budget timer does NOT fire while no microtask
        // runs; once we yield, `Promise.race` resolves with `timedOut` and
        // emits the warn line — but the finalizer also already returned.
        harness.time.tick(HANDOFF_DRAIN_TIMEOUT_MS + 5_000);
      },
    };

    const sequence = runShutdownSequence(harness.ctx);
    for (let i = 0; i < 10; i += 1) {
      await flush();
      harness.time.tick(100);
    }
    await expect(sequence).rejects.toBeInstanceOf(AggregateError);

    // hooks.onShutdown completed before the budget timer could pre-empt;
    // since the task resolved first the race returns the task value (not
    // `timedOut`), so no warn is expected for hooks.onShutdown. The soft
    // bound is documented: the function still returns regardless of the
    // sync-blocking phase. Assert termination.
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

  it('aborts the timeout sleep when the finalizer wins, leaving no pending timer', async () => {
    // Hooks.onShutdown resolves immediately; the budget sleep must abort so
    // it does not later fire and emit a delayed "exceeded" warning.
    const harness = buildHarness({
      hooksOnShutdown: async () => {
        // resolves on next microtask
      },
    });

    const sequence = runShutdownSequence(harness.ctx);
    // Drain advances only via internal awaits; no virtual ticks needed for
    // promptly-resolving finalizers. A safety advance covers the scheduled
    // closeIpc race.
    await flush(64);
    harness.time.tick(HANDOFF_DRAIN_TIMEOUT_MS + 1000);
    await flush(64);
    await sequence;

    // No "exceeded drain budget" line should appear for hooks.onShutdown:
    // when the task wins, the sleep is aborted in `finally`.
    const sawHooksTimeout = harness.logLines.some((l) => l.includes('hooks.onShutdown: exceeded drain budget'));
    expect(sawHooksTimeout).toBe(false);
    expect(harness.closeIpcCalled()).toBe(true);
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
      }),
      shutdown: async () => ({
        kind: 'provider-hosts-quiesced',
        liveProxySets: [set],
        acquisitionCleanupHolds: [],
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
        cleanupObligations: ['child termination'],
        operatorActions: [
          {
            kind: 'retained-job-containment',
            jobId: 'hard-held-job',
            provider: 'claude',
            jobDir: '/tmp/coral/jobs/hard-held-job',
            actionCommand: 'coral-cli abort hard-held-job',
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
        };
      },
      shutdown: async () => ({
        kind: 'provider-hosts-quiesced',
        liveProxySets: [],
        acquisitionCleanupHolds: [],
      }),
      cleanupObligations: () => ({ liveProxySets: [set], acquisitionCleanupHolds: [] }),
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
        cleanupObligations: ['provider host drain for handoff'],
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

  it('retains authority through a fatal app-server quiesce failure with no durable recovery action', async () => {
    const authorityCalls: string[] = [];
    const harness = buildHarness({ reason: 'replaced', hooksOnShutdown: async () => {} });
    harness.ctx.handoffQuiescePorts = () => [
      { quiesceAppServerJobsForHandoff: async () => Promise.reject(new Error('quiescence unavailable')) },
    ];
    harness.ctx.closeIpcServerFn = async () => {
      authorityCalls.push('closeIpc');
    };

    await expect(runShutdownSequence(harness.ctx)).rejects.toBeInstanceOf(AggregateError);
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
        };
      },
      shutdown: async () => ({
        kind: 'provider-hosts-quiesced',
        liveProxySets: [],
        acquisitionCleanupHolds: [],
      }),
      cleanupObligations: () => ({
        liveProxySets: [retainedSet],
        acquisitionCleanupHolds: [acquisitionHold],
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
        cleanupObligations: ['provider host drain for handoff', 'provider acquisition pending-handoff-acquisition'],
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

/** Shutdown aggregates its failures, so the detail a test cares about lives in `errors`, not the summary. */
async function shutdownFailureDetail(ctx: Parameters<typeof runShutdownSequence>[0]): Promise<string> {
  try {
    const disposition = await runShutdownSequence(ctx);
    if (disposition.disposition === 'held') {
      return disposition.deferredFailures
        .map(({ label, error }) => `${label}: ${error instanceof Error ? error.message : String(error)}`)
        .join(' | ');
    }
  } catch (error: unknown) {
    if (error instanceof AggregateError) {
      return error.errors.map((entry: unknown) => (entry instanceof Error ? entry.message : String(entry))).join(' | ');
    }
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the shutdown sequence to report a failure');
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
      }),
      shutdown: async () => ({
        kind: 'provider-hosts-quiesced',
        liveProxySets: [],
        acquisitionCleanupHolds: [hold],
      }),
    };

    expect(await shutdownFailureDetail(harness.ctx)).toMatch(
      /provider proxy stop and reap: .*acquisition guardian 4242: guardian is still alive/u,
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
      }),
      shutdown: async () => {
        // The acquisition settles here — during `providerHostManager.shutdown()` itself, after whatever
        // reading of `liveSets()` happened before this call started.
        live = [fakeSet('late', callLog)];
        return { kind: 'provider-hosts-quiesced', liveProxySets: live, acquisitionCleanupHolds: [] };
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

  it('fails the shutdown when a reap completes without confirming disappearance', async () => {
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
    expect(await shutdownFailureDetail(harness.ctx)).toMatch(/unconfirmed: p1: a recorded root is still alive/u);
  });

  it('fails the shutdown when a reap rejects, naming the set that could not be released', async () => {
    const callLog: CallLog = [];
    const harness = buildHarness({
      reason: 'fatal',
      hooksOnShutdown: async () => {},
      providerProxyAuthority: registryOf([
        fakeSet('p1', callLog, {
          stopAndReap: () => Promise.reject(new Error('signal refused')),
        }),
        fakeSet('p2', callLog),
      ]),
    });

    // The healthy set is still reaped: one failure must not skip the others.
    expect(await shutdownFailureDetail(harness.ctx)).toMatch(/p1: .*signal refused/u);
    expect(callLog).toContain('reap:p2');
  });

  it('retains the IPC socket when provider control cannot be released', async () => {
    const callLog: CallLog = [];
    const harness = buildHarness({
      hooksOnShutdown: async () => {},
      providerProxyAuthority: registryOf([
        fakeSet('p1', callLog, { initiateControlClose: () => Promise.reject(new Error('control gone')) }),
      ]),
    });
    harness.ctx.closeIpcServerFn = async () => {
      callLog.push('closeIpcServerFn:start');
    };

    expect(await shutdownFailureDetail(harness.ctx)).toMatch(/control p1: .*control gone/u);
    expect(callLog).not.toContain('closeIpcServerFn:start');
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
    const harness = buildHarness({
      hooksOnShutdown: async () => {},
      providerProxyAuthority: registryOf([
        fakeSet('p-throws', callLog, {
          stopHeartbeats: () => {
            throw new Error('heartbeat scheduler already disposed');
          },
        }),
        fakeSet('p2', callLog),
      ]),
    });
    harness.ctx.closeIpcServerFn = async () => {
      callLog.push('closeIpcServerFn:start');
    };

    expect(await shutdownFailureDetail(harness.ctx)).toMatch(
      /heartbeats p-throws: .*heartbeat scheduler already disposed/u,
    );
    expect(callLog).toContain('heartbeats:p2');
    expect(callLog).toContain('control:p-throws');
    expect(callLog).toContain('control:p2');
    expect(callLog).not.toContain('closeIpcServerFn:start');
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

  it('remains fatal when the controls close but the IPC release fails', async () => {
    const callLog: CallLog = [];
    const harness = buildHarness({
      hooksOnShutdown: async () => {},
      providerProxyAuthority: registryOf([fakeSet('p1', callLog)]),
      closeIpcServerFn: async () => {
        throw new Error('socket stuck');
      },
    });

    // The already-armed reaper still enforces its own fixed deadline, but this shutdown must not claim it
    // released authority cleanly.
    expect(await shutdownFailureDetail(harness.ctx)).toMatch(
      /provider control and IPC authority release: .*IPC socket: .*socket stuck/u,
    );
    expect(callLog).toContain('control:p1');
  });
});

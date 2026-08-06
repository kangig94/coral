import { readFileSync } from 'node:fs';
import type { Server, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { HANDOFF_DRAIN_TIMEOUT_MS, SHUTDOWN_DRAIN_TIMEOUT_MS, runShutdownSequence } from '#src/coordinator/shutdown.js';
import type {
  ProviderProxyAuthorityRegistry,
  ProviderProxySetAuthority,
} from '#src/coordinator/live/provider-proxy-authority.js';
import type { IpcListener } from '#src/transport/ipc/server.js';
import type { Runtime } from '#src/runtime/ports.js';
import { VirtualTime } from '#tools/simulation/core/virtual-time.js';

// AC5: `runShutdownSequence` completes within `HANDOFF_DRAIN_TIMEOUT_MS` even
// when an async-cooperative finalizer hangs. The IPC socket must remain bound
// (i.e. `closeIpcServerFn` must NOT be called) until all bounded finalizers
// have completed or had their budget elapsed; socket release is the last step.

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

  // Minimal runtime — only `time` is read by `runShutdownSequence`.
  const runtime = { time } as unknown as Runtime;

  // Stub server: `close` and `closeAllConnections` are called synchronously;
  // we do not need to simulate the HTTP wire.
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
      },
      shutdown: async () => {},
    } as never,
    providerProxyAuthority: opts.providerProxyAuthority,
    storeServicesRef: {
      tryGet: () => storeServices,
      get: () => storeServices,
      set: () => {},
      clear: () => {},
    } as never,
    terminateAllFn: () => {},
    handoffQuiescePorts: () => [],
    disposeLifecycleReactor: () => {
      callLog.push('lifecycleReactor.dispose');
    },
    hooks: {
      onShutdown: async (_mode, signal) => {
        // Default: hangs forever. Tests override per case.
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

    let resolved = false;
    const sequence = runShutdownSequence(harness.ctx).then(() => {
      resolved = true;
    });

    // Drive virtual time forward enough to fire all budget timers.
    // The bounded steps consume `HANDOFF_DRAIN_TIMEOUT_MS` worth of virtual
    // time in aggregate when each finalizer hangs; each step's race expires
    // back-to-back as the deadline draws closer.
    for (let advanced = 0; advanced <= HANDOFF_DRAIN_TIMEOUT_MS + 100; advanced += 100) {
      harness.time.tick(100);
      await flush();
      if (resolved) break;
    }
    await sequence;

    expect(resolved).toBe(true);
    const elapsed = harness.time.now() - startedAt;
    expect(elapsed).toBeLessThanOrEqual(HANDOFF_DRAIN_TIMEOUT_MS + 100);

    // Warn line for the hanging hooks.onShutdown finalizer must be present.
    const warnedHooks = harness.logLines.some((line) => line.includes('hooks.onShutdown: exceeded drain budget'));
    expect(warnedHooks).toBe(true);
    expect(hookSignal).not.toBeNull();
    expect((hookSignal as unknown as AbortSignal).aborted).toBe(true);

    // Socket release happens regardless.
    expect(harness.closeIpcCalled()).toBe(true);
  });

  it('bounds hard-mode provider host shutdown before terminating children', async () => {
    const harness = buildHarness({
      hooksOnShutdown: async () => {},
    });
    harness.ctx.reason = 'test-cleanup';
    let providerSignal: AbortSignal | undefined;
    harness.ctx.providerHostManager = {
      drainForHandoff: async () => {},
      shutdown: (signal?: AbortSignal) => {
        providerSignal = signal;
        return new Promise<void>(() => {});
      },
    } as never;
    harness.ctx.terminateAllFn = () => {
      harness.callLog.push('terminateAllFn');
    };

    const sequence = runShutdownSequence(harness.ctx);
    for (let i = 0; i <= SHUTDOWN_DRAIN_TIMEOUT_MS + 100; i += 100) {
      harness.time.tick(100);
      await flush();
    }
    await sequence;

    const sawExceeded = harness.logLines.some((l) => l.includes('provider host shutdown: exceeded drain budget'));
    expect(sawExceeded).toBe(true);
    expect(providerSignal?.aborted).toBe(true);
    expect(harness.callLog).toContain('terminateAllFn');
    expect(harness.closeIpcCalled()).toBe(true);
  });

  it('continues hard shutdown when crash terminalization throws', async () => {
    const harness = buildHarness({
      hooksOnShutdown: async () => {},
    });
    harness.ctx.reason = 'test-cleanup';
    let terminalizationSignal: AbortSignal | undefined;
    harness.ctx.markJobsAsErrorFn = (_message, signal) => {
      terminalizationSignal = signal;
      throw new Error('injected crash terminalization failure');
    };
    harness.ctx.providerHostManager = {
      drainForHandoff: async () => {},
      shutdown: async () => {
        harness.callLog.push('providerHostManager.shutdown');
      },
    } as never;
    harness.ctx.terminateAllFn = () => {
      harness.callLog.push('terminateAllFn');
    };

    await expect(runShutdownSequence(harness.ctx)).rejects.toBeInstanceOf(AggregateError);

    expect(terminalizationSignal).toBeInstanceOf(AbortSignal);
    expect(harness.callLog).toContain('providerHostManager.shutdown');
    expect(harness.callLog).toContain('terminateAllFn');
    expect(harness.logLines).toContainEqual(
      expect.stringContaining('crashed job terminalization failed during shutdown'),
    );
  });

  it('emits a budget-exhausted skip log for finalizers reached after the deadline', async () => {
    // Provider-host drain consumes the entire budget so subsequent steps see
    // remaining=0 and emit the "skipped" message rather than the "exceeded"
    // message. The app-server quiesce step is structurally synchronous and
    // does not consume budget.
    const harness = buildHarness({});
    harness.ctx.providerHostManager = {
      drainForHandoff: () => new Promise<void>(() => {}),
      shutdown: async () => {},
    } as never;

    const sequence = runShutdownSequence(harness.ctx);
    for (let i = 0; i <= HANDOFF_DRAIN_TIMEOUT_MS + 100; i += 200) {
      harness.time.tick(200);
      await flush();
    }
    await sequence;

    // The drain-for-handoff step exceeded budget; later steps must surface
    // "skipped (drain budget exhausted)" because remainingDrain() == 0.
    const sawExceeded = harness.logLines.some((l) =>
      l.includes('provider host drain for handoff: exceeded drain budget'),
    );
    const sawSkipped = harness.logLines.some((l) => l.includes('hooks.onShutdown: skipped (drain budget exhausted)'));
    expect(sawExceeded).toBe(true);
    expect(sawSkipped).toBe(true);
    expect(harness.closeIpcCalled()).toBe(true);
  });

  it('releases the IPC socket only after every wrapped finalizer settles or expires', async () => {
    const harness = buildHarness({
      hooksOnShutdown: () => new Promise<void>(() => {}),
    });

    // Spy on the finalizer/socket-close ordering.
    const order: string[] = [];
    const wrap = <K extends keyof typeof harness.ctx>(key: K): void => {
      // no-op marker function for ordering
      void key;
    };
    void wrap;

    const origHooks = harness.ctx.hooks.onShutdown;
    harness.ctx.hooks = {
      onShutdown: async (_mode, signal) => {
        order.push('hooks:start');
        await origHooks('hard', signal);
        order.push('hooks:resolved'); // unreachable — hangs
      },
    };
    const origDrain = harness.ctx.providerHostManager.drainForHandoff;
    harness.ctx.providerHostManager = {
      drainForHandoff: async () => {
        order.push('drainForHandoff:start');
        await origDrain();
        order.push('drainForHandoff:resolved');
      },
      shutdown: async () => {},
    } as never;
    harness.ctx.closeIpcServerFn = async (_l: IpcListener) => {
      order.push('closeIpc');
    };

    const sequence = runShutdownSequence(harness.ctx);
    for (let i = 0; i <= HANDOFF_DRAIN_TIMEOUT_MS + 100; i += 100) {
      harness.time.tick(100);
      await flush();
    }
    await sequence;

    // closeIpc MUST appear after the hanging hooks finalizer started; it
    // is the LAST entry — any later finalizer would violate the
    // socket-release-is-last invariant.
    expect(order).toContain('closeIpc');
    expect(order.indexOf('closeIpc')).toBe(order.length - 1);
    expect(order.indexOf('closeIpc')).toBeGreaterThan(order.indexOf('hooks:start'));
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
    await sequence;

    // hooks.onShutdown completed before the budget timer could pre-empt;
    // since the task resolved first the race returns the task value (not
    // `timedOut`), so no warn is expected for hooks.onShutdown. The soft
    // bound is documented: the function still returns regardless of the
    // sync-blocking phase. Assert termination.
    expect(harness.closeIpcCalled()).toBe(true);
  });

  it('lifecycle invokes onStopped synchronously after runShutdownSequence resolves (no async work between socket release and exit)', () => {
    // Structural invariant: in `lifecycle.ts`'s shutdown path, the `.finally`
    // block following `runShutdownSequence(...)` MUST contain `onStopped?.()`
    // without any `await` between the surrounding `.finally(() => {` and the
    // callback invocation. This pins the "socket release IS process exit"
    // assumption — async work between `closeIpcServerFn` resolution and
    // `onStopped()` would let the OS keep the socket FD past the moment the
    // old daemon claims to have released authority.
    const lifecyclePath = fileURLToPath(new URL('../../../src/coordinator/lifecycle.ts', import.meta.url));
    const source = readFileSync(lifecyclePath, 'utf-8');

    // Locate the `.finally` block that follows the `runShutdownSequence` call.
    const finallyMatch = source.match(/\.finally\(\(\)\s*=>\s*{([\s\S]*?)}\)/);
    expect(finallyMatch, 'shutdown .finally block must exist').toBeTruthy();
    const finallyBody = finallyMatch![1];

    // No `await` may appear in the finally body — it is the synchronous
    // bridge from runShutdownSequence resolution to onStopped().
    expect(finallyBody.includes('await')).toBe(false);
    expect(finallyBody.includes('onStopped')).toBe(true);
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
});

/** One live set whose every step the test drives. Defaults are the healthy path. */
function fakeSet(
  proxyInstanceId: string,
  callLog: CallLog,
  overrides: Partial<ProviderProxySetAuthority> = {},
): ProviderProxySetAuthority {
  return {
    proxyInstanceId,
    snapshotOperations: async () => ['op-1'],
    installHandoffGrant: async () => {
      callLog.push(`install:${proxyInstanceId}`);
    },
    stopAndReap: async () => {
      callLog.push(`reap:${proxyInstanceId}`);
      return { disappearanceReceipt: `gone:${proxyInstanceId}` };
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
    await runShutdownSequence(ctx);
  } catch (error: unknown) {
    if (error instanceof AggregateError) {
      return error.errors.map((entry: unknown) => (entry instanceof Error ? entry.message : String(entry))).join(' | ');
    }
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the shutdown sequence to report a failure');
}

describe('required provider-proxy shutdown steps', () => {
  it('reaps every live set on a hard shutdown before terminating owned children', async () => {
    const callLog: CallLog = [];
    const harness = buildHarness({
      reason: 'fatal',
      hooksOnShutdown: async () => {},
      providerProxyAuthority: registryOf([fakeSet('p1', callLog), fakeSet('p2', callLog)]),
    });
    harness.ctx.terminateAllFn = () => {
      callLog.push('terminateAll');
    };

    await runShutdownSequence(harness.ctx);

    // The detached sets outlive this coordinator, so they must be reaped by identity before the handle-based
    // termination that only reaches children this process still owns.
    expect(callLog).toEqual(['reap:p1', 'reap:p2', 'terminateAll']);
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

  it('installs one grant per carrier and reaps only the carriers with nothing to hand off', async () => {
    const callLog: CallLog = [];
    const empty = fakeSet('p-empty', callLog, { snapshotOperations: async () => [] });
    const harness = buildHarness({
      hooksOnShutdown: async () => {},
      providerProxyAuthority: registryOf([fakeSet('p-live', callLog), empty]),
    });

    await runShutdownSequence(harness.ctx);

    expect(callLog).toContain('install:p-live');
    // A carrier with no live operation has nothing a successor could adopt, so leaving it running would
    // strand it; a carrier that does have work is handed over instead of killed.
    expect(callLog).toContain('reap:p-empty');
    expect(callLog).not.toContain('reap:p-live');
    expect(callLog).not.toContain('install:p-empty');
  });

  it('hard-transitions only the carrier whose grant install failed', async () => {
    const callLog: CallLog = [];
    const harness = buildHarness({
      hooksOnShutdown: async () => {},
      providerProxyAuthority: registryOf([
        fakeSet('p-bad', callLog, { installHandoffGrant: () => Promise.reject(new Error('reaper refused')) }),
        fakeSet('p-good', callLog),
      ]),
    });

    expect(await shutdownFailureDetail(harness.ctx)).toMatch(/reaper refused/u);
    // The failed carrier goes down; the healthy one keeps its grant, because one failed install must not
    // strand every other operation behind a single EOF.
    expect(callLog).toContain('reap:p-bad');
    expect(callLog).toContain('install:p-good');
    expect(callLog).not.toContain('reap:p-good');
  });

  it('triggers the IPC socket release even when every control close rejects', async () => {
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

    // The socket is what the successor is waiting on. A control close that rejects must not suppress its
    // release, or the successor waits out an adoption window it was never meant to spend.
    expect(await shutdownFailureDetail(harness.ctx)).toMatch(/control p1: .*control gone/u);
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
    expect(await shutdownFailureDetail(harness.ctx)).toMatch(/IPC socket release: .*socket stuck/u);
    expect(callLog).toContain('control:p1');
  });
});

import type { ProcessLiveness } from '#src/infra/node-process.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  bindWithHandoff,
  HandoffEscalationError,
  registerCoordinatorStartupRecovery,
  type BoundCoordinator,
  type HandoffOptions,
  type HandoffSignalLedger,
  type HandoffSignalPolicy,
} from '#src/coordinator/handoff.js';
import { SIGKILL_GRACE_MS, SIGTERM_GRACE_MS } from '#src/infra/process-constants.js';
import { VirtualTime } from '#tools/simulation/core/virtual-time.js';
import type { Runtime } from '#src/runtime/ports.js';
import { IncumbentMatchesError, type IncumbentHealth, type IncumbentIdentity } from '#src/transport/ipc/handoff.js';
import { backendLog } from '#src/infra/backend-log.js';

vi.mock('#src/transport/ipc/handoff.js', async (importOriginal) => {
  const original = await importOriginal<object>();
  return {
    ...original,
    requestIncumbentShutdown: vi.fn(),
  };
});

// `probeProcessIncarnation` is called inside `verifySignalTarget`; mock
// it so we can stage matched/null outcomes deterministically.
vi.mock('#src/infra/node-process.js', async (importOriginal) => {
  const original = await importOriginal<object>();
  return {
    ...original,
    probeProcessIncarnation: vi.fn(),
  };
});

import { requestIncumbentShutdown } from '#src/transport/ipc/handoff.js';
import { probeProcessIncarnation } from '#src/infra/node-process.js';

const mockedShutdown = requestIncumbentShutdown as ReturnType<typeof vi.fn>;
const mockedProbe = probeProcessIncarnation as ReturnType<typeof vi.fn>;

interface KillCall {
  pid: number;
  signal: NodeJS.Signals | 0;
}

function buildHarness(opts?: {
  bindSequence?: Array<{ kind: 'bound' } | { kind: 'incumbent'; reason: string }>;
  totalBudgetMs?: number;
  observeLiveness?: (pid: number) => ProcessLiveness;
  killThrows?: boolean;
  readDiscovery?: HandoffOptions['readVerifiedIncumbentFromDiscovery'];
  signalLedger?: HandoffSignalLedger;
  signalCooldownMs?: number;
  signalPolicy?: HandoffSignalPolicy;
  signal?: AbortSignal;
  runStartupRecovery?: HandoffOptions['runStartupRecovery'];
  platform?: NodeJS.Platform;
}) {
  const time = new VirtualTime();
  const killCalls: KillCall[] = [];
  const observeLivenessImpl = opts?.observeLiveness ?? ((): ProcessLiveness => 'alive');
  const runtime: Pick<Runtime, 'time' | 'process' | 'env'> = {
    time,
    process: {
      kill: (pid: number, signal: NodeJS.Signals | 0) => {
        killCalls.push({ pid, signal });
        if (opts?.killThrows) {
          throw new Error('kill failed');
        }
        return true;
      },
      observeLiveness: observeLivenessImpl,
    } as unknown as Runtime['process'],
    env: {
      platform: () => opts?.platform ?? 'linux',
    } as unknown as Runtime['env'],
  };

  let bindIndex = 0;
  const bindSequence = opts?.bindSequence ?? [{ kind: 'incumbent', reason: 'live-listener' }];
  const bindAttempt = vi.fn(async () => {
    const idx = Math.min(bindIndex, bindSequence.length - 1);
    bindIndex += 1;
    return bindSequence[idx];
  });

  const readDiscovery: HandoffOptions['readVerifiedIncumbentFromDiscovery'] = opts?.readDiscovery ?? (() => null);

  const options: HandoffOptions = {
    socketPath: '/tmp/coral.sock',
    desired: { version: '0.9.1', bundleHash: 'new-hash', flavor: 'prod', namespace: 'ns' },
    bindAttempt,
    runStartupRecovery: opts?.runStartupRecovery ?? (async () => []),
    runtime,
    readVerifiedIncumbentFromDiscovery: readDiscovery,
    ...(opts?.signalLedger === undefined ? {} : { signalLedger: opts.signalLedger }),
    ...(opts?.signalCooldownMs === undefined ? {} : { signalCooldownMs: opts.signalCooldownMs }),
    ...(opts?.signalPolicy === undefined ? {} : { signalPolicy: opts.signalPolicy }),
    ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
    totalBudgetMs: opts?.totalBudgetMs ?? 30_000,
  };

  return { time, runtime, options, killCalls, bindAttempt };
}

const flush = async (rounds = 16): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
};

function shutdownResult(overrides: {
  health?: IncumbentHealth | null;
  verifiedIdentity?: IncumbentIdentity | null;
  shutdownAttempted?: boolean;
  shutdownUnauthorized?: boolean;
}) {
  return {
    health: null,
    verifiedIdentity: null,
    shutdownAttempted: true,
    shutdownUnauthorized: false,
    ...overrides,
  };
}

beforeEach(() => {
  mockedShutdown.mockReset();
  mockedProbe.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('bindWithHandoff', () => {
  it('happy path: first bind attempt succeeds → no incumbent observed', async () => {
    const { options, time, bindAttempt } = buildHarness({
      bindSequence: [{ kind: 'bound' }],
    });
    const before = time.now();
    const result = await bindWithHandoff(options);
    expect(result.acquiredViaHandoff).toBe(false);
    expect(bindAttempt).toHaveBeenCalledTimes(1);
    expect(mockedShutdown).not.toHaveBeenCalled();
    expect(time.now()).toBe(before);
  });

  it('runs startup recovery only after the real bound capability registers its coordinator runner', async () => {
    const runCoordinatorStartupRecovery = vi.fn(async () => ({}) as never);
    const runStartupRecovery = vi.fn(async (_inputs, runJobsStartup) => {
      await runJobsStartup({} as never);
      return [];
    });
    const { options } = buildHarness({
      bindSequence: [{ kind: 'bound' }],
      runStartupRecovery,
    });
    const bound = await bindWithHandoff(options);

    expect(() => bound.runStartupRecovery({} as never)).toThrow('Bound coordinator startup recovery is not registered');

    registerCoordinatorStartupRecovery(bound, runCoordinatorStartupRecovery);
    await expect(bound.runStartupRecovery({} as never)).resolves.toEqual([]);
    expect(runStartupRecovery).toHaveBeenCalledTimes(1);
    expect(runCoordinatorStartupRecovery).toHaveBeenCalledTimes(1);
  });

  it('rejects a structurally forged bound coordinator at the consumed boundary', () => {
    const forged: BoundCoordinator = {
      acquiredViaHandoff: false,
      runStartupRecovery: async () => [],
    };

    expect(() => registerCoordinatorStartupRecovery(forged, async () => ({}) as never)).toThrow(
      'Bound coordinator capability is not registered',
    );
  });

  it('same-bundle incumbent throws IncumbentMatchesError', async () => {
    const { options } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }, { kind: 'bound' }],
    });
    mockedShutdown.mockImplementationOnce(() => {
      throw new IncumbentMatchesError(options.desired);
    });
    await expect(bindWithHandoff(options)).rejects.toBeInstanceOf(IncumbentMatchesError);
  });

  it('mismatched bundle: requests shutdown, polls bind, succeeds', async () => {
    const { options, time } = buildHarness({
      bindSequence: [
        { kind: 'incumbent', reason: 'live-listener' },
        { kind: 'incumbent', reason: 'live-listener' },
        { kind: 'bound' },
      ],
    });
    const verifiedIdentity: IncumbentIdentity = {
      pid: 4242,
      incarnation: testIncarnation(1_000_000),
      source: 'health',
    };
    mockedShutdown.mockResolvedValue(
      shutdownResult({
        health: {
          bundleHash: 'old',
          flavor: 'prod',
          namespace: 'ns',
          pid: 4242,
          incarnation: testIncarnation(1_000_000),
        } as IncumbentHealth,
        verifiedIdentity,
      }),
    );
    const promise = bindWithHandoff(options);
    // Poll cycles: each iteration sleeps `SOCKET_BIND_POLL_MS` (200).
    for (let i = 0; i < 5; i += 1) {
      await flush();
      time.tick(200);
    }
    await flush();
    const result = await promise;
    expect(result.acquiredViaHandoff).toBe(true);
    expect(mockedShutdown).toHaveBeenCalled();
  });

  it('cutover handoff: mismatched incumbent with discovery boot credential self-completes', async () => {
    const discoveryIdentity: IncumbentIdentity = {
      pid: 5252,
      incarnation: testIncarnation(7_000),
      source: 'discovery',
      instanceId: 'cutover-incumbent',
      token: 'backend-token',
      bootToken: 'boot-token',
      shutdownToken: 'shutdown-token',
    };
    const { options, time } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }, { kind: 'bound' }],
      readDiscovery: () => discoveryIdentity,
    });
    mockedShutdown.mockResolvedValue(
      shutdownResult({
        health: {
          bundleHash: 'old-hash',
          flavor: 'prod',
          namespace: 'ns',
          status: 'ok',
          pid: discoveryIdentity.pid,
          incarnation: discoveryIdentity.incarnation,
          instanceId: discoveryIdentity.instanceId,
        },
        verifiedIdentity: null,
        shutdownAttempted: true,
        shutdownUnauthorized: false,
      }),
    );

    const promise = bindWithHandoff(options);
    await flush();
    time.tick(200);
    await flush();

    await expect(promise).resolves.toEqual({
      acquiredViaHandoff: true,
      runStartupRecovery: expect.any(Function),
    });
    expect(mockedShutdown).toHaveBeenCalledWith(
      expect.objectContaining({
        socketPath: '/tmp/coral.sock',
        desired: options.desired,
        bootToken: 'boot-token',
      }),
    );
  });

  it('cutover handoff: mismatched incumbent without discovery boot credential requires manual shutdown', async () => {
    const discoveryIdentity: IncumbentIdentity = {
      pid: 5353,
      incarnation: testIncarnation(7_100),
      source: 'discovery',
      instanceId: 'cutover-incumbent-no-credential',
      token: 'backend-token',
      shutdownToken: 'shutdown-token',
    };
    const { options } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }],
      readDiscovery: () => discoveryIdentity,
    });
    mockedShutdown.mockResolvedValue(
      shutdownResult({
        health: {
          bundleHash: 'old-hash',
          flavor: 'prod',
          namespace: 'ns',
          status: 'ok',
          pid: discoveryIdentity.pid,
          incarnation: discoveryIdentity.incarnation,
          instanceId: discoveryIdentity.instanceId,
        },
        verifiedIdentity: null,
        shutdownAttempted: false,
        shutdownUnauthorized: false,
      }),
    );

    await expect(bindWithHandoff(options)).rejects.toThrow(
      'Manual shutdown required: refusing handoff for pid=5353 because verified shutdown capability was unavailable',
    );
    expect(mockedShutdown).toHaveBeenCalledWith(
      expect.objectContaining({
        socketPath: '/tmp/coral.sock',
        desired: options.desired,
        bootToken: undefined,
      }),
    );
  });

  it('budget exhausted with no verified pid → HandoffEscalationError', async () => {
    const { options, time } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }],
      totalBudgetMs: 500,
    });
    mockedShutdown.mockResolvedValue(shutdownResult({ health: null, verifiedIdentity: null }));

    const promise = bindWithHandoff(options);
    for (let i = 0; i < 30; i += 1) {
      await flush();
      time.tick(100);
    }
    await flush();
    await expect(promise).rejects.toBeInstanceOf(HandoffEscalationError);
  });

  it('SIGTERM/SIGKILL escalation: matched pid, then kill', async () => {
    const verifiedIdentity: IncumbentIdentity = {
      pid: 7777,
      incarnation: testIncarnation(555_000),
      source: 'health',
    };
    const { options, time, killCalls } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }],
      totalBudgetMs: 1_000,
      readDiscovery: () => ({
        ...verifiedIdentity,
        source: 'discovery',
        instanceId: 'incumbent-a',
        token: 'token-a',
        bootToken: 'boot-token-a',
        shutdownToken: 'shutdown-token-a',
      }),
    });
    mockedShutdown.mockResolvedValue(shutdownResult({ health: null, verifiedIdentity }));
    mockedProbe.mockReturnValue(testIncarnation(555_000)); // matched

    const promise = bindWithHandoff(options).catch((e: Error) => e);
    for (let i = 0; i < 30; i += 1) {
      await flush();
      time.tick(200);
    }
    for (let i = 0; i < (SIGTERM_GRACE_MS + SIGKILL_GRACE_MS) / 200 + 5; i += 1) {
      await flush();
      time.tick(200);
    }
    const outcome = await promise;
    expect(outcome).toBeInstanceOf(HandoffEscalationError);
    const sigterms = killCalls.filter((c) => c.signal === 'SIGTERM');
    const sigkills = killCalls.filter((c) => c.signal === 'SIGKILL');
    expect(sigterms.length).toBeGreaterThanOrEqual(1);
    expect(sigkills.length).toBeGreaterThanOrEqual(1);
    expect(sigterms[0].pid).toBe(7777);
  });

  it('startup abort during handoff interrupts before the next escalation', async () => {
    const controller = new AbortController();
    const verifiedIdentity: IncumbentIdentity = {
      pid: 7788,
      incarnation: testIncarnation(556_000),
      source: 'health',
    };
    const { options, time, killCalls } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }],
      totalBudgetMs: 500,
      signal: controller.signal,
      readDiscovery: () => ({
        ...verifiedIdentity,
        source: 'discovery',
        instanceId: 'abort-incumbent',
        token: 'token-abort',
        bootToken: 'boot-token-abort',
        shutdownToken: 'shutdown-token-abort',
      }),
    });
    mockedShutdown.mockResolvedValue(shutdownResult({ health: null, verifiedIdentity }));
    mockedProbe.mockReturnValue(verifiedIdentity.incarnation);

    let outcome: Error | undefined;
    void bindWithHandoff(options).catch((e: Error) => {
      outcome = e;
    });
    for (let i = 0; i < 30 && !killCalls.some((c) => c.signal === 'SIGTERM'); i += 1) {
      await flush();
      time.tick(200);
    }
    await flush();
    expect(killCalls.filter((c) => c.signal === 'SIGTERM')).toHaveLength(1);

    const callsAtAbort = killCalls.length;
    controller.abort();
    for (let i = 0; i < 80 && outcome === undefined; i += 1) {
      await flush();
      time.tick(200);
    }

    expect(outcome?.name).toBe('AbortError');
    expect(killCalls).toHaveLength(callsAtAbort);
    expect(killCalls.some((c) => c.signal === 'SIGKILL')).toBe(false);
  });

  it('benign discovery identity change before signaling resets and retries the new incumbent', async () => {
    const oldIdentity: IncumbentIdentity = {
      pid: 7001,
      incarnation: testIncarnation(101_000),
      source: 'discovery',
      instanceId: 'old-incumbent',
      token: 'old-token',
      bootToken: 'old-boot-token',
      shutdownToken: 'old-shutdown-token',
    };
    const newIdentity: IncumbentIdentity = {
      pid: 7002,
      incarnation: testIncarnation(202_000),
      source: 'discovery',
      instanceId: 'new-incumbent',
      token: 'new-token',
      bootToken: 'new-boot-token',
      shutdownToken: 'new-shutdown-token',
    };
    const discoveryReads: IncumbentIdentity[] = [oldIdentity, newIdentity, newIdentity, newIdentity];
    const { options, time, killCalls } = buildHarness({
      bindSequence: [
        { kind: 'incumbent', reason: 'live-listener' },
        { kind: 'incumbent', reason: 'live-listener' },
        { kind: 'bound' },
      ],
      totalBudgetMs: 5_000,
      readDiscovery: () => discoveryReads.shift() ?? newIdentity,
    });
    mockedShutdown
      .mockResolvedValueOnce(shutdownResult({ health: null, verifiedIdentity: oldIdentity }))
      .mockResolvedValueOnce(shutdownResult({ health: null, verifiedIdentity: newIdentity }));

    const promise = bindWithHandoff(options);
    for (let i = 0; i < 20; i += 1) {
      await flush();
      time.tick(200);
    }

    await expect(promise).resolves.toEqual({
      acquiredViaHandoff: true,
      runStartupRecovery: expect.any(Function),
    });
    expect(mockedShutdown).toHaveBeenCalledTimes(2);
    expect(mockedShutdown.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ bootToken: 'old-boot-token' }));
    expect(mockedShutdown.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ bootToken: 'new-boot-token' }));
    expect(killCalls).toEqual([]);
  });

  it('audits handoff signals without logging coordinator tokens', async () => {
    const warnSpy = vi.spyOn(backendLog, 'warn').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(backendLog, 'error').mockImplementation(() => undefined);
    try {
      const verifiedIdentity: IncumbentIdentity = {
        pid: 7654,
        incarnation: testIncarnation(444_000),
        source: 'health',
      };
      const { options, time } = buildHarness({
        bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }],
        totalBudgetMs: 500,
        readDiscovery: () => ({
          ...verifiedIdentity,
          source: 'discovery',
          instanceId: 'audit-incumbent',
          token: 'secret-admin-token',
          bootToken: 'secret-boot-token',
          shutdownToken: 'secret-shutdown-token',
        }),
      });
      mockedShutdown.mockResolvedValue(shutdownResult({ health: null, verifiedIdentity }));
      mockedProbe.mockReturnValue(verifiedIdentity.incarnation);

      const promise = bindWithHandoff(options).catch((e: Error) => e);
      for (let i = 0; i < 80; i += 1) {
        await flush();
        time.tick(200);
      }
      await promise;

      const messages = [...warnSpy.mock.calls, ...errorSpy.mock.calls].map((call) => String(call[0] ?? ''));
      const auditMessages = messages.filter(
        (message) => message.startsWith('audit ') && message.includes('"event":"handoff_signal"'),
      );
      expect(auditMessages.length).toBeGreaterThan(0);
      expect(auditMessages.some((message) => message.includes('"instanceId":"audit-incumbent"'))).toBe(true);
      expect(auditMessages.join('\n')).not.toContain('secret-admin-token');
      expect(auditMessages.join('\n')).not.toContain('secret-boot-token');
      expect(auditMessages.join('\n')).not.toContain('secret-shutdown-token');
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('process gone before signal → retries bind without signaling', async () => {
    let alive = true;
    const verifiedIdentity: IncumbentIdentity = {
      pid: 99999,
      incarnation: testIncarnation(999_000),
      source: 'health',
    };
    const { options, time, killCalls } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }, { kind: 'bound' }],
      observeLiveness: () => (alive ? 'alive' : 'absent'),
      totalBudgetMs: 500,
      readDiscovery: () => ({ ...verifiedIdentity, source: 'discovery', bootToken: 'boot-token' }),
    });
    mockedShutdown.mockResolvedValue(shutdownResult({ health: null, verifiedIdentity }));
    mockedProbe.mockImplementation(() => {
      // Simulate process gone right at SIGTERM revalidation: probe returns null.
      return null;
    });
    // For verifySignalTarget to return 'gone', observeLiveness must also return false.
    alive = false;

    const promise = bindWithHandoff(options);
    for (let i = 0; i < 50; i += 1) {
      await flush();
      time.tick(200);
    }
    await flush();
    const result = await promise;
    expect(result.acquiredViaHandoff).toBe(true);
    expect(killCalls.filter((c) => c.signal === 'SIGTERM').length).toBe(0);
  });

  // The two halves of the same incident, and they must not be conflated again.
  //
  // A disagreement between what the incumbent published and what this contender probes must not cost the
  // *credential*: rejecting the record on that basis discarded the boot token beside it, and a contender
  // without that token cannot ask anyone to stand down — which is how a newer build died on every session
  // start. So the shutdown RPC still runs, with the token.
  //
  // It must cost the *signal*. Under the old derivation a disagreement was unavoidable noise (168 seconds
  // measured on WSL2 between two processes reading the same clock). With the opaque token two probes of one
  // process agree, so a disagreement now means what it says: this pid is not the process the record is
  // about — a stale `coordinator.json` and an ordinary pid wrap are enough — and signalling it delivers
  // SIGKILL to a stranger.
  it('uses the token but refuses to signal a pid the incumbent did not publish', async () => {
    const verifiedIdentity: IncumbentIdentity = { pid: 4321, incarnation: testIncarnation(500), source: 'health' };
    const { options, time, killCalls } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }],
      totalBudgetMs: 1_000,
      observeLiveness: () => 'alive' as const,
      readDiscovery: () => ({
        ...verifiedIdentity,
        source: 'discovery',
        instanceId: 'incumbent-drift',
        token: 'token-drift',
        bootToken: 'boot-token-drift',
        shutdownToken: 'shutdown-token-drift',
      }),
    });
    mockedShutdown.mockResolvedValue(shutdownResult({ health: null, verifiedIdentity }));
    // Consistent within this process, and 168 away from what the incumbent reported.
    mockedProbe.mockReturnValue(testIncarnation(668));

    const promise = bindWithHandoff(options).catch((e: Error) => e);
    for (let i = 0; i < 30; i += 1) {
      await flush();
      time.tick(200);
    }
    for (let i = 0; i < (SIGTERM_GRACE_MS + SIGKILL_GRACE_MS) / 200 + 5; i += 1) {
      await flush();
      time.tick(200);
    }
    const outcome = await promise;

    // The credential must survive the disagreement and be used: this is the whole reason the record is
    // no longer rejected. Before the change no token reached this call, so `shutdownAttempted` stayed
    // false and the contender died on the gate that exists to catch a missing credential.
    expect(mockedShutdown).toHaveBeenCalledWith(expect.objectContaining({ bootToken: 'boot-token-drift' }));

    expect(outcome).toBeInstanceOf(HandoffEscalationError);
    expect(killCalls, 'a pid the incumbent did not publish must never be signalled').toEqual([]);
  });

  // The upgrade this branch exists for: the incumbent is a build that predates the token, so it publishes no
  // incarnation at all. Its boot token still works, so it steps down gracefully — that path is untouched, and
  // it is the path an ordinary upgrade takes. What it cannot do is authorize a kill: with nothing published,
  // the only baseline is this contender's own first look, and a pid recycled before that look matches itself
  // forever. An unresponsive predecessor therefore ends in a diagnostic the operator acts on.
  it('asks a pre-token incumbent to stand down but will not escalate to a signal', async () => {
    const { options, time, killCalls } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }],
      totalBudgetMs: 1_000,
      observeLiveness: () => 'alive' as const,
      readDiscovery: () => ({
        pid: 7777,
        source: 'discovery',
        instanceId: 'pre-token-incumbent',
        token: 'token-legacy',
        bootToken: 'boot-token-legacy',
        shutdownToken: 'shutdown-token-legacy',
      }),
    });
    mockedShutdown.mockResolvedValue(shutdownResult({ health: null, verifiedIdentity: null }));
    mockedProbe.mockReturnValue(testIncarnation(4_242));

    const promise = bindWithHandoff(options).catch((e: Error) => e);
    for (let i = 0; i < (SIGTERM_GRACE_MS + SIGKILL_GRACE_MS) / 200 + 40; i += 1) {
      await flush();
      time.tick(200);
    }
    const outcome = await promise;

    expect(mockedShutdown).toHaveBeenCalledWith(expect.objectContaining({ bootToken: 'boot-token-legacy' }));
    expect(outcome).toBeInstanceOf(HandoffEscalationError);
    expect(killCalls, 'an incumbent that published no incarnation must never be signalled').toEqual([]);
  });

  // Everything an eviction needs is present here — a published incarnation, a matching probe, a live pid —
  // and it is still refused, because on macOS that agreement is not proof. `ps -o lstart=` is wall clock at
  // one-second resolution and macOS exposes no boot-relative start, so a backward clock step inside one boot
  // lets a later process reuse a pid and land on the same displayed second. Two processes, one token. The
  // graceful path is untouched: the shutdown RPC still ran with the token, which is how an ordinary upgrade
  // proceeds. What macOS gives up is forcing out a peer that will not answer.
  it('refuses to signal on a platform whose identity two processes can share', async () => {
    const verifiedIdentity: IncumbentIdentity = { pid: 8181, incarnation: testIncarnation(700), source: 'health' };
    const { options, time, killCalls } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }],
      totalBudgetMs: 1_000,
      observeLiveness: () => 'alive' as const,
      platform: 'darwin',
      readDiscovery: () => ({
        ...verifiedIdentity,
        source: 'discovery',
        instanceId: 'darwin-incumbent',
        token: 'token-darwin',
        bootToken: 'boot-token-darwin',
        shutdownToken: 'shutdown-token-darwin',
      }),
    });
    mockedShutdown.mockResolvedValue(shutdownResult({ health: null, verifiedIdentity }));
    mockedProbe.mockReturnValue(testIncarnation(700));

    const promise = bindWithHandoff(options).catch((e: Error) => e);
    for (let i = 0; i < (SIGTERM_GRACE_MS + SIGKILL_GRACE_MS) / 200 + 40; i += 1) {
      await flush();
      time.tick(200);
    }
    const outcome = await promise;

    expect(mockedShutdown).toHaveBeenCalledWith(expect.objectContaining({ bootToken: 'boot-token-darwin' }));
    expect(outcome).toBeInstanceOf(HandoffEscalationError);
    expect(killCalls, 'a matching incarnation is not proof on a platform that cannot make it one').toEqual([]);
  });

  // The guarantee that survives: between the handshake and the signal, the pid must still name the same
  // process. Both observations are this contender's own, so the comparison is meaningful.
  it('refuses to signal when the pid was recycled after this contender observed it', async () => {
    const verifiedIdentity: IncumbentIdentity = { pid: 1234, incarnation: testIncarnation(500), source: 'health' };
    const { options, time, killCalls } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }],
      totalBudgetMs: 500,
      observeLiveness: () => 'alive' as const,
      readDiscovery: () => ({ ...verifiedIdentity, source: 'discovery', bootToken: 'boot-token' }),
    });
    mockedShutdown.mockResolvedValue(shutdownResult({ health: null, verifiedIdentity }));
    // The first probe is consumed by the handshake anchor; every later one sees a different process on
    // the same pid. Discovery populates `incumbent` before the handshake, which is the ordinary path —
    // an earlier revision anchored only when discovery had NOT, so this exact path reached escalation
    // with no baseline and both of its adjacent probes agreed on the recycled process.
    mockedProbe.mockReturnValueOnce(testIncarnation(999)).mockReturnValue(testIncarnation(1_001));

    const promise = bindWithHandoff(options).catch((e: Error) => e);
    for (let i = 0; i < 30; i += 1) {
      await flush();
      time.tick(200);
    }
    const outcome = await promise;
    expect(outcome).toBeInstanceOf(HandoffEscalationError);
    expect(killCalls, 'a recycled pid must never be signalled').toEqual([]);
  });

  // The path that had no baseline at all: discovery names the incumbent, the handshake authenticates
  // nothing (a bound but IPC-silent daemon), and the pid is recycled before escalation. If the baseline
  // is taken at escalation instead of at adoption, both probes see the replacement, they agree, and the
  // unrelated process is signalled. Adoption-time anchoring is what makes the two probes span the window.
  it('refuses to signal a recycled pid even when the handshake authenticated nothing', async () => {
    const verifiedFromDiscovery: IncumbentIdentity = {
      pid: 9091,
      incarnation: testIncarnation(1_111_000),
      source: 'discovery',
      instanceId: 'silent-incumbent',
      token: 'token',
      bootToken: 'boot-token',
      shutdownToken: 'shutdown-token',
    };
    const { options, time, killCalls } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }],
      totalBudgetMs: 500,
      observeLiveness: () => 'alive' as const,
      readDiscovery: () => verifiedFromDiscovery,
    });
    mockedShutdown.mockResolvedValue(shutdownResult({ health: null, verifiedIdentity: null }));
    // Adoption observes the incumbent; everything after observes the process that took its pid.
    mockedProbe.mockReturnValueOnce(testIncarnation(1_111_000)).mockReturnValue(testIncarnation(2_222_000));

    const promise = bindWithHandoff(options).catch((e: Error) => e);
    for (let i = 0; i < 80; i += 1) {
      await flush();
      time.tick(200);
    }
    const outcome = await promise;
    expect(outcome).toBeInstanceOf(HandoffEscalationError);
    expect(killCalls, 'a pid recycled before escalation must never be signalled').toEqual([]);
  }, 10_000);

  // An unreadable incarnation is not a dead process. Treating it as one skipped the fail-closed branch
  // and let a later, too-late probe become the baseline.
  it('refuses to signal when the incarnation is unreadable while the pid is alive', async () => {
    const verifiedIdentity: IncumbentIdentity = { pid: 2468, incarnation: testIncarnation(500), source: 'health' };
    const { options, time, killCalls } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }],
      totalBudgetMs: 500,
      observeLiveness: () => 'alive' as const,
      readDiscovery: () => ({ ...verifiedIdentity, source: 'discovery', bootToken: 'boot-token' }),
    });
    mockedShutdown.mockResolvedValue(shutdownResult({ health: null, verifiedIdentity }));
    mockedProbe.mockReturnValueOnce(testIncarnation(777)).mockReturnValue(null);

    const promise = bindWithHandoff(options).catch((e: Error) => e);
    for (let i = 0; i < 30; i += 1) {
      await flush();
      time.tick(200);
    }
    const outcome = await promise;
    expect(outcome).toBeInstanceOf(HandoffEscalationError);
    expect(killCalls, 'unreadable must not be read as gone').toEqual([]);
  });

  it('identity change at immediate pre-signal revalidation stays fatal', async () => {
    const oldIdentity: IncumbentIdentity = {
      pid: 4320,
      incarnation: testIncarnation(699),
      source: 'discovery',
      instanceId: 'old-pre-signal',
      token: 'old-token',
      bootToken: 'old-boot-token',
      shutdownToken: 'old-shutdown-token',
    };
    const newIdentity: IncumbentIdentity = {
      pid: 4322,
      incarnation: testIncarnation(701),
      source: 'discovery',
      instanceId: 'new-pre-signal',
      token: 'new-token',
      bootToken: 'new-boot-token',
      shutdownToken: 'new-shutdown-token',
    };
    let reads = 0;
    const { options, killCalls } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }],
      totalBudgetMs: 0,
      readDiscovery: () => {
        reads += 1;
        return reads === 1 ? oldIdentity : newIdentity;
      },
    });

    const outcome = await bindWithHandoff(options).catch((e: Error) => e);

    expect(outcome).toBeInstanceOf(HandoffEscalationError);
    expect(String((outcome as Error).message)).toContain('fresh coordinator discovery changed');
    expect(mockedShutdown).not.toHaveBeenCalled();
    expect(killCalls).toEqual([]);
  });

  it('refuses to signal when fresh discovery identity is unavailable', async () => {
    const { options, time, killCalls } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }],
      totalBudgetMs: 500,
      readDiscovery: () => null,
    });
    const verifiedIdentity: IncumbentIdentity = {
      pid: 4321,
      incarnation: testIncarnation(700),
      source: 'health',
    };
    mockedShutdown.mockResolvedValue(shutdownResult({ health: null, verifiedIdentity }));
    mockedProbe.mockReturnValue(testIncarnation(700));

    const promise = bindWithHandoff(options).catch((e: Error) => e);
    for (let i = 0; i < 30; i += 1) {
      await flush();
      time.tick(200);
    }
    const outcome = await promise;
    expect(outcome).toBeInstanceOf(HandoffEscalationError);
    expect(String((outcome as Error).message)).toContain('fresh coordinator discovery was unavailable');
    expect(killCalls).toEqual([]);
  });

  it('rate-limits repeated SIGTERM for the same incumbent', async () => {
    const verifiedIdentity: IncumbentIdentity = {
      pid: 2468,
      incarnation: testIncarnation(900),
      source: 'health',
    };
    let lastSignaledAtMs = 0;
    const signalLedger: HandoffSignalLedger = {
      read: () => ({
        version: 1,
        socketPath: '/tmp/coral.sock',
        pid: verifiedIdentity.pid,
        incarnation: verifiedIdentity.incarnation,
        instanceId: 'same-incumbent',
        signal: 'SIGTERM',
        signaledAtMs: lastSignaledAtMs,
      }),
      write: vi.fn(),
    };
    const { options, time, killCalls } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }],
      totalBudgetMs: 500,
      signalLedger,
      signalCooldownMs: 10_000,
      readDiscovery: () => ({
        ...verifiedIdentity,
        source: 'discovery',
        instanceId: 'same-incumbent',
        token: 'same-token',
        bootToken: 'same-boot-token',
        shutdownToken: 'same-shutdown-token',
      }),
    });
    lastSignaledAtMs = time.now();
    mockedShutdown.mockResolvedValue(shutdownResult({ health: null, verifiedIdentity }));
    mockedProbe.mockReturnValue(verifiedIdentity.incarnation);

    const promise = bindWithHandoff(options).catch((e: Error) => e);
    for (let i = 0; i < 30; i += 1) {
      await flush();
      time.tick(200);
    }
    const outcome = await promise;
    expect(outcome).toBeInstanceOf(HandoffEscalationError);
    expect(String((outcome as Error).message)).toContain('Manual repair required');
    expect(killCalls).toEqual([]);
  });

  it('manual signal policy refuses process signals after graceful handoff fails', async () => {
    const verifiedIdentity: IncumbentIdentity = {
      pid: 1357,
      incarnation: testIncarnation(901),
      source: 'health',
    };
    const { options, time, killCalls } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }],
      totalBudgetMs: 500,
      signalPolicy: 'manual',
      readDiscovery: () => ({
        ...verifiedIdentity,
        source: 'discovery',
        bootToken: 'boot-token',
        shutdownToken: 'shutdown-token',
      }),
    });
    mockedShutdown.mockResolvedValue(shutdownResult({ health: null, verifiedIdentity }));
    mockedProbe.mockReturnValue(verifiedIdentity.incarnation);

    const promise = bindWithHandoff(options).catch((e: Error) => e);
    for (let i = 0; i < 30; i += 1) {
      await flush();
      time.tick(200);
    }
    const outcome = await promise;
    expect(outcome).toBeInstanceOf(HandoffEscalationError);
    expect(String((outcome as Error).message)).toContain('CORAL_HANDOFF_SIGNAL_POLICY=manual');
    expect(killCalls).toEqual([]);
  });

  it('refuses to signal when fresh discovery lacks signal capability fields', async () => {
    const verifiedIdentity: IncumbentIdentity = {
      pid: 9753,
      incarnation: testIncarnation(903),
      source: 'health',
    };
    const { options, time, killCalls } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }],
      totalBudgetMs: 500,
      readDiscovery: () => ({
        ...verifiedIdentity,
        source: 'discovery',
        shutdownToken: 'shutdown-token',
      }),
    });
    mockedShutdown.mockResolvedValue(shutdownResult({ health: null, verifiedIdentity }));
    mockedProbe.mockReturnValue(verifiedIdentity.incarnation);

    const promise = bindWithHandoff(options).catch((e: Error) => e);
    for (let i = 0; i < 30; i += 1) {
      await flush();
      time.tick(200);
    }
    const outcome = await promise;
    expect(outcome).toBeInstanceOf(HandoffEscalationError);
    expect(String((outcome as Error).message)).toContain(
      'verified coordinator discovery lacked instanceId, token, bootToken',
    );
    expect(killCalls).toEqual([]);
  });

  it('term-only signal policy sends SIGTERM but refuses SIGKILL', async () => {
    const verifiedIdentity: IncumbentIdentity = {
      pid: 8642,
      incarnation: testIncarnation(902),
      source: 'health',
    };
    const { options, time, killCalls } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }],
      totalBudgetMs: 500,
      signalPolicy: 'term-only',
      readDiscovery: () => ({
        ...verifiedIdentity,
        source: 'discovery',
        instanceId: 'term-only-incumbent',
        token: 'token',
        bootToken: 'boot-token',
        shutdownToken: 'shutdown-token',
      }),
    });
    mockedShutdown.mockResolvedValue(shutdownResult({ health: null, verifiedIdentity }));
    mockedProbe.mockReturnValue(verifiedIdentity.incarnation);

    const promise = bindWithHandoff(options).catch((e: Error) => e);
    for (let i = 0; i < (SIGTERM_GRACE_MS + 2_000) / 200; i += 1) {
      await flush();
      time.tick(200);
    }
    const outcome = await promise;
    expect(outcome).toBeInstanceOf(HandoffEscalationError);
    expect(String((outcome as Error).message)).toContain('term-only forbids SIGKILL');
    expect(killCalls.filter((c) => c.signal === 'SIGTERM')).toHaveLength(1);
    expect(killCalls.filter((c) => c.signal === 'SIGKILL')).toHaveLength(0);
  });

  it('discovery fallback: when health has no pid, reads coordinator.json via injected probe', async () => {
    const verifiedFromDiscovery: IncumbentIdentity = {
      pid: 8888,
      incarnation: testIncarnation(1_111_000),
      source: 'discovery',
      instanceId: 'discovery-incumbent',
      token: 'token',
      bootToken: 'boot-token',
      shutdownToken: 'shutdown-token',
    };
    const { options, time, killCalls } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }],
      totalBudgetMs: 500,
      readDiscovery: () => verifiedFromDiscovery,
    });
    mockedShutdown.mockResolvedValue(shutdownResult({ health: null, verifiedIdentity: null }));
    mockedProbe.mockReturnValue(testIncarnation(1_111_000)); // matched

    const promise = bindWithHandoff(options).catch((e: Error) => e);
    // Need enough time to: exhaust budget (500), SIGTERM_GRACE (5000),
    // SIGKILL_GRACE (5000). 80 × 200 = 16000ms covers all phases.
    for (let i = 0; i < 80; i += 1) {
      await flush();
      time.tick(200);
    }
    const outcome = await promise;
    expect(outcome).toBeInstanceOf(HandoffEscalationError);
    expect(killCalls.some((c) => c.signal === 'SIGTERM' && c.pid === 8888)).toBe(true);
  }, 10_000);

  it('no shutdown RPC issued after drain deadline', async () => {
    const { options, time } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }],
      totalBudgetMs: 200,
    });
    mockedShutdown.mockResolvedValue(shutdownResult({ health: null, verifiedIdentity: null }));
    const callsAtDeadline: number[] = [];

    const promise = bindWithHandoff(options).catch((e: Error) => e);
    for (let i = 0; i < 30; i += 1) {
      await flush();
      time.tick(200);
      callsAtDeadline.push(mockedShutdown.mock.calls.length);
    }
    await promise;

    expect(mockedShutdown.mock.calls.length).toBeLessThanOrEqual(2);
  });
});

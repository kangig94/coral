// Unit coverage for the bind/escalation state machine in
// `src/coordinator/handoff.ts`. All cases use VirtualTime + a stubbed
// transport-side IPC helper; no real sockets, no real signals.

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

// We mock `requestIncumbentShutdown` so the handoff state machine sees
// scripted health/verifiedIdentity outcomes without spinning real IPC.
vi.mock('#src/transport/ipc/handoff.js', async (importOriginal) => {
  const original = await importOriginal<object>();
  return {
    ...original,
    requestIncumbentShutdown: vi.fn(),
  };
});

// `probeProcessStartedAtSeconds` is called inside `verifySignalTarget`; mock
// it so we can stage matched/null outcomes deterministically.
vi.mock('#src/infra/node-process.js', async (importOriginal) => {
  const original = await importOriginal<object>();
  return {
    ...original,
    probeProcessStartedAtSeconds: vi.fn(),
  };
});

import { requestIncumbentShutdown } from '#src/transport/ipc/handoff.js';
import { probeProcessStartedAtSeconds } from '#src/infra/node-process.js';

const mockedShutdown = requestIncumbentShutdown as ReturnType<typeof vi.fn>;
const mockedProbe = probeProcessStartedAtSeconds as ReturnType<typeof vi.fn>;

interface KillCall {
  pid: number;
  signal: NodeJS.Signals | 0;
}

function buildHarness(opts?: {
  bindSequence?: Array<{ kind: 'bound' } | { kind: 'incumbent'; reason: string }>;
  totalBudgetMs?: number;
  isAlive?: (pid: number) => boolean;
  killThrows?: boolean;
  readDiscovery?: HandoffOptions['readVerifiedIncumbentFromDiscovery'];
  signalLedger?: HandoffSignalLedger;
  signalCooldownMs?: number;
  signalPolicy?: HandoffSignalPolicy;
  signal?: AbortSignal;
  runStartupRecovery?: HandoffOptions['runStartupRecovery'];
}) {
  const time = new VirtualTime();
  const killCalls: KillCall[] = [];
  const isAliveImpl = opts?.isAlive ?? (() => true);
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
      isAlive: isAliveImpl,
    } as unknown as Runtime['process'],
    env: {
      platform: () => 'linux',
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
      processStartedAt: 1_000_000,
      source: 'health',
    };
    mockedShutdown.mockResolvedValue(
      shutdownResult({
        health: {
          bundleHash: 'old',
          flavor: 'prod',
          namespace: 'ns',
          pid: 4242,
          processStartedAt: 1_000_000,
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
      processStartedAt: 7_000,
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
          processStartedAt: discoveryIdentity.processStartedAt,
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
      processStartedAt: 7_100,
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
          processStartedAt: discoveryIdentity.processStartedAt,
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
      processStartedAt: 555_000,
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
    mockedProbe.mockReturnValue(555_000); // matched

    const promise = bindWithHandoff(options).catch((e: Error) => e);
    // Burn through the budget so escalation engages.
    for (let i = 0; i < 30; i += 1) {
      await flush();
      time.tick(200);
    }
    // Allow SIGTERM grace and SIGKILL grace to elapse.
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
      processStartedAt: 556_000,
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
    mockedProbe.mockReturnValue(verifiedIdentity.processStartedAt);

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
      processStartedAt: 101_000,
      source: 'discovery',
      instanceId: 'old-incumbent',
      token: 'old-token',
      bootToken: 'old-boot-token',
      shutdownToken: 'old-shutdown-token',
    };
    const newIdentity: IncumbentIdentity = {
      pid: 7002,
      processStartedAt: 202_000,
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
        processStartedAt: 444_000,
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
      mockedProbe.mockReturnValue(verifiedIdentity.processStartedAt);

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
      processStartedAt: 999_000,
      source: 'health',
    };
    const { options, time, killCalls } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }, { kind: 'bound' }],
      isAlive: () => alive,
      totalBudgetMs: 500,
      readDiscovery: () => ({ ...verifiedIdentity, source: 'discovery', bootToken: 'boot-token' }),
    });
    mockedShutdown.mockResolvedValue(shutdownResult({ health: null, verifiedIdentity }));
    mockedProbe.mockImplementation(() => {
      // Simulate process gone right at SIGTERM revalidation: probe returns null.
      return null;
    });
    // For verifySignalTarget to return 'gone', isAlive must also return false.
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

  it('alive-but-mismatched start time before SIGTERM → HandoffEscalationError, no signal sent', async () => {
    const verifiedIdentity: IncumbentIdentity = {
      pid: 1234,
      processStartedAt: 500,
      source: 'health',
    };
    const { options, time, killCalls } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }],
      totalBudgetMs: 500,
      isAlive: () => true,
      readDiscovery: () => ({ ...verifiedIdentity, source: 'discovery', bootToken: 'boot-token' }),
    });
    mockedShutdown.mockResolvedValue(shutdownResult({ health: null, verifiedIdentity }));
    // Probe returns DIFFERENT start time → mismatch → HandoffEscalationError.
    mockedProbe.mockReturnValue(999); // mismatch

    const promise = bindWithHandoff(options).catch((e: Error) => e);
    for (let i = 0; i < 30; i += 1) {
      await flush();
      time.tick(200);
    }
    const outcome = await promise;
    expect(outcome).toBeInstanceOf(HandoffEscalationError);
    expect(killCalls).toEqual([]);
  });

  it('identity change at immediate pre-signal revalidation stays fatal', async () => {
    const oldIdentity: IncumbentIdentity = {
      pid: 4320,
      processStartedAt: 699,
      source: 'discovery',
      instanceId: 'old-pre-signal',
      token: 'old-token',
      bootToken: 'old-boot-token',
      shutdownToken: 'old-shutdown-token',
    };
    const newIdentity: IncumbentIdentity = {
      pid: 4322,
      processStartedAt: 701,
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
      processStartedAt: 700,
      source: 'health',
    };
    mockedShutdown.mockResolvedValue(shutdownResult({ health: null, verifiedIdentity }));
    mockedProbe.mockReturnValue(700);

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
      processStartedAt: 900,
      source: 'health',
    };
    let lastSignaledAtMs = 0;
    const signalLedger: HandoffSignalLedger = {
      read: () => ({
        version: 1,
        socketPath: '/tmp/coral.sock',
        pid: verifiedIdentity.pid,
        processStartedAt: verifiedIdentity.processStartedAt,
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
    mockedProbe.mockReturnValue(verifiedIdentity.processStartedAt);

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
      processStartedAt: 901,
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
    mockedProbe.mockReturnValue(verifiedIdentity.processStartedAt);

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
      processStartedAt: 903,
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
    mockedProbe.mockReturnValue(verifiedIdentity.processStartedAt);

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
      processStartedAt: 902,
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
    mockedProbe.mockReturnValue(verifiedIdentity.processStartedAt);

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
      processStartedAt: 1_111_000,
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
    mockedProbe.mockReturnValue(1_111_000); // matched

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

    // After the budget is exhausted, no further shutdown RPCs should be sent.
    // The first call is allowed; subsequent ones (after deadline) are not.
    expect(mockedShutdown.mock.calls.length).toBeLessThanOrEqual(2);
  });
});

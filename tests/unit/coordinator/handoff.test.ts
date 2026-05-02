// Unit coverage for the bind/escalation state machine in
// `src/coordinator/handoff.ts`. All cases use VirtualTime + a stubbed
// transport-side IPC helper; no real sockets, no real signals.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  bindWithHandoff,
  HandoffEscalationError,
  IncumbentMatchesError,
  SIGTERM_GRACE_MS,
  SIGKILL_GRACE_MS,
  type HandoffOptions,
} from '#src/coordinator/handoff.js';
import { VirtualTime } from '#tools/simulation/core/virtual-time.js';
import type { Runtime } from '#src/runtime/ports.js';
import type { IncumbentHealth, IncumbentIdentity } from '#src/transport/ipc/handoff.js';

// We mock `requestIncumbentShutdown` so the handoff state machine sees
// scripted health/verifiedIdentity outcomes without spinning real IPC.
vi.mock('#src/transport/ipc/handoff.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('#src/transport/ipc/handoff.js')>();
  return {
    ...original,
    requestIncumbentShutdown: vi.fn(),
  };
});

// `probeProcessStartedAtSeconds` is called inside `verifySignalTarget`; mock
// it so we can stage matched/null outcomes deterministically.
vi.mock('#src/infra/node-process.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('#src/infra/node-process.js')>();
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

  const readDiscovery: HandoffOptions['readVerifiedIncumbentFromDiscovery'] =
    opts?.readDiscovery ?? (() => null);

  const options: HandoffOptions = {
    socketPath: '/tmp/coral.sock',
    desired: { bundleHash: 'new-hash', flavor: 'prod', namespace: 'ns' },
    bindAttempt,
    runtime,
    readVerifiedIncumbentFromDiscovery: readDiscovery,
    totalBudgetMs: opts?.totalBudgetMs ?? 30_000,
  };

  return { time, runtime, options, killCalls, bindAttempt };
}

const flush = async (rounds = 16): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
};

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

  it('same-bundle incumbent throws IncumbentMatchesError', async () => {
    const { options } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }, { kind: 'bound' }],
    });
    mockedShutdown.mockImplementationOnce(async () => {
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
    mockedShutdown.mockResolvedValue({
      health: { bundleHash: 'old', flavor: 'prod', namespace: 'ns', pid: 4242, processStartedAt: 1_000_000 } as IncumbentHealth,
      verifiedIdentity,
    });
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

  it('budget exhausted with no verified pid → HandoffEscalationError', async () => {
    const { options, time } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }],
      totalBudgetMs: 500,
    });
    mockedShutdown.mockResolvedValue({ health: null, verifiedIdentity: null });

    const promise = bindWithHandoff(options);
    for (let i = 0; i < 30; i += 1) {
      await flush();
      time.tick(100);
    }
    await flush();
    await expect(promise).rejects.toBeInstanceOf(HandoffEscalationError);
  });

  it('SIGTERM/SIGKILL escalation: matched pid, then kill', async () => {
    const { options, time, killCalls } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }],
      totalBudgetMs: 1_000,
    });
    const verifiedIdentity: IncumbentIdentity = {
      pid: 7777,
      processStartedAt: 555_000,
      source: 'health',
    };
    mockedShutdown.mockResolvedValue({ health: null, verifiedIdentity });
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

  it('process gone before signal → retries bind without signaling', async () => {
    let alive = true;
    const { options, time, killCalls } = buildHarness({
      bindSequence: [
        { kind: 'incumbent', reason: 'live-listener' },
        { kind: 'bound' },
      ],
      isAlive: () => alive,
      totalBudgetMs: 500,
    });
    const verifiedIdentity: IncumbentIdentity = {
      pid: 99999,
      processStartedAt: 999_000,
      source: 'health',
    };
    mockedShutdown.mockResolvedValue({ health: null, verifiedIdentity });
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
    const { options, time, killCalls } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }],
      totalBudgetMs: 500,
      isAlive: () => true,
    });
    const verifiedIdentity: IncumbentIdentity = {
      pid: 1234,
      processStartedAt: 500,
      source: 'health',
    };
    mockedShutdown.mockResolvedValue({ health: null, verifiedIdentity });
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

  it('discovery fallback: when health has no pid, reads coordinator.json via injected probe', async () => {
    const verifiedFromDiscovery: IncumbentIdentity = {
      pid: 8888,
      processStartedAt: 1_111_000,
      source: 'discovery',
    };
    const { options, time, killCalls } = buildHarness({
      bindSequence: [{ kind: 'incumbent', reason: 'live-listener' }],
      totalBudgetMs: 500,
      readDiscovery: () => verifiedFromDiscovery,
    });
    mockedShutdown.mockResolvedValue({ health: null, verifiedIdentity: null });
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
    mockedShutdown.mockResolvedValue({ health: null, verifiedIdentity: null });
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

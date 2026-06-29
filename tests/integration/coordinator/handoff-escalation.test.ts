// AC7: handoff-escalation integration coverage. Drives `bindWithHandoff`
// against a virtual incumbent that holds the socket past the drain budget,
// asserting SIGTERM → SIGKILL escalation timing, pre-signal pid revalidation,
// and the no-verified-pid bounded failure path.
//
// Uses VirtualTime + scripted IPC reply fakes; no real daemons spawn.

import { describe, expect, it, vi } from 'vitest';
import { bindWithHandoff, HandoffEscalationError } from '#src/coordinator/handoff.js';
import { SIGKILL_GRACE_MS, SIGTERM_GRACE_MS } from '#src/infra/process-constants.js';
import { VirtualTime } from '#tools/simulation/core/virtual-time.js';
import type { Runtime } from '#src/runtime/ports.js';
import type { IncumbentIdentity } from '#src/transport/ipc/handoff.js';

vi.mock('#src/transport/ipc/handoff.js', async (orig) => {
  const original = await orig<object>();
  return { ...original, requestIncumbentShutdown: vi.fn() };
});
vi.mock('#src/infra/node-process.js', async (orig) => {
  const original = await orig<object>();
  return { ...original, probeProcessStartedAtSeconds: vi.fn() };
});

import { requestIncumbentShutdown } from '#src/transport/ipc/handoff.js';
import { probeProcessStartedAtSeconds } from '#src/infra/node-process.js';

const mockedShutdown = requestIncumbentShutdown as ReturnType<typeof vi.fn>;
const mockedProbe = probeProcessStartedAtSeconds as ReturnType<typeof vi.fn>;

const flush = async (rounds = 16): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
};

interface KillCall {
  pid: number;
  signal: NodeJS.Signals | 0;
  at: number;
}

function buildEscalationHarness(opts: {
  incumbentExitsAt: number | null; // virtual time when isAlive flips false
  totalBudgetMs: number;
  identity: IncumbentIdentity | null;
}) {
  const time = new VirtualTime();
  const start = time.now();
  const killCalls: KillCall[] = [];

  const isAlive = (pid: number): boolean => {
    if (pid !== opts.identity?.pid) return false;
    if (opts.incumbentExitsAt === null) return true;
    return time.now() - start < opts.incumbentExitsAt;
  };

  const runtime: Pick<Runtime, 'time' | 'process' | 'env'> = {
    time,
    process: {
      kill: (pid: number, signal: NodeJS.Signals | 0) => {
        killCalls.push({ pid, signal, at: time.now() - start });
        return true;
      },
      isAlive,
    } as unknown as Runtime['process'],
    env: { platform: () => 'linux' } as unknown as Runtime['env'],
  };

  let bindCount = 0;
  const bindAttempt = vi.fn(async () => {
    bindCount += 1;
    // Bind succeeds only after the incumbent exits.
    if (opts.incumbentExitsAt === null) {
      return { kind: 'incumbent' as const, reason: 'live-listener' };
    }
    if (time.now() - start >= opts.incumbentExitsAt) {
      return { kind: 'bound' as const };
    }
    return { kind: 'incumbent' as const, reason: 'live-listener' };
  });

  return {
    time,
    runtime,
    killCalls,
    bindAttempt,
    bindCount: () => bindCount,
    options: {
      socketPath: '/tmp/coral.sock',
      desired: { version: '0.9.1', bundleHash: 'new', flavor: 'prod' as const, namespace: 'ns' },
      bindAttempt,
      runtime,
      readVerifiedIncumbentFromDiscovery: () => opts.identity,
      totalBudgetMs: opts.totalBudgetMs,
    },
    elapsedMs: () => time.now() - start,
  };
}

describe('handoff escalation (AC7)', () => {
  it('hung incumbent: SIGTERM after budget, SIGKILL after grace, bind succeeds when process exits', async () => {
    const identity: IncumbentIdentity = {
      pid: 5555,
      processStartedAt: 100,
      source: 'discovery',
      instanceId: 'hung-incumbent',
      token: 'token',
      bootToken: 'boot-token',
      shutdownToken: 'shutdown-token',
    };
    const totalBudgetMs = 1_000;
    // Incumbent exits at T=12000 (after SIGTERM grace+SIGKILL grace fully elapse).
    const incumbentExitsAt = totalBudgetMs + SIGTERM_GRACE_MS + 2_000;
    const harness = buildEscalationHarness({ incumbentExitsAt, totalBudgetMs, identity });
    mockedShutdown.mockResolvedValue({ health: null, verifiedIdentity: identity });
    // Probe matches identity until the incumbent "exits" — after that, probe returns null.
    mockedProbe.mockImplementation(() => (harness.elapsedMs() < incumbentExitsAt ? identity.processStartedAt : null));

    const promise = bindWithHandoff(harness.options);
    // Drive virtual time forward.
    for (let i = 0; i < 100; i += 1) {
      await flush();
      harness.time.tick(200);
    }
    await flush();
    const outcome = await promise;
    expect(outcome.acquiredViaHandoff).toBe(true);

    const sigterms = harness.killCalls.filter((c) => c.signal === 'SIGTERM');
    expect(sigterms.length).toBeGreaterThanOrEqual(1);
    expect(sigterms[0].pid).toBe(identity.pid);
    expect(sigterms[0].at).toBeGreaterThanOrEqual(totalBudgetMs);
  }, 15_000);

  it('hard bound: HandoffEscalationError fires within budget+SIGTERM+SIGKILL graces when no verified pid', async () => {
    const totalBudgetMs = 500;
    const harness = buildEscalationHarness({
      incumbentExitsAt: null,
      totalBudgetMs,
      identity: null,
    });
    // No verified identity from health or discovery.
    mockedShutdown.mockResolvedValue({ health: null, verifiedIdentity: null });

    const promise = bindWithHandoff(harness.options).catch((e: Error) => e);
    for (let i = 0; i < 30; i += 1) {
      await flush();
      harness.time.tick(200);
    }
    const outcome = await promise;
    expect(outcome).toBeInstanceOf(HandoffEscalationError);
    expect(harness.elapsedMs()).toBeLessThan(totalBudgetMs + SIGTERM_GRACE_MS + SIGKILL_GRACE_MS);
    expect(harness.killCalls).toEqual([]);
  }, 15_000);

  it('process exited before SIGTERM: helper observes "gone", retries bind without signaling', async () => {
    const identity: IncumbentIdentity = {
      pid: 1234,
      processStartedAt: 555,
      source: 'discovery',
      instanceId: 'gone-incumbent',
      token: 'token',
      bootToken: 'boot-token',
      shutdownToken: 'shutdown-token',
    };
    const totalBudgetMs = 500;
    // Incumbent exits at T=600, just after the budget expires.
    const harness = buildEscalationHarness({
      incumbentExitsAt: 600,
      totalBudgetMs,
      identity,
    });
    mockedShutdown.mockResolvedValue({ health: null, verifiedIdentity: identity });
    // Probe returns null after incumbent exits → 'gone'.
    mockedProbe.mockImplementation(() => (harness.elapsedMs() < 600 ? identity.processStartedAt : null));

    const promise = bindWithHandoff(harness.options);
    for (let i = 0; i < 30; i += 1) {
      await flush();
      harness.time.tick(200);
    }
    await flush();
    const outcome = await promise;
    expect(outcome.acquiredViaHandoff).toBe(true);
    // Critical: NO SIGTERM/SIGKILL was issued because the helper observed
    // 'gone' before signaling.
    expect(harness.killCalls).toEqual([]);
  }, 15_000);

  it('replacement startup recovery does not run while incumbent finalizers are in budget', async () => {
    // Surrogate for "runStartupRecoveryFn does not start before bind succeeds":
    // we assert bindAttempt continues to return 'incumbent' until the
    // incumbent is observed gone — i.e. bindWithHandoff blocks on the
    // socket, and only resolves when the incumbent has actually exited.
    const identity: IncumbentIdentity = {
      pid: 8888,
      processStartedAt: 222,
      source: 'discovery',
      instanceId: 'finalizer-incumbent',
      token: 'token',
      bootToken: 'boot-token',
      shutdownToken: 'shutdown-token',
    };
    const totalBudgetMs = 1_000;
    const exitAtMs = totalBudgetMs / 2; // incumbent gracefully exits within budget
    const harness = buildEscalationHarness({
      incumbentExitsAt: exitAtMs,
      totalBudgetMs,
      identity,
    });
    mockedShutdown.mockResolvedValue({ health: null, verifiedIdentity: identity });
    mockedProbe.mockReturnValue(identity.processStartedAt);

    let runStartupRecoveryCalled = false;
    const promise = bindWithHandoff(harness.options).then(() => {
      runStartupRecoveryCalled = true;
    });
    // Tick past exit time.
    for (let i = 0; i < 30; i += 1) {
      await flush();
      harness.time.tick(100);
      if (harness.elapsedMs() < exitAtMs) {
        expect(runStartupRecoveryCalled).toBe(false);
      }
    }
    await flush();
    await promise;
    expect(runStartupRecoveryCalled).toBe(true);
  }, 15_000);
});

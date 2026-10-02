import { beforeEach, describe, expect, it, vi } from 'vitest';

import { bindWithHandoff, HandoffEscalationError } from '#src/coordinator/handoff.js';
import { createRealTimePort } from '#src/infra/time.js';
import type { Runtime } from '#src/runtime/ports.js';
import { IncumbentMatchesError, probeIncumbent } from '#src/transport/ipc/handoff.js';

vi.mock('#src/transport/ipc/handoff.js', async (loadOriginal) => ({
  ...(await loadOriginal<object>()),
  probeIncumbent: vi.fn(),
}));

const healthProbe = vi.mocked(probeIncumbent);

beforeEach(() => {
  healthProbe.mockReset();
});

function options(bindAttempt: () => Promise<{ kind: 'bound' } | { kind: 'incumbent'; reason: string }>) {
  const kill = vi.fn();
  let elapsedMs = 0n;
  const runtime = {
    time: {
      ...createRealTimePort(),
      monotonicNow: () => elapsedMs,
      sleep: async (milliseconds: number) => {
        elapsedMs += BigInt(milliseconds);
      },
    },
    process: { kill, observeLiveness: () => 'alive' },
    env: { platform: () => 'linux' },
  } as unknown as Pick<Runtime, 'time' | 'process' | 'env'>;
  return {
    kill,
    handoff: {
      socketPath: '/tmp/coral-consent-test.sock',
      desired: { version: '0.10.14', bundleHash: 'branch', flavor: 'prod' as const, namespace: 'branch' },
      bindAttempt,
      runStartupRecovery: async () => [],
      runtime,
      readVerifiedIncumbentFromDiscovery: () => null,
      totalBudgetMs: 450,
    },
  };
}

describe('bindWithHandoff', () => {
  it('binds immediately when there is no incumbent', async () => {
    const bindAttempt = vi.fn(async () => ({ kind: 'bound' as const }));
    const { handoff } = options(bindAttempt);

    expect((await bindWithHandoff(handoff)).acquiredViaHandoff).toBe(false);
    expect(healthProbe).not.toHaveBeenCalled();
  });

  it('requests succession only for a strictly older answering incumbent of the same flavor', async () => {
    const requestSuccession = vi.fn(async () => undefined);
    for (const [version, flavor] of [
      ['0.10.13', 'prod'],
      ['0.10.14', 'prod'],
      ['0.10.13', 'dev'],
    ] as const) {
      healthProbe.mockResolvedValueOnce({
        version,
        flavor,
        bundleHash: 'incumbent',
        namespace: 'incumbent',
        status: 'ok',
      });
      const { handoff } = options(async () => ({ kind: 'incumbent', reason: 'live-listener' }));
      await expect(
        bindWithHandoff({
          ...handoff,
          readVerifiedIncumbentFromDiscovery: () => ({ pid: 100, source: 'discovery', bootToken: 'boot' }),
          requestSuccession,
        }),
      ).rejects.toBeInstanceOf(IncumbentMatchesError);
    }
    expect(requestSuccession).toHaveBeenCalledTimes(1);
    expect(requestSuccession).toHaveBeenCalledWith(
      '/tmp/coral-consent-test.sock',
      {
        pid: 100,
        source: 'discovery',
        bootToken: 'boot',
      },
      {
        version: '0.10.13',
        flavor: 'prod',
        bundleHash: 'incumbent',
        namespace: 'incumbent',
        status: 'ok',
      },
    );
  });

  it('waits for an administrative drain to release the socket', async () => {
    healthProbe.mockResolvedValue({
      version: '0.10.13',
      bundleHash: 'incumbent',
      flavor: 'prod',
      namespace: 'incumbent',
      status: 'draining',
    });
    let attempts = 0;
    const { handoff, kill } = options(async () =>
      ++attempts === 3 ? { kind: 'bound' } : { kind: 'incumbent', reason: 'live-listener' },
    );

    expect((await bindWithHandoff(handoff)).acquiredViaHandoff).toBe(true);
    expect(attempts).toBe(3);
    expect(kill).not.toHaveBeenCalled();
  });

  it('refuses an unresponsive live socket holder at the deadline without signaling', async () => {
    healthProbe.mockResolvedValue(null);
    const { handoff, kill } = options(async () => ({ kind: 'incumbent', reason: 'live-listener' }));

    await expect(bindWithHandoff(handoff)).rejects.toBeInstanceOf(HandoffEscalationError);
    expect(kill).not.toHaveBeenCalled();
  });
});

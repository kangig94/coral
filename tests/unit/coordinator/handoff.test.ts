import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  bindWithHandoff,
  HandoffEscalationError,
  UpgradeSupervisorUnavailableError,
} from '#src/coordinator/handoff.js';
import { createRealTimePort } from '#src/infra/time.js';
import type { Runtime } from '#src/runtime/ports.js';
import { IncumbentMatchesError, probeIncumbent } from '#src/transport/ipc/handoff.js';
import { IpcRpcError } from '#src/transport/ipc/client.js';
import { VirtualTime } from '#tools/simulation/core/virtual-time.js';

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
  const runtime = {
    time: createRealTimePort(),
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

  it.each(['0.10.13', '0.10.14', '0.10.15'])(
    'concedes to an answering incumbent at version %s without a shutdown or signal',
    async (version) => {
      healthProbe.mockResolvedValueOnce({
        version,
        bundleHash: 'incumbent',
        flavor: 'prod',
        namespace: 'incumbent',
        status: 'ok',
      });
      const bindAttempt = vi.fn(async () => ({ kind: 'incumbent' as const, reason: 'live-listener' }));
      const { handoff, kill } = options(bindAttempt);

      await expect(bindWithHandoff(handoff)).rejects.toBeInstanceOf(IncumbentMatchesError);
      expect(bindAttempt).toHaveBeenCalledTimes(1);
      expect(kill).not.toHaveBeenCalled();
    },
  );

  it('concedes when serving health includes a succession attempt', async () => {
    healthProbe.mockResolvedValueOnce({
      version: '0.10.14',
      bundleHash: 'incumbent',
      flavor: 'prod',
      namespace: 'incumbent',
      status: 'ok',
      succession: { state: 'committing' },
    } as Awaited<ReturnType<typeof probeIncumbent>>);
    const { handoff, kill } = options(async () => ({ kind: 'incumbent', reason: 'live-listener' }));

    await expect(bindWithHandoff(handoff)).rejects.toBeInstanceOf(IncumbentMatchesError);
    expect(kill).not.toHaveBeenCalled();
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

  it('surfaces a missing waiter instead of exiting as an ordinary redundant contender', async () => {
    healthProbe.mockResolvedValueOnce({
      version: '0.10.13',
      bundleHash: 'incumbent',
      flavor: 'prod',
      namespace: 'incumbent',
      status: 'ok',
    });
    const { handoff } = options(async () => ({ kind: 'incumbent', reason: 'live-listener' }));
    await expect(
      bindWithHandoff({
        ...handoff,
        readVerifiedIncumbentFromDiscovery: () => ({ pid: 100, source: 'discovery', instanceId: 'incumbent' }),
        requestSuccession: async () => {
          throw new UpgradeSupervisorUnavailableError('claim failed');
        },
      }),
    ).rejects.toBeInstanceOf(UpgradeSupervisorUnavailableError);
  });

  it.each(['release', 'held', 'unknown', 'successor', 'draining', 'capacity'] as const)(
    'gives a confirmed incumbent exit its own bounded bind window (%s)',
    async (exit) => {
      const time = new VirtualTime();
      const { handoff, kill } = options(async () =>
        exit === 'release' && time.now() >= startedAt + 1_600
          ? { kind: 'bound' }
          : { kind: 'incumbent', reason: 'live-listener' },
      );
      const startedAt = time.now();
      healthProbe.mockImplementation(async () => {
        if (time.now() < startedAt + 1_600) return null;
        if (exit === 'capacity')
          throw new IpcRpcError({
            code: -32603,
            message: 'Too many IPC connections',
            data: { code: 'too_many_ipc_connections' },
          });
        if (exit === 'successor' || exit === 'draining') {
          return {
            version: '0.10.15',
            bundleHash: 'successor',
            flavor: 'prod',
            namespace: 'successor',
            status: exit === 'draining' ? 'draining' : 'ok',
          };
        }
        return null;
      });
      const result = bindWithHandoff({
        ...handoff,
        totalBudgetMs: 600,
        runtime: {
          ...handoff.runtime,
          time,
          process: {
            ...handoff.runtime.process,
            observeLiveness: () => (time.now() < startedAt + 600 ? 'alive' : exit === 'unknown' ? 'unknown' : 'absent'),
          },
        },
        readVerifiedIncumbentFromDiscovery: () => ({ pid: 100, source: 'discovery', instanceId: 'incumbent' }),
      }).then(
        (value) => ({ value, settledAt: time.now() }),
        (error: unknown) => ({ error, settledAt: time.now() }),
      );
      for (let elapsed = 0; elapsed <= 6_000; elapsed += 200) {
        for (let turn = 0; turn < 20; turn++) await Promise.resolve();
        time.tick(200);
      }
      const outcome = await result;
      if (exit === 'release') {
        expect(outcome).toMatchObject({ value: { acquiredViaHandoff: true }, settledAt: startedAt + 1_600 });
      } else if (exit === 'successor') {
        expect(outcome).toMatchObject({ error: expect.any(IncumbentMatchesError), settledAt: startedAt + 1_600 });
      } else {
        expect(outcome).toMatchObject({
          error: {
            code:
              exit === 'draining'
                ? 'handoff_administrative_drain_timeout'
                : exit === 'capacity'
                  ? 'handoff_ipc_capacity_timeout'
                  : 'handoff_socket_holder_unverified',
          },
          settledAt: startedAt + (exit === 'unknown' ? 600 : 5_600),
        });
      }
      expect(kill).not.toHaveBeenCalled();
    },
  );

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

  // A live holder that misses one probe may be stalled rather than dead; refusing on that first miss is what
  // lets a waiting CLI print force-kill guidance against a coordinator that answers a moment later.
  it('keeps probing a live holder that stalls once, and concedes when it answers', async () => {
    healthProbe.mockResolvedValueOnce(null).mockResolvedValueOnce({
      version: '0.10.14',
      bundleHash: 'incumbent',
      flavor: 'prod',
      namespace: 'incumbent',
      status: 'ok',
    });
    const { handoff, kill } = options(async () => ({ kind: 'incumbent', reason: 'live-listener' }));

    await expect(
      bindWithHandoff({
        ...handoff,
        readVerifiedIncumbentFromDiscovery: () => ({ pid: 100, source: 'discovery', instanceId: 'incumbent' }),
      }),
    ).rejects.toBeInstanceOf(IncumbentMatchesError);
    expect(healthProbe).toHaveBeenCalledTimes(2);
    expect(kill).not.toHaveBeenCalled();
  });

  it('refuses an unresponsive live socket holder at the deadline without signaling', async () => {
    healthProbe.mockResolvedValue(null);
    const { handoff, kill } = options(async () => ({ kind: 'incumbent', reason: 'live-listener' }));

    await expect(bindWithHandoff(handoff)).rejects.toBeInstanceOf(HandoffEscalationError);
    expect(kill).not.toHaveBeenCalled();
  });

  it('classifies a holder that drains once then remains silent as unverified', async () => {
    healthProbe
      .mockResolvedValueOnce({
        version: '0.10.13',
        bundleHash: 'incumbent',
        flavor: 'prod',
        namespace: 'incumbent',
        status: 'draining',
      })
      .mockResolvedValue(null);
    const { handoff } = options(async () => ({ kind: 'incumbent', reason: 'live-listener' }));

    await expect(bindWithHandoff(handoff)).rejects.toMatchObject({ code: 'handoff_socket_holder_unverified' });
  });

  it('keeps the drain timeout while the holder continues answering draining', async () => {
    healthProbe.mockResolvedValue({
      version: '0.10.13',
      bundleHash: 'incumbent',
      flavor: 'prod',
      namespace: 'incumbent',
      status: 'draining',
    });
    const { handoff } = options(async () => ({ kind: 'incumbent', reason: 'live-listener' }));

    await expect(bindWithHandoff(handoff)).rejects.toMatchObject({ code: 'handoff_administrative_drain_timeout' });
  });

  it('clears an earlier connection-cap refusal after sustained silence', async () => {
    healthProbe
      .mockRejectedValueOnce(
        new IpcRpcError({
          code: -32603,
          message: 'Too many IPC connections',
          data: { code: 'too_many_ipc_connections' },
        }),
      )
      .mockResolvedValue(null);
    const { handoff } = options(async () => ({ kind: 'incumbent', reason: 'live-listener' }));

    await expect(bindWithHandoff(handoff)).rejects.toMatchObject({ code: 'handoff_socket_holder_unverified' });
  });
});

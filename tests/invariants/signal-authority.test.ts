import { describe, expect, it, vi } from 'vitest';

import { bindWithHandoff, HandoffEscalationError, type HandoffOptions } from '../../src/coordinator/handoff.js';
import type { Runtime } from '../../src/runtime/ports.js';
import type { IncumbentIdentity } from '../../src/transport/ipc/handoff.js';
import type * as IpcHandoffModule from '../../src/transport/ipc/handoff.js';
import { testIncarnation } from '../helpers/process-incarnation.js';

vi.mock('../../src/transport/ipc/handoff.js', async (importOriginal) => ({
  ...(await importOriginal<typeof IpcHandoffModule>()),
  probeIncumbent: vi.fn(async () => null),
}));

describe('an unanswered socket holder grants no signal authority', () => {
  it('reaches the handoff deadline without signalling after incumbent verification becomes unavailable', async () => {
    const incumbent: IncumbentIdentity = {
      pid: 91_001,
      incarnation: testIncarnation(91_001_000),
      source: 'discovery',
      instanceId: 'signal-settlement-invariant',
      token: 'token',
      bootToken: 'boot-token',
      shutdownToken: 'shutdown-token',
    };
    const kill = vi.fn(() => true);
    let now = 0;
    const runtime: Pick<Runtime, 'time' | 'process' | 'env'> = {
      time: {
        now: () => now,
        monotonicNow: () => BigInt(now),
        sleep: async (ms) => {
          now += ms;
        },
      } as Runtime['time'],
      process: {
        kill,
        readProcessIncarnation: () => null,
        observeLiveness: () => 'unknown',
      } as unknown as Runtime['process'],
      env: { platform: () => 'linux' } as unknown as Runtime['env'],
    };
    const readIncumbent = vi
      .fn<HandoffOptions['readVerifiedIncumbentFromDiscovery']>(() => null)
      .mockReturnValueOnce(incumbent);
    const options: HandoffOptions = {
      socketPath: '/tmp/coral-signal-settlement-invariant.sock',
      desired: { version: 'invariant', bundleHash: 'invariant', flavor: 'prod', namespace: 'invariant' },
      bindAttempt: async () => ({ kind: 'incumbent', reason: 'signal-settlement-invariant' }),
      runStartupRecovery: async () => [],
      runtime,
      readVerifiedIncumbentFromDiscovery: readIncumbent,
      totalBudgetMs: 1_000,
    };

    const outcome = await bindWithHandoff(options).catch((error: unknown) => error);

    expect(now).toBe(1_000);
    expect(readIncumbent.mock.calls.length).toBeGreaterThan(1);
    expect(outcome).toBeInstanceOf(HandoffEscalationError);
    expect(outcome).toMatchObject({ code: 'handoff_socket_holder_unverified' });
    expect(kill).not.toHaveBeenCalled();
  });
});

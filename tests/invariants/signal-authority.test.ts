import { describe, expect, it } from 'vitest';

import { bindWithHandoff, HandoffEscalationError, type HandoffOptions } from '../../src/coordinator/handoff.js';
import type { Runtime } from '../../src/runtime/ports.js';
import type { IncumbentIdentity } from '../../src/transport/ipc/handoff.js';
import { testIncarnation } from '../helpers/process-incarnation.js';

describe('a signal aimed at a pid establishes that the pid is still its recorded process', () => {
  it.each(['alive', 'absent', 'unknown'] as const)(
    'does not signal an unresponsive incumbent when its process is %s',
    async (targetStatus) => {
      const incumbent: IncumbentIdentity = {
        pid: 91_001,
        incarnation: testIncarnation(91_001_000),
        source: 'discovery',
        instanceId: 'signal-settlement-invariant',
        token: 'token',
        bootToken: 'boot-token',
        shutdownToken: 'shutdown-token',
      };
      const acceptedSignals: NodeJS.Signals[] = [];
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
          kill: (_pid: number, acceptedSignal: NodeJS.Signals | 0) => {
            if (acceptedSignal !== 0) acceptedSignals.push(acceptedSignal);
            return true;
          },
          readProcessIncarnation: () => incumbent.incarnation ?? null,
          observeLiveness: () => targetStatus,
        } as unknown as Runtime['process'],
        env: { platform: () => 'linux' } as unknown as Runtime['env'],
      };
      const options: HandoffOptions = {
        socketPath: '/tmp/coral-signal-settlement-invariant.sock',
        desired: { version: 'invariant', bundleHash: 'invariant', flavor: 'prod', namespace: 'invariant' },
        bindAttempt: async () => ({ kind: 'incumbent', reason: 'signal-settlement-invariant' }),
        runStartupRecovery: async () => [],
        runtime,
        readVerifiedIncumbentFromDiscovery: () => incumbent,
        totalBudgetMs: 1,
      };

      const outcome = await bindWithHandoff(options).catch((error: unknown) => error);

      expect(acceptedSignals).toEqual([]);
      expect(outcome).toBeInstanceOf(HandoffEscalationError);
    },
  );
});

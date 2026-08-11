import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as WorldModule from '#src/coordinator/composition/world.js';

const capturedWorlds = vi.hoisted(() => [] as WorldModule.CoordinatorWorld[]);

vi.mock('#src/coordinator/composition/world.js', async (importOriginal) => {
  const actual = await importOriginal<typeof WorldModule>();
  return {
    ...actual,
    createCoordinatorWorld: (...args: Parameters<typeof actual.createCoordinatorWorld>) => {
      const world = actual.createCoordinatorWorld(...args);
      capturedWorlds.push(world);
      return world;
    },
  };
});

import { createStartupRecoveryBarrier } from '#src/coordinator/composition/world.js';
import { classifyLocalCarriers } from '#src/coordinator/composition/carrier-observation.js';
import type { JobProjectionDetail } from '#src/jobs/read-queries.js';
import {
  createHandoffCoresHarness,
  type HandoffCoresHarness,
} from '#tests/integration/coordinator/handoff-cores-harness.js';

const OWNERLESS_JOB_ID = '00000000-0000-4000-8000-000000000097';

function ownerlessAcquiredDetail(): JobProjectionDetail {
  return {
    status: {
      jobId: OWNERLESS_JOB_ID,
      owner: { kind: 'provider-session', id: 'session-1' },
      sessionId: 'session-1',
      provider: 'codex',
      projectRoot: '/tmp/project',
      backendNamespace: 'barrier-test',
      jobKind: 'provider',
      phase: 'running',
      updatedAt: '2026-08-11T00:00:00.000Z',
    },
    launch: null,
    runtime: {
      transport: 'app-server',
      startTime: '2026-08-11T00:00:00.000Z',
      providerMeta: {
        provider: 'codex',
        leaseState: 'acquired',
        hostRef: { provider: 'codex', fingerprint: 'f', instanceId: 'i', leaseMode: 'shared' },
      },
    },
    exit: null,
  };
}

let harness: HandoffCoresHarness | null = null;

afterEach(async () => {
  await harness?.cleanup();
  harness = null;
  capturedWorlds.length = 0;
});

describe('startup recovery barrier composition', () => {
  it('publishes only the coordinator instance whose lifecycle completed startup recovery', () => {
    const first = createStartupRecoveryBarrier();
    const second = createStartupRecoveryBarrier();

    expect(first.read.hasPassed()).toBe(false);
    expect(second.read.hasPassed()).toBe(false);

    first.publication.publish();

    expect(first.read.hasPassed()).toBe(true);
    expect(second.read.hasPassed()).toBe(false);
  });

  it('classifies an ownerless acquired job as unaccounted after production startup publishes the barrier', async () => {
    harness = createHandoffCoresHarness();
    const bootPromise = harness.bootCore({ instanceId: 'barrier-production-core' });
    const world = capturedWorlds.at(-1);
    if (world === undefined) throw new Error('Production composition did not create a coordinator world.');

    expect(world.startupRecoveryBarrier.hasPassed()).toBe(false);

    await bootPromise;

    const [result] = classifyLocalCarriers(
      [OWNERLESS_JOB_ID],
      {
        getDb: () => harness!.db,
        loadJobProjectionDetail: () => ownerlessAcquiredDetail(),
        platform: process.platform,
        hasStartupRecoveryPassed: () => world.startupRecoveryBarrier.hasPassed(),
        isAdmittedByThisCoordinator: () => false,
        registryStateForJob: () => null,
      },
      7,
    );

    expect(world.startupRecoveryBarrier.hasPassed()).toBe(true);
    expect(result?.observation.liveness).toBe('unknown');
    expect(result?.observation.defect).toBe('local-unknown-after-recovery-decision');
  });
});

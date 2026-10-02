import { describe, expect, it } from 'vitest';

import { parseBackendHealth, type BackendHealth } from '#src/transport/http/backend/health.js';
import type { ShutdownRemainderProjection } from '#src/infra/shutdown-contract.js';

const HEALTHY_BASE: BackendHealth = {
  status: 'ok',
  kernel: { phase: 'running', readyAt: 1_700_000_000_000 },
  version: '0.7.1',
  bundleHash: 'hash-1234',
  flavor: 'prod',
  instanceId: 'instance-1',
  namespace: 'test-ns',
  pid: 4_242,
  uptimeMs: 1000,
  active: 0,
  activeJobs: 0,
  inflightRequests: 0,
  queueDepth: 0,
  textProjectionState: 'idle',
  components: [{ id: 'kb', phase: 'online' }],
};

const SHUTDOWN_ENTRY = {
  label: 'server close',
  remainder: { owner: 'process-exit' },
  settlement: { cause: 'budget-exhausted' },
} as const;

const SHUTDOWN_PROJECTION = {
  reason: 'sigterm',
  mode: 'handoff',
  elapsedMs: 750,
  boundMs: 9_250,
  attempt: { started: 2, limit: 3 },
  lastDeclined: {
    attempt: 1,
    reason: 'required-shutdown-step-unsettled',
    exit: 'shutdown-budget-exhaustion',
    undischarged: [SHUTDOWN_ENTRY],
    retainedAuthority: {
      ipcSocket: true,
      providerControlProxyInstanceIds: [],
      cleanupObligations: [],
    },
  },
} as const satisfies ShutdownRemainderProjection;

describe('/health typed shape (AC10a)', () => {
  it('accepts an older payload without a shutdown projection', () => {
    const parsed = parseBackendHealth(HEALTHY_BASE);
    expect(parsed?.health).toMatchObject(HEALTHY_BASE);
    expect(parsed?.health).not.toHaveProperty('shutdown');
  });

  it('keeps readable shutdown entries and names an unsupported entry by its original slot', () => {
    const malformedEntry = {
      label: 'provider host dispose',
      remainder: { owner: 'successor-recovery' },
      settlement: { cause: 'from-a-newer-build' },
    };
    const parsed = parseBackendHealth({
      ...HEALTHY_BASE,
      shutdown: {
        ...SHUTDOWN_PROJECTION,
        lastDeclined: {
          ...SHUTDOWN_PROJECTION.lastDeclined,
          undischarged: [SHUTDOWN_ENTRY, malformedEntry, { ...SHUTDOWN_ENTRY, label: 'stream response close' }],
        },
      },
    });

    expect(parsed?.health.shutdown).toEqual({
      ...SHUTDOWN_PROJECTION,
      lastDeclined: {
        ...SHUTDOWN_PROJECTION.lastDeclined,
        undischarged: [SHUTDOWN_ENTRY, { ...SHUTDOWN_ENTRY, label: 'stream response close' }],
      },
      skippedEntries: [{ entryNumber: 2, label: 'provider host dispose', owner: 'successor-recovery' }],
    });
  });
});

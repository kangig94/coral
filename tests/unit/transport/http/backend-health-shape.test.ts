import { statusFromParsedHealth } from '#src/cli/backend-status.js';
import { formatBackendStatus } from '#src/cli/format/backend.js';
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

describe('storage retention visibility', () => {
  it('carries the last typed outcome through health decoding and backend status formatting', () => {
    const retention = {
      startedAt: 1,
      finishedAt: 2,
      phase: 'partial',
      deleted: 10,
      kept: 1,
      failed: 1,
      outcomes: [
        { kind: 'failed', subject: 'exports/job', reason: 'unlink denied' },
        { kind: 'kept', subject: 'legacy', reason: 'owner unknown' },
      ],
    };
    const parsed = parseBackendHealth({ ...HEALTHY_BASE, retention });
    expect(parsed?.health.retention).toEqual(retention);
    const status = statusFromParsedHealth(parsed!);
    const text = formatBackendStatus(status, { kind: 'absent' }, null);
    expect(text).toContain('Storage retention: partial');
    expect(text).toContain('exports/job: unlink denied');
    expect(text).toContain('legacy: owner unknown');
  });

  it('drops an unsupported retention status without rejecting a serving backend', () => {
    const parsed = parseBackendHealth({ ...HEALTHY_BASE, retention: { phase: 'from-newer-build' } });
    expect(parsed?.health.status).toBe('ok');
    expect(parsed?.health).not.toHaveProperty('retention');
  });
});

describe('additive provider-operation startup health', () => {
  it('accepts older health and drops unsupported startup projections without rejecting health', () => {
    expect(
      parseBackendHealth(HEALTHY_BASE)?.health.diagnostics?.providerOperationStartupReconciliation,
    ).toBeUndefined();
    const parsed = parseBackendHealth({
      ...HEALTHY_BASE,
      diagnostics: {
        providerOperationStartupReconciliation: { phase: 'future-state' },
        carriers: { coverage: 'complete', liveJobs: 0, unknownJobs: 0, recoveryDefectJobs: 0 },
      },
    });
    expect(parsed?.health.status).toBe('ok');
    expect(parsed?.health.diagnostics?.carriers?.coverage).toBe('complete');
    expect(parsed?.health.diagnostics?.providerOperationStartupReconciliation).toBeUndefined();
  });
});

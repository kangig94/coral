import { describe, expect, it } from 'vitest';
import { sessionContinuationLeaseClaimedBodySchema } from '#src/sessions/event-bodies.js';
import { TEST_CODEX_BINDING } from '#tests/helpers/provider-credentials.js';

describe('session fault event builders', () => {
  it('rejects continuation lease detail that differs from the ProviderSession snapshot', () => {
    const lease = {
      status: 'claimed' as const,
      staleJobId: 'stale-job',
      resumedJobId: 'resumed-job',
      workflowId: 'workflow-1',
      workflowSlotId: 'workflow-1:0:0',
      replacementGeneration: 1,
      reason: 'stale_recovery' as const,
      expiresAt: '2026-07-22T01:00:00.000Z',
      recordedAt: '2026-07-22T00:00:00.000Z',
      claimedAt: '2026-07-22T00:00:01.000Z',
    };
    const entry = {
      sessionId: 'session-1',
      binding: TEST_CODEX_BINDING,
      name: 'session-1',
      state: 'ready' as const,
      retention: 'retain' as const,
      artifactHandles: [],
      retentionDiscard: { attempts: [] },
      continuationLease: { ...lease, resumedJobId: 'different-job' },
      activeJobId: 'resumed-job',
      providerContinuity: null,
      cwd: '/repo',
      projectRoot: '/repo',
      backendNamespace: 'tests',
      createdAt: '2026-07-22T00:00:00.000Z',
      lastUsedAt: '2026-07-22T00:00:01.000Z',
      version: 2,
    };

    expect(() => sessionContinuationLeaseClaimedBodySchema.parse({ entry, sessionId: entry.sessionId, lease })).toThrow(
      'Continuation lease detail must exactly equal entry.continuationLease.',
    );
  });
});

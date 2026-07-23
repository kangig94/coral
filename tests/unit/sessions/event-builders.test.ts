import { describe, expect, it } from 'vitest';

import {
  sessionAdapterUnparseableEvent,
  sessionInterruptedEvent,
  sessionProviderFailedEvent,
} from '#src/sessions/event-builders.js';
import { sessionInterruptedBodySchema } from '#src/sessions/event-bodies.js';
import { sessionContinuationLeaseClaimedBodySchema } from '#src/sessions/event-bodies.js';
import { TEST_CODEX_BINDING } from '#tests/helpers/provider-credentials.js';

const OPTIONS = {
  sessionId: 'session-1',
  jobId: 'job-1',
  namespace: 'ns-1',
  project: '/repo',
  correlationId: 'corr-1',
  parentJobId: 'parent-1',
  workflowSlotId: 'slot-1',
} as const;

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

  it('builds session.interrupted with caller metadata and refs', () => {
    expect(
      sessionInterruptedEvent(
        {
          trigger: 'restart',
          continuity: 'pre_checkpoint_preserved',
        },
        OPTIONS,
      ),
    ).toEqual({
      type: 'session.interrupted',
      stream: { kind: 'session', id: 'session-1' },
      namespace: 'ns-1',
      project: '/repo',
      correlationId: 'corr-1',
      refs: {
        sessionId: 'session-1',
        jobId: 'job-1',
        parentJobId: 'parent-1',
        workflowSlotId: 'slot-1',
      },
      body: {
        trigger: 'restart',
        continuity: 'pre_checkpoint_preserved',
      },
    });
  });

  it('rejects the removed wrapped session.interrupted layout', () => {
    expect(() =>
      sessionInterruptedBodySchema.parse({
        entry: {},
        fault: { trigger: 'restart', continuity: 'missing' },
      }),
    ).toThrow();
  });

  it('builds session.provider_failed', () => {
    expect(
      sessionProviderFailedEvent(
        {
          provider: 'codex',
          reason: 'request_failed',
          message: 'transport reset',
        },
        { sessionId: 'session-1' },
      ),
    ).toEqual({
      type: 'session.provider_failed',
      stream: { kind: 'session', id: 'session-1' },
      refs: { sessionId: 'session-1' },
      body: {
        provider: 'codex',
        reason: 'request_failed',
        message: 'transport reset',
      },
    });
  });

  it('builds session.adapter_unparseable', () => {
    expect(
      sessionAdapterUnparseableEvent(
        {
          provider: 'claude',
          exitCode: 1,
          stdout: 'out',
          stderr: 'err',
          parseError: 'bad json',
        },
        { sessionId: 'session-1' },
      ),
    ).toEqual({
      type: 'session.adapter_unparseable',
      stream: { kind: 'session', id: 'session-1' },
      refs: { sessionId: 'session-1' },
      body: {
        provider: 'claude',
        exitCode: 1,
        stdout: 'out',
        stderr: 'err',
        parseError: 'bad json',
      },
    });
  });
});

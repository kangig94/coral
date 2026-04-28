import { describe, expect, it } from 'vitest';

import {
  sessionAdapterUnparseableEvent,
  sessionInterruptedEvent,
  sessionProviderFailedEvent,
} from '#src/sessions/shell/session-fault-events.js';

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
      bodyVersion: 1,
      body: {
        trigger: 'restart',
        continuity: 'pre_checkpoint_preserved',
      },
    });
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
      bodyVersion: 1,
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
      bodyVersion: 1,
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

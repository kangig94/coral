import { describe, expect, it } from 'vitest';

import type { CoralEventInput } from '#src/store/index.js';
import {
  ADAPTER_OUTPUT_UNPARSEABLE_KIND,
  PROVIDER_REQUEST_FAILED_KIND,
  PROVIDER_SESSION_UNAVAILABLE_KIND,
} from '#src/providers/fault.js';
import {
  materializeJobLaunchRejected,
  materializeJobRecoveryFault,
  materializeProviderFault,
  materializeSessionInterrupted,
} from '#src/jobs/shell/fault-materializer.js';

function createAppendRecorder(): {
  readonly events: CoralEventInput[];
  readonly progressStore: {
    appendEventsWithResult(events: readonly CoralEventInput[]): Array<{
      seq: number;
      stream: CoralEventInput['stream'];
    }>;
  };
} {
  const events: CoralEventInput[] = [];
  let seq = 0;

  return {
    events,
    progressStore: {
      appendEventsWithResult(inputs) {
        for (const input of inputs) {
          events.push(JSON.parse(JSON.stringify(input)) as CoralEventInput);
        }
        return inputs.map((input) => ({
          seq: ++seq,
          stream: input.stream,
        }));
      },
    },
  };
}

const OPTIONS = {
  jobId: 'job-1',
  sessionId: 'session-1',
  parentJobId: 'parent-1',
  workflowSlotId: 'slot-1',
} as const;

describe('fault-materializer canonical output boundary (AC3.6, AC3.7)', () => {
  it.each([
    [{ kind: 'ghost_launch' }, { kind: 'job_fault', fault: { kind: 'ghost_launch' } }],
    [{ kind: 'wrapper_lost' }, { kind: 'job_fault', fault: { kind: 'wrapper_lost' } }],
    [
      { kind: 'wrapper_crashed', cause: { message: 'wrapper exploded' } },
      { kind: 'job_fault', fault: { kind: 'wrapper_crashed', cause: { message: 'wrapper exploded' } } },
    ],
  ] as const)('returns an immediate canonical job outcome for %j', (fault, expected) => {
    const recorder = createAppendRecorder();

    const outcome = materializeJobRecoveryFault(recorder.progressStore, fault, OPTIONS);

    expect(outcome).toEqual(expected);
    expect(recorder.events).toEqual([]);
  });

  it.each([
    ['stale_status_schema', { kind: 'stale_status_schema' }],
    ['recovery_parse_failed', { kind: 'recovery_parse_failed', cause: { message: 'partial stderr' } }],
  ] as const)('appends a canonical job progress cause event for %s', (_label, fault) => {
    const recorder = createAppendRecorder();

    const outcome = materializeJobRecoveryFault(recorder.progressStore, fault, OPTIONS);

    expect(outcome).toEqual({
      kind: 'failed',
      causeRef: {
        stream: { kind: 'job', id: 'job-1' },
        seq: 1,
      },
    });
    expect(recorder.events).toEqual([
      {
        type: 'job.progress.emitted',
        stream: { kind: 'job', id: 'job-1' },
        refs: {
          jobId: 'job-1',
          sessionId: 'session-1',
          parentJobId: 'parent-1',
          workflowSlotId: 'slot-1',
        },
        bodyVersion: 1,
        body: fault,
      },
    ]);
  });

  it('appends a canonical job.launch.rejected cause event', () => {
    const recorder = createAppendRecorder();

    const outcome = materializeJobLaunchRejected(
      recorder.progressStore,
      {
        reason: 'busy',
        message: 'Provider queue is full.',
        provider: 'codex',
        globalActive: 4,
        globalLimit: 4,
      },
      OPTIONS,
    );

    expect(outcome).toEqual({
      kind: 'failed',
      causeRef: {
        stream: { kind: 'job', id: 'job-1' },
        seq: 1,
      },
    });
    expect(recorder.events[0]).toEqual({
      type: 'job.launch.rejected',
      stream: { kind: 'job', id: 'job-1' },
      refs: {
        jobId: 'job-1',
        sessionId: 'session-1',
        parentJobId: 'parent-1',
        workflowSlotId: 'slot-1',
      },
      bodyVersion: 1,
      body: {
        reason: 'busy',
        message: 'Provider queue is full.',
        provider: 'codex',
        globalActive: 4,
        globalLimit: 4,
      },
    });
  });

  it('appends a canonical session.interrupted cause event', () => {
    const recorder = createAppendRecorder();

    const outcome = materializeSessionInterrupted(
      recorder.progressStore,
      {
        trigger: 'restart',
        continuity: 'pre_checkpoint_preserved',
      },
      OPTIONS,
    );

    expect(outcome).toEqual({
      kind: 'failed',
      causeRef: {
        stream: { kind: 'session', id: 'session-1' },
        seq: 1,
      },
    });
    expect(recorder.events[0]).toEqual({
      type: 'session.interrupted',
      stream: { kind: 'session', id: 'session-1' },
      refs: {
        jobId: 'job-1',
        sessionId: 'session-1',
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

  it.each([
    [
      ADAPTER_OUTPUT_UNPARSEABLE_KIND,
      {
        kind: ADAPTER_OUTPUT_UNPARSEABLE_KIND,
        provider: 'claude',
        exitCode: 17,
        stdout: 'partial stdout',
        stderr: 'partial stderr',
        parseError: 'bad json',
      },
      'session.adapter_unparseable',
      {
        provider: 'claude',
        exitCode: 17,
        stdout: 'partial stdout',
        stderr: 'partial stderr',
        parseError: 'bad json',
      },
    ],
    [
      PROVIDER_SESSION_UNAVAILABLE_KIND,
      {
        kind: PROVIDER_SESSION_UNAVAILABLE_KIND,
        provider: 'claude',
        reason: 'thread missing',
      },
      'session.provider_failed',
      {
        provider: 'claude',
        reason: 'session_unavailable',
        message: 'thread missing',
      },
    ],
    [
      PROVIDER_REQUEST_FAILED_KIND,
      {
        kind: PROVIDER_REQUEST_FAILED_KIND,
        provider: 'codex',
        message: 'transport reset',
      },
      'session.provider_failed',
      {
        provider: 'codex',
        reason: 'request_failed',
        message: 'transport reset',
      },
    ],
  ] as const)(
    'materializes provider fault %s into a canonical session event',
    (_kind, fault, expectedType, expectedBody) => {
      const recorder = createAppendRecorder();

      const outcome = materializeProviderFault(recorder.progressStore, fault, OPTIONS);

      expect(outcome).toEqual({
        kind: 'failed',
        causeRef: {
          stream: { kind: 'session', id: 'session-1' },
          seq: 1,
        },
      });
      expect(recorder.events[0]).toEqual({
        type: expectedType,
        stream: { kind: 'session', id: 'session-1' },
        refs: {
          jobId: 'job-1',
          sessionId: 'session-1',
          parentJobId: 'parent-1',
          workflowSlotId: 'slot-1',
        },
        bodyVersion: 1,
        body: expectedBody,
      });
    },
  );
});

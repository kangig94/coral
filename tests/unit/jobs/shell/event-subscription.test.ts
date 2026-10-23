import { expect, it } from 'vitest';
import { publishJobEvents, subscribeJobEvents } from '#src/jobs/shell/event-subscription.js';
import {
  executionHarness,
  openedJob,
  requestedExecution,
  executionInput,
  EXECUTION_JOB_ID as jobId,
} from '#tests/helpers/job-executions.js';

it('delivers an execution end after acceptance committed in a different batch', async () => {
  const h = executionHarness();
  const abort = new AbortController();
  const stream = subscribeJobEvents({ afterSeq: 0, jobIds: [jobId], abortSignal: abort.signal })[
    Symbol.asyncIterator
  ]();
  try {
    h.append(openedJob(), requestedExecution());
    const accepted = h.append(
      executionInput('job.execution.outcome.accepted', {
        execution: 1,
        terminal: { content: 'done', durationMs: 1, outcome: { kind: 'completed' } },
      }),
    )[0];
    const waiting = stream.next();
    const ended = h.append(
      executionInput('job.execution.ended', {
        execution: 1,
        causeRef: { stream: { kind: 'job', id: jobId }, seq: accepted.seq },
      }),
    );
    publishJobEvents(ended, h.db, h.readCtx);
    expect(await waiting).toMatchObject({
      done: false,
      value: { jobId, execution: 1, type: 'terminal', result: { content: 'done' } },
    });
  } finally {
    abort.abort();
    await stream.return?.();
    h.db.close();
  }
});

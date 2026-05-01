import { describe, expect, it } from 'vitest';

import type { CauseRef, CauseRefToken } from '#src/causality/cause-ref.js';
import type { CommitContext } from '#src/store/append.js';
import type { ResolvableCoralEventInput } from '#src/store/envelope.js';
import { selectFinalCauseRef } from '#src/coordinator/services/workflow-finalization.js';
import type { WorkflowFinalizationIntent } from '#src/workflow/finalization.js';

type RecordedInput = {
  readonly input: ResolvableCoralEventInput<unknown, unknown>;
  readonly token: CauseRefToken<unknown>;
};

function createContextRecorder(): {
  readonly appended: RecordedInput[];
  readonly c: CommitContext<unknown>;
} {
  const appended: RecordedInput[] = [];
  return {
    appended,
    c: {
      append(input) {
        const token = { slot: appended.length } as unknown as CauseRefToken<unknown>;
        appended.push({ input, token });
        return token;
      },
    },
  };
}

const WORKFLOW_JOB_ID = 'workflow-1';
const STEP_DETAILS = [] as Extract<WorkflowFinalizationIntent, { outcome: 'failed' }>['stepDetails'];

describe('selectFinalCauseRef precedence', () => {
  it('uses causeRef directly and does NOT append a lifecycle_fault when both are set', () => {
    const { appended, c } = createContextRecorder();
    const causeRef: CauseRef = {
      stream: { kind: 'job', id: 'job-1' },
      seq: 7,
    };
    const intent: Extract<WorkflowFinalizationIntent, { outcome: 'failed' }> = {
      outcome: 'failed',
      workflowJobId: WORKFLOW_JOB_ID,
      causeRef,
      lifecycleFault: { kind: 'wrapper_crashed', message: 'should be discarded' },
      stepDetails: STEP_DETAILS,
    };

    const result = selectFinalCauseRef(c, WORKFLOW_JOB_ID, intent);

    expect(result).toBe(causeRef);
    expect(appended).toEqual([]);
  });

  it('appends workflow.lifecycle_fault and returns its token when only lifecycleFault is set', () => {
    const { appended, c } = createContextRecorder();
    const intent: Extract<WorkflowFinalizationIntent, { outcome: 'failed' }> = {
      outcome: 'failed',
      workflowJobId: WORKFLOW_JOB_ID,
      lifecycleFault: { kind: 'wrapper_crashed', message: 'wrapper exploded' },
      stepDetails: STEP_DETAILS,
    };

    const result = selectFinalCauseRef(c, WORKFLOW_JOB_ID, intent);

    expect(appended).toHaveLength(1);
    expect(appended[0].input).toMatchObject({
      type: 'workflow.lifecycle_fault',
      stream: { kind: 'workflow', id: WORKFLOW_JOB_ID },
      body: { kind: 'wrapper_crashed', message: 'wrapper exploded' },
    });
    expect(result).toBe(appended[0].token);
  });
});

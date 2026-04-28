import type { CauseRef } from '../causality/cause-ref.js';
import type { AbortReason } from '../jobs/outcome.js';
import type { StepDetail } from './execution-contract.js';
import type { WorkflowLifecycleFaultBody } from './events.js';

export type WorkflowFinalizationIntent =
  | {
      outcome: 'completed';
      workflowJobId: string;
      finalOutput: string;
      stepDetails: StepDetail[];
    }
  | {
      outcome: 'failed';
      workflowJobId: string;
      causeRef?: CauseRef;
      lifecycleFault: WorkflowLifecycleFaultBody;
      stepDetails: StepDetail[];
    }
  | {
      outcome: 'aborted';
      workflowJobId: string;
      reason: AbortReason;
      stepDetails: StepDetail[];
    };

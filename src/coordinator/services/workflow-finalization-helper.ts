import { appendJobTerminalRecorded, failedTerminalOutcome } from '../../jobs/terminal/recording.js';
import type { CommitContext } from '../../store/append.js';
import { workflowCompletedEvent, workflowLifecycleFaultEvent } from '../../workflow/events.js';
import type { WorkflowFinalizationIntent } from '../../workflow/finalization.js';

export interface WorkflowFinalizationRecording {
  readonly sessionId?: string | null;
  readonly namespace?: string;
  readonly project?: string;
}

export function composeWorkflowFinalization<Scope>(
  c: CommitContext<Scope>,
  workflowJobId: string,
  intent: WorkflowFinalizationIntent,
  recording: WorkflowFinalizationRecording,
): void {
  if (intent.workflowJobId !== workflowJobId) {
    throw new Error(`Workflow finalization intent job '${intent.workflowJobId}' did not match '${workflowJobId}'.`);
  }

  if (intent.outcome === 'completed') {
    c.append(workflowCompletedEvent(workflowJobId, { outcome: 'completed', stepDetails: intent.stepDetails }));
    appendJobTerminalRecorded(c, {
      jobId: workflowJobId,
      sessionId: recording.sessionId,
      namespace: recording.namespace,
      project: recording.project,
      terminal: {
        content: intent.finalOutput,
        outcome: { kind: 'completed' },
      },
      continuity: null,
    });
    return;
  }

  if (intent.outcome === 'aborted') {
    c.append(workflowCompletedEvent(workflowJobId, { outcome: 'aborted', stepDetails: intent.stepDetails }));
    appendJobTerminalRecorded(c, {
      jobId: workflowJobId,
      sessionId: recording.sessionId,
      namespace: recording.namespace,
      project: recording.project,
      terminal: {
        content: '',
        outcome: { kind: 'aborted', reason: intent.reason },
      },
      continuity: null,
    });
    return;
  }

  const causeRef = intent.causeRef ?? c.append(workflowLifecycleFaultEvent(workflowJobId, intent.lifecycleFault));
  const workflowCompleted = c.append(
    workflowCompletedEvent(workflowJobId, {
      outcome: 'failed',
      causeRef,
      stepDetails: intent.stepDetails,
    }),
  );
  appendJobTerminalRecorded(c, {
    jobId: workflowJobId,
    sessionId: recording.sessionId,
    namespace: recording.namespace,
    project: recording.project,
    terminal: {
      content: '',
      outcome: failedTerminalOutcome(workflowCompleted),
    },
    continuity: null,
  });
}

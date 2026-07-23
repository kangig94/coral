import { z } from 'zod';

export const workflowLifecycleSchema = z.enum(['active', 'draining', 'faulted', 'completed', 'failed', 'aborted']);
export type WorkflowLifecycle = z.infer<typeof workflowLifecycleSchema>;
export const workflowTerminalLifecycleSchema = z.enum(['completed', 'failed', 'aborted']);
export type WorkflowTerminalLifecycle = z.infer<typeof workflowTerminalLifecycleSchema>;

export type WorkflowLifecycleEvent =
  | { readonly type: 'workflow.plan.declared' }
  | { readonly type: 'workflow.drain.entered' }
  | { readonly type: 'workflow.lifecycle_fault' }
  | { readonly type: 'workflow.completed'; readonly outcome: 'completed' | 'failed' | 'aborted' };

/** The single transition table used by both append validation and projection rebuild. */
export function transitionWorkflowLifecycle(
  current: WorkflowLifecycle | null,
  event: WorkflowLifecycleEvent,
): WorkflowLifecycle | null {
  if (event.type === 'workflow.plan.declared') {
    return current === null ? 'active' : null;
  }
  if (current === null) {
    return null;
  }
  if (event.type === 'workflow.drain.entered') {
    return current === 'active' ? 'draining' : null;
  }
  if (event.type === 'workflow.lifecycle_fault') {
    return current === 'active' || current === 'draining' ? 'faulted' : null;
  }
  if (current === 'active' || current === 'draining') {
    return event.outcome;
  }
  if (current === 'faulted' && event.outcome === 'failed') {
    return 'failed';
  }
  return null;
}

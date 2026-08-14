import type { Database } from '../store/db.js';
import type { JobStatus, WorkflowChildJobSummary } from '../jobs/records.js';
import { workflowSlotLabel } from './plan.js';
import { readWorkflowProjection } from './read-queries.js';
import { parseWorkflowSlotId } from './slot-id.js';

function workflowLabels(db: Database, workflowJobId: string): ReadonlyMap<string, string> {
  const workflow = readWorkflowProjection(db, workflowJobId);
  const labels = new Map<string, string>();
  for (const slot of workflow?.plan.slots ?? []) {
    const parsed = parseWorkflowSlotId(slot.slotId);
    if (parsed !== null) {
      labels.set(slot.slotId, workflowSlotLabel(slot, parsed.atomIndex));
    }
  }
  return labels;
}

export function labelWorkflowChildStatus(db: Database, status: JobStatus): JobStatus {
  if (status.parentWorkflowJobId === undefined || status.workflowSlotId === undefined) {
    return status;
  }
  const label = workflowLabels(db, status.parentWorkflowJobId).get(status.workflowSlotId);
  return label === undefined ? status : { ...status, workflowLabel: label };
}

export function labelWorkflowStatuses<T extends { jobId: string; status: JobStatus }>(db: Database, jobs: T[]): T[] {
  const labelsByWorkflow = new Map<string, ReadonlyMap<string, string>>();
  return jobs.map((job) => {
    const parentId = job.status.parentWorkflowJobId;
    const slotId = job.status.workflowSlotId;
    if (parentId === undefined || slotId === undefined) {
      return job;
    }
    const labels = labelsByWorkflow.get(parentId) ?? workflowLabels(db, parentId);
    labelsByWorkflow.set(parentId, labels);
    const label = labels.get(slotId);
    return label === undefined ? job : { ...job, status: { ...job.status, workflowLabel: label } };
  });
}

export function labelWorkflowChildren(
  db: Database,
  parentWorkflowJobId: string,
  children: WorkflowChildJobSummary[],
): WorkflowChildJobSummary[] {
  return labelWorkflowStatuses(
    db,
    children.map((child) => ({
      ...child,
      status: { ...child.status, parentWorkflowJobId: child.status.parentWorkflowJobId ?? parentWorkflowJobId },
    })),
  );
}

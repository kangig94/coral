export type JobEventRefs = {
  jobId: string;
  sessionId?: string;
  parentJobId?: string;
  workflowId?: string;
  workflowSlotId?: string;
};

export type JobEventRefsInput = {
  jobId: string;
  sessionId?: string | null;
  parentJobId?: string | null;
  workflowId?: string | null;
  workflowSlotId?: string | null;
};

function requireJobRef(field: keyof JobEventRefs, value: string): string {
  if (value.length === 0) {
    throw new Error(`Job ref '${field}' must be non-empty.`);
  }
  return value;
}

function optionalJobRef(field: keyof JobEventRefs, value: string | null | undefined): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return requireJobRef(field, value);
}

export function buildJobEventRefs(input: JobEventRefsInput): JobEventRefs {
  const sessionId = optionalJobRef('sessionId', input.sessionId);
  const parentJobId = optionalJobRef('parentJobId', input.parentJobId);
  const workflowId = optionalJobRef('workflowId', input.workflowId);
  const workflowSlotId = optionalJobRef('workflowSlotId', input.workflowSlotId);

  return {
    jobId: requireJobRef('jobId', input.jobId),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(parentJobId === undefined ? {} : { parentJobId }),
    ...(workflowId === undefined ? {} : { workflowId }),
    ...(workflowSlotId === undefined ? {} : { workflowSlotId }),
  };
}

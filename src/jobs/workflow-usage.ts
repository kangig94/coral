import type { Database } from '../store/db.js';

import { USAGE_TOKEN_FIELDS, type UsageSummary } from '../providers/contract.js';
import { jobDiagnosticsSchema } from './terminal/result.js';
import { prepareCached } from '../store/db.js';

const TOKEN_FIELDS = USAGE_TOKEN_FIELDS;

type TokenField = (typeof TOKEN_FIELDS)[number];
type WorkflowUsageRow = {
  diagnostics: string | null;
};

function addToken(result: UsageSummary, field: TokenField, value: number | undefined): void {
  if (value === undefined) {
    return;
  }

  result[field] = (result[field] ?? 0) + value;
}

function hasUsageValue(usage: UsageSummary): boolean {
  return TOKEN_FIELDS.some((field) => usage[field] !== undefined) || usage.costUsd !== undefined;
}

export function aggregateWorkflowUsage(db: Database, workflowJobId: string): UsageSummary | undefined {
  // Workflow aggregates intentionally sum direct child jobs only; nested
  // workflow jobs contribute through their own terminal diagnostics.
  const rows = prepareCached<[string], WorkflowUsageRow>(
    db,
    `SELECT diagnostics
       FROM projection_jobs
      WHERE parent_workflow_job_id = ?`,
  ).all(workflowJobId);

  const result: UsageSummary = {};
  let sawUsage = false;
  let costUsd = 0;
  let sawCost = false;
  let jobsWithoutCostData = 0;

  for (const row of rows) {
    if (row.diagnostics === null) {
      continue;
    }

    const usage = jobDiagnosticsSchema.parse(JSON.parse(row.diagnostics)).usage;
    if (usage === undefined || !hasUsageValue(usage)) {
      continue;
    }

    sawUsage = true;
    for (const field of TOKEN_FIELDS) {
      addToken(result, field, usage[field]);
    }

    if (usage.costUsd === undefined) {
      jobsWithoutCostData += 1;
    } else {
      costUsd += usage.costUsd;
      sawCost = true;
    }
  }

  if (!sawUsage) {
    return undefined;
  }

  if (sawCost) {
    result.costUsd = costUsd;
  }
  if (jobsWithoutCostData > 0) {
    result.jobsWithoutCostData = jobsWithoutCostData;
  }

  return result;
}

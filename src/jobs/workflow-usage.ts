import type { RecoveryObservation } from '../recovery/phase-observation.js';
import type { Database } from '../store/db.js';

import { USAGE_TOKEN_FIELDS, type UsageSummary } from '../providers/contract.js';
import { jobExecutionOutcomeAcceptedBodySchema } from './terminal/result.js';

const TOKEN_FIELDS = USAGE_TOKEN_FIELDS;

type TokenField = (typeof TOKEN_FIELDS)[number];
type WorkflowUsageRow = {
  body: Uint8Array;
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

export function aggregateWorkflowUsage(
  db: Database,
  workflowJobId: string,
  observation?: RecoveryObservation,
): UsageSummary | undefined {
  const rows = db
    .prepare<[string], WorkflowUsageRow>(
      `SELECT accepted.body
         FROM projection_jobs child
         JOIN events ended ON ended.stream_kind = 'job' AND ended.stream_id = child.job_id
           AND ended.type = 'job.execution.ended'
         JOIN events accepted ON accepted.seq = json_extract(CAST(ended.body AS TEXT), '$.causeRef.seq')
           AND accepted.stream_kind = 'job' AND accepted.stream_id = child.job_id
           AND accepted.type = 'job.execution.outcome.accepted'
           AND json_extract(CAST(accepted.body AS TEXT), '$.execution') = json_extract(CAST(ended.body AS TEXT), '$.execution')
        WHERE child.parent_workflow_job_id = ?
        ORDER BY ended.seq ASC`,
    )
    .all(workflowJobId);
  observation?.record('workflow-child-diagnostics', { reads: rows.length });

  const result: UsageSummary = {};
  let sawUsage = false;
  let costUsd = 0;
  let sawCost = false;
  let jobsWithoutCostData = 0;

  for (const row of rows) {
    const usage = jobExecutionOutcomeAcceptedBodySchema.parse(JSON.parse(Buffer.from(row.body).toString('utf8')))
      .diagnostics?.usage;
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

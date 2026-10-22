import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

describe('workflow continuations have one slot job', () => {
  it('keeps continuation leases and replacement generations out of live workflow authority', () => {
    for (const path of [
      'src/sessions/continuation-lease-events.ts',
      'src/sessions/continuation-lease-recovery-source.ts',
      'src/jobs/conversation/continuation-lease-events.ts',
      'src/jobs/conversation/continuation-lease-recovery-source.ts',
    ]) expect(existsSync(new URL(`../../${path}`, import.meta.url))).toBe(false);
    for (const path of [
      'src/workflow/stale-recovery.ts', 'src/workflow/wait.ts', 'src/workflow/job-authority.ts',
      'src/workflow/recover.ts', 'src/workflow/read-queries.ts', 'src/workflow/launch.ts',
      'src/workflow/execution-contract.ts', 'src/coordinator/execution-service.ts',
      'src/coordinator/services/job-launch.ts', 'src/coordinator/services/recovery/authority-snapshot.ts',
      'src/coordinator/composition/succession-owners/local-authority.ts',
      'src/jobs/conversation/entry.ts', 'src/jobs/conversation/lifecycle-reactor.ts',
      'src/jobs/launch.ts', 'src/jobs/shell/launch.ts',
    ]) expect(source(path), path).not.toMatch(/continuationLease|ContinuationLease|workflowSlotGeneration|replacesWorkflowJobId|workflow_slot_generation|replaces_workflow_job_id/u);
  });

  it('exports workflow executions without predecessor job labels', () => {
    expect(source('src/jobs/terminal/export.ts')).not.toContain('Replaces workflow job');
    expect(source('src/cli/format/jobs.ts')).not.toMatch(/Replaces workflow job|Workflow generation|\bREPLACES\b/u);
  });
});

import { CoralSetupError } from '../runtime/errors.js';
import { decodeBody } from '../store/body-codec.js';
import type { DomainAppendValidator } from '../store/reducers.js';
import { jobOpenedBodySchema, jobExecutionRequestedBodySchema, type JobOpenedBody } from '../jobs/launch.js';
import { readJobOpened } from '../jobs/execution-state.js';
import { workflowLifecycleSchema } from './lifecycle.js';
import { workflowPlanSchema } from './plan.js';

export const validateWorkflowJobAuthority: DomainAppendValidator = (ctx, inputs) => {
  const opened = new Map<string, JobOpenedBody>();
  const declared = new Map<string, ReturnType<typeof workflowPlanSchema.parse>>();
  const closing = new Set(
    inputs
      .filter((input) => input.stream.kind === 'workflow' && input.type === 'workflow.completed')
      .map((input) => input.stream.id),
  );
  const slots = new Map<string, string>();
  const rows = ctx.db
    .prepare<
      [],
      { stream_id: string; type: string; stream_kind: 'job'; body: Uint8Array }
    >("SELECT stream_id, type, stream_kind, body FROM events WHERE stream_kind = 'job' AND type = 'job.opened'")
    .all();
  for (const row of rows) {
    const job = decodeBody(row, jobOpenedBodySchema, ctx.readCtx);
    if (job.jobKind === 'provider' && job.owner.kind === 'workflow')
      slots.set(`${job.owner.id}\0${job.workflowSlotId}`, row.stream_id);
  }

  for (const input of inputs) {
    if (input.type === 'workflow.plan.declared' && input.stream.kind === 'workflow') {
      const { plan } = input.body as { plan: unknown };
      declared.set(input.stream.id, workflowPlanSchema.parse(plan));
      continue;
    }
    if (input.type === 'job.opened') {
      const job = jobOpenedBodySchema.parse(input.body);
      opened.set(input.stream.id, job);
      if (job.jobKind === 'provider' && job.owner.kind === 'workflow') {
        const key = `${job.owner.id}\0${job.workflowSlotId}`;
        const previous = slots.get(key);
        if (previous !== undefined && previous !== input.stream.id) {
          throw new CoralSetupError({
            code: 'workflow_slot_job_conflict',
            userMessage: `Workflow slot '${job.workflowSlotId}' already names job '${previous}'.`,
            remediation: 'Continue the slot’s existing job.',
          });
        }
        slots.set(key, input.stream.id);
      }
      continue;
    }
    if (input.type !== 'job.execution.requested') continue;
    const request = jobExecutionRequestedBodySchema.parse(input.body);
    const job = opened.get(input.stream.id) ?? readJobOpened(ctx.db, input.stream.id, ctx.readCtx);
    if (job === null || job.owner.kind !== 'workflow') continue;
    const workflowId = job.owner.id;
    const row = ctx.db
      .prepare<
        [string],
        { lifecycle: string; plan: string }
      >('SELECT lifecycle, plan FROM projection_workflows WHERE workflow_id = ?')
      .get(workflowId);
    const plan =
      declared.get(workflowId) ?? (row === undefined ? undefined : workflowPlanSchema.parse(JSON.parse(row.plan)));
    const lifecycle = declared.has(workflowId)
      ? 'active'
      : row === undefined
        ? undefined
        : workflowLifecycleSchema.parse(row.lifecycle);
    if (plan === undefined || lifecycle === undefined) {
      throw new CoralSetupError({
        code: 'job_owner_missing',
        userMessage: `Workflow owner '${workflowId}' does not exist.`,
        remediation: 'Declare the owning workflow before requesting execution.',
      });
    }
    if (closing.has(workflowId) || (lifecycle !== 'active' && lifecycle !== 'draining')) {
      throw new CoralSetupError({
        code: 'workflow_owner_terminal',
        userMessage: `Workflow owner '${workflowId}' is closed.`,
        remediation: 'Request execution only while the owning workflow is open.',
      });
    }
    if (job.jobKind === 'workflow' && request.execution === 1) continue;
    if (
      job.jobKind !== 'provider' ||
      !plan.slots.some((slot) => slot.slotId === job.workflowSlotId) ||
      slots.get(`${workflowId}\0${job.workflowSlotId}`) !== input.stream.id
    ) {
      throw new CoralSetupError({
        code: 'workflow_slot_job_mismatch',
        userMessage: `Workflow '${workflowId}' does not name job '${input.stream.id}' in its slot.`,
        remediation: 'Continue only the job bound to the owning workflow slot.',
      });
    }
  }
};

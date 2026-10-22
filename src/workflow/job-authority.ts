import { CoralSetupError } from '../runtime/errors.js';
import type { DomainAppendValidator } from '../store/reducers.js';
import type { CoralEventInput } from '../store/envelope.js';
import { jobOpenedBodySchema, jobExecutionRequestedBodySchema, type JobOpenedBody } from '../jobs/launch.js';
import { readJobOpened } from '../jobs/execution-journal.js';
import { workflowLifecycleSchema } from './lifecycle.js';
import { workflowPlanSchema } from './plan.js';

export const validateWorkflowJobAuthority: DomainAppendValidator = (ctx, inputs) => {
  const candidates = inputs.filter(
    (input) => input.stream.kind === 'job' && (input.type === 'job.opened' || input.type === 'job.execution.requested'),
  );
  if (candidates.length === 0) return;
  const opened = new Map<string, JobOpenedBody>();
  for (const input of candidates) {
    const job =
      input.type === 'job.opened'
        ? jobOpenedBodySchema.parse(input.body)
        : (opened.get(input.stream.id) ?? readJobOpened(ctx.db, input.stream.id, ctx.readCtx));
    if (job !== null) opened.set(input.stream.id, job);
  }
  if (![...opened.values()].some((job) => job.owner.kind === 'workflow')) return;
  const authority = new WorkflowJobAuthority(ctx, inputs, opened);
  for (const input of inputs) authority.apply(input);
};

type WorkflowAppendContext = Parameters<DomainAppendValidator>[0];

class WorkflowJobAuthority {
  private readonly declared = new Map<string, ReturnType<typeof workflowPlanSchema.parse>>();
  private readonly closing: Set<string>;
  private readonly slots = new Map<string, string>();
  private readonly ctx: WorkflowAppendContext;
  private readonly opened: Map<string, JobOpenedBody>;

  constructor(ctx: WorkflowAppendContext, inputs: readonly CoralEventInput[], opened: Map<string, JobOpenedBody>) {
    this.ctx = ctx;
    this.opened = opened;
    this.closing = new Set(
      inputs
        .filter((input) => input.stream.kind === 'workflow' && input.type === 'workflow.completed')
        .map((input) => input.stream.id),
    );
  }

  apply(input: CoralEventInput): void {
    if (input.type === 'workflow.plan.declared' && input.stream.kind === 'workflow') {
      const { plan } = input.body as { plan: unknown };
      this.declared.set(input.stream.id, workflowPlanSchema.parse(plan));
    } else if (input.type === 'job.opened') {
      const job = jobOpenedBodySchema.parse(input.body);
      this.opened.set(input.stream.id, job);
      this.reserveSlot(input.stream.id, job);
    } else if (input.type === 'job.execution.requested') {
      this.validateRequest(input);
    }
  }

  private jobForSlot(workflowId: string, slot: string | undefined): string | undefined {
    const key = `${workflowId}\0${slot}`;
    return (
      this.slots.get(key) ??
      this.ctx.db
        .prepare<
          [string, string | null],
          { job_id: string }
        >('SELECT job_id FROM projection_jobs WHERE parent_workflow_job_id = ? AND workflow_slot = ?')
        .get(workflowId, slot ?? null)?.job_id
    );
  }

  private reserveSlot(jobId: string, job: JobOpenedBody): void {
    if (job.jobKind !== 'provider' || job.owner.kind !== 'workflow') return;
    const key = `${job.owner.id}\0${job.workflowSlotId}`;
    const previous = this.jobForSlot(job.owner.id, job.workflowSlotId);
    if (previous !== undefined && previous !== jobId) {
      throw new CoralSetupError({
        code: 'workflow_slot_job_conflict',
        userMessage: `Workflow slot '${job.workflowSlotId}' already names job '${previous}'.`,
        remediation: 'Continue the slot’s existing job.',
      });
    }
    this.slots.set(key, jobId);
  }

  private validateRequest(input: CoralEventInput): void {
    const request = jobExecutionRequestedBodySchema.parse(input.body);
    const job = this.opened.get(input.stream.id) ?? readJobOpened(this.ctx.db, input.stream.id, this.ctx.readCtx);
    if (job === null || job.owner.kind !== 'workflow') return;
    const workflowId = job.owner.id;
    const plan = this.requireOpenPlan(workflowId);
    if (job.jobKind === 'workflow' && request.execution === 1) return;
    if (
      job.jobKind !== 'provider' ||
      !plan.slots.some((slot) => slot.slotId === job.workflowSlotId) ||
      this.jobForSlot(workflowId, job.workflowSlotId) !== input.stream.id
    ) {
      throw new CoralSetupError({
        code: 'workflow_slot_job_mismatch',
        userMessage: `Workflow '${workflowId}' does not name job '${input.stream.id}' in its slot.`,
        remediation: 'Continue only the job bound to the owning workflow slot.',
      });
    }
  }

  private requireOpenPlan(workflowId: string): ReturnType<typeof workflowPlanSchema.parse> {
    const row = this.ctx.db
      .prepare<
        [string],
        { lifecycle: string; plan: string }
      >('SELECT lifecycle, plan FROM projection_workflows WHERE workflow_id = ?')
      .get(workflowId);
    const plan =
      this.declared.get(workflowId) ?? (row === undefined ? undefined : workflowPlanSchema.parse(JSON.parse(row.plan)));
    const lifecycle = this.declared.has(workflowId)
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
    if (this.closing.has(workflowId) || (lifecycle !== 'active' && lifecycle !== 'draining')) {
      throw new CoralSetupError({
        code: 'workflow_owner_terminal',
        userMessage: `Workflow owner '${workflowId}' is closed.`,
        remediation: 'Request execution only while the owning workflow is open.',
      });
    }
    return plan;
  }
}

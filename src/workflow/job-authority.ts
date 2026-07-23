import { CoralSetupError } from '../runtime/errors.js';
import { sessionContinuationLeaseClaimedBodySchema } from '../sessions/event-bodies.js';
import { decodeBody } from '../store/body-codec.js';
import type { DomainAppendValidator } from '../store/reducers.js';
import { jobLaunchRequestBodySchema } from '../jobs/launch.js';
import { workflowLifecycleSchema, workflowTerminalLifecycleSchema } from './lifecycle.js';
import { readProjectionJobRows } from '../jobs/projection-row.js';

const TERMINAL_LIFECYCLES: ReadonlySet<string> = new Set(workflowTerminalLifecycleSchema.options);

type WorkflowSlotHead = { jobId: string; sessionId: string; generation: number; terminal: boolean };

function slotChainError(jobId: string, reason: string, context: Record<string, unknown>): CoralSetupError {
  return new CoralSetupError({
    code: 'workflow_slot_chain_invalid',
    userMessage: `Workflow child '${jobId}' violates the durable slot-attempt chain: ${reason}.`,
    remediation: 'Launch exactly generation 0 first, then replace only the current terminal generation.',
    context,
  });
}

export const validateWorkflowJobAuthority: DomainAppendValidator = (ctx, inputs) => {
  const declaredInBatch = new Set(
    inputs.filter((input) => input.type === 'workflow.plan.declared').map((input) => input.stream.id),
  );
  const terminalInBatch = new Map<string, string>();
  const replacementClaims = new Map<string, ReturnType<typeof sessionContinuationLeaseClaimedBodySchema.parse>>();
  const heads = new Map<string, WorkflowSlotHead | null>();

  for (const input of inputs) {
    if (input.type === 'workflow.completed') {
      const body = workflowTerminalLifecycleSchema.parse(
        typeof input.body === 'object' && input.body !== null
          ? (input.body as { outcome?: unknown }).outcome
          : undefined,
      );
      terminalInBatch.set(input.stream.id, body);
    } else if (input.type === 'session.continuation_lease.claimed') {
      const body = sessionContinuationLeaseClaimedBodySchema.parse(input.body);
      replacementClaims.set(body.lease.resumedJobId, body);
    }
  }

  const workflowRow = (workflowId: string): { lifecycle: string } | undefined =>
    ctx.db
      .prepare<[string], { lifecycle: string }>('SELECT lifecycle FROM projection_workflows WHERE workflow_id = ?')
      .get(workflowId);

  const readHead = (workflowId: string, slotId: string): WorkflowSlotHead | null => {
    const key = `${workflowId}\0${slotId}`;
    if (heads.has(key)) return heads.get(key) ?? null;
    const rows = readProjectionJobRows(ctx.db)
      .filter((row) => row.parent_workflow_job_id === workflowId && row.workflow_slot === slotId)
      .sort((left, right) => (left.workflow_slot_generation ?? 0) - (right.workflow_slot_generation ?? 0));
    let expectedGeneration = 0;
    let predecessor: string | null = null;
    let head: WorkflowSlotHead | null = null;
    for (const row of rows) {
      if (row.workflow_slot_generation !== expectedGeneration || row.session_id === null) {
        throw slotChainError(row.job_id, 'stored generations are incomplete or unscoped', {
          workflowId,
          slotId,
          expectedGeneration,
          actualGeneration: row.workflow_slot_generation,
        });
      }
      const launchRow = ctx.db
        .prepare<[string], { type: string; stream_kind: 'job'; body: Uint8Array | Buffer }>(
          `SELECT type, stream_kind, body FROM events
            WHERE stream_id = ? AND type = 'job.launch.requested' LIMIT 1`,
        )
        .get(row.job_id);
      if (launchRow === undefined)
        throw slotChainError(row.job_id, 'projection has no launch event', { workflowId, slotId });
      const launch = decodeBody(launchRow, jobLaunchRequestBodySchema, ctx.readCtx);
      const replaces = launch.jobKind === 'provider' ? launch.replacesWorkflowJobId : undefined;
      if (
        (expectedGeneration === 0 && replaces !== undefined) ||
        (expectedGeneration > 0 && replaces !== predecessor)
      ) {
        throw slotChainError(row.job_id, 'stored predecessor link is invalid', {
          workflowId,
          slotId,
          generation: expectedGeneration,
          expectedPredecessor: predecessor,
          actualPredecessor: replaces,
        });
      }
      head = {
        jobId: row.job_id,
        sessionId: row.session_id,
        generation: expectedGeneration,
        terminal: row.terminal !== null,
      };
      predecessor = row.job_id;
      expectedGeneration += 1;
    }
    heads.set(key, head);
    return head;
  };

  for (const input of inputs) {
    if (input.type !== 'job.launch.requested') continue;
    const launch = jobLaunchRequestBodySchema.parse(input.body);

    if (launch.jobKind === 'workflow') {
      const exists = declaredInBatch.has(input.stream.id) || workflowRow(input.stream.id) !== undefined;
      if (!exists) {
        throw new CoralSetupError({
          code: 'job_owner_missing',
          userMessage: `Workflow owner '${input.stream.id}' does not exist.`,
          remediation: 'Declare the workflow aggregate before launching its workflow job.',
        });
      }
      continue;
    }
    if (launch.jobKind !== 'provider' || launch.owner.kind !== 'workflow') continue;

    const row = declaredInBatch.has(launch.owner.id) ? { lifecycle: 'active' } : workflowRow(launch.owner.id);
    if (row === undefined) {
      throw new CoralSetupError({
        code: 'job_owner_missing',
        userMessage: `Workflow owner '${launch.owner.id}' does not exist.`,
        remediation: 'Declare the workflow aggregate before launching its child job.',
      });
    }
    const storedLifecycle = workflowLifecycleSchema.parse(row.lifecycle);
    const terminalLifecycle = terminalInBatch.get(launch.owner.id);
    if (terminalLifecycle !== undefined || TERMINAL_LIFECYCLES.has(storedLifecycle)) {
      throw new CoralSetupError({
        code: 'workflow_owner_terminal',
        userMessage: `Workflow owner '${launch.owner.id}' is already ${terminalLifecycle ?? storedLifecycle}.`,
        remediation: 'Do not launch child jobs after the workflow reaches a terminal lifecycle.',
        context: {
          workflowId: launch.owner.id,
          lifecycle: terminalLifecycle ?? storedLifecycle,
          requestedJobId: input.stream.id,
        },
      });
    }

    const slotId = input.refs?.workflowSlotId;
    if (slotId === undefined || launch.workflowSlotGeneration === undefined) {
      throw slotChainError(input.stream.id, 'workflow child generation is required', {
        workflowId: launch.owner.id,
        slotId,
      });
    }
    const key = `${launch.owner.id}\0${slotId}`;
    const head = readHead(launch.owner.id, slotId);
    if (head === null) {
      if (
        launch.workflowSlotGeneration !== 0 ||
        launch.replacesWorkflowJobId !== undefined ||
        replacementClaims.has(input.stream.id)
      ) {
        throw slotChainError(input.stream.id, 'first child must be generation 0 without a predecessor', {
          workflowId: launch.owner.id,
          slotId,
          generation: launch.workflowSlotGeneration,
          predecessor: launch.replacesWorkflowJobId,
        });
      }
    } else {
      if (!head.terminal) {
        throw slotChainError(input.stream.id, 'current child is still nonterminal', {
          workflowId: launch.owner.id,
          slotId,
          currentJobId: head.jobId,
        });
      }
      if (
        launch.workflowSlotGeneration !== head.generation + 1 ||
        launch.replacesWorkflowJobId !== head.jobId ||
        launch.sessionId !== head.sessionId
      ) {
        throw slotChainError(input.stream.id, 'replacement generation or predecessor does not match', {
          workflowId: launch.owner.id,
          slotId,
          currentJobId: head.jobId,
          currentGeneration: head.generation,
          generation: launch.workflowSlotGeneration,
          predecessor: launch.replacesWorkflowJobId,
        });
      }
      const claim = replacementClaims.get(input.stream.id);
      if (
        claim === undefined ||
        claim.sessionId !== launch.sessionId ||
        claim.lease.staleJobId !== head.jobId ||
        claim.lease.resumedJobId !== input.stream.id ||
        claim.lease.workflowId !== launch.owner.id ||
        claim.lease.workflowSlotId !== slotId ||
        claim.lease.replacementGeneration !== launch.workflowSlotGeneration
      ) {
        throw slotChainError(input.stream.id, 'replacement has no exact claimed continuation intent', {
          workflowId: launch.owner.id,
          slotId,
          sessionId: launch.sessionId,
          generation: launch.workflowSlotGeneration,
        });
      }
    }
    heads.set(key, {
      jobId: input.stream.id,
      sessionId: launch.sessionId,
      generation: launch.workflowSlotGeneration,
      terminal: false,
    });
  }
};

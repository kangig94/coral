import type { JobProgressStore } from '../../jobs/contracts/job-store.js';
import {
  committedExecutionRequest,
  committedProviderLaunchDecision,
  findCommittedExecutionRequest,
} from '../../jobs/execution-journal.js';
import { isTerminalPhase } from '../../jobs/phase.js';
import { jobInCallerScope } from '../../jobs/scope.js';
import { jobSendAttemptSchema, type JobSendTarget, type JobSendResult } from '../../jobs/send.js';
import type { ProviderJobLaunchDecision } from '../../jobs/launch.js';
import type { InvocationContext } from '../../runtime/invocation-context.js';
import type { CanonicalWorkDir } from '../../runtime/canonical-work-dir.js';
import type { Database } from '../../store/db.js';
import { readProviderOperationForJob } from '../../store/provider-operation-journal.js';
import {
  ProviderProxyOperationControlHeldError,
  type DurableProviderProxyOperationAuthority,
} from '../live/provider-proxy/operation-route.js';
import { providerProxySetIdentityFromRecord, type ProviderProxySetIdentity } from './provider-proxy-set/identity.js';

export interface JobSendRequest {
  readonly projectRoot: CanonicalWorkDir;
  readonly jobId: string;
  readonly input: string;
  readonly clientMessageId: string;
  readonly target: JobSendTarget;
}

export interface JobSendServiceDeps {
  progressStore: Pick<JobProgressStore, 'readStatus' | 'getDb'>;
  currentJobEpochKey(): string;
  resume(request: JobSendRequest, ctx: InvocationContext): Promise<ProviderJobLaunchDecision>;
  authorityFor(
    identity: ProviderProxySetIdentity,
  ): Pick<DurableProviderProxyOperationAuthority, 'sendOperation'> | null;
}

const attempts = new WeakMap<Database, Map<string, Promise<void>>>();
const closedSteer = (): JobSendResult => ({
  state: 'unknown',
  reason:
    'The bound execution has ended or its original operation is unavailable. The original message may have been delivered; it was not sent again.',
});

export class JobSendService {
  private readonly deps: JobSendServiceDeps;

  constructor(deps: JobSendServiceDeps) {
    this.deps = deps;
  }

  async send(request: JobSendRequest, ctx: InvocationContext): Promise<JobSendResult> {
    if (
      !jobSendAttemptSchema.safeParse({
        jobId: request.jobId,
        input: request.input,
        clientMessageId: request.clientMessageId,
        target: request.target,
      }).success
    )
      return {
        state: 'refused',
        code: 'invalid_request',
        reason: 'A valid input, message identity and execution target are required.',
      };
    const db = this.deps.progressStore.getDb();
    let jobs = attempts.get(db);
    if (jobs === undefined) {
      jobs = new Map();
      attempts.set(db, jobs);
    }
    const previous = jobs.get(request.jobId) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    jobs.set(request.jobId, turn);
    await previous;
    try {
      return await this.sendBound(request, ctx);
    } finally {
      release();
      if (jobs.get(request.jobId) === turn) jobs.delete(request.jobId);
    }
  }

  private async sendBound(request: JobSendRequest, ctx: InvocationContext): Promise<JobSendResult> {
    const status = this.deps.progressStore.readStatus(request.jobId);
    if (status === null)
      return request.target.mode === 'steer'
        ? closedSteer()
        : { state: 'refused', code: 'not_found', reason: 'The job was not found.' };
    if (!jobInCallerScope(status, request.projectRoot, 'contains'))
      return { state: 'refused', code: 'scope_mismatch', reason: 'The job belongs to another project.' };
    if (status.jobKind !== 'provider')
      return {
        state: 'refused',
        code: 'transport_unsupported',
        reason: 'The job has no provider turn to receive input.',
      };

    const db = this.deps.progressStore.getDb();
    const epochKey = this.deps.currentJobEpochKey();
    const replay = findCommittedExecutionRequest(db, request.jobId, request.clientMessageId);
    if (replay !== null) {
      if (
        request.target.mode !== 'continue' ||
        replay.request.execution !== request.target.execution + 1 ||
        replay.request.input !== request.input ||
        epochKey !== request.target.sourceEpoch ||
        committedExecutionRequest(db, request.jobId, request.target.execution).requestedSeq !==
          request.target.requestedSeq
      )
        return {
          state: 'refused',
          code: 'continuation_target_changed',
          reason: 'This message identity belongs to a different continuation envelope.',
        };
      const original = committedProviderLaunchDecision(db, replay, epochKey);
      return {
        state: 'launched',
        launch: {
          kind: 'provider-session',
          jobId: request.jobId,
          requestedSeq: original.requestedSeq,
          epochKey,
          launchState: original.status,
        },
      };
    }

    const target = request.target;
    const latest = status.execution === null ? null : committedExecutionRequest(db, request.jobId, status.execution);
    const matches =
      status.execution === target.execution &&
      latest?.requestedSeq === target.requestedSeq &&
      epochKey === target.sourceEpoch;
    const ended = isTerminalPhase(status.phase);
    const admission = !matches || (target.mode === 'continue' && !ended) ? 'refused' : ended ? 'ended' : 'admitted';
    if (target.mode === 'continue') {
      if (admission !== 'ended')
        return {
          state: 'refused',
          code: 'continuation_target_changed',
          reason:
            'The bound predecessor is no longer the latest ended execution. Read job detail before a new send attempt.',
        };
      if (status.owner.kind !== 'provider-session')
        return {
          state: 'refused',
          code: 'transport_unsupported',
          reason: 'Only provider-session owners accept a jobs send continuation.',
        };
      const decision = await this.deps.resume(request, ctx);
      switch (decision.status) {
        case 'running':
        case 'queued':
          return {
            state: 'launched',
            launch: {
              kind: 'provider-session',
              jobId: request.jobId,
              requestedSeq: decision.requestedSeq,
              epochKey: decision.epochKey,
              launchState: decision.status,
            },
          };
        case 'refused':
          return {
            state: 'refused',
            code:
              decision.code === 'continuation_target_changed' || decision.code === 'execution_finishing'
                ? decision.code
                : 'provider_rejected',
            reason: decision.message,
          };
        case 'undetermined':
          return { state: 'unknown', reason: decision.message };
      }
    }
    if (admission !== 'admitted') return closedSteer();
    if (status.finishing === true)
      return {
        state: 'refused',
        code: 'execution_finishing',
        reason:
          'This invocation wrote nothing because the execution is finishing. Any earlier invocation with this message identity may have been delivered.',
      };

    const record = readProviderOperationForJob(db, request.jobId);
    if (
      (record !== null && 'controlIntent' in record && record.controlIntent.kind !== 'run') ||
      (record?.phase === 'prestart-cleanup-pending' && record.afterRelease.kind === 'terminal-aborted') ||
      (record?.phase === 'activation-resolution-pending' && record.onNeverStarted.kind === 'terminal-aborted')
    )
      return { state: 'refused', code: 'job_not_running', reason: 'The job is being stopped.' };
    if (record === null || record.phase !== 'executing')
      return { state: 'refused', code: 'turn_not_started', reason: 'The job turn has not started.' };
    const authority = this.deps.authorityFor(providerProxySetIdentityFromRecord(record));
    if (authority === null)
      return { state: 'refused', code: 'control_unavailable', reason: 'Provider proxy control is unavailable.' };
    try {
      return await authority.sendOperation(record.operation, {
        text: request.input,
        clientMessageId: request.clientMessageId,
      });
    } catch (error: unknown) {
      if (error instanceof ProviderProxyOperationControlHeldError)
        return { state: 'refused', code: 'control_unavailable', reason: error.message };
      throw error;
    }
  }
}

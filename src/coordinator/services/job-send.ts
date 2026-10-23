import type { JobProgressStore } from '../../jobs/contracts/job-store.js';
import {
  type CommittedExecutionRequest,
  committedExecutionRequest,
  committedProviderLaunchDecision,
  findCommittedExecutionRequest,
} from '../../jobs/execution-journal.js';
import { isTerminalPhase } from '../../jobs/phase.js';
import { jobInCallerScope } from '../../jobs/scope.js';
import { jobSendAttemptSchema, missingJobSendRefusal, type JobSendResult } from '../../jobs/send.js';
import { matchesContinuationEnvelope, matchesContinuationTarget, type JobSendTarget } from '../../jobs/send-target.js';
import type { JobLocationView } from '../../jobs/location-index.js';
import type {
  LaunchRefusalCode,
  ProviderJobLaunchDecision,
  AcceptedProviderJobLaunchDecision,
} from '../../jobs/launch.js';
import type { InvocationContext } from '../../runtime/invocation-context.js';
import { canonicalWorkDirWireSchema, type CanonicalWorkDir } from '../../runtime/canonical-work-dir.js';
import { sameEpoch } from '../../store/epoch/identity.js';
import { assertNever } from '../../infra/error-format.js';
import type { JobStatus } from '../../jobs/records.js';
import { readProviderOperationForJob } from '../../store/provider-operation-journal.js';
import type { ProviderOperationRecord } from '../../store/provider-operation-record.js';
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
  attempts: Map<string, Promise<void>>;
  progressStore: Pick<JobProgressStore, 'readStatus' | 'getDb'>;
  jobLocations: Pick<JobLocationView, 'read'>;
  currentJobEpochKey(): string;
  resume(request: JobSendRequest, ctx: InvocationContext): Promise<ProviderJobLaunchDecision>;
  authorityFor(
    identity: ProviderProxySetIdentity,
  ): Pick<DurableProviderProxyOperationAuthority, 'sendOperation'> | null;
}

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
    const validation = jobSendAttemptSchema.safeParse({
      jobId: request.jobId,
      input: request.input,
      clientMessageId: request.clientMessageId,
      target: request.target,
    });
    if (!validation.success)
      return {
        state: 'refused',
        code: 'invalid_request',
        reason: validation.error.issues.map((issue) => issue.message).join('; '),
        invalidFields: [
          ...new Set(
            validation.error.issues.map((issue) => (typeof issue.path[0] === 'string' ? issue.path[0] : 'request')),
          ),
        ],
      };
    const jobs = this.deps.attempts;
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
    if (status === null) {
      const location = this.deps.jobLocations.read(request.jobId);
      if (
        location !== null &&
        !jobInCallerScope(
          {
            jobKind: location.subject.jobKind,
            workDir:
              location.subject.workDir === null ? null : canonicalWorkDirWireSchema.parse(location.subject.workDir),
          },
          request.projectRoot,
          'contains',
        )
      )
        return { state: 'refused', code: 'scope_mismatch', reason: 'The job belongs to another project.' };
      return missingJobSendRefusal(location);
    }
    if (!jobInCallerScope(status, request.projectRoot, 'contains'))
      return { state: 'refused', code: 'scope_mismatch', reason: 'The job belongs to another project.' };
    if (status.jobKind !== 'provider')
      return {
        state: 'refused',
        code: request.target.mode === 'continue' ? 'non_provider_job' : 'transport_unsupported',
        reason: 'The job has no provider turn to receive input.',
      };

    const replay = findCommittedExecutionRequest(
      this.deps.progressStore.getDb(),
      request.jobId,
      request.clientMessageId,
    );
    if (replay !== null) return this.replay(request, replay);
    return request.target.mode === 'continue' ? this.continue(request, status, ctx) : this.steer(request, status);
  }

  private replay(request: JobSendRequest, replay: CommittedExecutionRequest): JobSendResult {
    const db = this.deps.progressStore.getDb();
    const epochKey = this.deps.currentJobEpochKey();
    if (!matchesContinuationEnvelope(db, request, replay, epochKey))
      return {
        state: 'refused',
        code: 'continuation_target_changed',
        reason: 'This message identity belongs to a different continuation envelope.',
      };
    return this.launched(committedProviderLaunchDecision(db, replay, epochKey), replay.request.execution);
  }

  private launched(decision: AcceptedProviderJobLaunchDecision, execution: number): JobSendResult {
    return {
      state: 'launched',
      launch: {
        kind: 'provider-session',
        jobId: decision.jobId,
        execution,
        requestedSeq: decision.requestedSeq,
        epochKey: decision.epochKey,
        launchState: decision.status,
      },
    };
  }

  private async continue(request: JobSendRequest, status: JobStatus, ctx: InvocationContext): Promise<JobSendResult> {
    const refusal = this.validateContinuationTarget(request, status);
    if (refusal !== null) return refusal;
    const decision = await this.deps.resume(request, ctx);
    return this.continuationResult(decision, request.target.execution + 1);
  }

  private validateContinuationTarget(request: JobSendRequest, status: JobStatus): JobSendResult | null {
    const requestedSeq =
      status.execution === null
        ? null
        : committedExecutionRequest(this.deps.progressStore.getDb(), request.jobId, status.execution).requestedSeq;
    if (
      !matchesContinuationTarget(request.target, {
        execution: status.execution,
        open: !isTerminalPhase(status.phase),
        requestedSeq,
        sourceEpoch: this.deps.currentJobEpochKey(),
      })
    )
      return {
        state: 'refused',
        code: 'continuation_target_changed',
        reason:
          'The bound predecessor is no longer the latest ended execution. Read job detail before a new send attempt.',
      };
    if (status.owner.kind !== 'provider-session')
      return {
        state: 'refused',
        code: 'owner_not_provider_session',
        reason: 'Only provider-session owners accept a jobs send continuation.',
      };
    return null;
  }

  private continuationResult(decision: ProviderJobLaunchDecision, execution: number): JobSendResult {
    switch (decision.status) {
      case 'running':
      case 'queued':
        return this.launched(decision, execution);
      case 'refused':
        return { state: 'refused', code: continuationRefusalCodes[decision.code], reason: decision.message };
      case 'undetermined':
        switch (decision.code) {
          case 'continuation_commit_uncertain':
            return { state: 'unknown', reason: decision.message };
          case 'work_directory_unobservable':
          case 'provider_preflight_undetermined':
            return { state: 'refused', code: decision.code, reason: decision.message };
          case 'discuss_launch_undetermined':
            return { state: 'refused', code: 'provider_rejected', reason: decision.message };
          default:
            return assertNever(decision);
        }
    }
  }

  private async steer(request: JobSendRequest, status: JobStatus): Promise<JobSendResult> {
    const refusal = this.validateSteerTarget(request, status);
    if (refusal !== null) return refusal;
    const operation = this.steerableOperation(request.jobId);
    if (operation.state === 'refused') return operation;
    return this.deliverSteer(request, operation.record);
  }

  private validateSteerTarget(request: JobSendRequest, status: JobStatus): JobSendResult | null {
    const db = this.deps.progressStore.getDb();
    if (status.execution === null || request.target.execution > status.execution)
      return { state: 'refused', code: 'execution_superseded', reason: 'The bound execution does not exist.' };
    const targetRequest = committedExecutionRequest(db, request.jobId, request.target.execution);
    if (
      targetRequest.requestedSeq !== request.target.requestedSeq ||
      !sameEpoch(this.deps.currentJobEpochKey(), request.target.sourceEpoch)
    )
      return {
        state: 'refused',
        code: 'execution_superseded',
        reason: 'The bound execution address does not match this job.',
      };
    if (status.execution !== request.target.execution || isTerminalPhase(status.phase)) return closedSteer();
    if (status.finishing === true)
      return {
        state: 'refused',
        code: 'execution_finishing',
        reason:
          'This invocation wrote nothing because the execution is finishing. Any earlier invocation with this message identity may have been delivered.',
      };

    return null;
  }

  private steerableOperation(
    jobId: string,
  ):
    | { state: 'executing'; record: Extract<ProviderOperationRecord, { phase: 'executing' }> }
    | Extract<JobSendResult, { state: 'refused' }> {
    const record = readProviderOperationForJob(this.deps.progressStore.getDb(), jobId);
    if (
      (record !== null && 'controlIntent' in record && record.controlIntent.kind !== 'run') ||
      (record?.phase === 'prestart-cleanup-pending' && record.afterRelease.kind === 'terminal-aborted') ||
      (record?.phase === 'activation-resolution-pending' && record.onNeverStarted.kind === 'terminal-aborted')
    )
      return { state: 'refused', code: 'job_not_running', reason: 'The job is being stopped.' };
    if (record === null || record.phase !== 'executing')
      return { state: 'refused', code: 'turn_not_started', reason: 'The job turn has not started.' };
    return { state: 'executing', record };
  }

  private async deliverSteer(
    request: JobSendRequest,
    record: Extract<ProviderOperationRecord, { phase: 'executing' }>,
  ): Promise<JobSendResult> {
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

const continuationRefusalCodes = {
  execution_finishing: 'execution_finishing',
  continuation_target_changed: 'continuation_target_changed',
  archive_missing: 'archive_missing',
  archive_hash_mismatch: 'archive_hash_mismatch',
  profile_mismatch: 'profile_mismatch',
  work_directory_missing: 'work_directory_missing',
  busy: 'busy',
  succession_admission_paused: 'succession_admission_paused',
  session_busy: 'session_busy',
  native_unobservable: 'native_unobservable',
  archive_invalid: 'archive_invalid',
  provider_preflight_failed: 'provider_preflight_failed',
  session_not_found: 'session_not_found',
  execution_superseded: 'execution_superseded',
  transport_unsupported: 'transport_unsupported',
  scope_mismatch: 'scope_mismatch',
  invalid_request: 'invalid_request',
  retention_discard_in_flight: 'execution_finishing',
  execution_admission_in_flight: 'execution_finishing',
  non_resumable: 'archive_missing',
  archive_stale: 'archive_missing',
  provider_binding_profile_mismatch: 'profile_mismatch',
  provider_binding_subject_mismatch: 'profile_mismatch',
  provider_mismatch: 'provider_rejected',
  unknown_provider: 'provider_rejected',
  invalid_agent: 'provider_rejected',
  agent_not_found: 'provider_rejected',
  agent_namespace_not_found: 'provider_rejected',
  job_launch_duplicate: 'provider_rejected',
  job_owner_mismatch: 'provider_rejected',
  job_owner_missing: 'provider_rejected',
  job_provider_session_missing: 'provider_rejected',
  job_binding_owner_mismatch: 'provider_rejected',
  discussion_job_launch_conflict: 'provider_rejected',
  workflow_owner_terminal: 'provider_rejected',
  workflow_slot_job_conflict: 'provider_rejected',
  workflow_slot_job_mismatch: 'provider_rejected',
  provider_scope_missing: 'provider_rejected',
  provider_execution_environment_invalid: 'provider_rejected',
  publication_failed: 'provider_rejected',
  launch_failed: 'provider_rejected',
  provider_binding_missing_profile: 'profile_mismatch',
  provider_binding_profile_unavailable: 'profile_mismatch',
  provider_binding_identity_unavailable: 'profile_mismatch',
  provider_binding_unsupported_selection: 'profile_mismatch',
  provider_binding_invalid_persisted_binding: 'profile_mismatch',
} satisfies Record<LaunchRefusalCode, Extract<JobSendResult, { state: 'refused' }>['code']>;

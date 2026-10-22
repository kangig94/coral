import type { JobProgressStore } from '../../jobs/contracts/job-store.js';
import { isTerminalPhase } from '../../jobs/phase.js';
import { jobInCallerScope } from '../../jobs/scope.js';
import type { ProxyOperationSendResult } from '../../provider-proxy/protocol.js';
import type { CanonicalWorkDir } from '../../runtime/canonical-work-dir.js';
import { readProviderOperationForJob } from '../../store/provider-operation-journal.js';
import {
  ProviderProxyOperationControlHeldError,
  type DurableProviderProxyOperationAuthority,
} from '../live/provider-proxy/operation-route.js';
import { providerProxySetIdentityFromRecord, type ProviderProxySetIdentity } from './provider-proxy-set/identity.js';

export interface JobSendRequest {
  projectRoot: CanonicalWorkDir;
  jobId: string;
  input: string;
  clientMessageId: string;
}

export interface JobSendServiceDeps {
  progressStore: Pick<JobProgressStore, 'readStatus' | 'getDb'>;
  authorityFor(
    identity: ProviderProxySetIdentity,
  ): Pick<DurableProviderProxyOperationAuthority, 'sendOperation'> | null;
}

export class JobSendService {
  private readonly deps: JobSendServiceDeps;

  constructor(deps: JobSendServiceDeps) {
    this.deps = deps;
  }

  async send(request: JobSendRequest): Promise<ProxyOperationSendResult> {
    const status = this.deps.progressStore.readStatus(request.jobId);
    if (status === null) {
      return { state: 'refused', code: 'not_found', reason: 'The job was not found.' };
    }
    if (!jobInCallerScope(status, request.projectRoot, 'contains')) {
      return { state: 'refused', code: 'scope_mismatch', reason: 'The job belongs to another project.' };
    }
    if (status.jobKind !== 'provider') {
      return {
        state: 'refused',
        code: 'transport_unsupported',
        reason: 'The job has no provider turn to receive input.',
      };
    }
    if (status.finishing || isTerminalPhase(status.phase)) {
      return { state: 'refused', code: 'turn_ended', reason: 'The job turn has ended.' };
    }

    const record = readProviderOperationForJob(this.deps.progressStore.getDb(), request.jobId);
    if (
      (record !== null && 'controlIntent' in record && record.controlIntent.kind !== 'run') ||
      (record?.phase === 'prestart-cleanup-pending' && record.afterRelease.kind === 'terminal-aborted') ||
      (record?.phase === 'activation-resolution-pending' && record.onNeverStarted.kind === 'terminal-aborted')
    ) {
      return { state: 'refused', code: 'job_not_running', reason: 'The job is being stopped.' };
    }
    if (record === null || record.phase !== 'executing') {
      return { state: 'refused', code: 'turn_not_started', reason: 'The job turn has not started.' };
    }

    const authority = this.deps.authorityFor(providerProxySetIdentityFromRecord(record));
    if (authority === null) {
      return { state: 'refused', code: 'control_unavailable', reason: 'Provider proxy control is unavailable.' };
    }
    try {
      return await authority.sendOperation(record.operation, {
        text: request.input,
        clientMessageId: request.clientMessageId,
      });
    } catch (error: unknown) {
      if (error instanceof ProviderProxyOperationControlHeldError) {
        return { state: 'refused', code: 'control_unavailable', reason: error.message };
      }
      throw error;
    }
  }
}

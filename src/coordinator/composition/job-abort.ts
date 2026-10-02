import type {
  AbortAbandonment,
  AbortDecision,
  AbortHold,
  AbortRefusal,
  AbortResult,
} from '../../jobs/contracts/abort-registry.js';
import type { CreateBackendControlDeps } from './job-control.js';

type AbortCollection = {
  pending: Set<string>;
  aborted: string[];
  refused: AbortRefusal[];
  held: AbortHold[];
  abandoned: AbortAbandonment[];
};

function retainAbortOutcome(collection: AbortCollection, result: AbortResult): void {
  const { pending, refused, held, abandoned } = collection;
  for (const refusal of result.refused ?? []) {
    if (!pending.has(refusal.jobId)) continue;
    pending.delete(refusal.jobId);
    refused.push(refusal);
  }
  for (const hold of result.held ?? []) {
    if (!pending.has(hold.jobId)) continue;
    pending.delete(hold.jobId);
    held.push(hold);
  }
  for (const abandonment of result.abandoned ?? []) {
    if (!pending.has(abandonment.jobId)) continue;
    pending.delete(abandonment.jobId);
    abandoned.push(abandonment);
  }
}

export function abortCoordinatorJobs(jobIds: string[], deps: CreateBackendControlDeps): AbortDecision {
  const { world, listExecutionServices, getLifecycleController, internalJobAbortRegistry, requestStops } = deps;
  const collection: AbortCollection = {
    pending: new Set(jobIds),
    aborted: [],
    refused: [],
    held: [],
    abandoned: [],
  };
  const { pending, aborted, refused, held, abandoned } = collection;
  const providerStops = requestStops(jobIds, 'signal_abort');
  if (providerStops.kind === 'admission-closed') {
    if (world.launchCoordinator.successionAdmissionPaused()) {
      return { kind: 'retryable', code: 'succession_admission_paused', jobIds: providerStops.jobIds };
    }
    return { kind: 'successor-owned', jobIds: providerStops.jobIds };
  }
  const recorded = new Set<string>();
  for (const [jobId, outcome] of providerStops.outcomes) {
    if (outcome.kind === 'recorded') {
      recorded.add(jobId);
    } else if (outcome.kind === 'unrecorded') {
      pending.delete(jobId);
      refused.push({
        jobId,
        reason: outcome.reason,
        nextStep:
          "The stop could not be recorded, so this job was not aborted and may still be running. Retry the abort. If the same refusal repeats, this coordinator cannot read the job's provider-operation record.",
      });
    }
  }

  const recoveryRegistry = getLifecycleController()?.getRecoveryRegistry();
  if (recoveryRegistry && recoveryRegistry.size > 0) {
    const registryJobIds: string[] = [];
    for (const jobId of pending) {
      if (recoveryRegistry.has(jobId)) {
        registryJobIds.push(jobId);
      }
    }
    if (registryJobIds.length > 0) {
      const result = recoveryRegistry.abort(registryJobIds);
      for (const jobId of result.aborted) {
        pending.delete(jobId);
        aborted.push(jobId);
      }
      retainAbortOutcome(collection, result);
    }
  }

  for (const service of listExecutionServices()) {
    if (pending.size === 0) break;
    const result = service.abort([...pending]);
    for (const jobId of result.aborted) {
      if (!pending.has(jobId)) continue;

      if (recoveryRegistry !== null && recoveryRegistry !== undefined) {
        recoveryRegistry.markCancelled(jobId);
      }
      pending.delete(jobId);
      aborted.push(jobId);
    }
    retainAbortOutcome(collection, result);
  }

  if (pending.size > 0) {
    const result = internalJobAbortRegistry.abort([...pending]);
    for (const jobId of result.aborted) {
      if (!pending.has(jobId)) continue;
      pending.delete(jobId);
      aborted.push(jobId);
    }
    retainAbortOutcome(collection, result);
  }

  for (const jobId of recorded) {
    if (!pending.delete(jobId)) continue;
    aborted.push(jobId);
  }

  return {
    kind: 'answered',
    result: {
      aborted,
      notFound: [...pending],
      ...(refused.length === 0 ? {} : { refused }),
      ...(held.length === 0 ? {} : { held }),
      ...(abandoned.length === 0 ? {} : { abandoned }),
    },
  };
}

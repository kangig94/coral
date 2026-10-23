import type { JobStatus } from '../../jobs/records.js';
import type { JobAbortRegistryPort, AbortResult } from '../../jobs/contracts/abort-registry.js';

export interface JobAbortServiceDeps {
  abortRegistry: JobAbortRegistryPort;
  readStatus(jobId: string): JobStatus | null;
}

export class JobAbortService {
  private readonly deps: JobAbortServiceDeps;
  constructor(deps: JobAbortServiceDeps) {
    this.deps = deps;
  }

  abort(jobIds: string[]): AbortResult {
    const aborted: string[] = [];
    const notFound: string[] = [];
    const refused: NonNullable<AbortResult['refused']> = [];
    const held: NonNullable<AbortResult['held']> = [];
    const abandoned: NonNullable<AbortResult['abandoned']> = [];

    for (const jobId of jobIds) {
      if (this.deps.readStatus(jobId)?.finishing === true) {
        refused.push({
          jobId,
          reason: 'The execution has accepted its outcome and is finishing.',
          nextStep: { detail: 'Wait for the execution to end.', remedy: { kind: 'wait-job', jobId } },
        });
        continue;
      }
      if (!this.deps.abortRegistry.has(jobId)) {
        notFound.push(jobId);
        continue;
      }

      const result = this.deps.abortRegistry.abort([jobId]);
      aborted.push(...result.aborted);
      notFound.push(...result.notFound);
      refused.push(...(result.refused ?? []));
      held.push(...(result.held ?? []));
      abandoned.push(...(result.abandoned ?? []));
    }

    return {
      aborted,
      notFound,
      ...(refused.length === 0 ? {} : { refused }),
      ...(held.length === 0 ? {} : { held }),
      ...(abandoned.length === 0 ? {} : { abandoned }),
    };
  }
}

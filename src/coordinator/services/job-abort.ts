import type { JobAbortRegistryPort, AbortResult } from '../../jobs/contracts/abort-registry.js';

export interface JobAbortServiceDeps {
  abortRegistry: JobAbortRegistryPort;
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

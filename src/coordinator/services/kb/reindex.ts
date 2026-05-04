import { reindex } from '../../../kb/ops/reindex.js';
import { kbSuccess, type KbToolResult } from '../../../kb/result.js';
import type { KnowledgeBaseRuntime } from '../../../kb/subsystem.js';
import type { JobAbortRegistryPort } from '../../../jobs/contracts/abort-registry.js';
import type { JobProgressStore } from '../../../jobs/contracts/job-store.js';
import type { KbReindexStarted, ReindexResult } from '../../../kb/entry-types.js';
import { throwIfAborted } from '../../../runtime/abort.js';
import type { Runtime } from '../../../runtime/ports.js';
import type { KbSourceImportReadinessWaiter } from './source-import.js';
import { KbOperationJobShell, type KbOperationJobBodyContext, type KbOperationJobContext } from './shell.js';

export interface KbReindexServiceDeps {
  runtime: Pick<Runtime, 'ids' | 'time' | 'storage'>;
  progressStore: JobProgressStore;
  backendNamespace: string;
  bundleHash: string;
  waitForReadiness: KbSourceImportReadinessWaiter;
  abortRegistry: JobAbortRegistryPort;
}

export type KbReindexRequest = {
  async?: boolean;
};

export class KbReindexService {
  private readonly shell: KbOperationJobShell;

  constructor(private readonly deps: KbReindexServiceDeps) {
    this.shell = new KbOperationJobShell(deps);
  }

  run(
    request: KbReindexRequest,
    ctx: { projectRoot: string },
    kbSubsystem: KnowledgeBaseRuntime,
  ): KbToolResult | Promise<KbToolResult> {
    const jobCtx = this.jobContext(ctx);
    if (request.async === true) {
      const { jobId } = this.shell.launchAsync('kb.reindex', jobCtx, (job) => this.runReindex(job, kbSubsystem));
      return kbSuccess({
        status: 'running',
        job: jobId,
      } satisfies KbReindexStarted);
    }

    return this.shell.runSync('kb.reindex', jobCtx, (job) => this.runReindex(job, kbSubsystem));
  }

  private jobContext(ctx: { projectRoot: string }): KbOperationJobContext {
    return {
      projectRoot: ctx.projectRoot,
      request: {},
      failure: {
        code: 'kb_reindex_failed',
        abortedCode: 'kb_reindex_aborted',
        operation: 'reindex',
        message: (cause) => `KB reindex failed: ${cause.message}`,
        detail: (cause) => ({
          operation: 'reindex',
          cause,
        }),
      },
    };
  }

  private async runReindex(
    job: KbOperationJobBodyContext,
    kbSubsystem: KnowledgeBaseRuntime,
  ): Promise<{ data: ReindexResult; terminalContent: string }> {
    const result = await reindex(kbSubsystem.kb, { signal: job.signal });
    if (!('warning' in result)) {
      throwIfAborted(job.signal, 'readiness');
      await this.deps.waitForReadiness({
        kb: kbSubsystem.kb,
        readiness: 'base-search',
        snapshot: kbSubsystem.kb.getCorpusStateSnapshot(),
        signal: job.signal,
      });
    }

    const total = result.notes + result.sources + result.communities + result.wikis + result.principles;
    return {
      data: result,
      terminalContent: `Reindexed ${total} KB entries.\nwikis: ${result.wikis}`,
    };
  }
}

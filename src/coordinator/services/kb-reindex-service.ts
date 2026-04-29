import { reindex } from '../../kb/ops/reindex.js';
import { kbError, kbSuccess, type KbToolResult } from '../../kb/result.js';
import type { KnowledgeBaseRuntime } from '../../kb/subsystem.js';
import type { JobAbortRegistryPort } from '../../jobs/contracts/abort-registry.js';
import type { JobProgressStore } from '../../jobs/contracts/job-store.js';
import type { ReindexResult } from '../../kb/entry-types.js';
import { isUserAbort, throwIfAborted } from '../../runtime/abort.js';
import type { Runtime } from '../../runtime/ports.js';
import type { KbSourceImportReadinessWaiter } from './kb-source-import-service.js';
import { KbJobRecorder, normalizeKbFailureDetail } from './kb-job-recorder.js';

export interface KbReindexServiceDeps {
  runtime: Pick<Runtime, 'ids' | 'time' | 'storage'>;
  progressStore: JobProgressStore;
  backendNamespace: string;
  bundleHash: string;
  waitForReadiness: KbSourceImportReadinessWaiter;
  abortRegistry: JobAbortRegistryPort;
}

type KbReindexRunResult =
  | { ok: true; data: ReindexResult }
  | { ok: false; aborted: true; message: string }
  | { ok: false; aborted?: false; message: string; detail?: unknown };

export class KbReindexService {
  private readonly recorder: KbJobRecorder;

  constructor(private readonly deps: KbReindexServiceDeps) {
    this.recorder = new KbJobRecorder(deps);
  }

  async run(ctx: { projectRoot: string }, kbSubsystem: KnowledgeBaseRuntime): Promise<KbToolResult> {
    const { jobId, startedAtMs, signal, finalize } = this.recorder.startInternalJob({
      projectRoot: ctx.projectRoot,
      operation: 'kb.reindex',
      request: {},
    });

    try {
      const result = await this.runReindex(jobId, ctx.projectRoot, kbSubsystem, startedAtMs, signal);
      if (result.ok) {
        return kbSuccess(result.data);
      }
      if (result.aborted === true) {
        return kbError('kb_reindex_aborted', result.message, { job: jobId });
      }
      return kbError('kb_reindex_failed', result.message, {
        job: jobId,
        ...(result.detail === undefined ? {} : { detail: result.detail }),
      });
    } finally {
      finalize();
    }
  }

  private async runReindex(
    jobId: string,
    projectRoot: string,
    kbSubsystem: KnowledgeBaseRuntime,
    startedAtMs: number,
    signal: AbortSignal,
  ): Promise<KbReindexRunResult> {
    try {
      const result = await reindex(kbSubsystem.kb, { signal });
      if (!('warning' in result)) {
        throwIfAborted(signal, 'readiness');
        await this.deps.waitForReadiness({
          kb: kbSubsystem.kb,
          readiness: 'base-search',
          snapshot: kbSubsystem.kb.getCorpusStateSnapshot(),
          signal,
        });
      }

      // Pre-terminal abort fence — see kb-source-import-service for rationale.
      throwIfAborted(signal, 'finalize');
      const total = result.notes + result.sources + result.communities + result.principles;
      this.recorder.appendCompleted(jobId, startedAtMs, `Reindexed ${total} KB entries.`);
      return { ok: true, data: result };
    } catch (error: unknown) {
      if (isUserAbort(error)) {
        this.recorder.appendAborted(jobId, startedAtMs, 'user_abort');
        return { ok: false, aborted: true, message: error.message };
      }
      const detail = normalizeKbFailureDetail(error);
      this.recorder.appendOperationFailureWithTerminal({
        jobId,
        projectRoot,
        operation: 'reindex',
        message: `KB reindex failed: ${detail.message}`,
        detail: {
          operation: 'reindex',
          cause: detail,
        },
        startedAtMs,
      });
      return {
        ok: false,
        message: detail.message,
        detail,
      };
    }
  }
}

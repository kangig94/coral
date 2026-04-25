import { errorMessage } from '../../infra/error-format.js';
import { nowIsoString } from '../../infra/time.js';
import { reindex } from '../../kb/ops/reindex.js';
import { kbError, kbSuccess, type KbToolResult } from '../../kb/result.js';
import type { KnowledgeBaseRuntime } from '../../kb/subsystem.js';
import type { CauseRef } from '../../causality/cause-ref.js';
import type { TerminalOutcome } from '../../jobs/outcome.js';
import type { JobProgressStore } from '../../jobs/progress-store-contract.js';
import type { ReindexResult } from '../../kb/entry-types.js';
import type { Runtime } from '../../runtime/ports.js';
import type { KbSourceImportReadinessWaiter } from './kb-source-import-service.js';

export interface KbReindexServiceDeps {
  runtime: Pick<Runtime, 'ids' | 'time' | 'storage'>;
  progressStore: JobProgressStore;
  backendNamespace: string;
  bundleHash: string;
  waitForReadiness: KbSourceImportReadinessWaiter;
}

type KbReindexRunResult =
  | { ok: true; data: ReindexResult }
  | { ok: false; message: string; detail?: unknown };

function normalizeErrorDetail(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      message: error.message,
      ...(error.stack === undefined ? {} : { stack: error.stack }),
    };
  }
  return { message: errorMessage(error) };
}

export class KbReindexService {
  constructor(private readonly deps: KbReindexServiceDeps) {}

  async run(ctx: { projectRoot: string }, kbSubsystem: KnowledgeBaseRuntime): Promise<KbToolResult> {
    const jobId = this.deps.runtime.ids.uuid();
    const startedAtMs = this.deps.runtime.time.now();
    const createdAt = nowIsoString(this.deps.runtime.time);

    this.deps.progressStore.appendLaunchRequested(jobId, {
      jobId,
      sessionId: null,
      provider: null,
      projectRoot: ctx.projectRoot,
      backendNamespace: this.deps.backendNamespace,
      bundleHash: this.deps.bundleHash,
      jobKind: 'kb',
      pool: 'default',
      enqueueSequence: this.deps.progressStore.nextEnqueueSequence(),
      operation: 'kb.reindex',
      request: {},
      createdAt,
    });
    this.deps.progressStore.appendRuntimeStarted(jobId, {
      transport: 'internal',
      operation: 'kb.reindex',
      startTime: nowIsoString(this.deps.runtime.time),
    });

    const result = await this.runReindex(jobId, ctx.projectRoot, kbSubsystem, startedAtMs);
    if (result.ok) {
      return kbSuccess(result.data);
    }
    return kbError('kb_reindex_failed', result.message, {
      job: jobId,
      ...(result.detail === undefined ? {} : { detail: result.detail }),
    });
  }

  private async runReindex(
    jobId: string,
    projectRoot: string,
    kbSubsystem: KnowledgeBaseRuntime,
    startedAtMs: number,
  ): Promise<KbReindexRunResult> {
    try {
      const result = await reindex(kbSubsystem.kb);
      if (!('warning' in result)) {
        await this.deps.waitForReadiness({
          kb: kbSubsystem.kb,
          readiness: 'base-search',
          snapshot: kbSubsystem.kb.getCorpusStateSnapshot(),
        });
      }

      const total = result.notes + result.sources + result.communities + result.principles;
      this.appendCompleted(jobId, projectRoot, startedAtMs, `Reindexed ${total} KB entries.`);
      return { ok: true, data: result };
    } catch (error: unknown) {
      const detail = normalizeErrorDetail(error);
      const causeRef = this.appendFailureCause(jobId, projectRoot, detail);
      this.appendFailed(jobId, projectRoot, startedAtMs, causeRef);
      return {
        ok: false,
        message: detail.message,
        detail,
      };
    }
  }

  private appendFailureCause(
    jobId: string,
    projectRoot: string,
    detail: { message: string; stack?: string },
  ): CauseRef {
    const [event] = this.deps.progressStore.appendEventsWithResult([
      {
        type: 'job.progress.emitted',
        stream: { kind: 'job', id: jobId },
        namespace: this.deps.backendNamespace,
        project: projectRoot,
        refs: { jobId },
        bodyVersion: 1,
        body: {
          kind: 'domain',
          stage: 'kb_operation_failed',
          message: `KB reindex failed: ${detail.message}`,
          ts: nowIsoString(this.deps.runtime.time),
          detail: {
            operation: 'reindex',
            cause: detail,
          },
        },
      },
    ]);

    if (event === undefined) {
      throw new Error(`Failed to append KB reindex failure cause for ${jobId}`);
    }

    return {
      stream: { kind: 'job', id: jobId },
      seq: event.seq,
    };
  }

  private appendCompleted(jobId: string, projectRoot: string, startedAtMs: number, content: string): void {
    this.appendTerminal(jobId, projectRoot, startedAtMs, {
      kind: 'completed',
    }, content);
  }

  private appendFailed(jobId: string, projectRoot: string, startedAtMs: number, causeRef: CauseRef): void {
    this.appendTerminal(jobId, projectRoot, startedAtMs, {
      kind: 'failed',
      causeRef,
    }, '');
  }

  private appendTerminal(
    jobId: string,
    projectRoot: string,
    startedAtMs: number,
    outcome: TerminalOutcome,
    content: string,
  ): void {
    this.deps.progressStore.appendEvent({
      type: 'job.terminal.recorded',
      stream: { kind: 'job', id: jobId },
      namespace: this.deps.backendNamespace,
      project: projectRoot,
      refs: { jobId },
      bodyVersion: 1,
      body: {
        terminal: {
          outcome,
          durationMs: Math.max(0, this.deps.runtime.time.now() - startedAtMs),
          content,
        },
      },
    });
  }
}

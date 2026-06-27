import { kbError, kbSuccess, type KbToolResult } from '../../../kb/result.js';
import type { KbJobOperation } from '../../../jobs/launch.js';
import { isUserAbort, throwIfAborted } from '../../../runtime/abort.js';
import {
  KbJobRecorder,
  normalizeKbFailureDetail,
  type KbFailureDetail,
  type KbInternalJobRequest,
  type KbJobRecorderDeps,
} from '../../services/kb/recorder.js';

export interface KbOperationJobRecorderHelpers {
  appendMessage(message: string): void;
}

export interface KbOperationJobBodyContext {
  jobId: string;
  signal: AbortSignal;
  recorder: KbOperationJobRecorderHelpers;
}

export type KbOperationJobBody<T> = (ctx: KbOperationJobBodyContext) => Promise<{
  data: T;
  terminalContent: string;
}>;

export interface KbOperationJobContext {
  projectRoot: string;
  request: KbInternalJobRequest;
  failure: {
    code: string;
    abortedCode: string;
    operation: string;
    message(cause: KbFailureDetail): string;
    detail(cause: KbFailureDetail): unknown;
  };
}

export class KbOperationJobShell {
  private readonly recorder: KbJobRecorder;

  constructor(deps: KbJobRecorderDeps) {
    this.recorder = new KbJobRecorder(deps);
  }

  async runSync<T>(
    operationName: KbJobOperation,
    ctx: KbOperationJobContext,
    body: KbOperationJobBody<T>,
  ): Promise<KbToolResult> {
    const started = this.recorder.startInternalJob({
      projectRoot: ctx.projectRoot,
      operation: operationName,
      request: ctx.request,
    });

    try {
      return await this.runStartedJob(started, ctx, body);
    } finally {
      started.finalize();
    }
  }

  launchAsync<T>(
    operationName: KbJobOperation,
    ctx: KbOperationJobContext,
    body: KbOperationJobBody<T>,
  ): { jobId: string } {
    const started = this.recorder.startInternalJob({
      projectRoot: ctx.projectRoot,
      operation: operationName,
      request: ctx.request,
    });

    void this.runStartedJob(started, ctx, body).finally(started.finalize);
    return { jobId: started.jobId };
  }

  private async runStartedJob<T>(
    started: {
      jobId: string;
      startedAtMs: number;
      signal: AbortSignal;
    },
    ctx: KbOperationJobContext,
    body: KbOperationJobBody<T>,
  ): Promise<KbToolResult> {
    try {
      const result = await body({
        jobId: started.jobId,
        signal: started.signal,
        recorder: {
          appendMessage: (message) => this.recorder.appendMessage(started.jobId, ctx.projectRoot, message),
        },
      });

      throwIfAborted(started.signal, 'finalize');
      this.recorder.appendCompleted(started.jobId, started.startedAtMs, result.terminalContent);
      return kbSuccess(result.data);
    } catch (error: unknown) {
      if (isUserAbort(error)) {
        this.recorder.appendAborted(started.jobId, started.startedAtMs, 'user_abort');
        return kbError(ctx.failure.abortedCode, error.message, { job: started.jobId });
      }

      const cause = normalizeKbFailureDetail(error);
      this.recorder.appendOperationFailureWithTerminal({
        jobId: started.jobId,
        projectRoot: ctx.projectRoot,
        operation: ctx.failure.operation,
        message: ctx.failure.message(cause),
        detail: ctx.failure.detail(cause),
        startedAtMs: started.startedAtMs,
      });
      return kbError(ctx.failure.code, cause.message, { job: started.jobId, detail: cause });
    }
  }
}

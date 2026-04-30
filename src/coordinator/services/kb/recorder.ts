import { errorMessage } from '../../../infra/error-format.js';
import { nowIsoString } from '../../../infra/time.js';
import type { JobAbortRegistryPort } from '../../../jobs/contracts/abort-registry.js';
import type { KbSourceImportJobRequest, KbJobOperation } from '../../../jobs/launch.js';
import type { AbortReason, TerminalOutcome } from '../../../jobs/outcome.js';
import type { JobProgressStore } from '../../../jobs/contracts/job-store.js';
import { appendJobTerminalRecorded, failedTerminalOutcome } from '../../../jobs/terminal/recording.js';
import type { Runtime } from '../../../runtime/ports.js';

export type KbInternalJobRequest = KbSourceImportJobRequest | Record<string, never>;

export type KbFailureDetail = { message: string; stack?: string };

export interface KbJobRecorderDeps {
  runtime: Pick<Runtime, 'ids' | 'time'>;
  progressStore: JobProgressStore;
  backendNamespace: string;
  bundleHash: string;
  abortRegistry: JobAbortRegistryPort;
}

/**
 * Run handle for an internal KB job.
 *
 * `signal` aborts when an operator runs `coral-cli abort <jobId>` — the
 * coordinator-owned `abortRegistry` triggers the registered callback, which
 * calls `controller.abort('user_abort')`. Honor it at named checkpoints in
 * the pipeline.
 *
 * `finalize()` deregisters the controller from `abortRegistry`. Idempotent —
 * call it on terminal record OR on cleanup; safe to call more than once.
 */
export interface StartedKbInternalJob {
  jobId: string;
  startedAtMs: number;
  signal: AbortSignal;
  finalize: () => void;
}

export function normalizeKbFailureDetail(error: unknown): KbFailureDetail {
  if (error instanceof Error) {
    return {
      message: error.message,
      ...(error.stack === undefined ? {} : { stack: error.stack }),
    };
  }
  return { message: errorMessage(error) };
}

export function normalizeHostedKbFailureDetail(detail: unknown): unknown {
  if (detail === undefined) {
    return undefined;
  }
  if (detail instanceof Error) {
    return {
      message: detail.message,
      ...(detail.stack === undefined ? {} : { stack: detail.stack }),
    };
  }

  try {
    return JSON.parse(JSON.stringify(detail)) as unknown;
  } catch {
    return { message: errorMessage(detail) };
  }
}

export class KbJobRecorder {
  constructor(private readonly deps: KbJobRecorderDeps) {}

  startInternalJob(params: {
    projectRoot: string;
    operation: KbJobOperation;
    request: KbInternalJobRequest;
  }): StartedKbInternalJob {
    const jobId = this.deps.runtime.ids.uuid();
    const createdAt = nowIsoString(this.deps.runtime.time);
    const startedAtMs = this.deps.runtime.time.now();

    this.deps.progressStore.appendLaunchRequested(jobId, {
      jobId,
      sessionId: null,
      provider: null,
      projectRoot: params.projectRoot,
      backendNamespace: this.deps.backendNamespace,
      bundleHash: this.deps.bundleHash,
      jobKind: 'kb',
      pool: 'default',
      enqueueSequence: this.deps.progressStore.nextEnqueueSequence(),
      operation: params.operation,
      request: params.request,
      createdAt,
    });
    this.deps.progressStore.appendRuntimeStarted(jobId, {
      transport: 'internal',
      operation: params.operation,
      startTime: nowIsoString(this.deps.runtime.time),
    });

    // The callback owns the `'user_abort'` reason because
    // `AbortRegistry.abort()` calls `controller.abort()` without a reason —
    // setting it here is what lets downstream `AbortError.reason` map to
    // `terminal { outcome: aborted, reason: 'user_abort' }` (Phase 6 / AC9).
    const controller = new AbortController();
    this.deps.abortRegistry.register(jobId, () => controller.abort('user_abort'));

    let finalized = false;
    const finalize = (): void => {
      if (finalized) return;
      finalized = true;
      this.deps.abortRegistry.remove(jobId);
    };

    return { jobId, startedAtMs, signal: controller.signal, finalize };
  }

  appendMessage(jobId: string, projectRoot: string, message: string): void {
    this.deps.progressStore.commit((c) => {
      c.append({
        type: 'job.progress.emitted',
        stream: { kind: 'job', id: jobId },
        namespace: this.deps.backendNamespace,
        project: projectRoot,
        refs: { jobId },
        bodyVersion: 1,
        body: {
          kind: 'message',
          message,
          ts: nowIsoString(this.deps.runtime.time),
        },
      });
      return undefined;
    });
  }

  appendOperationFailureWithTerminal(params: {
    jobId: string;
    projectRoot: string;
    operation: string;
    message: string;
    detail: unknown;
    startedAtMs: number;
  }): void {
    const durationMs = Math.max(0, this.deps.runtime.time.now() - params.startedAtMs);
    const causeEvent = {
      type: 'job.progress.emitted',
      stream: { kind: 'job', id: params.jobId },
      namespace: this.deps.backendNamespace,
      project: params.projectRoot,
      refs: { jobId: params.jobId },
      bodyVersion: 1,
      body: {
        kind: 'domain',
        stage: 'kb_operation_failed',
        message: params.message,
        ts: nowIsoString(this.deps.runtime.time),
        detail: params.detail,
      },
    } as const;

    this.deps.progressStore.commit((c) => {
      const cause = c.append(causeEvent);
      appendJobTerminalRecorded(c, {
        jobId: params.jobId,
        namespace: this.deps.backendNamespace,
        project: params.projectRoot,
        terminal: {
          outcome: failedTerminalOutcome(cause),
          durationMs,
          content: '',
        },
        continuity: null,
      });
      return undefined;
    });
  }

  appendHostedKbOperationFailure(params: {
    jobId: string;
    sessionId: string;
    projectRoot: string;
    namespace: string;
    operation: string;
    code: string;
    message: string;
    detail: unknown;
  }): void {
    this.deps.progressStore.commit((c) => {
      c.append({
        type: 'job.progress.emitted',
        stream: { kind: 'job', id: params.jobId },
        namespace: params.namespace,
        project: params.projectRoot,
        refs: {
          jobId: params.jobId,
          sessionId: params.sessionId,
        },
        bodyVersion: 1,
        body: {
          kind: 'domain',
          stage: 'hosted_kb_operation_failed',
          message: `KB ${params.operation} failed: ${params.message}`,
          ts: nowIsoString(this.deps.runtime.time),
          detail: {
            operation: params.operation,
            code: params.code,
            message: params.message,
            ...(params.detail === undefined ? {} : { detail: params.detail }),
          },
        },
      });
      return undefined;
    });
  }

  appendCompleted(jobId: string, startedAtMs: number, content: string): void {
    this.commitTerminal(jobId, startedAtMs, { kind: 'completed' }, content);
  }

  appendAborted(jobId: string, startedAtMs: number, reason: AbortReason): void {
    this.commitTerminal(jobId, startedAtMs, { kind: 'aborted', reason }, '');
  }

  private commitTerminal(jobId: string, startedAtMs: number, outcome: TerminalOutcome, content: string): void {
    this.deps.progressStore.commit((c) => {
      appendJobTerminalRecorded(c, {
        jobId,
        terminal: {
          outcome,
          durationMs: Math.max(0, this.deps.runtime.time.now() - startedAtMs),
          content,
        },
        continuity: null,
      });
      return undefined;
    });
  }
}

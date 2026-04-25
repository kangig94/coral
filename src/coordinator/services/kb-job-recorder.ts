import { errorMessage } from '../../infra/error-format.js';
import { nowIsoString } from '../../infra/time.js';
import type { CauseRef } from '../../causality/cause-ref.js';
import type { KbSourceImportJobRequest, KbJobOperation } from '../../jobs/launch.js';
import { phaseForOutcome, type TerminalOutcome } from '../../jobs/outcome.js';
import type { JobProgressStore } from '../../jobs/progress-store-contract.js';
import type { Runtime } from '../../runtime/ports.js';

type KbInternalJobRequest = KbSourceImportJobRequest | Record<string, never>;

export type KbFailureDetail = { message: string; stack?: string };

export interface KbJobRecorderDeps {
  runtime: Pick<Runtime, 'ids' | 'time'>;
  progressStore: JobProgressStore;
  backendNamespace: string;
  bundleHash: string;
}

export interface StartedKbInternalJob {
  jobId: string;
  startedAtMs: number;
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

    return { jobId, startedAtMs };
  }

  appendMessage(jobId: string, projectRoot: string, message: string): void {
    this.deps.progressStore.appendEvent({
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
  }

  appendKbOperationFailureCause(params: {
    jobId: string;
    projectRoot: string;
    operation: string;
    message: string;
    detail: unknown;
  }): CauseRef {
    const [event] = this.deps.progressStore.appendEventsWithResult([
      {
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
      },
    ]);

    if (event === undefined) {
      throw new Error(`Failed to append KB operation failure cause for ${params.jobId}`);
    }

    return {
      stream: { kind: 'job', id: params.jobId },
      seq: event.seq,
    };
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
    kbRefs?: Array<{ entryId: string }>;
  }): void {
    this.deps.progressStore.appendEvent({
      type: 'job.progress.emitted',
      stream: { kind: 'job', id: params.jobId },
      namespace: params.namespace,
      project: params.projectRoot,
      refs: {
        jobId: params.jobId,
        sessionId: params.sessionId,
        ...(params.kbRefs === undefined ? {} : { kbRefs: params.kbRefs }),
      },
      bodyVersion: 1,
      body: {
        kind: 'domain',
        stage: 'kb_operation_failed',
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
  }

  appendCompleted(jobId: string, startedAtMs: number, content: string): void {
    this.appendTerminal(jobId, startedAtMs, { kind: 'completed' }, content);
  }

  appendFailed(jobId: string, startedAtMs: number, causeRef: CauseRef): void {
    this.appendTerminal(jobId, startedAtMs, { kind: 'failed', causeRef }, '');
  }

  private appendTerminal(jobId: string, startedAtMs: number, outcome: TerminalOutcome, content: string): void {
    this.deps.progressStore.appendTerminal(
      jobId,
      null,
      {
        outcome,
        durationMs: Math.max(0, this.deps.runtime.time.now() - startedAtMs),
        content,
      },
      phaseForOutcome(outcome),
    );
  }
}

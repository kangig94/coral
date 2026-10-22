import { errorMessage } from '../../infra/error-format.js';
import { nowIsoString } from '../../infra/time.js';
import type { JobAbortRegistryPort } from '../contracts/abort-registry.js';
import type { JobProgressStore } from '../contracts/job-store.js';
import { kbJobLaunchPayloadSchema, type KbSourceImportJobRequest, type KbJobOperation } from '../launch.js';
import type { AbortReason, TerminalOutcome } from '../outcome.js';
import type { InternalJobRuntime, JobLaunch } from '../records.js';
import { buildJobEventRefs } from '../refs.js';
import { appendJobExecutionOutcomeAccepted, failedTerminalOutcome } from '../terminal/recording.js';
import type { ExecutionFinisher } from '../finishing.js';
import type { Runtime } from '../../runtime/ports.js';

export type KbInternalJobRequest = KbSourceImportJobRequest | Record<string, never>;

export type KbFailureDetail = { message: string; stack?: string };

export interface KbJobRecorderDeps {
  executionFinisher: ExecutionFinisher;
  runtime: Pick<Runtime, 'ids' | 'time'>;
  progressStore: JobProgressStore;
  backendNamespace: string;
  bundleHash: string;
  abortRegistry: JobAbortRegistryPort;
  internalJobOwner?: InternalJobRuntime['owner'];
}

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
  private readonly deps: KbJobRecorderDeps;
  constructor(deps: KbJobRecorderDeps) {
    this.deps = deps;
  }

  startInternalJob(params: {
    projectRoot: string;
    operation: KbJobOperation;
    request: KbInternalJobRequest;
  }): StartedKbInternalJob {
    const jobId = this.deps.runtime.ids.uuid();
    const createdAt = nowIsoString(this.deps.runtime.time);
    const startedAtMs = this.deps.runtime.time.now();

    const common = {
      jobId,
      owner: { kind: 'system-task', id: `${params.operation}:${jobId}` },
      conversationJobId: null,
      provider: null,
      projectRoot: params.projectRoot,
      backendNamespace: this.deps.backendNamespace,
      bundleHash: this.deps.bundleHash,
      jobKind: 'kb',
      pool: 'default',
      enqueueSequence: this.deps.progressStore.nextEnqueueSequence(),
      createdAt,
    } as const;
    const payload = kbJobLaunchPayloadSchema.parse({ operation: params.operation, request: params.request });
    const launch: JobLaunch = { ...common, ...payload };
    this.deps.progressStore.appendLaunchRequested(jobId, launch);
    this.deps.progressStore.appendRuntimeStarted(jobId, {
      transport: 'internal',
      operation: params.operation,
      ...(this.deps.internalJobOwner === undefined ? {} : { owner: this.deps.internalJobOwner }),
      startTime: nowIsoString(this.deps.runtime.time),
    });

    // The callback owns the `'user_abort'` reason because
    // `AbortRegistry.abort()` calls `controller.abort()` without a reason —
    // setting it here is what lets downstream `AbortError.reason` map to
    // `terminal { outcome: aborted, reason: 'user_abort' }`.
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

  appendMessage(jobId: string, _projectRoot: string, message: string): void {
    this.deps.progressStore.appendProgress(jobId, null, message);
  }

  async appendOperationFailureWithTerminal(params: {
    jobId: string;
    projectRoot: string;
    operation: string;
    message: string;
    detail: unknown;
    startedAtMs: number;
  }): Promise<void> {
    const durationMs = Math.max(0, this.deps.runtime.time.now() - params.startedAtMs);
    const causeEvent = {
      type: 'job.execution.progress',
      stream: { kind: 'job', id: params.jobId },
      namespace: this.deps.backendNamespace,
      project: params.projectRoot,
      refs: buildJobEventRefs({ jobId: params.jobId }),
      body: {
        execution: 1,
        kind: 'domain',
        stage: 'kb_operation_failed',
        message: params.message,
        detail: params.detail,
      },
    } as const;

    await this.deps.executionFinisher.accept({ jobId: params.jobId, execution: 1 }, (c) => {
      const cause = c.append(causeEvent);
      appendJobExecutionOutcomeAccepted(c, {
        jobId: params.jobId,
        execution: 1,
        namespace: this.deps.backendNamespace,
        project: params.projectRoot,
        terminal: {
          outcome: failedTerminalOutcome(cause),
          durationMs,
          content: '',
        },
      });
      return undefined;
    });
  }

  appendHostedKbOperationFailure(params: {
    jobId: string;
    execution: number;
    conversationJobId: string;
    projectRoot: string;
    namespace: string;
    operation: string;
    code: string;
    message: string;
    detail: unknown;
  }): void {
    this.deps.progressStore.commit((c) => {
      c.append({
        type: 'job.execution.progress',
        stream: { kind: 'job', id: params.jobId },
        namespace: params.namespace,
        project: params.projectRoot,
        refs: buildJobEventRefs({ jobId: params.jobId, }),
        body: {
          execution: params.execution,
          kind: 'domain',
          stage: 'hosted_kb_operation_failed',
          message: `KB ${params.operation} failed: ${params.message}`,
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

  async appendCompleted(jobId: string, startedAtMs: number, content: string): Promise<void> {
    await this.commitTerminal(jobId, startedAtMs, { kind: 'completed' }, content);
  }

  async appendAborted(jobId: string, startedAtMs: number, reason: AbortReason): Promise<void> {
    await this.commitTerminal(jobId, startedAtMs, { kind: 'aborted', reason }, '');
  }

  private async commitTerminal(
    jobId: string,
    startedAtMs: number,
    outcome: TerminalOutcome,
    content: string,
  ): Promise<void> {
    const durationMs = Math.max(0, this.deps.runtime.time.now() - startedAtMs);
    await this.deps.executionFinisher.accept({ jobId, execution: 1 }, (c) => {
      appendJobExecutionOutcomeAccepted(c, { jobId, execution: 1, terminal: { outcome, durationMs, content } });
      return undefined;
    });
  }
}

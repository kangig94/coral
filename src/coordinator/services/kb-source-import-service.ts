import { errorMessage } from '../../infra/error-format.js';
import { isRecord } from '../../infra/json.js';
import { nowIsoString } from '../../infra/time.js';
import { prepareSourceImport } from '../../kb/ops/source-import.js';
import { persistPreparedSource } from '../../kb/ops/source-store.js';
import type { KnowledgeBaseRuntime } from '../../kb/subsystem.js';
import { kbError, kbSuccess, type KbToolResult } from '../../kb/result.js';
import type { KbCorpusSnapshot, KbRuntime } from '../../kb/contracts.js';
import type { Runtime } from '../../runtime/ports.js';
import type { JobProgressStore } from '../../jobs/progress-store-contract.js';
import type { CauseRef, TerminalOutcome } from '../../jobs/outcome.js';
import { sourceImportReadinessValues, type SourceImportReadiness } from '../../jobs/launch.js';

export type KbSourceImportRequest = {
  filePath: string;
  slug?: string;
  readiness: SourceImportReadiness;
  async: boolean;
};

export type KbSourceImportCompleted = {
  status: 'completed';
  job: string;
  readiness: SourceImportReadiness;
  slug: string;
  path: string;
};

export type KbSourceImportStarted = {
  status: 'running' | 'queued';
  job: string;
  readiness: SourceImportReadiness;
};

export type KbSourceImportReadinessWaiter = (params: {
  kb: KbRuntime;
  readiness: SourceImportReadiness;
  snapshot: KbCorpusSnapshot;
}) => Promise<void>;

export interface KbSourceImportServiceDeps {
  runtime: Pick<Runtime, 'ids' | 'time' | 'storage'>;
  progressStore: JobProgressStore;
  backendNamespace: string;
  bundleHash: string;
  waitForReadiness: KbSourceImportReadinessWaiter;
}

type KbSourceImportRunResult =
  | { ok: true; data: KbSourceImportCompleted }
  | { ok: false; message: string; detail?: unknown };

type ParseKbSourceImportRequestResult =
  | { ok: true; data: KbSourceImportRequest }
  | { ok: false; message: string };

const SOURCE_IMPORT_REQUEST_KEYS = new Set(['filePath', 'slug', 'readiness', 'async']);
const SOURCE_IMPORT_READINESS = new Set<string>(sourceImportReadinessValues);

export function parseKbSourceImportRequest(args: Record<string, unknown>): ParseKbSourceImportRequestResult {
  if (!isRecord(args)) {
    return { ok: false, message: 'Expected an object request body.' };
  }

  for (const key of Object.keys(args)) {
    if (!SOURCE_IMPORT_REQUEST_KEYS.has(key)) {
      return { ok: false, message: `Unrecognized key: ${key}` };
    }
  }

  const filePath = args.filePath;
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return { ok: false, message: 'filePath is required.' };
  }

  const slug = args.slug;
  if (slug !== undefined && (typeof slug !== 'string' || slug.length === 0)) {
    return { ok: false, message: 'slug must be a non-empty string when provided.' };
  }

  const readiness = args.readiness ?? 'base-search';
  if (typeof readiness !== 'string' || !SOURCE_IMPORT_READINESS.has(readiness)) {
    return {
      ok: false,
      message: `readiness must be one of: ${sourceImportReadinessValues.join(', ')}.`,
    };
  }

  const async = args.async ?? false;
  if (typeof async !== 'boolean') {
    return { ok: false, message: 'async must be a boolean when provided.' };
  }

  return {
    ok: true,
    data: {
      filePath,
      ...(slug === undefined ? {} : { slug }),
      readiness: readiness as SourceImportReadiness,
      async,
    },
  };
}

function normalizeErrorDetail(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      message: error.message,
      ...(error.stack === undefined ? {} : { stack: error.stack }),
    };
  }
  return { message: errorMessage(error) };
}

export class KbSourceImportService {
  constructor(private readonly deps: KbSourceImportServiceDeps) {}

  start(
    request: KbSourceImportRequest,
    ctx: { projectRoot: string },
    kbSubsystem: KnowledgeBaseRuntime,
  ): KbToolResult | Promise<KbToolResult> {
    const jobId = this.deps.runtime.ids.uuid();
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
      operation: 'kb.source_import',
      request: {
        filePath: request.filePath,
        ...(request.slug === undefined ? {} : { slug: request.slug }),
        readiness: request.readiness,
      },
      createdAt,
    });
    this.deps.progressStore.appendRuntimeStarted(jobId, {
      transport: 'internal',
      operation: 'kb.source_import',
      startTime: nowIsoString(this.deps.runtime.time),
    });

    const run = this.run(jobId, request, ctx, kbSubsystem, this.deps.runtime.time.now());
    if (request.async) {
      void run;
      return kbSuccess({
        status: 'running',
        job: jobId,
        readiness: request.readiness,
      } satisfies KbSourceImportStarted);
    }

    return run.then((result) => {
      if (result.ok) {
        return kbSuccess(result.data);
      }
      return kbError('kb_source_import_failed', result.message, {
        job: jobId,
        ...(result.detail === undefined ? {} : { detail: result.detail }),
      });
    });
  }

  private async run(
    jobId: string,
    request: KbSourceImportRequest,
    ctx: { projectRoot: string },
    kbSubsystem: KnowledgeBaseRuntime,
    startedAtMs: number,
  ): Promise<KbSourceImportRunResult> {
    try {
      const prepared = await prepareSourceImport(
        request.filePath,
        request.slug,
        (line) => this.appendProgress(jobId, ctx.projectRoot, line),
        kbSubsystem.kb.runtimeDir,
      );
      const persisted = await persistPreparedSource(kbSubsystem.kb, prepared.stagedPath, prepared.slug);
      kbSubsystem.curateScheduler.scheduleDeferredCommit();
      const snapshot = kbSubsystem.kb.getCorpusStateSnapshot();
      await this.deps.waitForReadiness({
        kb: kbSubsystem.kb,
        readiness: request.readiness,
        snapshot,
      });

      this.appendCompleted(jobId, ctx.projectRoot, startedAtMs, `Imported: ${persisted.path}`);
      return {
        ok: true,
        data: {
          status: 'completed',
          job: jobId,
          readiness: request.readiness,
          slug: persisted.slug,
          path: persisted.path,
        },
      };
    } catch (error: unknown) {
      const detail = normalizeErrorDetail(error);
      const causeRef = this.appendFailureCause(jobId, ctx.projectRoot, request, detail);
      this.appendFailed(jobId, ctx.projectRoot, startedAtMs, causeRef);
      return {
        ok: false,
        message: detail.message,
        detail,
      };
    }
  }

  private appendProgress(jobId: string, projectRoot: string, message: string): void {
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

  private appendFailureCause(
    jobId: string,
    projectRoot: string,
    request: KbSourceImportRequest,
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
          message: `KB source import failed: ${detail.message}`,
          ts: nowIsoString(this.deps.runtime.time),
          detail: {
            operation: 'source_import',
            filePath: request.filePath,
            readiness: request.readiness,
            cause: detail,
          },
        },
      },
    ]);

    if (event === undefined) {
      throw new Error(`Failed to append KB source import failure cause for ${jobId}`);
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
        outcome,
        durationMs: Math.max(0, this.deps.runtime.time.now() - startedAtMs),
        content,
      },
    });
  }
}

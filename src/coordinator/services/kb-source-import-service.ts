import { isRecord } from '../../infra/json.js';
import { prepareSourceImport } from '../../kb/ops/source-import.js';
import { persistPreparedSource } from '../../kb/ops/source-store.js';
import type { KnowledgeBaseRuntime } from '../../kb/subsystem.js';
import { kbError, kbSuccess, type KbToolResult } from '../../kb/result.js';
import type { KbCorpusSnapshot, KbRuntime } from '../../kb/contracts.js';
import type { Runtime } from '../../runtime/ports.js';
import type { JobProgressStore } from '../../jobs/progress-store-contract.js';
import { sourceImportReadinessValues, type SourceImportReadiness } from '../../jobs/launch.js';
import { KbJobRecorder, normalizeKbFailureDetail } from './kb-job-recorder.js';

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
  runtime: Pick<Runtime, 'ids' | 'time' | 'storage' | 'env' | 'process'>;
  progressStore: JobProgressStore;
  backendNamespace: string;
  bundleHash: string;
  waitForReadiness: KbSourceImportReadinessWaiter;
}

type KbSourceImportRunResult =
  | { ok: true; data: KbSourceImportCompleted }
  | { ok: false; message: string; detail?: unknown };

type ParseKbSourceImportRequestResult = { ok: true; data: KbSourceImportRequest } | { ok: false; message: string };

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

export class KbSourceImportService {
  private readonly recorder: KbJobRecorder;

  constructor(private readonly deps: KbSourceImportServiceDeps) {
    this.recorder = new KbJobRecorder(deps);
  }

  start(
    request: KbSourceImportRequest,
    ctx: { projectRoot: string },
    kbSubsystem: KnowledgeBaseRuntime,
  ): KbToolResult | Promise<KbToolResult> {
    const { jobId, startedAtMs } = this.recorder.startInternalJob({
      projectRoot: ctx.projectRoot,
      operation: 'kb.source_import',
      request: {
        filePath: request.filePath,
        ...(request.slug === undefined ? {} : { slug: request.slug }),
        readiness: request.readiness,
      },
    });

    const run = this.run(jobId, request, ctx, kbSubsystem, startedAtMs);
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
        (line) => this.recorder.appendMessage(jobId, ctx.projectRoot, line),
        kbSubsystem.kb.runtimeDir,
        this.deps.runtime,
      );
      const persisted = await persistPreparedSource(kbSubsystem.kb, prepared.stagedPath, prepared.slug);
      kbSubsystem.curateScheduler.scheduleDeferredCommit();
      const snapshot = kbSubsystem.kb.getCorpusStateSnapshot();
      await this.deps.waitForReadiness({
        kb: kbSubsystem.kb,
        readiness: request.readiness,
        snapshot,
      });

      this.recorder.appendCompleted(jobId, startedAtMs, `Imported: ${persisted.path}`);
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
      const detail = normalizeKbFailureDetail(error);
      const causeRef = this.recorder.appendKbOperationFailureCause({
        jobId,
        projectRoot: ctx.projectRoot,
        operation: 'source_import',
        message: `KB source import failed: ${detail.message}`,
        detail: {
          operation: 'source_import',
          filePath: request.filePath,
          readiness: request.readiness,
          cause: detail,
        },
      });
      this.recorder.appendFailed(jobId, startedAtMs, causeRef);
      return {
        ok: false,
        message: detail.message,
        detail,
      };
    }
  }
}

import { isRecord } from '../../../infra/json.js';
import { hasParentPathSegment, prepareSourceImport, resolveSourceImportFilePath } from '../../../kb/ops/source-import.js';
import { persistPreparedSource } from '../../../kb/ops/source-store.js';
import type { KnowledgeBaseRuntime } from '../../../kb/subsystem.js';
import { kbSuccess, kbValidationError, type KbToolResult } from '../../../kb/result.js';
import type { KbCorpusSnapshot, KbRuntime } from '../../../kb/contract.js';
import { throwIfAborted } from '../../../runtime/abort.js';
import type { Runtime } from '../../../runtime/ports.js';
import type { JobAbortRegistryPort } from '../../../jobs/contracts/abort-registry.js';
import type { JobProgressStore } from '../../../jobs/contracts/job-store.js';
import { sourceImportReadinessValues, type SourceImportReadiness } from '../../../jobs/launch.js';
import { KbOperationJobShell, type KbOperationJobBodyContext, type KbOperationJobContext } from './shell.js';

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
  signal?: AbortSignal;
}) => Promise<void>;

export interface KbSourceImportServiceDeps {
  runtime: Pick<Runtime, 'ids' | 'time' | 'storage' | 'env' | 'process'>;
  progressStore: JobProgressStore;
  backendNamespace: string;
  bundleHash: string;
  waitForReadiness: KbSourceImportReadinessWaiter;
  abortRegistry: JobAbortRegistryPort;
}

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
  if (hasParentPathSegment(filePath)) {
    return { ok: false, message: 'filePath must not contain ".." path segments.' };
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
  private readonly shell: KbOperationJobShell;

  constructor(private readonly deps: KbSourceImportServiceDeps) {
    this.shell = new KbOperationJobShell(deps);
  }

  start(
    request: KbSourceImportRequest,
    ctx: { projectRoot: string },
    kbSubsystem: KnowledgeBaseRuntime,
  ): KbToolResult | Promise<KbToolResult> {
    let resolvedFilePath: string;
    try {
      resolvedFilePath = resolveSourceImportFilePath(request.filePath, ctx.projectRoot, this.deps.runtime.storage);
    } catch (error: unknown) {
      return kbValidationError(error instanceof Error ? error : new Error(String(error)));
    }

    const resolvedRequest: KbSourceImportRequest = {
      ...request,
      filePath: resolvedFilePath,
    };
    const jobCtx = this.jobContext(resolvedRequest, ctx);
    if (request.async) {
      const { jobId } = this.shell.launchAsync('kb.source_import', jobCtx, (job) =>
        this.runImport(job, resolvedRequest, ctx.projectRoot, kbSubsystem),
      );
      return kbSuccess({
        status: 'running',
        job: jobId,
        readiness: resolvedRequest.readiness,
      } satisfies KbSourceImportStarted);
    }

    return this.shell.runSync('kb.source_import', jobCtx, (job) =>
      this.runImport(job, resolvedRequest, ctx.projectRoot, kbSubsystem),
    );
  }

  private jobContext(request: KbSourceImportRequest, ctx: { projectRoot: string }): KbOperationJobContext {
    return {
      projectRoot: ctx.projectRoot,
      request: {
        filePath: request.filePath,
        ...(request.slug === undefined ? {} : { slug: request.slug }),
        readiness: request.readiness,
      },
      failure: {
        code: 'kb_source_import_failed',
        abortedCode: 'kb_source_import_aborted',
        operation: 'source_import',
        message: (cause) => `KB source import failed: ${cause.message}`,
        detail: (cause) => ({
          operation: 'source_import',
          filePath: request.filePath,
          readiness: request.readiness,
          cause,
        }),
      },
    };
  }

  private async runImport(
    job: KbOperationJobBodyContext,
    request: KbSourceImportRequest,
    allowedReadRoot: string,
    kbSubsystem: KnowledgeBaseRuntime,
  ): Promise<{ data: KbSourceImportCompleted; terminalContent: string }> {
    throwIfAborted(job.signal, 'convert');
    const prepared = await prepareSourceImport(
      request.filePath,
      request.slug,
      (line) => job.recorder.appendMessage(line),
      kbSubsystem.kb.runtimeDir,
      this.deps.runtime,
      { signal: job.signal, allowedReadRoot },
    );
    throwIfAborted(job.signal, 'persist');
    const persisted = await persistPreparedSource(kbSubsystem.kb, prepared.stagedPath, prepared.slug, {
      signal: job.signal,
    });
    kbSubsystem.curateScheduler.scheduleDeferredCommit();
    throwIfAborted(job.signal, 'readiness');
    const snapshot = kbSubsystem.kb.getCorpusStateSnapshot();
    await this.deps.waitForReadiness({
      kb: kbSubsystem.kb,
      readiness: request.readiness,
      snapshot,
      signal: job.signal,
    });

    return {
      data: {
        status: 'completed',
        job: job.jobId,
        readiness: request.readiness,
        slug: persisted.slug,
        path: persisted.path,
      },
      terminalContent: `Imported: ${persisted.path}`,
    };
  }
}

import { isRecord } from '../../infra/json.js';
import { prepareSourceImport } from '../../kb/ops/source-import.js';
import { persistPreparedSource } from '../../kb/ops/source-store.js';
import type { KnowledgeBaseRuntime } from '../../kb/subsystem.js';
import { kbError, kbSuccess, type KbToolResult } from '../../kb/result.js';
import type { KbCorpusSnapshot, KbRuntime } from '../../kb/contract.js';
import { isAbortError, throwIfAborted } from '../../runtime/abort.js';
import type { Runtime } from '../../runtime/ports.js';
import type { JobAbortRegistryPort } from '../../jobs/contracts/abort-registry.js';
import type { JobProgressStore } from '../../jobs/contracts/job-store.js';
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

type KbSourceImportRunResult =
  | { ok: true; data: KbSourceImportCompleted }
  | { ok: false; aborted: true; message: string }
  | { ok: false; aborted?: false; message: string; detail?: unknown };

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
    const { jobId, startedAtMs, signal, finalize } = this.recorder.startInternalJob({
      projectRoot: ctx.projectRoot,
      operation: 'kb.source_import',
      request: {
        filePath: request.filePath,
        ...(request.slug === undefined ? {} : { slug: request.slug }),
        readiness: request.readiness,
      },
    });

    const run = this.run(jobId, request, ctx, kbSubsystem, startedAtMs, signal).finally(finalize);
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
      if (result.aborted === true) {
        return kbError('kb_source_import_aborted', result.message, { job: jobId });
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
    signal: AbortSignal,
  ): Promise<KbSourceImportRunResult> {
    try {
      throwIfAborted(signal, 'convert');
      const prepared = await prepareSourceImport(
        request.filePath,
        request.slug,
        (line) => this.recorder.appendMessage(jobId, ctx.projectRoot, line),
        kbSubsystem.kb.runtimeDir,
        this.deps.runtime,
        { signal },
      );
      throwIfAborted(signal, 'persist');
      const persisted = await persistPreparedSource(kbSubsystem.kb, prepared.stagedPath, prepared.slug, { signal });
      kbSubsystem.curateScheduler.scheduleDeferredCommit();
      throwIfAborted(signal, 'readiness');
      const snapshot = kbSubsystem.kb.getCorpusStateSnapshot();
      await this.deps.waitForReadiness({
        kb: kbSubsystem.kb,
        readiness: request.readiness,
        snapshot,
        signal,
      });

      // Pre-terminal abort fence: closes the narrow race where a user
      // `coral-cli abort` lands between `fn` body completion and terminal
      // commit. Without this, the terminal would commit `completed` while
      // `abort` returns `aborted=true`, producing the misleading
      // "aborted but completed" UX.
      throwIfAborted(signal, 'finalize');
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
      if (isUserAbort(error)) {
        this.recorder.appendAborted(jobId, startedAtMs, 'user_abort');
        return { ok: false, aborted: true, message: error.message };
      }
      const detail = normalizeKbFailureDetail(error);
      this.recorder.appendOperationFailureWithTerminal({
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

/**
 * Only `AbortError` whose `reason === 'user_abort'` maps to the user-abort
 * terminal outcome (spec §6.4 / AC9). Mutation-lock deadline aborts surface as
 * `AbortError` with `reason = { kind: 'mutation_deadline', timeoutMs }` and
 * intentionally fall through to the failed-terminal recorder — they never
 * map to `aborted/user_abort`.
 */
function isUserAbort(error: unknown): error is { reason: 'user_abort'; message: string } {
  return isAbortError(error) && error.reason === 'user_abort';
}

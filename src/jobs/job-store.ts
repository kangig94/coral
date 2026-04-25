import type { Database } from 'better-sqlite3';
import { join } from 'node:path';

import { appendEvents as appendJournalEvents, type AppendedEvent, type AppendEventsFn } from '../store/append.js';
import { openStoreDatabase } from '../store/db.js';
import type { CoralEventInput, UpcasterRegistry } from '../store/envelope.js';
import { ensureStoreSchemasDir } from '../store/schema-loader.js';
import { composeReducers, type ComposedReducers } from '../store/reducers.js';
import { listJobProjections, loadJobProjectionDetail, readJobProgress } from './read-queries.js';
import type { Runtime } from '../runtime/ports.js';
import { jobsDir } from "./paths.js";
import { ensureResultMarkdownArtifact } from './terminal/export.js';
import type { DurableProcessExit } from '../runtime/durable-runtime.js';
import { nowDate, nowIsoString } from '../infra/time.js';
import { createNoopJobEventBus, type JobEventBus } from './event-bus.js';
import { jobsRegistry } from './events/index.js';
import { isLivePhase } from './phase.js';
import type { JobPhase } from './phase.js';
import type { InitJobOptions, JobProgressStore, TerminalWriteOptions } from './contracts/progress-store.js';
import {
  normalizeJobTerminal,
  type JobLaunch,
  type JobRuntime,
  type JobStatus,
  type JobTerminal,
  type JobTerminalInput,
} from './records.js';

export type ProgressStoreOptions = {
  eventBus?: JobEventBus;
  db?: Database;
  appendEvents?: AppendEventsFn;
  reducers?: ComposedReducers;
};

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const s = String(seconds).padStart(2, ' ');
  const m = String(minutes).padStart(2, ' ');
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
  }
  return `${m}m ${s}s`;
}

function formatProgressMessage(startedAt: number | undefined, nowMs: number, message: string): string {
  const elapsed = startedAt === undefined ? 0 : nowMs - startedAt;
  return `[${formatElapsed(elapsed)}] ${message}`;
}

function toTerminalPayload(detail: ReturnType<typeof loadJobProjectionDetail>): JobTerminal | null {
  const exit = detail.exit;
  if (!exit) {
    return null;
  }

  return {
    content: exit.content,
    outcome: exit.outcome,
    durationMs: exit.durationMs,
  };
}

export class JobStore implements JobProgressStore {
  private readonly eventBus: JobEventBus;
  private readonly db: Database;
  private readonly appendEvents: AppendEventsFn;
  private readonly namespaceOverrides = new Map<string, { backendNamespace: string; bundleHash?: string }>();
  private readonly jobStartedAt = new Map<string, number>();
  private changeSeq = 0;
  private waiters: Array<() => void> = [];
  private enqueueSequence = 0;

  public readonly schemas: ComposedReducers['schemas'];
  public readonly upcasters: UpcasterRegistry;

  constructor(
    private readonly namespace: string,
    private readonly runtime: Pick<Runtime, 'storage' | 'paths' | 'time'>,
    upcasters: UpcasterRegistry,
    options: ProgressStoreOptions = {},
  ) {
    const { eventBus = createNoopJobEventBus(), db, appendEvents, reducers = composeReducers(jobsRegistry) } = options;

    this.eventBus = eventBus;
    this.schemas = reducers.schemas;
    this.upcasters = upcasters;
    this.db = db ?? this.openDefaultStoreDatabase();
    this.appendEvents =
      appendEvents ??
      ((inputs) => {
        return appendJournalEvents(this.db, inputs, {
          now: () => nowDate(this.runtime.time),
          reducers,
          upcasters: this.upcasters,
        });
      });
  }

  private resolveDefaultDbPath(): string {
    if (this.usesInMemoryStorage()) {
      return ':memory:';
    }
    return this.runtime.paths.coral.store.dbFile;
  }

  private openDefaultStoreDatabase(): Database {
    const path = this.resolveDefaultDbPath();
    try {
      return openStoreDatabase({
        path,
        storage: this.runtime.storage,
        schemasDir: ensureStoreSchemasDir(this.runtime.storage),
      });
    } catch (error: unknown) {
      // The coordinator opens its own store DB and surfaces the same schema
      // error if real-disk state is incompatible — so we can fall back to
      // :memory: here without masking real production bugs. Tests that point a
      // real Runtime at a dev box's stale ~/.coral DB still get a working
      // store rather than a hard failure during ProgressStore construction.
      if (path === ':memory:') {
        throw error;
      }
      return openStoreDatabase({
        path: ':memory:',
        storage: this.runtime.storage,
        schemasDir: ensureStoreSchemasDir(this.runtime.storage),
      });
    }
  }

  private usesInMemoryStorage(): boolean {
    const storage = this.runtime.storage as {
      snapshot?: unknown;
      restore?: unknown;
    };
    return typeof storage.snapshot === 'function' && typeof storage.restore === 'function';
  }

  getNamespace(): string {
    return this.namespace;
  }

  getEventBus(): JobEventBus {
    return this.eventBus;
  }

  getDb(): Database {
    return this.db;
  }

  jobDir(jobId: string): string {
    return join(jobsDir(), jobId);
  }

  getChangeSeq(): number {
    return this.changeSeq;
  }

  waitForChange(sinceSeq: number): Promise<void> {
    if (this.changeSeq !== sinceSeq) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private notifyWaiters(): void {
    this.changeSeq += 1;
    const batch = this.waiters;
    this.waiters = [];
    for (const resolve of batch) {
      resolve();
    }
  }

  private notifyPhaseChange(previous: JobStatus | null, next: JobStatus | null): void {
    if (!previous || !next || previous.phase === next.phase) {
      return;
    }
    this.eventBus.emit('job:phase_changed', {
      jobId: next.jobId,
      phase: next.phase,
      previousPhase: previous.phase,
    });
  }

  private detail(jobId: string) {
    return this.applyNamespaceOverride(loadJobProjectionDetail(this.db, jobId, this), jobId);
  }

  private applyNamespaceOverrideToStatus(jobId: string, status: JobStatus): JobStatus {
    const override = this.namespaceOverrides.get(jobId);
    if (!override) {
      return status;
    }

    return {
      ...status,
      backendNamespace: override.backendNamespace,
      ...(override.bundleHash === undefined ? {} : { bundleHash: override.bundleHash }),
    };
  }

  private applyNamespaceOverride(detail: ReturnType<typeof loadJobProjectionDetail>, jobId: string) {
    const override = this.namespaceOverrides.get(jobId);
    if (!override) {
      return detail;
    }

    return {
      ...detail,
      launch:
        detail.launch === null
          ? null
          : {
              ...detail.launch,
              backendNamespace: override.backendNamespace,
              ...(override.bundleHash === undefined ? {} : { bundleHash: override.bundleHash }),
            },
      status:
        detail.status === null
          ? null
          : {
              ...detail.status,
              backendNamespace: override.backendNamespace,
              ...(override.bundleHash === undefined ? {} : { bundleHash: override.bundleHash }),
            },
    };
  }

  loadJobProjectionDetail(jobId: string) {
    return this.detail(jobId);
  }

  readJobProgress(jobId: string) {
    return readJobProgress(this.db, jobId, this);
  }

  ensureResultArtifact(jobId: string): string {
    return ensureResultMarkdownArtifact(this.db, jobId, this.runtime.storage, this);
  }

  listJobProjections() {
    return listJobProjections(this.db, this).map(({ jobId, status }) => ({
      jobId,
      status: this.applyNamespaceOverrideToStatus(jobId, status),
    }));
  }

  appendEventsWithResult(inputs: readonly CoralEventInput[]): AppendedEvent[] {
    if (inputs.length === 0) {
      return [];
    }

    const previousByJob = new Map<string, JobStatus | null>();
    for (const input of inputs) {
      if (input.stream.kind !== 'job' || previousByJob.has(input.stream.id)) {
        continue;
      }
      previousByJob.set(input.stream.id, this.readStatus(input.stream.id));
    }

    const appended = this.appendEvents(inputs) ?? [];

    for (const event of appended) {
      if (event.stream.kind !== 'job') {
        continue;
      }

      if (event.type === 'job.launch.requested') {
        const body = event.body as {
          sessionId?: string;
          provider?: string;
          projectRoot?: string;
        };
        this.namespaceOverrides.delete(event.stream.id);
        this.eventBus.emit('job:created', {
          jobId: event.stream.id,
          sessionId: body.sessionId ?? '',
          provider: body.provider ?? 'kb',
          projectRoot: body.projectRoot ?? '',
        });
        continue;
      }

      if (event.type === 'job.progress.emitted') {
        const body = event.body as { kind?: string; message?: string };
        if (body.kind === 'message' && typeof body.message === 'string') {
          this.eventBus.emit('job:progress', { jobId: event.stream.id, seq: event.seq, message: body.message });
        }
        continue;
      }

      if (event.type === 'job.terminal.recorded') {
        this.jobStartedAt.delete(event.stream.id);
        const result = this.readTerminalProjection(event.stream.id);
        if (result !== null) {
          this.eventBus.emit('job:completed', { jobId: event.stream.id, result });
        }
      }
    }

    for (const [jobId, previous] of previousByJob) {
      const next = this.readStatus(jobId);
      this.notifyPhaseChange(previous, next);
    }

    this.notifyWaiters();
    return [...appended];
  }

  appendEvent(input: CoralEventInput): void {
    this.appendEventsWithResult([input]);
  }

  initJob(opts: InitJobOptions): void {
    const dir = this.jobDir(opts.jobId);
    this.runtime.storage.mkdirSync(dir, { recursive: true });
    this.jobStartedAt.set(opts.jobId, this.runtime.time.now());
    const createdAt = nowIsoString(this.runtime.time);
    this.appendLaunchRequested(opts.jobId, {
      jobId: opts.jobId,
      sessionId: opts.sessionId,
      provider: opts.provider,
      projectRoot: opts.projectRoot,
      backendNamespace: opts.backendNamespace,
      ...(opts.bundleHash === undefined ? {} : { bundleHash: opts.bundleHash }),
      jobKind: opts.jobKind ?? 'provider',
      pool: 'default',
      enqueueSequence: 0,
      providerAction: 'exec',
      request: {
        prompt: '',
        cwd: opts.projectRoot,
        bypassPermissions: false,
        coralEnv: {},
      },
      createdAt,
    });

    if (opts.initialPhase === 'queued') {
      this.appendEvent({
        type: 'job.queue.queued',
        stream: { kind: 'job', id: opts.jobId },
        namespace: opts.backendNamespace,
        project: opts.projectRoot,
        refs: { jobId: opts.jobId, sessionId: opts.sessionId },
        bodyVersion: 1,
        body: {
          queuePosition: 0,
          runningJobIds: [],
        },
      });
      return;
    }

    if (opts.initialPhase === 'running') {
      this.appendEvent({
        type: 'job.runtime.started',
        stream: { kind: 'job', id: opts.jobId },
        namespace: opts.backendNamespace,
        project: opts.projectRoot,
        refs: { jobId: opts.jobId, sessionId: opts.sessionId },
        bodyVersion: 1,
        body: {
          startedAt: createdAt,
        },
      });
    }
  }

  rollbackJob(jobId: string): void {
    this.purgeFromCache(jobId);
    this.runtime.storage.rmSync(this.jobDir(jobId), { recursive: true, force: true });
    this.notifyWaiters();
  }

  purgeFromCache(jobId: string): void {
    this.namespaceOverrides.delete(jobId);
    this.jobStartedAt.delete(jobId);
  }

  readStatus(jobId: string): JobStatus | null {
    return this.detail(jobId).status;
  }

  nextEnqueueSequence(): number {
    this.enqueueSequence += 1;
    return this.enqueueSequence;
  }

  seedEnqueueSequence(maxRecovered: number): void {
    if (maxRecovered > this.enqueueSequence) {
      this.enqueueSequence = maxRecovered;
    }
  }

  appendLaunchRequested(jobId: string, launch: JobLaunch): void {
    this.runtime.storage.mkdirSync(this.jobDir(jobId), { recursive: true });
    const refs = {
      jobId,
      ...(launch.sessionId !== null && launch.sessionId.length > 0 ? { sessionId: launch.sessionId } : {}),
      ...(launch.parentWorkflowJobId ? { parentJobId: launch.parentWorkflowJobId } : {}),
      ...(launch.workflowSlotId ? { workflowSlotId: launch.workflowSlotId } : {}),
    };
    const body = launch.jobKind === 'kb'
      ? {
          projectRoot: launch.projectRoot,
          backendNamespace: launch.backendNamespace,
          bundleHash: launch.bundleHash,
          jobKind: launch.jobKind,
          pool: launch.pool,
          enqueueSequence: launch.enqueueSequence,
          operation: launch.operation ?? 'kb.source_import',
          request: { ...launch.request },
          createdAt: launch.createdAt,
        }
      : (() => {
          if (launch.sessionId === null || launch.provider === null) {
            throw new Error(`Provider job '${jobId}' requires sessionId and provider.`);
          }
          return {
            sessionId: launch.sessionId,
            provider: launch.provider,
            projectRoot: launch.projectRoot,
            backendNamespace: launch.backendNamespace,
            bundleHash: launch.bundleHash,
            jobKind: launch.jobKind,
            pool: launch.pool,
            enqueueSequence: launch.enqueueSequence,
            providerAction: launch.providerAction ?? 'exec',
            request: {
              ...launch.request,
              prompt: launch.request.prompt ?? '',
              cwd: launch.request.cwd ?? launch.projectRoot,
              bypassPermissions: launch.request.bypassPermissions ?? false,
              coralEnv: { ...(launch.request.coralEnv ?? {}) },
            },
            createdAt: launch.createdAt,
          };
        })();

    this.appendEvent({
      type: 'job.launch.requested',
      stream: { kind: 'job', id: jobId },
      namespace: launch.backendNamespace,
      project: launch.projectRoot,
      refs,
      bodyVersion: 1,
      body,
    });
  }

  readLaunchProjection(jobId: string): JobLaunch | null {
    return this.detail(jobId).launch;
  }

  appendRuntimeStarted(jobId: string, runtime: JobRuntime): void {
    const detail = this.detail(jobId);
    const status = detail.status;
    this.appendEvent({
      type: 'job.runtime.started',
      stream: { kind: 'job', id: jobId },
      namespace: status?.backendNamespace ?? this.namespace,
      project: status?.projectRoot,
      refs: {
        jobId,
        ...(status?.sessionId ? { sessionId: status.sessionId } : {}),
      },
      bodyVersion: 1,
      body:
        runtime.transport === 'internal'
          ? {
              transport: 'internal',
              operation: runtime.operation,
              startedAt: runtime.startTime,
            }
          : runtime.transport === 'app-server'
          ? {
              transport: 'app-server',
              startedAt: runtime.startTime,
              providerMeta: runtime.providerMeta,
            }
          : {
              transport: runtime.transport,
              pid: runtime.pid,
              stdoutPath: runtime.stdoutPath,
              stderrPath: runtime.stderrPath,
              startedAt: runtime.startTime,
              providerMeta: runtime.providerMeta,
              tailWatermark: runtime.tailWatermark,
            },
    });
  }

  readRuntimeProjection(jobId: string): JobRuntime | null {
    return this.detail(jobId).runtime;
  }

  readExitProjection(jobId: string): DurableProcessExit | null {
    const exit = this.detail(jobId).exit;
    if (!exit) {
      return null;
    }
    const processExit = exit.diagnostics.processExit;
    return {
      exitCode: processExit?.exitCode ?? (exit.outcome.kind === 'provider_exit' ? exit.outcome.code : null),
      signal: processExit?.signal ?? null,
      endTime: exit.endTime,
    };
  }

  readTerminalProjection(jobId: string): JobTerminal | null {
    return toTerminalPayload(this.detail(jobId));
  }

  rebindNamespace(jobId: string, newNamespace: string, newBundleHash?: string): void {
    const detail = this.detail(jobId);
    if (detail.launch !== null || detail.status !== null) {
      this.namespaceOverrides.set(jobId, {
        backendNamespace: newNamespace,
        ...(newBundleHash === undefined ? {} : { bundleHash: newBundleHash }),
      });
    }
    this.notifyWaiters();
  }

  listJobIds(): string[] {
    return this.listJobProjections().map(({ jobId }) => jobId);
  }

  liveJobCountByNamespace(namespace: string): number {
    if (!namespace) {
      return 0;
    }

    return (
      this.countProjectedLiveJobsByNamespace(namespace) +
      this.countLiveOverrideJobs((status) => status.backendNamespace === namespace)
    );
  }

  liveJobCount(bundleHash?: string): number {
    return (
      this.countProjectedLiveJobs(bundleHash) +
      this.countLiveOverrideJobs((status) => bundleHash === undefined || status.bundleHash === bundleHash)
    );
  }

  hydrateJobStartedAt(jobId: string, startTime: string): void {
    const ts = Date.parse(startTime);
    if (Number.isFinite(ts)) {
      this.jobStartedAt.set(jobId, ts);
    }
  }

  appendProgress(jobId: string, sessionId: string | null, message: string): number {
    const stamped = formatProgressMessage(this.jobStartedAt.get(jobId), this.runtime.time.now(), message);
    const detail = this.detail(jobId);
    const status = detail.status;
    const [appended] = this.appendEventsWithResult([{
      type: 'job.progress.emitted',
      stream: { kind: 'job', id: jobId },
      namespace: status?.backendNamespace ?? this.namespace,
      project: status?.projectRoot,
      refs: {
        jobId,
        ...(sessionId === null ? {} : { sessionId }),
      },
      bodyVersion: 1,
      body: {
        kind: 'message',
        message: stamped,
        ts: nowIsoString(this.runtime.time),
      },
    }]);
    return appended?.seq ?? 0;
  }

  appendTerminal(
    jobId: string,
    sessionId: string | null,
    result: JobTerminalInput,
    phase: JobPhase,
    options: TerminalWriteOptions = {},
  ): number {
    const detail = this.detail(jobId);
    const status = detail.status;
    const continuity = options.continuity ?? null;
    const terminal = normalizeJobTerminal(result);
    const diagnostics = options.diagnostics;
    const [appended] = this.appendEventsWithResult([{
      type: 'job.terminal.recorded',
      stream: { kind: 'job', id: jobId },
      namespace: status?.backendNamespace ?? this.namespace,
      project: status?.projectRoot,
      refs: {
        jobId,
        ...(sessionId === null ? {} : { sessionId }),
      },
      bodyVersion: 1,
      body: {
        terminal,
        diagnostics,
        continuity,
      },
    }]);
    return appended?.seq ?? 0;
  }

  private countLiveOverrideJobs(predicate: (status: JobStatus) => boolean): number {
    let count = 0;

    for (const jobId of this.namespaceOverrides.keys()) {
      const status = this.detail(jobId).status;
      if (status && isLivePhase(status.phase) && predicate(status)) {
        count += 1;
      }
    }

    return count;
  }

  private countProjectedLiveJobs(bundleHash?: string): number {
    const excludedJobIds = [...this.namespaceOverrides.keys()];
    const phasePlaceholders = ['queued', 'launching', 'running'];
    const clauses = [`phase IN (${phasePlaceholders.map(() => '?').join(', ')})`];
    const params: unknown[] = [...phasePlaceholders];

    if (excludedJobIds.length > 0) {
      clauses.push(`job_id NOT IN (${excludedJobIds.map(() => '?').join(', ')})`);
      params.push(...excludedJobIds);
    }

    if (bundleHash !== undefined) {
      clauses.push(`bundle_hash = ?`);
      params.push(bundleHash);
    }

    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
           FROM projection_jobs
          WHERE ${clauses.join('\n            AND ')}`,
      )
      .get(...params) as { count: number } | undefined;

    return row?.count ?? 0;
  }

  private countProjectedLiveJobsByNamespace(namespace: string): number {
    const excludedJobIds = [...this.namespaceOverrides.keys()];
    const phasePlaceholders = ['queued', 'launching', 'running'];
    const clauses = [`phase IN (${phasePlaceholders.map(() => '?').join(', ')})`, `backend_namespace = ?`];
    const params: unknown[] = [...phasePlaceholders, namespace];

    if (excludedJobIds.length > 0) {
      clauses.push(`job_id NOT IN (${excludedJobIds.map(() => '?').join(', ')})`);
      params.push(...excludedJobIds);
    }

    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
           FROM projection_jobs
          WHERE ${clauses.join('\n            AND ')}`,
      )
      .get(...params) as { count: number } | undefined;

    return row?.count ?? 0;
  }

}

export { JobStore as ProgressStore };

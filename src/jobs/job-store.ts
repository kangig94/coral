import type { Database } from 'better-sqlite3';
import { join } from 'node:path';

import { appendEvents as appendJournalEvents, type AppendedEvent, type AppendEventsFn } from '../store/append.js';
import { openStoreDatabase } from '../store/db.js';
import type { CoralEventInput, UpcasterRegistry } from '../store/envelope.js';
import { ensureStoreSchemasDir } from '../store/schema-loader.js';
import { storePaths } from '../store/paths.js';
import { composeReducers, type ComposedReducers } from '../store/reducers.js';
import { listJobProjections, loadJobProjectionDetail, readJobProgress } from '../store/queries/jobs.js';
import type { Runtime } from '../runtime/ports.js';
import { currentBuildFlavor } from '../infra/paths.js';
import type { DurableProcessExit } from '../runtime/durable-runtime.js';
import { formatElapsed } from '../infra/format-progress.js';
import { nowIsoString } from '../infra/time.js';
import { createNoopJobEventBus, type JobEventBus } from './event-bus.js';
import { jobsRegistry } from './events.js';
import { isLivePhase } from './phase.js';
import type { JobPhase } from './phase.js';
import type { InitJobOptions, JobProgressStore, TerminalWriteOptions } from './progress-store-contract.js';
import {
  cloneJobTerminal,
  normalizeJobTerminal,
  type JobLaunch,
  type JobRuntime,
  type JobStatus,
  type JobTerminal,
  type JobTerminalInput,
  type LaunchState,
} from './records.js';

export type ProgressStoreOptions = {
  eventBus?: JobEventBus;
  db?: Database;
  appendEvents?: AppendEventsFn;
  reducers?: ComposedReducers;
};

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
  private readonly drafts = new Map<string, JobStatus>();
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
          now: () => new Date(this.runtime.time.now()),
          reducers,
          upcasters: this.upcasters,
        });
      });
  }

  private resolveDefaultDbPath(): string {
    if (this.usesInMemoryStorage()) {
      return ':memory:';
    }
    try {
      return this.runtime.paths.coral.store.dbFile;
    } catch {
      return storePaths(currentBuildFlavor()).dbFile;
    }
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
      if (path === ':memory:' || this.isFlavorSettled()) {
        throw error;
      }

      return openStoreDatabase({
        path: ':memory:',
        storage: this.runtime.storage,
        schemasDir: ensureStoreSchemasDir(this.runtime.storage),
      });
    }
  }

  private isFlavorSettled(): boolean {
    try {
      void this.runtime.paths.coral.store.dbFile;
      return true;
    } catch {
      return false;
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
    return join(this.runtime.paths.jobsDir(), jobId);
  }

  resultPath(jobId: string): string {
    return join(this.jobDir(jobId), 'result.md');
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

  private cloneStatusRecord(status: JobStatus): JobStatus {
    return {
      ...status,
      launch: { ...status.launch },
      ...(status.continuity === undefined
        ? {}
        : {
            continuity:
              status.continuity === null
                ? null
                : {
                    ...status.continuity,
                    ...(status.continuity.providerContinuity === undefined
                      ? {}
                      : { providerContinuity: { ...status.continuity.providerContinuity } }),
                  },
          }),
      ...(status.result === undefined
        ? {}
        : {
            result: cloneJobTerminal(status.result),
          }),
    };
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

  private detailWithDraft(jobId: string) {
    const detail = this.detail(jobId);
    if (detail.status !== null) {
      this.drafts.delete(jobId);
      return detail;
    }

    const draft = this.drafts.get(jobId);
    if (!draft) {
      return detail;
    }

    return {
      ...detail,
      status: this.applyNamespaceOverrideToStatus(jobId, this.cloneStatusRecord(draft)),
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
    return this.detailWithDraft(jobId);
  }

  readJobProgress(jobId: string) {
    return readJobProgress(this.db, jobId, this);
  }

  listJobProjections() {
    const projections = new Map<string, JobStatus>();

    for (const { jobId, status } of listJobProjections(this.db, this)) {
      projections.set(jobId, this.applyNamespaceOverrideToStatus(jobId, status));
    }

    for (const [jobId, draft] of this.drafts) {
      if (projections.has(jobId)) {
        continue;
      }
      projections.set(jobId, this.applyNamespaceOverrideToStatus(jobId, this.cloneStatusRecord(draft)));
    }

    return [...projections.entries()].map(([jobId, status]) => ({ jobId, status }));
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

    for (const input of inputs) {
      if (input.type === 'job.launch.requested' && input.stream.kind === 'job') {
        this.drafts.delete(input.stream.id);
        this.namespaceOverrides.delete(input.stream.id);
      }
    }

    for (const event of appended) {
      if (event.stream.kind !== 'job') {
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
        const result = this.readTerminalPayload(event.stream.id);
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
    const phase = opts.initialPhase ?? 'launching';
    const draft: JobStatus = {
      jobId: opts.jobId,
      sessionId: opts.sessionId,
      provider: opts.provider,
      projectRoot: opts.projectRoot,
      backendNamespace: opts.backendNamespace,
      ...(opts.bundleHash === undefined ? {} : { bundleHash: opts.bundleHash }),
      ...(opts.jobKind === undefined ? {} : { jobKind: opts.jobKind }),
      phase,
      launch: {
        state: phase === 'queued' ? 'queued' : 'pending',
        updatedAt: nowIsoString(this.runtime.time),
      },
    };
    this.drafts.set(opts.jobId, draft);
    this.jobStartedAt.set(opts.jobId, this.runtime.time.now());
    this.notifyWaiters();
    this.eventBus.emit('job:created', {
      jobId: opts.jobId,
      sessionId: opts.sessionId,
      provider: opts.provider,
      projectRoot: opts.projectRoot,
    });
  }

  rollbackJob(jobId: string): void {
    this.purgeFromCache(jobId);
    this.runtime.storage.rmSync(this.jobDir(jobId), { recursive: true, force: true });
    this.notifyWaiters();
  }

  purgeFromCache(jobId: string): void {
    this.drafts.delete(jobId);
    this.namespaceOverrides.delete(jobId);
    this.jobStartedAt.delete(jobId);
  }

  readStatus(jobId: string): JobStatus | null {
    const detail = this.detail(jobId);
    if (detail.status) {
      this.drafts.delete(jobId);
      return detail.status;
    }
    return this.drafts.get(jobId) ?? null;
  }

  writeStatus(jobId: string, record: JobStatus): void {
    this.drafts.set(jobId, { ...record });
    this.notifyWaiters();
  }

  updateLaunchState(jobId: string, state: LaunchState, message?: string): void {
    const draft = this.drafts.get(jobId);
    if (!draft) {
      return;
    }
    draft.launch = {
      state,
      message,
      updatedAt: nowIsoString(this.runtime.time),
    };
    this.notifyWaiters();
  }

  updatePhase(jobId: string, phase: JobPhase): void {
    const draft = this.drafts.get(jobId);
    if (!draft) {
      return;
    }
    draft.phase = phase;
    this.notifyWaiters();
  }

  writeResultMd(jobId: string, text: string): void {
    this.runtime.storage.mkdirSync(this.jobDir(jobId), { recursive: true });
    this.runtime.storage.writeAtomicSync(this.resultPath(jobId), text, { encoding: 'utf-8' });
  }

  writeWorkflowResultMdOrThrow(jobId: string, text: string): void {
    this.runtime.storage.mkdirSync(this.jobDir(jobId), { recursive: true });
    if (!this.runtime.storage.writeAtomicSync(this.resultPath(jobId), text, { encoding: 'utf-8' })) {
      throw new Error(`Failed to write workflow result for ${jobId}`);
    }
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

  writeLaunchRecord(jobId: string, record: JobLaunch): void {
    this.runtime.storage.mkdirSync(this.jobDir(jobId), { recursive: true });
    this.appendEvent({
      type: 'job.launch.requested',
      stream: { kind: 'job', id: jobId },
      namespace: record.backendNamespace,
      project: record.projectRoot,
      refs: {
        jobId,
        sessionId: record.sessionId,
        ...(record.parentWorkflowJobId ? { parentJobId: record.parentWorkflowJobId } : {}),
      },
      bodyVersion: 1,
      body: {
        sessionId: record.sessionId,
        provider: record.provider,
        projectRoot: record.projectRoot,
        backendNamespace: record.backendNamespace,
        bundleHash: record.bundleHash,
        jobKind: record.jobKind,
        pool: record.pool,
        enqueueSequence: record.enqueueSequence,
        providerAction: record.providerAction,
        request: {
          ...record.request,
          coralEnv: { ...record.request.coralEnv },
        },
        ...(record.parentWorkflowJobId ? { parentJobId: record.parentWorkflowJobId } : {}),
        createdAt: record.createdAt,
      },
    });
  }

  readLaunchRecord(jobId: string): JobLaunch | null {
    return this.detail(jobId).launch;
  }

  writeRuntimeRecord(jobId: string, record: JobRuntime): void {
    const detail = this.detail(jobId);
    const status = detail.status ?? this.drafts.get(jobId);
    this.appendEvent({
      type: 'job.runtime.started',
      stream: { kind: 'job', id: jobId },
      namespace: status?.backendNamespace ?? this.namespace,
      project: status?.projectRoot,
      refs: {
        jobId,
        ...(status ? { sessionId: status.sessionId } : {}),
      },
      bodyVersion: 1,
      body:
        record.transport === 'app-server'
          ? {
              transport: 'app-server',
              startedAt: record.startTime,
              providerMeta: record.providerMeta,
            }
          : {
              transport: record.transport,
              pid: record.pid,
              stdoutPath: record.stdoutPath,
              stderrPath: record.stderrPath,
              startedAt: record.startTime,
              providerMeta: record.providerMeta,
              tailWatermark: record.tailWatermark,
            },
    });
  }

  readRuntimeRecord(jobId: string): JobRuntime | null {
    return this.detail(jobId).runtime;
  }

  readExitRecord(jobId: string): DurableProcessExit | null {
    const exit = this.detail(jobId).exit;
    if (!exit) {
      return null;
    }
    return {
      exitCode: exit.exitCode ?? null,
      signal: exit.signal ?? null,
      endTime: exit.endTime,
    };
  }

  readTerminalPayload(jobId: string): JobTerminal | null {
    return toTerminalPayload(this.detail(jobId));
  }

  rebindNamespace(jobId: string, newNamespace: string, newBundleHash?: string): void {
    const draft = this.drafts.get(jobId);
    if (draft) {
      draft.backendNamespace = newNamespace;
      if (newBundleHash !== undefined) {
        draft.bundleHash = newBundleHash;
      }
    }
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
    const ids = new Set<string>(this.drafts.keys());
    for (const { jobId } of this.listJobProjections()) {
      ids.add(jobId);
    }
    return [...ids];
  }

  liveJobCountByNamespace(namespace: string): number {
    if (!namespace) {
      return 0;
    }

    return (
      this.countProjectedLiveJobsByNamespace(namespace) +
      this.countLiveOverrideJobs((status) => status.backendNamespace === namespace) +
      this.countLiveDraftJobs((status) => status.backendNamespace === namespace)
    );
  }

  liveJobCount(bundleHash?: string): number {
    return (
      this.countProjectedLiveJobs(bundleHash) +
      this.countLiveOverrideJobs((status) => bundleHash === undefined || status.bundleHash === bundleHash) +
      this.countLiveDraftJobs((status) => bundleHash === undefined || status.bundleHash === bundleHash)
    );
  }

  hydrateJobStartedAt(jobId: string, startTime: string): void {
    const ts = Date.parse(startTime);
    if (Number.isFinite(ts)) {
      this.jobStartedAt.set(jobId, ts);
    }
  }

  hasLaunchRecord(jobId: string): boolean {
    return this.readLaunchRecord(jobId) !== null;
  }

  hasRuntimeRecord(jobId: string): boolean {
    return this.readRuntimeRecord(jobId) !== null;
  }

  hasExitRecord(jobId: string): boolean {
    return this.readExitRecord(jobId) !== null;
  }

  appendProgress(jobId: string, sessionId: string, message: string): number {
    const stamped = formatProgressMessage(this.jobStartedAt.get(jobId), this.runtime.time.now(), message);
    const detail = this.detail(jobId);
    const status = detail.status ?? this.drafts.get(jobId);
    const [appended] = this.appendEventsWithResult([{
      type: 'job.progress.emitted',
      stream: { kind: 'job', id: jobId },
      namespace: status?.backendNamespace ?? this.namespace,
      project: status?.projectRoot,
      refs: {
        jobId,
        sessionId,
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
    sessionId: string,
    result: JobTerminalInput,
    phase: JobPhase,
    options: TerminalWriteOptions = {},
  ): number {
    const detail = this.detail(jobId);
    const hasLaunchProjection = detail.launch !== null;
    const status = detail.status ?? this.drafts.get(jobId);
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
        sessionId,
      },
      bodyVersion: 1,
      body: {
        outcome: terminal.outcome,
        durationMs: terminal.durationMs,
        content: terminal.content,
        exitCode: options.exitCode,
        signal: options.signal,
        warnings: diagnostics?.warnings,
        usage: diagnostics?.usage,
        workflow: diagnostics?.workflow,
        continuity,
        ...(terminal.outcome.kind === 'provider_exit'
          ? {
              code: terminal.outcome.code,
              note: terminal.outcome.note,
            }
          : {}),
      },
    }]);
    if (!hasLaunchProjection) {
      const draft = this.drafts.get(jobId);
      if (draft) {
        const previousPhase = draft.phase;
        draft.phase = phase;
        draft.result = cloneJobTerminal(terminal);
        draft.continuity =
          continuity === null
            ? null
            : {
                ...continuity,
                ...(continuity.providerContinuity === undefined
                  ? {}
                  : { providerContinuity: { ...continuity.providerContinuity } }),
              };
        draft.launch = {
          state: phase === 'completed' ? 'ready' : 'error',
          updatedAt: nowIsoString(this.runtime.time),
        };
        this.notifyWaiters();
        if (previousPhase !== draft.phase) {
          this.eventBus.emit('job:phase_changed', {
            jobId,
            phase: draft.phase,
            previousPhase,
          });
        }
      }
    }
    return appended?.seq ?? 0;
  }

  markTerminalStatus(
    jobId: string,
    result: JobTerminalInput,
    phase: JobPhase,
    options: TerminalWriteOptions = {},
  ): void {
    this.appendTerminal(jobId, this.readStatus(jobId)?.sessionId ?? '', result, phase, options);
  }

  private countLiveDraftJobs(predicate: (status: JobStatus) => boolean): number {
    let count = 0;

    for (const draft of this.drafts.values()) {
      if (isLivePhase(draft.phase) && predicate(draft)) {
        count += 1;
      }
    }

    return count;
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

import type { Database } from 'better-sqlite3';
import { join } from 'node:path';

import { TypedEventBus } from '../coordinator/control.js';
import { appendEvents as appendJournalEvents, type AppendEventsFn } from '../store/append.js';
import { openStoreDatabase } from '../store/db.js';
import { createEmptyRegistry } from '../store/envelope.js';
import type { CoralEventInput } from '../store/envelope.js';
import { composeReducers } from '../store/reducers.js';
import { listJobProjections, loadJobProjectionDetail, readJobProgress } from '../store/queries/jobs.js';
import type { Runtime } from '../runtime/ports.js';
import type { JobExitRecord } from '../runtime/durable-runtime.js';
import { formatElapsed } from '../shared/format-progress.js';
import { nowIsoString } from '../shared/utils.js';
import { discussRegistry } from '../discuss/store-registry.js';
import { sessionsRegistry } from '../sessions/events.js';
import { workflowRegistry } from '../workflow/events.js';
import { jobsRegistry } from './events.js';
import { isLivePhase } from './phase.js';
import type { JobPhase } from './phase.js';
import { readBackendNamespace } from './records.js';
import type {
  JobKind,
  JobLaunchRecord,
  JobProgressRecord,
  JobRuntimeRecord,
  JobStatusRecord,
  JobTerminalRecord,
  LaunchState,
} from './records.js';

export type ReplayCursor = {
  lastEventId: number;
};

export type InitJobOptions = {
  jobId: string;
  sessionId: string;
  provider: string;
  projectRoot: string;
  backendNamespace: string;
  bundleHash?: string;
  jobKind?: JobKind;
  initialPhase?: JobPhase;
};

export function createReplayCursor(): ReplayCursor {
  return { lastEventId: 0 };
}

function formatProgressMessage(startedAt: number | undefined, nowMs: number, message: string): string {
  const elapsed = startedAt === undefined ? 0 : nowMs - startedAt;
  return `[${formatElapsed(elapsed)}] ${message}`;
}

function toTerminalPayload(detail: ReturnType<typeof loadJobProjectionDetail>): JobTerminalRecord | null {
  const exit = detail.exit;
  if (!exit) {
    return null;
  }

  return {
    content: exit.content,
    outcome: exit.outcome,
    ...(exit.durationMs === undefined ? {} : { durationMs: exit.durationMs }),
    ...(exit.exitCode === undefined ? {} : { exitCode: exit.exitCode }),
    ...(exit.nonResumable === undefined ? {} : { nonResumable: exit.nonResumable }),
    ...(exit.warnings === undefined ? {} : { warnings: [...exit.warnings] }),
    ...(exit.usage === undefined ? {} : { usage: { ...exit.usage } }),
    ...(exit.workflow === undefined
      ? {}
      : {
          workflow: {
            steps: exit.workflow.steps.map((step) => ({ ...step })),
          },
        }),
  };
}

export class JobStore {
  private readonly eventBus: TypedEventBus;
  private readonly db: Database;
  private readonly appendEvents: AppendEventsFn;
  private readonly drafts = new Map<string, JobStatusRecord>();
  private readonly namespaceOverrides = new Map<string, { backendNamespace: string; bundleHash?: string }>();
  private readonly progressEventCounters = new Map<string, number>();
  private readonly jobStartedAt = new Map<string, number>();
  private changeSeq = 0;
  private waiters: Array<() => void> = [];
  private enqueueSequence = 0;

  constructor(
    private readonly namespace: string,
    private readonly runtime: Pick<Runtime, 'storage' | 'paths' | 'time'>,
    eventBus: TypedEventBus = new TypedEventBus(),
    db?: Database,
    appendEvents?: AppendEventsFn,
  ) {
    this.eventBus = eventBus;
    this.db = db ?? openStoreDatabase({
      path: this.resolveDefaultDbPath(),
      storage: this.runtime.storage,
    });
    this.appendEvents =
      appendEvents ??
      ((inputs) => {
        appendJournalEvents(this.db, inputs, {
          now: () => new Date(this.runtime.time.now()),
          reducers: composeReducers(jobsRegistry, sessionsRegistry, discussRegistry, workflowRegistry),
          upcasters: createEmptyRegistry(),
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
      return ':memory:';
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

  getEventBus(): TypedEventBus {
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

  private notifyPhaseChange(previous: JobStatusRecord | null, next: JobStatusRecord | null): void {
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
    return this.applyNamespaceOverride(loadJobProjectionDetail(this.db, jobId), jobId);
  }

  private cloneStatusRecord(status: JobStatusRecord): JobStatusRecord {
    return {
      ...status,
      launch: { ...status.launch },
      ...(status.result === undefined
        ? {}
        : {
            result: {
              ...status.result,
              ...(status.result.warnings === undefined ? {} : { warnings: [...status.result.warnings] }),
              ...(status.result.usage === undefined ? {} : { usage: { ...status.result.usage } }),
              ...(status.result.workflow === undefined
                ? {}
                : {
                    workflow: {
                      steps: status.result.workflow.steps.map((step) => ({ ...step })),
                    },
                  }),
            },
          }),
    };
  }

  private applyNamespaceOverrideToStatus(jobId: string, status: JobStatusRecord): JobStatusRecord {
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
    return readJobProgress(this.db, jobId);
  }

  listJobProjections() {
    const projections = new Map<string, JobStatusRecord>();

    for (const { jobId, status } of listJobProjections(this.db)) {
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

  appendEvent(input: CoralEventInput): void {
    if (input.stream.kind !== 'job') {
      this.appendEvents([input]);
      return;
    }

    const jobId = input.stream.id;
    const previous = this.readStatus(jobId);
    this.appendEvents([input]);
    if (input.type === 'job.launch.requested') {
      this.drafts.delete(jobId);
      this.namespaceOverrides.delete(jobId);
    }

    const next = this.readStatus(jobId);
    this.notifyWaiters();
    this.notifyPhaseChange(previous, next);

    if (input.type === 'job.progress.emitted') {
      const body = input.body as { kind?: string; message?: string };
      if (body.kind === 'message' && typeof body.message === 'string') {
        const eventId = this.readProgressTail(jobId);
        this.progressEventCounters.set(jobId, eventId);
        this.eventBus.emit('job:progress', { jobId, eventId, message: body.message });
      }
      return;
    }

    if (input.type === 'job.terminal.recorded') {
      this.progressEventCounters.delete(jobId);
      this.jobStartedAt.delete(jobId);
      const result = this.readTerminalPayload(jobId);
      if (result !== null) {
        this.eventBus.emit('job:completed', { jobId, result });
      }
    }
  }

  initJob(opts: InitJobOptions): void {
    const dir = this.jobDir(opts.jobId);
    this.runtime.storage.mkdirSync(dir, { recursive: true });
    const phase = opts.initialPhase ?? 'launching';
    const draft: JobStatusRecord = {
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
    this.progressEventCounters.delete(jobId);
    this.jobStartedAt.delete(jobId);
  }

  readStatus(jobId: string): JobStatusRecord | null {
    const detail = this.detail(jobId);
    if (detail.status) {
      this.drafts.delete(jobId);
      return detail.status;
    }
    return this.drafts.get(jobId) ?? null;
  }

  writeStatus(jobId: string, record: JobStatusRecord): void {
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

  writeLaunchRecord(jobId: string, record: JobLaunchRecord): void {
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

  readLaunchRecord(jobId: string): JobLaunchRecord | null {
    return this.detail(jobId).launch as JobLaunchRecord | null;
  }

  writeRuntimeRecord(jobId: string, record: JobRuntimeRecord): void {
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

  readRuntimeRecord(jobId: string): JobRuntimeRecord | null {
    return this.detail(jobId).runtime as JobRuntimeRecord | null;
  }

  writeExitRecord(_jobId: string, _record: JobExitRecord): void {
    // Journal authority derives terminal state from job.terminal.recorded events.
  }

  readExitRecord(jobId: string): JobExitRecord | null {
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

  readTerminalPayload(jobId: string): JobTerminalRecord | null {
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
    return this.listJobProjections().filter(({ status }) => {
      return isLivePhase(status.phase) && readBackendNamespace(status) === namespace;
    }).length;
  }

  liveJobCount(bundleHash?: string): number {
    return this.listJobProjections().filter(({ status }) => {
      return isLivePhase(status.phase) && (bundleHash === undefined || status.bundleHash === bundleHash);
    }).length;
  }

  hydrateEventCounter(jobId: string): void {
    const history = readJobProgress(this.db, jobId);
    const maxEventId = history.reduce((max, event) => Math.max(max, event.eventId), 0);
    if (maxEventId > 0) {
      this.progressEventCounters.set(jobId, maxEventId);
    }
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
    this.appendEvent({
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
    });
    return this.progressEventCounters.get(jobId) ?? this.readProgressTail(jobId);
  }

  appendTerminal(jobId: string, sessionId: string, result: JobTerminalRecord, _phase: JobPhase): number {
    const hasLaunchProjection = this.detail(jobId).launch !== null;
    const detail = this.detail(jobId);
    const status = detail.status ?? this.drafts.get(jobId);
    this.appendEvent({
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
        outcome: result.outcome,
        durationMs: result.durationMs ?? 0,
        content: result.content,
        exitCode: result.exitCode,
        warnings: result.warnings,
        usage: result.usage,
        workflow: result.workflow,
        nonResumable: result.nonResumable,
        ...(result.outcome.kind === 'provider_exit'
          ? {
              code: result.outcome.code,
              note: result.outcome.note,
            }
          : {}),
      },
    });
    if (!hasLaunchProjection) {
      const draft = this.drafts.get(jobId);
      if (draft) {
        const previousPhase = draft.phase;
        draft.phase = _phase;
        draft.result = {
          ...result,
          ...(result.workflow === undefined
            ? {}
            : {
                workflow: {
                  steps: result.workflow.steps.map((step) => ({ ...step })),
                },
              }),
        };
        draft.launch = {
          state: _phase === 'completed' ? 'ready' : 'error',
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
    return this.readProgressTail(jobId);
  }

  markTerminalStatus(jobId: string, result: JobTerminalRecord, phase: JobPhase): void {
    this.appendTerminal(jobId, this.readStatus(jobId)?.sessionId ?? '', result, phase);
  }

  replayFrom(jobId: string, fromEventId: number, cursor: ReplayCursor): JobProgressRecord[] {
    const floor = Math.max(fromEventId, cursor.lastEventId);
    const events = this.readJobProgress(jobId).filter((event) => event.eventId > floor);
    if (events.length > 0) {
      cursor.lastEventId = events[events.length - 1].eventId;
    }
    return events as JobProgressRecord[];
  }

  private readProgressTail(jobId: string): number {
    return this.readJobProgress(jobId).reduce((max, event) => Math.max(max, event.eventId), 0);
  }
}

export { JobStore as ProgressStore };

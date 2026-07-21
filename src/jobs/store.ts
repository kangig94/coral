import type { Database } from '../store/db.js';
import { join } from 'node:path';

import type { CauseRefToken } from '../causality/cause-ref.js';
import type { ProviderLookupPort } from '../providers/catalog.js';
import {
  commit as commitJournalEvents,
  type AppendedEvent,
  type CommitAppendInput,
  type CommitClosureResult,
  type CommitContext,
  type CommitEventsFn,
  type PostCommitObserver,
} from '../store/append.js';
import type { ResolvableCoralEventInput } from '../store/envelope.js';
import type { EventBodyCodec } from '../store/event-body-codec.js';
import { composeReducers, type ComposedReducers } from '../store/reducers.js';
import { listJobProjections, loadJobProjectionDetail, readJobEvents } from './read-queries.js';
import type { Runtime } from '../runtime/ports.js';
import { jobsDir } from './paths.js';
import { ensureResultMarkdownArtifact } from './terminal/export.js';
import type { DurableProcessExit } from '../runtime/durable-runtime.js';
import { nowDate, nowIsoString } from '../infra/time.js';
import { createNoopJobEventBus, jobCreatedEvent, type JobEventBus } from './event-bus.js';
import { jobLaunchRequestBodySchema } from './launch.js';
import { jobsRegistry } from './events.js';
import { isLivePhase } from './phase.js';
import type { InitJobOptions, JobProgressStore } from './contracts/job-store.js';
import type { JobProgressTiming, JobRuntimeStartedBody } from './event-bodies.js';
import { type JobLaunch, type JobRuntime, type JobStatus, type JobTerminal } from './records.js';
import { progressTimingFromProjection } from './progress-timing.js';
import { buildJobEventRefs } from './refs.js';

export type JobStoreOptions = {
  eventBus?: JobEventBus;
  db: Database;
  reducers?: ComposedReducers;
  /**
   * Required. JobStore composes `AppendContext.providers` from this port,
   * which is now mandatory at the append boundary (see `store/append.ts`).
   * Production composition supplies `providerLookupPortFromCatalog(...)`;
   * tests that don't exercise provider validation may use
   * `permissiveProviderLookupPort` from `tests/helpers/append-context.ts`.
   */
  providers: ProviderLookupPort;
  observer?: PostCommitObserver;
};

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

function jobRuntimeStartedBody(runtime: JobRuntime): JobRuntimeStartedBody {
  if (runtime.transport === 'internal') {
    return {
      transport: 'internal',
      operation: runtime.operation,
      ...(runtime.owner === undefined ? {} : { owner: runtime.owner }),
      startedAt: runtime.startTime,
    };
  }

  if (runtime.transport === 'app-server') {
    return {
      transport: 'app-server',
      startedAt: runtime.startTime,
      providerMeta: runtime.providerMeta,
    };
  }

  if (runtime.transport === 'workflow') {
    return {
      transport: 'workflow',
      startedAt: runtime.startTime,
    };
  }

  return {
    transport: runtime.transport,
    pid: runtime.pid,
    stdoutPath: runtime.stdoutPath,
    stderrPath: runtime.stderrPath,
    startedAt: runtime.startTime,
    tailWatermark: runtime.tailWatermark,
  };
}

export function jobLaunchRequestedEvent(jobId: string, launch: JobLaunch) {
  // Spec §6.1 line 813 + §13.1 worked example: every job whose lifetime
  // belongs to a workflow carries `refs.workflowId` (the workflow stream
  // that owns the plan). Convention: `workflowJobId === workflowId` — the
  // workflow's own job IS its workflow stream, so its launch carries
  // `refs.workflowId = jobId`. Workflow children carry
  // `refs.workflowId = parentWorkflowJobId` plus `refs.parentJobId` and
  // `refs.workflowSlotId`. Non-workflow jobs omit the field.
  const workflowId = launch.jobKind === 'workflow' ? jobId : launch.parentWorkflowJobId;
  const refs = buildJobEventRefs({
    jobId,
    sessionId: launch.sessionId,
    parentJobId: launch.parentWorkflowJobId,
    workflowId,
    workflowSlotId: launch.workflowSlotId,
  });
  const body =
    launch.jobKind === 'kb'
      ? {
          owner: launch.owner,
          projectRoot: launch.projectRoot,
          backendNamespace: launch.backendNamespace,
          bundleHash: launch.bundleHash,
          jobKind: launch.jobKind,
          pool: launch.pool,
          enqueueSequence: launch.enqueueSequence,
          operation: launch.operation,
          request: { ...launch.request },
          createdAt: launch.createdAt,
        }
      : launch.jobKind === 'workflow'
        ? {
            owner: launch.owner,
            projectRoot: launch.projectRoot,
            backendNamespace: launch.backendNamespace,
            bundleHash: launch.bundleHash,
            jobKind: 'workflow' as const,
            pool: launch.pool,
            enqueueSequence: launch.enqueueSequence,
            request: {
              prompt: launch.request.prompt,
              cwd: launch.request.cwd,
              bypassPermissions: launch.request.bypassPermissions,
              coralEnv: { ...launch.request.coralEnv },
            },
            createdAt: launch.createdAt,
          }
        : {
            owner: launch.owner,
            ...(launch.discussionRun === undefined ? {} : { discussionRun: launch.discussionRun }),
            sessionId: launch.sessionId,
            provider: launch.provider,
            projectRoot: launch.projectRoot,
            backendNamespace: launch.backendNamespace,
            bundleHash: launch.bundleHash,
            jobKind: launch.jobKind,
            pool: launch.pool,
            enqueueSequence: launch.enqueueSequence,
            providerAction: launch.providerAction,
            workflowSlotGeneration: launch.workflowSlotGeneration,
            replacesWorkflowJobId: launch.replacesWorkflowJobId,
            request: {
              ...launch.request,
              prompt: launch.request.prompt,
              cwd: launch.request.cwd,
              bypassPermissions: launch.request.bypassPermissions,
              coralEnv: { ...launch.request.coralEnv },
            },
            createdAt: launch.createdAt,
          };

  return {
    type: 'job.launch.requested' as const,
    stream: { kind: 'job' as const, id: jobId },
    namespace: launch.backendNamespace,
    project: launch.projectRoot,
    refs,
    bodyVersion: 1,
    body,
  };
}

export class JobStore implements JobProgressStore {
  private readonly eventBus: JobEventBus;
  private readonly db: Database;
  private readonly commitEvents: CommitEventsFn;
  private readonly observer?: PostCommitObserver;
  private readonly namespaceOverrides = new Map<string, { backendNamespace: string; bundleHash?: string }>();
  private changeSeq = 0;
  private waiters: Array<() => void> = [];
  private enqueueSequence = 0;

  public readonly schemas: ComposedReducers['schemas'];
  public readonly bodyCodec: EventBodyCodec;

  private readonly namespace: string;
  private readonly runtime: Pick<Runtime, 'storage' | 'paths' | 'time' | 'env'>;
  constructor(
    namespace: string,
    runtime: Pick<Runtime, 'storage' | 'paths' | 'time' | 'env'>,
    bodyCodec: EventBodyCodec,
    options: JobStoreOptions,
  ) {
    this.namespace = namespace;
    this.runtime = runtime;
    const { eventBus = createNoopJobEventBus(), db, reducers = composeReducers(jobsRegistry) } = options;

    this.eventBus = eventBus;
    this.observer = options.observer;
    this.schemas = reducers.schemas;
    this.bodyCodec = bodyCodec;
    this.db = db;
    this.commitEvents = (cb) =>
      commitJournalEvents(this.db, cb, {
        now: () => nowDate(this.runtime.time),
        reducers,
        bodyCodec: this.bodyCodec,
        providers: options.providers,
      });
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
    return join(jobsDir(this.runtime.env), jobId);
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

  readJobEvents(jobId: string) {
    return readJobEvents(this.db, jobId, this);
  }

  ensureResultArtifact(jobId: string): string {
    return ensureResultMarkdownArtifact(
      this.db,
      jobId,
      this.runtime.paths.coral.exports.jobsRoot,
      this.runtime.storage,
      this,
    );
  }

  listJobProjections() {
    return listJobProjections(this.db, this).map(({ jobId, status }) => ({
      jobId,
      status: this.applyNamespaceOverrideToStatus(jobId, status),
    }));
  }

  private publishAppendedEvents(
    appended: readonly AppendedEvent[],
    previousByJob: ReadonlyMap<string, JobStatus | null>,
  ): AppendedEvent[] {
    for (const event of appended) {
      if (event.stream.kind !== 'job') {
        continue;
      }

      if (event.type === 'job.launch.requested') {
        const launch = jobLaunchRequestBodySchema.parse(event.body);
        this.namespaceOverrides.delete(event.stream.id);
        this.eventBus.emit('job:created', jobCreatedEvent(event.stream.id, launch));
        continue;
      }

      if (event.type === 'job.progress.emitted') {
        const body = event.body as { kind?: string; message?: string; timing?: JobProgressTiming };
        if (body.kind === 'message' && typeof body.message === 'string') {
          this.eventBus.emit('job:progress', {
            jobId: event.stream.id,
            seq: event.seq,
            message: body.message,
            timing: body.timing as JobProgressTiming,
          });
        }
        continue;
      }

      if (event.type === 'job.terminal.recorded') {
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

  commit(cb: <Scope>(c: CommitContext<Scope>) => CommitClosureResult): AppendedEvent[] {
    const previousByJob = new Map<string, JobStatus | null>();
    const appended =
      this.commitEvents(<Scope>(c: CommitContext<Scope>) => {
        const appendCollected = c.append as <const Body>(
          input: ResolvableCoralEventInput<Scope, Body>,
        ) => CauseRefToken<Scope>;
        const tracked: CommitContext<Scope> = {
          append: <const Body>(input: CommitAppendInput<Scope, Body>) => {
            if (input.stream.kind === 'job' && !previousByJob.has(input.stream.id)) {
              previousByJob.set(input.stream.id, this.readStatus(input.stream.id));
            }
            return appendCollected(input);
          },
        };

        return cb(tracked);
      }) ?? [];

    const published = this.publishAppendedEvents(appended, previousByJob);
    if (published.length > 0) {
      this.observer?.(published);
    }
    return published;
  }

  initJob(opts: InitJobOptions): void {
    const dir = this.jobDir(opts.jobId);
    this.runtime.storage.mkdirSync(dir, { recursive: true });
    const createdAt = nowIsoString(this.runtime.time);
    this.appendLaunchRequested(opts.jobId, {
      jobId: opts.jobId,
      owner: { kind: 'provider-session', id: opts.sessionId },
      sessionId: opts.sessionId,
      provider: opts.provider,
      projectRoot: opts.projectRoot,
      backendNamespace: opts.backendNamespace,
      ...(opts.bundleHash === undefined ? {} : { bundleHash: opts.bundleHash }),
      jobKind: 'provider',
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
      this.commit((c) => {
        c.append({
          type: 'job.queue.queued',
          stream: { kind: 'job', id: opts.jobId },
          namespace: opts.backendNamespace,
          project: opts.projectRoot,
          refs: buildJobEventRefs({ jobId: opts.jobId, sessionId: opts.sessionId }),
          bodyVersion: 1,
          body: {
            queuePosition: 0,
            runningJobIds: [],
          },
        });
        return undefined;
      });
      return;
    }

    if (opts.initialPhase === 'running') {
      this.commit((c) => {
        c.append({
          type: 'job.runtime.started',
          stream: { kind: 'job', id: opts.jobId },
          namespace: opts.backendNamespace,
          project: opts.projectRoot,
          refs: buildJobEventRefs({ jobId: opts.jobId, sessionId: opts.sessionId }),
          bodyVersion: 1,
          body: {
            transport: 'app-server',
            startedAt: createdAt,
            providerMeta: {
              provider: opts.provider,
              leaseState: 'waiting',
            },
          },
        });
        return undefined;
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
    this.commit((c) => {
      c.append(jobLaunchRequestedEvent(jobId, launch));
      return undefined;
    });
  }

  readLaunchProjection(jobId: string): JobLaunch | null {
    return this.detail(jobId).launch;
  }

  appendRuntimeStarted(jobId: string, runtime: JobRuntime): void {
    const detail = this.detail(jobId);
    const status = detail.status;
    this.commit((c) => {
      c.append({
        type: 'job.runtime.started',
        stream: { kind: 'job', id: jobId },
        namespace: status?.backendNamespace ?? this.namespace,
        project: status?.projectRoot,
        refs: buildJobEventRefs({ jobId, sessionId: status?.sessionId ?? null }),
        bodyVersion: 1,
        body: jobRuntimeStartedBody(runtime),
      });
      return undefined;
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
    let exitCode = processExit?.exitCode ?? null;
    if (exitCode === null && exit.outcome.kind === 'provider_exit') {
      exitCode = exit.outcome.code;
    }
    return {
      exitCode,
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

  appendProgress(jobId: string, sessionId: string | null, message: string): number {
    const nowMs = this.runtime.time.now();
    const detail = this.detail(jobId);
    const status = detail.status;
    const timing = progressTimingFromProjection(detail, nowMs);
    const [appended] = this.commit((c) => {
      c.append({
        type: 'job.progress.emitted',
        stream: { kind: 'job', id: jobId },
        namespace: status?.backendNamespace ?? this.namespace,
        project: status?.projectRoot,
        refs: buildJobEventRefs({ jobId, sessionId }),
        bodyVersion: 1,
        body: {
          kind: 'message',
          message,
          timing,
        },
      });
      return undefined;
    });
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

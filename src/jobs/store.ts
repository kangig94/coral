import type { AppendContext } from '../store/append.js';
import { loadExecutionWaitDetail, type ExecutionWaitDetail } from './wait/execution-detail.js';
import { currentResultInput, loadRetainedCurrentJob } from './retained-current.js';
import { retainedResultInput } from './historical-reader.js';
import type { RecoveryObservation } from '../recovery/phase-observation.js';
import type { ProgressSource, ProgressVisitResult } from './wait/contract.js';
import { visitJobProgress } from './read-queries.js';
import { sameEpoch } from '../store/epoch/identity.js';
import { hasReadableTerminalDetail } from './terminal/identity.js';
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
import {
  listJobProjections,
  loadJobProjectionDetail,
  loadJobExecutionDetails,
  hydrateJobProjectionDetailFromEvents,
  readJobEvents,
  readJobLastSeq,
} from './read-queries.js';
import type { Runtime } from '../runtime/ports.js';
import { jobsDir } from './paths.js';
import { TerminalResultExportOwner } from './terminal/export.js';
import { resultPathFor } from './paths.js';
import { type WorkflowReportPort } from './terminal/render.js';
import { type JobLocationIndex, type JobLocation, type JobLocationSubject } from './location-index.js';
import { withTerminalSource } from './terminal/source.js';
import { deriveLaunchReadiness } from './launch-readiness.js';
import type { DurableProcessExit } from '../runtime/durable-runtime.js';
import { nowDate, nowIsoString } from '../infra/time.js';
import { createNoopJobEventBus, jobCreatedEvent, type JobEventBus } from './event-bus.js';
import { jobOpenedBodySchema, jobExecutionRequestedBodySchema } from './launch.js';
import { jobExecutionEndedBodySchema, jobExecutionOutcomeAcceptedBodySchema } from './terminal/result.js';
import { decodeBody } from '../store/body-codec.js';
import { jobsRegistry } from './events.js';
import { isLivePhase } from './phase.js';
import type { InitJobOptions, JobProgressStore } from './contracts/job-store.js';
import { type JobProgressTiming, type JobRuntimeStartedBody } from './event-bodies.js';
import {
  type JobLaunch,
  type JobRuntime,
  type JobStatus,
  type JobTerminal,
  type JobDetailResponse,
} from './records.js';
import { progressTimingFromProjection } from './progress-timing.js';
import { buildJobEventRefs } from './refs.js';
import {
  countProjectedLiveJobRows,
  decodeProjectionJobStoredRow,
  readStoredNonterminalProjectionJobIds,
  type ProjectionJobStoredRow,
} from './projection-row.js';
import type { StoreReadContext } from '../store/body-codec.js';
import type { EventsRow } from '../store/schema.js';
import type { JobProjectionDetail } from './read-queries.js';
import { writeDurableCliProvisionalProcessRuntimeMeta } from './runtime-meta-store.js';
import type { DurableCliProvisionalProcessRuntimeMeta } from './runtime-meta.js';

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
  beforeAppend?: (input: ResolvableCoralEventInput<unknown, unknown>) => void;
  withCommitGuard?: AppendContext['withCommitGuard'];
  withExecutionAdmission?: (jobId: string, execution: number, subject: JobLocationSubject, action: () => void) => void;
};

export type RawJobRecoveryProjection = {
  readonly projection: ProjectionJobStoredRow;
  readonly events: readonly EventsRow[];
};

/** Hydrates one complete raw job projection without consulting persisted state again. */
export function hydrateJobRecoveryProjection(
  raw: RawJobRecoveryProjection,
  ctx: StoreReadContext,
): JobProjectionDetail {
  return hydrateJobProjectionDetailFromEvents(decodeProjectionJobStoredRow(raw.projection), raw.events, ctx);
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

function jobRuntimeStartedBody(runtime: JobRuntime, execution: number): JobRuntimeStartedBody {
  if (runtime.transport === 'internal') {
    return {
      execution,
      transport: 'internal',
      operation: runtime.operation,
      ...(runtime.owner === undefined ? {} : { owner: runtime.owner }),
      startedAt: runtime.startTime,
    };
  }

  if (runtime.transport === 'app-server') {
    return {
      execution,
      transport: 'app-server',
      startedAt: runtime.startTime,
      providerMeta: runtime.providerMeta,
    };
  }

  if (runtime.transport === 'workflow') {
    return {
      execution,
      transport: 'workflow',
      startedAt: runtime.startTime,
    };
  }

  return {
    execution,
    transport: runtime.transport,
    pid: runtime.pid,
    stdoutPath: runtime.stdoutPath,
    stderrPath: runtime.stderrPath,
    startedAt: runtime.startTime,
    tailWatermark: runtime.tailWatermark,
  };
}

export function jobLaunchRequestedEvent(jobId: string, launch: JobLaunch) {
  const workflowId = launch.jobKind === 'workflow' ? jobId : launch.parentWorkflowJobId;
  const refs = buildJobEventRefs({
    jobId,
    parentJobId: launch.parentWorkflowJobId,
    workflowId,
    workflowSlotId: launch.workflowSlotId,
  });
  const body = jobExecutionRequestedBodySchema.parse({
    execution: launch.execution,
    input: launch.jobKind === 'kb' ? { operation: launch.operation, request: launch.request } : launch.request.prompt,
    action: launch.jobKind === 'provider' ? launch.providerAction : 'exec',
    pool: launch.pool,
    enqueueSequence: launch.enqueueSequence,
    coralEnv: launch.jobKind === 'kb' ? {} : launch.request.coralEnv,
    createdAt: launch.createdAt,
    backendNamespace: launch.backendNamespace,
    bundleHash: launch.bundleHash,
    discussionRun: launch.discussionRun,
  });

  return {
    type: 'job.execution.requested' as const,
    stream: { kind: 'job' as const, id: jobId },
    namespace: launch.backendNamespace,
    project: launch.projectRoot,
    refs,
    body,
  };
}

export class JobStore implements JobProgressStore {
  private readonly admissionGuard: JobStoreOptions['withExecutionAdmission'];
  private readonly eventBus: JobEventBus;
  private readonly db: Database;
  private readonly commitEvents: CommitEventsFn;
  private readonly observer?: PostCommitObserver;
  private readonly namespaceOverrides = new Map<string, { backendNamespace: string; bundleHash?: string }>();
  private changeSeq = 0;
  private waiters: Array<() => void> = [];
  private enqueueSequence = 0;

  public readonly schemas: ComposedReducers['schemas'];
  public readonly streamKinds: ComposedReducers['streamKinds'];
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

    this.admissionGuard = options.withExecutionAdmission;
    this.eventBus = eventBus;
    this.observer = options.observer;
    this.schemas = reducers.schemas;
    this.streamKinds = reducers.streamKinds;
    this.bodyCodec = bodyCodec;
    this.db = db;
    const appendContext = {
      now: () => nowDate(this.runtime.time),
      reducers,
      bodyCodec: this.bodyCodec,
      providers: options.providers,
      beforeAppend: options.beforeAppend,
      withCommitGuard: options.withCommitGuard,
    };
    this.commitEvents = (cb, options) => commitJournalEvents(this.db, cb, appendContext, options);
  }

  withExecutionAdmission(jobId: string, execution: number, subject: JobLocationSubject, action: () => void): void {
    if (this.admissionGuard === undefined) action();
    else this.admissionGuard(jobId, execution, subject, action);
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

  private detail(jobId: string, observation?: RecoveryObservation) {
    return this.applyNamespaceOverride(loadJobProjectionDetail(this.db, jobId, this, observation), jobId);
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

  loadJobProjectionDetail(jobId: string, observation?: RecoveryObservation) {
    return this.detail(jobId, observation);
  }

  resultPathFor(jobId: string, execution: number): string {
    return resultPathFor(this.runtime.paths.coral.exports.jobsRoot, jobId, execution);
  }

  loadJobDetailResponse(jobId: string): JobDetailResponse | null {
    const latest = this.detail(jobId);
    if (latest.status === null) return null;
    const executions = loadJobExecutionDetails(this.db, jobId, this).map(({ execution, requestedSeq, detail }) => ({
      ...detail,
      status: this.applyNamespaceOverrideToStatus(jobId, detail.status),
      execution,
      requestedSeq,
      resultPath: this.resultPathFor(jobId, execution),
    }));
    const selected = executions.at(-1);
    return {
      status: latest.status,
      events: selected?.events ?? [],
      readiness: deriveLaunchReadiness(latest),
      exit: latest.exit,
      executions,
      ...(selected === undefined ? {} : { requestedSeq: selected.requestedSeq, resultPath: selected.resultPath }),
    };
  }

  loadJobWaitDetail(jobId: string, requestedSeq?: number, jobIds?: readonly string[]): ExecutionWaitDetail {
    const detail = loadExecutionWaitDetail(this.db, jobId, this, requestedSeq, jobIds);
    return detail.status === null
      ? detail
      : { ...detail, status: this.applyNamespaceOverrideToStatus(jobId, detail.status) };
  }

  readJobLastSeq(jobId: string): number | null {
    return readJobLastSeq(this.db, jobId);
  }

  readJobEvents(jobId: string, terminalOnly = false, afterSeq = 0, observation?: RecoveryObservation) {
    return readJobEvents(this.db, jobId, this, terminalOnly, afterSeq, observation);
  }

  visitProgress<T>(read: (source: ProgressSource) => T): ProgressVisitResult<T> {
    return visitJobProgress(this.db, this, read);
  }

  observeJobAbsence(jobId: string): boolean {
    return (
      this.db.prepare("SELECT 1 FROM events WHERE stream_kind = 'job' AND stream_id = ? LIMIT 1").get(jobId) ===
      undefined
    );
  }

  private resultExports: TerminalResultExportOwner | null = null;
  private exportLocations: JobLocationIndex | null = null;
  private workflowReport?: WorkflowReportPort;

  configureResultExports(locations: JobLocationIndex | null, workflowReport?: WorkflowReportPort): void {
    if (this.exportLocations === locations && this.workflowReport === (workflowReport ?? locations?.workflowReport))
      return;
    this.exportLocations = locations;
    this.workflowReport = workflowReport ?? locations?.workflowReport;
    this.resultExports = null;
  }

  getResultExportOwner(): TerminalResultExportOwner {
    if (this.resultExports !== null) return this.resultExports;
    this.resultExports = new TerminalResultExportOwner({
      runtime: this.runtime,
      jobsRoot: this.runtime.paths.coral.exports.jobsRoot,
      workflowReport: this.workflowReport,
      readTerminalInput: (db, jobId, execution) => {
        const index = this.exportLocations;
        const location = index?.read(jobId);
        return index && location
          ? retainedResultInput(index, location.epochKey, db, jobId, execution)
          : currentResultInput(db, ':memory:', jobId, execution, this.workflowReport);
      },
      failures: this.exportLocations?.resultRepairFailures,
      repairScope: this.exportLocations ?? undefined,
      hydrationRetry: (jobId) => {
        const location = this.exportLocations?.read(jobId);
        return location
          ? this.exportLocations?.unknownLocationHolds().find((hold) => sameEpoch(hold.epochKey, location.epochKey))
              ?.retryScheduled
          : undefined;
      },
      prepareTerminal: (jobId, db) => {
        const index = this.exportLocations;
        const location = index?.read(jobId);
        if (!index || !location || hasReadableTerminalDetail(location)) return;
        index.prepareTerminal(jobId, db, location.epochKey, this.runtime.paths.coral.exports.jobsRoot);
      },
      location: (jobId, observation): JobLocation | null => {
        if (this.exportLocations) return this.exportLocations.read(jobId, observation);
        return loadRetainedCurrentJob(
          this.db,
          ':memory:',
          jobId,
          this.runtime.paths.coral.exports.jobsRoot,
          this.workflowReport,
        );
      },
      withSource: (jobId, read, snapshot) => {
        if (!this.exportLocations) return read(this.db, this);
        const location = snapshot ?? this.exportLocations.read(jobId);
        return location ? withTerminalSource(this.runtime, location.epochKey, (db) => read(db, this)) : null;
      },
    });
    return this.resultExports;
  }

  publishTerminalResult(jobId: string, execution?: number): string {
    return this.getResultExportOwner().publishTerminalResult(jobId, execution);
  }

  ensureResultArtifact(jobId: string, observation?: RecoveryObservation, execution?: number): string {
    return this.getResultExportOwner().ensureResultMarkdownArtifact(jobId, observation, execution);
  }

  listJobProjections() {
    return listJobProjections(this.db, this).map(({ jobId, status }) => ({
      jobId,
      execution: status.execution,
      resultPath: status.execution === null ? null : this.resultPathFor(jobId, status.execution),
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

      if (event.type === 'job.opened') {
        const launch = jobOpenedBodySchema.parse(event.body);
        this.namespaceOverrides.delete(event.stream.id);
        this.eventBus.emit('job:created', jobCreatedEvent(event.stream.id, launch));
        continue;
      }

      if (event.type === 'job.execution.requested') {
        this.namespaceOverrides.delete(event.stream.id);
        const { execution } = jobExecutionRequestedBodySchema.parse(event.body);
        this.eventBus.emit('job:requested', { jobId: event.stream.id, execution });
        continue;
      }

      if (event.type === 'job.execution.progress') {
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

      if (event.type === 'job.execution.ended') {
        const ended = jobExecutionEndedBodySchema.parse(event.body);
        const row = this.db.prepare<[number], EventsRow>('SELECT * FROM events WHERE seq = ?').get(ended.causeRef.seq);
        if (row === undefined || row.stream_kind !== 'job' || row.stream_id !== event.stream.id)
          throw new Error('Execution end has no accepted outcome.');
        const accepted = decodeBody(row, jobExecutionOutcomeAcceptedBodySchema, this);
        if (accepted.execution !== ended.execution) throw new Error('Execution end cites another execution.');
        this.eventBus.emit('job:completed', {
          jobId: event.stream.id,
          execution: ended.execution,
          result: accepted.terminal,
        });
      }
    }

    for (const [jobId, previous] of previousByJob) {
      const next = this.readStatus(jobId);
      this.notifyPhaseChange(previous, next);
    }

    this.notifyWaiters();
    return [...appended];
  }

  commit(
    cb: <Scope>(c: CommitContext<Scope>) => CommitClosureResult,
    options?: Parameters<CommitEventsFn>[1],
  ): AppendedEvent[] {
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
      }, options) ?? [];

    const published = this.publishAppendedEvents(appended, previousByJob);
    if (published.length > 0) {
      this.observer?.(published);
    }
    return published;
  }

  initJob(opts: InitJobOptions): void {
    this.runtime.storage.mkdirSync(this.jobDir(opts.jobId), { recursive: true });
    const createdAt = nowIsoString(this.runtime.time);
    this.withExecutionAdmission(
      opts.jobId,
      1,
      {
        projectRoot: opts.projectRoot,
        workDir: opts.conversation.cwd,
        jobKind: 'provider',
      },
      () =>
        this.commit((c) => {
          const metadata = {
            namespace: opts.backendNamespace,
            project: opts.projectRoot,
            stream: { kind: 'job' as const, id: opts.jobId },
            refs: buildJobEventRefs({ jobId: opts.jobId }),
          };
          c.append({
            ...metadata,
            type: 'job.opened',
            body: {
              owner: { kind: 'provider-session', id: opts.jobId },
              projectRoot: opts.projectRoot,
              createdAt,
              jobKind: 'provider',
              conversation: opts.conversation,
            },
          });
          c.append({
            ...metadata,
            type: 'job.execution.requested',
            body: {
              execution: 1,
              input: '',
              action: 'exec',
              pool: 'default',
              enqueueSequence: 0,
              coralEnv: {},
              createdAt,
              backendNamespace: opts.backendNamespace,
              bundleHash: opts.bundleHash,
            },
          });
          if (opts.initialPhase === 'queued')
            c.append({
              ...metadata,
              type: 'job.execution.queued',
              body: {
                execution: 1,
                queuePosition: 0,
                runningJobIds: [],
              },
            });
          if (opts.initialPhase === 'running')
            c.append({
              ...metadata,
              type: 'job.execution.started',
              body: {
                execution: 1,
                transport: 'app-server',
                startedAt: createdAt,
                providerMeta: { provider: opts.conversation.provider, leaseState: 'waiting' },
              },
            });
          return undefined;
        }),
    );
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
    this.withExecutionAdmission(
      jobId,
      launch.execution,
      {
        projectRoot: launch.projectRoot,
        workDir: launch.jobKind === 'kb' ? null : launch.request.cwd,
        jobKind: launch.jobKind,
      },
      () =>
        this.commit((c) => {
          if (this.readStatus(jobId) === null) {
            if (launch.jobKind === 'provider')
              throw new Error('Provider jobs must be opened through their conversation facet.');
            c.append({
              type: 'job.opened',
              stream: { kind: 'job', id: jobId },
              namespace: launch.backendNamespace,
              project: launch.projectRoot,
              refs: buildJobEventRefs({ jobId, workflowId: launch.jobKind === 'workflow' ? jobId : undefined }),
              body: jobOpenedBodySchema.parse({
                owner: launch.owner,
                projectRoot: launch.projectRoot,
                createdAt: launch.createdAt,
                jobKind: launch.jobKind,
                ...(launch.jobKind === 'workflow'
                  ? { cwd: launch.request.cwd, bypassPermissions: launch.request.bypassPermissions }
                  : {}),
              }),
            });
          }
          c.append(jobLaunchRequestedEvent(jobId, launch));
          return undefined;
        }),
    );
  }

  readLaunchProjection(jobId: string): JobLaunch | null {
    return this.detail(jobId).launch;
  }

  appendRuntimeStarted(
    jobId: string,
    runtime: JobRuntime,
    provisionalProcess?: Omit<DurableCliProvisionalProcessRuntimeMeta, 'jobId'>,
  ): void {
    const detail = this.detail(jobId);
    const status = detail.status;
    if (status === null || status.execution === null) throw new Error(`Job '${jobId}' has no requested execution.`);
    const execution = status.execution;
    this.commit((c) => {
      c.append({
        type: 'job.execution.started',
        stream: { kind: 'job', id: jobId },
        namespace: status?.backendNamespace ?? this.namespace,
        project: status?.projectRoot,
        refs: buildJobEventRefs({ jobId }),
        body: jobRuntimeStartedBody(runtime, execution),
      });
      if (provisionalProcess !== undefined) {
        writeDurableCliProvisionalProcessRuntimeMeta(this.db, { jobId, ...provisionalProcess });
      }
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

  listStoredNonterminalJobIds(): string[] {
    return readStoredNonterminalProjectionJobIds(this.db);
  }

  liveJobCount(): number {
    return this.countProjectedLiveJobs() + this.countLiveOverrideJobs();
  }

  appendProgress(jobId: string, message: string): number {
    const nowMs = this.runtime.time.now();
    const detail = this.detail(jobId);
    const status = detail.status;
    if (status === null || status.execution === null) throw new Error(`Job '${jobId}' has no requested execution.`);
    const execution = status.execution;
    const timing = progressTimingFromProjection(detail, nowMs);
    const [appended] = this.commit((c) => {
      c.append({
        type: 'job.execution.progress',
        stream: { kind: 'job', id: jobId },
        namespace: status?.backendNamespace ?? this.namespace,
        project: status?.projectRoot,
        refs: buildJobEventRefs({ jobId }),
        body: {
          execution,
          kind: 'message',
          message,
          timing,
        },
      });
      return undefined;
    });
    return appended?.seq ?? 0;
  }

  /** Only durable job-stream events may be announced to in-process listeners and waiters. */
  announceCommitted(appended: readonly AppendedEvent[]): void {
    this.publishAppendedEvents(appended, new Map());
  }

  private countLiveOverrideJobs(): number {
    let count = 0;

    for (const jobId of this.namespaceOverrides.keys()) {
      const status = this.detail(jobId).status;
      if (status && isLivePhase(status.phase)) {
        count += 1;
      }
    }

    return count;
  }

  private countProjectedLiveJobs(): number {
    const excludedJobIds = [...this.namespaceOverrides.keys()];
    return countProjectedLiveJobRows(this.db, excludedJobIds);
  }
}

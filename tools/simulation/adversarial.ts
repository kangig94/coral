import { join } from 'node:path';
import { SessionManager } from '../../src/sessions/shell.js';
import type { CoordinatorServerInfo, LifecycleState } from '../../src/coordinator/lifecycle.js';
import {
  createSimulationBackend,
  type SimulationBackend,
  type SimulationHookLog,
  type SimulationWorldCarryOver,
} from './core/backend.js';
import { DEFAULT_EPOCH_MS } from './core/virtual-time.js';
import {
  acquireNoRealIoMonitor,
  cloneNoRealIoReport,
  type NoRealIoRegistration,
  type NoRealIoReport,
} from './no-real-io.js';
import { normalizeWorldConfig } from './scenario-normalize.js';
import { ScenarioHttpRequest, ScenarioHttpResponse } from './scenario-http.js';
import type { LaunchStep, WaitUntil, WorldConfig } from './scenario-schema.js';
import type { LaunchDecision } from '../../src/jobs/launch.js';
import { isTerminalPhase } from '../../src/jobs/phase.js';
import type { JobEvent, JobRuntime, JobStatus, JobTerminal } from '../../src/jobs/records.js';
import type { DurableCliRuntimeRecord, DurableProcessExit } from '../../src/runtime/durable-runtime.js';
import type { ProviderSession } from '../../src/sessions/entry.js';
import { providerLookupPortFromCatalog } from '../../src/providers/catalog.js';

const RESULT_FILE = 'result.md';

export type LaunchJobOptions = {
  provider?: string;
  agent?: string;
  projectRoot?: string;
  coralEnv?: Record<string, string>;
};
export type SimulationArtifactKind = 'status' | 'result' | 'runtime' | 'stdout' | 'stderr' | 'exit';
export type ArtifactFreshness = 'cached' | 'fresh' | 'raw';

export type WaitObservation = {
  phase: string | null;
  runtimeRecorded: boolean;
  terminal: boolean;
  progress: string[];
  result: JobTerminal | null;
};

export type WaitDetail = {
  ok: boolean;
  jobId: string;
  steps: number;
  elapsedMs: number;
  expected: WaitUntil;
  actual: WaitObservation;
};

export type SimulationHttpResponse = {
  statusCode: number;
  headers: Record<string, string | number | string[]>;
  body: string;
};

export type SimulationGeneration = {
  index: number;
  backend: SimulationBackend;
  startedInfo: CoordinatorServerInfo | null;
};

type WorldGenerationState = {
  backend: SimulationBackend;
  startedInfo: CoordinatorServerInfo | null;
  phaseTransitions: Map<string, Array<{ previousPhase: string; phase: string }>>;
};

type ProgressCursor = {
  afterSeq: number;
  terminalSeen: boolean;
};

function createProgressCursor(): ProgressCursor {
  return { afterSeq: 0, terminalSeen: false };
}

function cloneHookLog(hooks: SimulationHookLog): SimulationHookLog {
  return {
    createServerCalls: [...hooks.createServerCalls],
    listenCalls: hooks.listenCalls.map((entry) => ({ ...entry })),
    writeBackendInfoCalls: hooks.writeBackendInfoCalls.map((entry) => ({
      pluginRoot: entry.pluginRoot,
      info: { ...entry.info },
    })),
    removeBackendInfoCalls: hooks.removeBackendInfoCalls.map((entry) => ({ ...entry })),
    kbDaemonStartCalls: hooks.kbDaemonStartCalls.map((entry) => ({ ...entry })),
    kbDaemonWarmupCalls: hooks.kbDaemonWarmupCalls.map((entry) => ({ ...entry })),
    recoverPersistedDiscussCalls: hooks.recoverPersistedDiscussCalls,
  };
}

function hasRuntimePid(record: unknown): record is { pid: number } {
  return (
    record !== null &&
    typeof record === 'object' &&
    'pid' in record &&
    typeof (record as { pid?: unknown }).pid === 'number'
  );
}

function hasRuntimeStreamPath(
  record: JobRuntime | DurableCliRuntimeRecord | null,
  key: 'stdoutPath' | 'stderrPath',
): record is (JobRuntime | DurableCliRuntimeRecord) & Record<typeof key, string> {
  if (record === null || !(key in record)) {
    return false;
  }
  return typeof (record as unknown as Record<string, unknown>)[key] === 'string';
}

/**
 * Control-flow exerciser for lifecycle/recovery sequencing and persisted artifact ordering within the simulation env snapshot.
 * Does not model true lock contention, host env discovery/mutation, or network behavior.
 */
export class SimulationWorld {
  private readonly initialConfig: WorldConfig;
  private readonly epochMs: number;
  private readonly noRealIoRegistration: NoRealIoRegistration;
  private current: WorldGenerationState;
  private generationIndex = 0;
  private elapsedOffsetMs = 0;
  private disposed = false;

  constructor(config: WorldConfig) {
    this.initialConfig = config;
    this.epochMs = this.initialConfig.epochMs ?? DEFAULT_EPOCH_MS;
    this.noRealIoRegistration = acquireNoRealIoMonitor();
    this.current = this.createGenerationState();
  }

  async boot(): Promise<CoordinatorServerInfo> {
    this.assertUsable();
    const info = await this.current.backend.backend.start();
    this.current.startedInfo = info;
    return info;
  }

  generation(): SimulationGeneration {
    this.assertUsable();
    return {
      index: this.generationIndex,
      backend: this.current.backend,
      startedInfo: this.current.startedInfo ? { ...this.current.startedInfo } : null,
    };
  }

  /**
   * `preserveWorld` restarts the coordinator on the world it was already running: same filesystem,
   * same process table, same journal. That is the only shape in which recovery adoption is reachable,
   * because a job can only be adopted from durable state that outlived the coordinator that wrote it.
   * Without it the next generation starts on a fresh machine and has nothing to adopt.
   */
  async cycle(options?: { preserveWorld?: boolean }): Promise<CoordinatorServerInfo> {
    this.assertUsable();
    this.elapsedOffsetMs = this.getVirtualElapsedMs();
    const carryOver = options?.preserveWorld === true ? this.current.backend.carryOver : undefined;
    // A restart that keeps its world is a replacement, not a crash.
    await this.current.backend.backend.shutdown(carryOver === undefined ? 'cycle' : 'replaced');
    await this.current.backend.backend.waitForShutdown();
    this.generationIndex += 1;
    this.current = this.createGenerationState(carryOver);
    return this.boot();
  }

  /**
   * Rewrite a stored event body into a shape this build cannot decode — the exact durable condition a
   * newer build's writer leaves behind when the two disagree about a field. It is not corruption: the
   * row is well-formed for whoever wrote it, and unreadable only here.
   */
  writeForeignRecord(eventType: string): number {
    this.assertUsable();
    const db = this.current.backend.progressStore.getDb();
    const row = db
      .prepare<[string], { seq: number }>(`SELECT seq FROM events WHERE type = ? ORDER BY seq DESC LIMIT 1`)
      .get(eventType);
    if (row === undefined) throw new Error(`No '${eventType}' event exists to rewrite.`);
    db.prepare<[Buffer, number]>(`UPDATE events SET body = ? WHERE seq = ?`).run(
      Buffer.from(JSON.stringify({ transport: 'durable-cli', writtenByANewerBuild: true }), 'utf-8'),
      row.seq,
    );
    return row.seq;
  }

  async shutdown(reason = 'simulation-shutdown'): Promise<void> {
    this.assertUsable();
    await this.current.backend.backend.shutdown(reason);
  }

  async waitForShutdown(): Promise<void> {
    this.assertUsable();
    await this.current.backend.backend.waitForShutdown();
  }

  async launchJob(prompt: string, opts?: LaunchJobOptions): Promise<LaunchDecision>;
  async launchJob(step: LaunchStep): Promise<LaunchDecision>;
  async launchJob(promptOrStep: string | LaunchStep, opts: LaunchJobOptions = {}): Promise<LaunchDecision> {
    this.assertUsable();
    this.assertBooted('launch');
    const step =
      typeof promptOrStep === 'string'
        ? ({
            type: 'launch',
            prompt: promptOrStep,
            provider: opts.provider ?? 'codex',
            agent: opts.agent,
            projectRoot: opts.projectRoot,
            coralEnv: opts.coralEnv,
          } satisfies LaunchStep)
        : promptOrStep;

    const projectRoot = step.projectRoot ?? this.current.backend.projectRoot;
    const service = this.current.backend.createService(projectRoot);
    const ctx = this.current.backend.createInvocationContext(projectRoot, step.coralEnv);
    return service.start(
      step.provider ?? 'codex',
      {
        prompt: step.prompt,
        ...(step.agent !== undefined ? { agent: step.agent } : {}),
      },
      ctx,
    );
  }

  async advance(ms: number): Promise<void> {
    this.assertUsable();
    await this.current.backend.advance(ms);
  }

  async waitUntil(
    jobId: string,
    until: WaitUntil,
    stepMs: number,
    limits: { maxSteps?: number; timeoutMs?: number },
  ): Promise<WaitDetail> {
    this.assertUsable();
    this.assertBooted('wait');
    const startedAt = this.getVirtualElapsedMs();
    const cursor = createProgressCursor();
    const accumulatedProgress: string[] = [];

    // A launch can hand control back while its detached execution is still
    // crossing promise boundaries at the current virtual instant.  Settle
    // that work before the first observation: advancing the clock first can
    // fire a newly spawned process's exit timer before exposing its runtime
    // record, making an already-satisfied runtimeRecorded wait look stale.
    await this.current.backend.advance(0);
    let steps = 0;
    let actual = this.observeJobIncremental(jobId, cursor, accumulatedProgress);

    if (this.matchesWaitCondition(until, actual)) {
      return {
        ok: true,
        jobId,
        steps,
        elapsedMs: this.getVirtualElapsedMs() - startedAt,
        expected: { ...until },
        actual,
      };
    }

    while (true) {
      const elapsedMs = this.getVirtualElapsedMs() - startedAt;
      const reachedStepBudget = limits.maxSteps !== undefined && steps >= limits.maxSteps;
      const reachedTimeBudget = limits.timeoutMs !== undefined && elapsedMs >= limits.timeoutMs;
      if (reachedStepBudget || reachedTimeBudget) {
        return {
          ok: false,
          jobId,
          steps,
          elapsedMs,
          expected: { ...until },
          actual,
        };
      }

      const advanceBy =
        limits.timeoutMs === undefined ? stepMs : Math.min(stepMs, Math.max(0, limits.timeoutMs - elapsedMs));
      if (advanceBy <= 0) {
        return {
          ok: false,
          jobId,
          steps,
          elapsedMs,
          expected: { ...until },
          actual,
        };
      }

      await this.advance(advanceBy);
      steps += 1;
      actual = this.observeJobIncremental(jobId, cursor, accumulatedProgress);
      if (this.matchesWaitCondition(until, actual)) {
        return {
          ok: true,
          jobId,
          steps,
          elapsedMs: this.getVirtualElapsedMs() - startedAt,
          expected: { ...until },
          actual,
        };
      }
    }
  }

  getJobStatus(jobId: string): JobStatus | null {
    this.assertUsable();
    return this.current.backend.progressStore.readStatus(jobId);
  }

  getProgress(jobId: string): string[] {
    return this.replay(jobId)
      .filter((event): event is JobEvent & { type: 'progress'; message: string } => event.type === 'progress')
      .map((event) => event.message);
  }

  async abort(jobId: string): Promise<void> {
    this.assertUsable();
    this.assertBooted('abort');
    const status = this.current.backend.progressStore.readStatus(jobId);
    if (!status) {
      throw new Error(`Cannot abort unknown job ${jobId}`);
    }

    if (isTerminalPhase(status.phase)) {
      return;
    }

    const service = this.current.backend.createService(status.projectRoot);
    const result = service.abort([jobId]);
    if (result.notFound.includes(jobId)) {
      throw new Error(`Abort registry did not contain ${jobId}`);
    }
  }

  async kill(target: { pid?: number; jobId?: string }): Promise<void> {
    this.assertUsable();
    this.assertBooted('kill');
    const pid =
      target.pid ??
      (target.jobId ? extractRuntimePid(this.readArtifact(target.jobId, 'runtime', { freshness: 'cached' })) : null);
    if (pid === null || pid === undefined) {
      if (target.jobId) {
        throw new Error(`Cannot resolve a runtime pid for job ${target.jobId}`);
      }
      throw new Error('Cannot kill without a pid or jobId');
    }
    // Observed life, not truthiness. `ProcessLiveness` is a string union, so every one of its three values is
    // truthy — `!observeLiveness(pid)` was never true and this guard never fired, letting the simulator report
    // a kill of an inactive pid as a success.
    if (this.current.backend.runtime.process.observeLiveness(pid) !== 'alive') {
      throw new Error(`Cannot kill pid ${pid}: it was not observed alive`);
    }
    this.current.backend.runtime.process.kill(pid, 'SIGTERM');
  }

  enqueueHang(delayMs?: number): void {
    this.assertUsable();
    this.current.backend.runtime.spawner.enqueueDurable({
      runtimeDelayMs: delayMs,
      exit: null,
    });
  }

  enqueueCrash(exitCode?: number, signal?: string, delayMs?: number): void {
    this.assertUsable();
    this.current.backend.runtime.spawner.enqueueDurable({
      exit: {
        delayMs,
        exitCode: exitCode ?? (signal === undefined ? 1 : null),
        signal: signal ?? null,
      },
    });
  }

  async invokeHttp(method: string, path: string, body?: unknown): Promise<SimulationHttpResponse> {
    this.assertUsable();
    const startedInfo = this.current.startedInfo;
    if (!startedInfo) {
      throw new Error('Simulation world must be booted before invoking HTTP');
    }

    const req = new ScenarioHttpRequest(method, path, startedInfo.token, body);
    const res = new ScenarioHttpResponse();
    const completion = Promise.resolve(this.current.backend.handleRequest(req as never, res as never));
    req.start();
    await completion;

    return {
      statusCode: res.statusCode,
      headers: Object.fromEntries(res.headers),
      body: res.body,
    };
  }

  replay(jobId: string, afterSeq = 0): JobEvent[] {
    this.assertUsable();
    return this.current.backend.progressStore.readJobEvents(jobId).filter((event) => event.seq > afterSeq);
  }

  readArtifact(
    jobId: string,
    kind: SimulationArtifactKind,
    _options: { freshness?: ArtifactFreshness } = {},
  ): string | JobStatus | JobRuntime | DurableProcessExit | null {
    this.assertUsable();

    switch (kind) {
      case 'status':
        return this.current.backend.progressStore.readStatus(jobId);
      case 'runtime':
        return this.current.backend.progressStore.readRuntimeProjection(jobId);
      case 'exit':
        return this.current.backend.progressStore.readExitProjection(jobId);
      case 'result':
        return this.readTextArtifact(this.resolveResultArtifactPath(jobId));
      case 'stdout':
      case 'stderr':
        return this.readTextArtifact(this.resolveStreamArtifactPath(jobId, kind));
    }
  }

  /**
   * Read straight from the quarantine table. Every decoded read surface is unavailable while the world
   * holds a record this build cannot parse, which is the condition these scenarios create — so this is
   * the only way to assert that a job was deferred rather than ended.
   */
  quarantinedSubjects(): string[] {
    this.assertUsable();
    return this.current.backend.progressStore
      .getDb()
      .prepare<[], { subject_key: string }>(`SELECT subject_key FROM recovery_quarantine WHERE state = 'active'`)
      .all()
      .map((row) => row.subject_key);
  }

  /**
   * Count terminal events straight from the journal. "The job was not ended" is the contract these
   * scenarios assert, and every decoded surface is unavailable while the world holds a record this
   * build cannot parse.
   */
  terminalEventCount(): number {
    this.assertUsable();
    const row = this.current.backend.progressStore
      .getDb()
      .prepare<[], { total: number }>(`SELECT COUNT(*) AS total FROM events WHERE type = 'job.terminal.recorded'`)
      .get();
    return row?.total ?? 0;
  }

  listJobIds(): string[] {
    this.assertUsable();
    return this.current.backend.progressStore.listJobIds();
  }

  listSessions(provider: string, projectRoot?: string): ProviderSession[] {
    this.assertUsable();
    const targetRoot = projectRoot ?? this.current.backend.projectRoot;
    return new SessionManager(
      targetRoot,
      this.current.backend.runtime,
      undefined,
      () => {},
      this.current.backend.progressStore.getDb(),
      providerLookupPortFromCatalog(this.current.backend.providerRegistry),
    ).list(provider);
  }

  getHookLog(): SimulationHookLog {
    this.assertUsable();
    return cloneHookLog(this.current.backend.hooks);
  }

  getNoRealIoReport(): NoRealIoReport {
    return cloneNoRealIoReport(this.noRealIoRegistration.report);
  }

  getBackendLifecycle(): LifecycleState {
    this.assertUsable();
    return this.current.backend.backend.getLifecycle();
  }

  getPhaseTransitions(jobId: string): Array<{ previousPhase: string; phase: string }> {
    this.assertUsable();
    return [...(this.current.phaseTransitions.get(jobId) ?? [])];
  }

  getVirtualElapsedMs(): number {
    return this.elapsedOffsetMs + (this.current.backend.runtime.time.now() - this.epochMs);
  }

  backendInfoExists(): boolean {
    this.assertUsable();
    return this.current.backend.runtime.storage.existsSync(
      this.current.backend.runtime.paths.coral.coordinator.infoFile,
    );
  }

  hasProjectSourceCache(projectRoot: string): boolean {
    this.assertUsable();
    return this.current.backend.runtime.paths
      .snapshot()
      .projectSourceCache.some(([cachedProjectRoot]) => cachedProjectRoot === projectRoot);
  }

  getKillLog(): Array<{ pid: number; signal: NodeJS.Signals | 0 }> {
    this.assertUsable();
    return this.current.backend.runtime.spawner.killCalls.map((entry) => ({ ...entry }));
  }

  isPidAlive(pid: number): boolean {
    this.assertUsable();
    return this.current.backend.runtime.process.observeLiveness(pid) === 'alive';
  }

  async teardown(): Promise<void> {
    try {
      const lifecycle = this.current.backend.backend.getLifecycle();
      if (lifecycle === 'starting' || lifecycle === 'running') {
        await this.current.backend.backend.shutdown('teardown');
      }
      if (lifecycle !== 'stopped') {
        await this.current.backend.backend.waitForShutdown();
      }
    } finally {
      this.dispose();
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.noRealIoRegistration.release();
  }

  private assertUsable(): void {
    if (this.disposed) {
      throw new Error('SimulationWorld has been disposed');
    }
  }

  private assertBooted(action: 'launch' | 'wait' | 'abort' | 'kill'): void {
    if (this.current.startedInfo === null) {
      throw new Error(`Simulation world must be booted before ${action}`);
    }
  }

  private createGenerationState(inherited?: SimulationWorldCarryOver): WorldGenerationState {
    const backend = createSimulationBackend(normalizeWorldConfig(this.initialConfig), inherited);
    const phaseTransitions = new Map<string, Array<{ previousPhase: string; phase: string }>>();

    backend.eventBus.on('job:phase_changed', ({ jobId, previousPhase, phase }) => {
      const entries = phaseTransitions.get(jobId) ?? [];
      entries.push({ previousPhase, phase });
      phaseTransitions.set(jobId, entries);
    });

    return {
      backend,
      startedInfo: null,
      phaseTransitions,
    };
  }

  private observeJob(jobId: string): WaitObservation {
    const status = this.current.backend.progressStore.readStatus(jobId);
    // A world can legitimately hold an event this build cannot decode — that is the whole subject of
    // the upgrade scenarios. Replay is a convenience here; the projection is what the assertions are
    // about, so an unreadable event must not stop the harness from observing the job at all.
    let replay: readonly JobEvent[];
    try {
      replay = this.replay(jobId);
    } catch {
      replay = [];
    }
    const replayTerminalSeen = replay.some((event) => event.type === 'terminal');

    let runtimeRecorded: boolean;
    try {
      runtimeRecorded = this.current.backend.progressStore.readRuntimeProjection(jobId) !== null;
    } catch {
      // An unreadable runtime record is still a recorded one — that is precisely the state under test.
      runtimeRecorded = true;
    }

    return {
      phase: status?.phase ?? null,
      runtimeRecorded,
      terminal:
        replayTerminalSeen ||
        Boolean(status?.result) ||
        (status !== null && status !== undefined ? isTerminalPhase(status.phase) : false),
      progress: replay
        .filter((event): event is JobEvent & { type: 'progress'; message: string } => event.type === 'progress')
        .map((event) => event.message),
      result: status?.result ?? null,
    };
  }

  private observeJobIncremental(jobId: string, cursor: ProgressCursor, accumulatedProgress: string[]): WaitObservation {
    const status = this.current.backend.progressStore.readStatus(jobId);
    const newEvents = this.current.backend.progressStore
      .readJobEvents(jobId)
      .filter((event) => event.seq > cursor.afterSeq);

    for (const event of newEvents) {
      cursor.afterSeq = Math.max(cursor.afterSeq, event.seq);
      if (event.type === 'progress' && event.message !== undefined) {
        accumulatedProgress.push(event.message);
      }
      if (event.type === 'terminal') {
        cursor.terminalSeen = true;
      }
    }

    return {
      phase: status?.phase ?? null,
      runtimeRecorded: this.current.backend.progressStore.readRuntimeProjection(jobId) !== null,
      terminal:
        cursor.terminalSeen ||
        Boolean(status?.result) ||
        (status !== null && status !== undefined ? isTerminalPhase(status.phase) : false),
      progress: accumulatedProgress,
      result: status?.result ?? null,
    };
  }

  private matchesWaitCondition(until: WaitUntil, actual: WaitObservation): boolean {
    if (until.phase !== undefined && actual.phase !== until.phase) {
      return false;
    }
    if (until.runtimeRecorded !== undefined && actual.runtimeRecorded !== until.runtimeRecorded) {
      return false;
    }
    if (until.terminal !== undefined && actual.terminal !== until.terminal) {
      return false;
    }
    if (
      until.progressContains !== undefined &&
      !actual.progress.some((entry) => entry.includes(until.progressContains as string))
    ) {
      return false;
    }
    return true;
  }

  private resolveResultArtifactPath(jobId: string): string {
    return join(this.current.backend.runtime.paths.coral.exports.jobsRoot, jobId, RESULT_FILE);
  }

  private resolveStreamArtifactPath(jobId: string, kind: 'stdout' | 'stderr'): string {
    const runtimeRecord = this.current.backend.progressStore.readRuntimeProjection(jobId);

    if (kind === 'stdout' && hasRuntimeStreamPath(runtimeRecord, 'stdoutPath')) {
      return runtimeRecord.stdoutPath;
    }
    if (kind === 'stderr' && hasRuntimeStreamPath(runtimeRecord, 'stderrPath')) {
      return runtimeRecord.stderrPath;
    }

    return join(this.current.backend.progressStore.jobDir(jobId), kind);
  }

  private readTextArtifact(path: string): string | null {
    try {
      return this.current.backend.runtime.storage.readFileSync(path, 'utf-8');
    } catch {
      return null;
    }
  }
}

export function extractRuntimePid(record: unknown): number | null {
  return hasRuntimePid(record) ? record.pid : null;
}

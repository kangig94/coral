import { join } from 'node:path';
import {
  isLivePhase,
  readBackendNamespace,
  type JobKind,
  type JobPhase,
  type LaunchState,
  type PersistedExitRecord,
  type PersistedLaunchRecord,
  type PersistedProgressRecord,
  type PersistedRuntimeRecord,
  type PersistedStatusRecord,
  type TerminalResult,
  type WorkflowCheckpoint,
} from '../shared/types.js';
import { isNoEntryError, nowIsoString } from '../shared/utils.js';
import { formatElapsed } from '../shared/format-progress.js';
import { TypedEventBus } from './event-bus.js';
import type { Runtime, RuntimeStoragePort, RuntimeTimePort } from './runtime.js';

const STATUS_FILE = 'status.json';
const PROGRESS_FILE = 'progress.jsonl';
const LAUNCH_FILE = 'launch.json';
const RUNTIME_FILE = 'runtime.json';
const EXIT_FILE = 'exit.json';
const WORKFLOW_STATE_FILE = 'workflow-state.json';
const READ_CHUNK = 8 * 1024;

export type ReplayCursor = { lastOffset: number; remainder: string };

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
  return { lastOffset: 0, remainder: '' };
}

export { formatElapsed } from '../shared/format-progress.js';

function isRuntimeLike(value: unknown): value is Pick<Runtime, 'storage' | 'time'> {
  return (
    value !== null &&
    typeof value === 'object' &&
    'storage' in value &&
    'time' in value &&
    value.storage !== null &&
    value.time !== null
  );
}

export class ProgressStore {
  private readonly namespace: string;
  private readonly storage: RuntimeStoragePort;
  private readonly time: RuntimeTimePort;
  private readonly eventCounters = new Map<string, number>();
  private readonly jobStartedAt = new Map<string, number>();
  private readonly statusCache = new Map<string, PersistedStatusRecord>();
  private readonly runtimeCache = new Map<string, PersistedRuntimeRecord | null>();
  private readonly knownJobIds = new Set<string>();
  private readonly eventBus: TypedEventBus;
  private enqueueSequence = 0;
  private liveCount = 0;
  private changeSeq = 0;
  private hydrated = false;
  private waiters: Array<() => void> = [];

  /**
   * One store per backend namespace. The constructor scans the runtime jobs
   * directory and
   * adopts only jobs that either (a) match this namespace, or (b) are legacy
   * records with no namespace field (adoptable on first access). Foreign
   * namespaces are excluded at discovery time, so every consumer of this
   * store operates on a namespace-bounded view by construction — no
   * downstream filter is required to avoid cross-namespace contamination.
   */
  constructor(namespace: string, runtime: Pick<Runtime, 'storage' | 'time'>, eventBus?: TypedEventBus);
  constructor(namespace: string, eventBus: TypedEventBus, runtime: Pick<Runtime, 'storage' | 'time'>);
  constructor(
    namespace: string,
    arg2: TypedEventBus | Pick<Runtime, 'storage' | 'time'>,
    arg3?: TypedEventBus | Pick<Runtime, 'storage' | 'time'>,
  ) {
    this.namespace = namespace;
    if (isRuntimeLike(arg2)) {
      this.storage = arg2.storage;
      this.time = arg2.time;
      this.eventBus = arg3 instanceof TypedEventBus ? arg3 : new TypedEventBus();
      return;
    }

    if (!isRuntimeLike(arg3)) {
      throw new Error('ProgressStore requires runtime-backed storage/time');
    }
    this.eventBus = arg2;
    this.storage = arg3.storage;
    this.time = arg3.time;
  }

  /** Returns the backend namespace this store is bound to. */
  getNamespace(): string {
    return this.namespace;
  }

  /**
   * Decide whether a job directory on disk should be owned by this store.
   *
   * Inclusion rules (all satisfy "this store may act on the job"):
   *   - status namespace matches this store            → my job
   *   - status namespace is null (legacy)              → adoptable
   *   - status is unreadable or corrupt                → garbage this store
   *     may need to clean up (ownership undetermined; treated as adoptable
   *     so that recovery can reclaim or delete the directory)
   *
   * The only exclusion is a readable status with an explicit foreign
   * namespace, which belongs to another live store and must not be touched.
   */
  private ownsJobOnDisk(jobId: string): boolean {
    try {
      const record = this.readStatusFromDisk(jobId);
      if (!record) return true;
      const ns = readBackendNamespace(record);
      return ns === null || ns === this.namespace;
    } catch {
      return true;
    }
  }

  getEventBus(): TypedEventBus {
    return this.eventBus;
  }

  /**
   * Returns a snapshot of the change sequence counter.
   * Pass this to `waitForChange()` to avoid missing notifications.
   */
  getChangeSeq(): number {
    return this.changeSeq;
  }

  /**
   * Waits until the change sequence advances past `sinceSeq`.
   * Returns immediately if changes have already occurred since `sinceSeq`.
   */
  waitForChange(sinceSeq: number): Promise<void> {
    if (this.changeSeq !== sinceSeq) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private notifyWaiters(): void {
    this.changeSeq++;
    const batch = this.waiters;
    this.waiters = [];
    for (const resolve of batch) resolve();
  }

  jobDir(jobId: string): string {
    return join(this.storage.jobsDir(), jobId);
  }

  resultPath(jobId: string): string {
    return join(this.jobDir(jobId), 'result.md');
  }

  private statusPath(jobId: string): string {
    return join(this.jobDir(jobId), STATUS_FILE);
  }

  private progressPath(jobId: string): string {
    return join(this.jobDir(jobId), PROGRESS_FILE);
  }

  private nextEventId(jobId: string): number {
    const current = this.eventCounters.get(jobId) ?? 0;
    const next = current + 1;
    this.eventCounters.set(jobId, next);
    return next;
  }

  liveJobCount(bundleHash?: string): number {
    this.ensureHydrated();
    if (bundleHash === undefined) {
      return this.liveCount;
    }
    let count = 0;
    for (const record of this.statusCache.values()) {
      if (isLivePhase(record.phase) && record.bundleHash === bundleHash) {
        count++;
      }
    }
    return count;
  }

  listJobIds(): string[] {
    this.ensureHydrated();
    return [...this.knownJobIds];
  }

  private applyStatusRecord(jobId: string, record: PersistedStatusRecord): void {
    const oldRecord = this.statusCache.get(jobId);
    const wasLive = oldRecord ? isLivePhase(oldRecord.phase) : false;
    const isLive = isLivePhase(record.phase);
    if (!wasLive && isLive) this.liveCount++;
    if (wasLive && !isLive) this.liveCount--;
    this.statusCache.set(jobId, { ...record });
    this.notifyWaiters();
    if (oldRecord && oldRecord.phase !== record.phase) {
      this.eventBus.emit('job:phase_changed', { jobId, phase: record.phase, previousPhase: oldRecord.phase });
    }
  }

  /** Atomic write to a job file. Tolerates missing job dir (deleted by cleanup). */
  private writeJobFile(filePath: string, content: string): boolean {
    try {
      return this.storage.writeAtomicSync(filePath, content, { encoding: 'utf-8' });
    } catch (error: unknown) {
      if (isNoEntryError(error)) return false;
      throw error;
    }
  }

  private persistStatusSync(jobId: string, record: PersistedStatusRecord): void {
    this.writeJobFile(this.statusPath(jobId), JSON.stringify(record, null, 2));
  }

  /** Create the job directory and write initial status.json. */
  initJob(opts: InitJobOptions): void {
    const {
      jobId,
      sessionId,
      provider,
      projectRoot,
      backendNamespace,
      bundleHash,
      jobKind,
      initialPhase = 'launching',
    } = opts;
    const dir = this.jobDir(jobId);
    this.storage.mkdirSync(dir, { recursive: true });
    const record: PersistedStatusRecord = {
      jobId,
      sessionId,
      provider,
      projectRoot,
      backendNamespace,
      phase: initialPhase,
      launch: { state: 'pending', updatedAt: nowIsoString(this.time) },
    };
    if (bundleHash !== undefined) {
      record.bundleHash = bundleHash;
    }
    if (jobKind !== undefined) {
      record.jobKind = jobKind;
    }
    this.persistStatusSync(jobId, record);
    this.knownJobIds.add(jobId);
    this.applyStatusRecord(jobId, record);
    this.writeJobFile(this.progressPath(jobId), '');
    this.eventBus.emit('job:created', { jobId, sessionId, provider, projectRoot });
    this.jobStartedAt.set(jobId, this.time.now());
  }

  rollbackJob(jobId: string): void {
    this.purgeFromCache(jobId);
    this.storage.rmSync(this.jobDir(jobId), { recursive: true, force: true });
  }

  /** Remove a job from all in-memory caches without touching disk. */
  purgeFromCache(jobId: string): void {
    const record = this.statusCache.get(jobId);
    if (record && isLivePhase(record.phase)) {
      this.liveCount--;
    }
    this.knownJobIds.delete(jobId);
    this.statusCache.delete(jobId);
    this.runtimeCache.delete(jobId);
    this.eventCounters.delete(jobId);
    this.jobStartedAt.delete(jobId);
  }

  /** Atomically write status.json (sync to avoid race between consecutive writes). */
  writeStatus(jobId: string, record: PersistedStatusRecord): void {
    this.persistStatusSync(jobId, record);
    this.knownJobIds.add(jobId);
    this.applyStatusRecord(jobId, record);
  }

  /** Read status.json. Returns null if not found or corrupt. */
  readStatus(jobId: string): PersistedStatusRecord | null {
    const cached = this.statusCache.get(jobId);
    if (cached) return { ...cached };

    try {
      const record = this.readStatusFromDisk(jobId);
      if (!record) return null;
      const namespace = readBackendNamespace(record);
      if (namespace !== null && namespace !== this.namespace) {
        return null;
      }
      this.knownJobIds.add(jobId);
      this.statusCache.set(jobId, { ...record });
      if (isLivePhase(record.phase)) this.liveCount++;
      return { ...record };
    } catch {
      return null;
    }
  }

  scopedLookup(jobId: string, projectRoot: string): 'found' | 'missing' | 'mismatch' {
    const status = this.readStatus(jobId);
    if (!status) return 'missing';
    if (status.projectRoot !== projectRoot) return 'mismatch';
    return 'found';
  }

  /** Update launch state in status.json (read-modify-write atomically). */
  updateLaunchState(jobId: string, state: LaunchState, message?: string): void {
    const record = this.readStatus(jobId);
    if (!record) return;
    record.launch = { state, message, updatedAt: nowIsoString(this.time) };
    this.writeStatus(jobId, record);
  }

  /** Update job phase in status.json. */
  updatePhase(jobId: string, phase: JobPhase): void {
    const record = this.readStatus(jobId);
    if (!record) return;
    record.phase = phase;
    this.writeStatus(jobId, record);
  }

  /** Append a progress event to progress.jsonl. Returns the eventId. */
  appendProgress(jobId: string, sessionId: string, message: string): number {
    const eventId = this.nextEventId(jobId);
    const startedAt = this.jobStartedAt.get(jobId);
    const elapsed = startedAt !== undefined ? this.time.now() - startedAt : 0;
    const stamped = `[${formatElapsed(elapsed)}] ${message}`;
    const entry: PersistedProgressRecord = {
      jobId,
      sessionId,
      eventId,
      type: 'progress',
      ts: nowIsoString(this.time),
      message: stamped,
    };
    try {
      this.storage.appendFileSync(this.progressPath(jobId), JSON.stringify(entry) + '\n');
    } catch {
      /* progress write must not break execution */
    }
    this.notifyWaiters();
    this.eventBus.emit('job:progress', { jobId, eventId, message: stamped });
    return eventId;
  }

  /** Append a terminal event to progress.jsonl and update status.json with terminal result. */
  appendTerminal(jobId: string, sessionId: string, result: TerminalResult, phase: JobPhase): number {
    const eventId = this.nextEventId(jobId);
    const entry: PersistedProgressRecord = {
      jobId,
      sessionId,
      eventId,
      type: 'terminal',
      ts: nowIsoString(this.time),
      result,
    };
    try {
      this.storage.appendFileSync(this.progressPath(jobId), JSON.stringify(entry) + '\n');
    } catch (error: unknown) {
      if (!isNoEntryError(error)) {
        throw error;
      }
    }
    this.knownJobIds.add(jobId);

    this.updateTerminalStatus(jobId, result, phase);
    this.clearTerminalState(jobId);
    this.eventBus.emit('job:completed', { jobId, result });
    return eventId;
  }

  markTerminalStatus(jobId: string, result: TerminalResult, phase: JobPhase): void {
    const didUpdateStatus = this.updateTerminalStatus(jobId, result, phase);
    this.clearTerminalState(jobId);
    if (!didUpdateStatus) {
      this.notifyWaiters();
    }
    this.eventBus.emit('job:completed', { jobId, result });
  }

  private updateTerminalStatus(jobId: string, result: TerminalResult, phase: JobPhase): boolean {
    const record = this.readStatus(jobId);
    if (!record) return false;
    record.phase = phase;
    record.result = result;
    this.writeStatus(jobId, record);
    return true;
  }

  private clearTerminalState(jobId: string): void {
    this.eventCounters.delete(jobId);
    this.jobStartedAt.delete(jobId);
  }

  /** Write result.md as a debugging/recovery artifact. */
  writeResultMd(jobId: string, text: string): void {
    this.writeJobFile(this.resultPath(jobId), text);
  }

  writeWorkflowResultMdOrThrow(jobId: string, text: string): void {
    const dir = this.jobDir(jobId);
    const finalPath = this.resultPath(jobId);
    this.storage.mkdirSync(dir, { recursive: true });
    if (!this.storage.writeAtomicSync(finalPath, text, { encoding: 'utf-8' })) {
      throw new Error(`Failed to write workflow result for ${jobId}`);
    }
  }

  // ── Durable launch/runtime/exit records ──────────────────────────────────

  /** Returns the next enqueue sequence number for FIFO recovery ordering. */
  nextEnqueueSequence(): number {
    return ++this.enqueueSequence;
  }

  /** Seed the enqueue counter from recovered jobs to prevent ordering collision. */
  seedEnqueueSequence(maxRecovered: number): void {
    if (maxRecovered > this.enqueueSequence) this.enqueueSequence = maxRecovered;
  }

  /** Write launch.json before queue admission. */
  writeLaunchRecord(jobId: string, record: PersistedLaunchRecord): void {
    this.storage.mkdirSync(this.jobDir(jobId), { recursive: true });
    this.writeJobFile(join(this.jobDir(jobId), LAUNCH_FILE), JSON.stringify(record, null, 2));
  }

  /** Read launch.json. Returns null if not found or corrupt. */
  readLaunchRecord(jobId: string): PersistedLaunchRecord | null {
    try {
      const data = this.storage.readFileSync(join(this.jobDir(jobId), LAUNCH_FILE), 'utf-8');
      return JSON.parse(data) as PersistedLaunchRecord;
    } catch {
      return null;
    }
  }

  /** Write runtime.json as the spawn-to-runtime commit. */
  writeRuntimeRecord(jobId: string, record: PersistedRuntimeRecord): void {
    const didWrite = this.writeJobFile(join(this.jobDir(jobId), RUNTIME_FILE), JSON.stringify(record, null, 2));
    if (didWrite) {
      this.runtimeCache.set(jobId, record);
    }
  }

  /** Read runtime.json. Returns null if not found or corrupt. */
  readRuntimeRecord(jobId: string): PersistedRuntimeRecord | null {
    const cached = this.runtimeCache.get(jobId);
    if (cached !== undefined) {
      return cached;
    }

    try {
      const data = this.storage.readFileSync(join(this.jobDir(jobId), RUNTIME_FILE), 'utf-8');
      const record = JSON.parse(data) as PersistedRuntimeRecord;
      this.runtimeCache.set(jobId, record);
      return record;
    } catch {
      this.runtimeCache.set(jobId, null);
      return null;
    }
  }

  /** Write exit.json as the completion sentinel. */
  writeExitRecord(jobId: string, record: PersistedExitRecord): void {
    this.writeJobFile(join(this.jobDir(jobId), EXIT_FILE), JSON.stringify(record, null, 2));
  }

  /** Read exit.json. Returns null if not found or corrupt. */
  readExitRecord(jobId: string): PersistedExitRecord | null {
    try {
      const data = this.storage.readFileSync(join(this.jobDir(jobId), EXIT_FILE), 'utf-8');
      return JSON.parse(data) as PersistedExitRecord;
    } catch {
      return null;
    }
  }

  /**
   * Read the last terminal payload from progress.jsonl. Returns null if not found or unreadable.
   *
   * Per-line parse failures are skipped silently — a malformed tail line (e.g. partial write
   * during a daemon crash) must NOT discard an already-found earlier terminal payload, since
   * that would silently re-introduce the Case (a) content-loss bug under a narrower failure mode.
   */
  readTerminalPayload(jobId: string): TerminalResult | null {
    let data: string;
    try {
      data = this.storage.readFileSync(this.progressPath(jobId), 'utf-8');
    } catch {
      return null;
    }
    if (data.length === 0) return null;

    let lastTerminal: TerminalResult | null = null;
    for (const line of data.split('\n')) {
      if (line.length === 0) continue;
      let record: PersistedProgressRecord;
      try {
        record = JSON.parse(line) as PersistedProgressRecord;
      } catch {
        continue;
      }
      if (record !== null && typeof record === 'object' && record.type === 'terminal') {
        lastTerminal = 'result' in record ? (record.result ?? null) : null;
      }
    }

    return lastTerminal;
  }

  /** Write workflow-state.json checkpoint. Best-effort — missing job dir is not fatal. */
  writeWorkflowCheckpoint(jobId: string, checkpoint: WorkflowCheckpoint): void {
    this.writeJobFile(join(this.jobDir(jobId), WORKFLOW_STATE_FILE), JSON.stringify(checkpoint, null, 2));
  }

  /** Read workflow-state.json checkpoint. Returns null if not found or corrupt. */
  readWorkflowCheckpoint(jobId: string): WorkflowCheckpoint | null {
    try {
      const data = this.storage.readFileSync(join(this.jobDir(jobId), WORKFLOW_STATE_FILE), 'utf-8');
      return JSON.parse(data) as WorkflowCheckpoint;
    } catch {
      return null;
    }
  }

  /** Rebind a job's namespace after service adoption. */
  rebindNamespace(jobId: string, newNamespace: string, newBundleHash?: string): void {
    const record = this.readStatus(jobId);
    if (!record) return;
    record.backendNamespace = newNamespace;
    if (newBundleHash !== undefined) {
      record.bundleHash = newBundleHash;
    }
    this.writeStatus(jobId, record);
  }

  /** Count live jobs belonging to a specific namespace (not filtered by bundleHash). */
  liveJobCountByNamespace(namespace: string): number {
    this.ensureHydrated();
    let count = 0;
    for (const record of this.statusCache.values()) {
      if (isLivePhase(record.phase) && record.backendNamespace === namespace) {
        count++;
      }
    }
    return count;
  }

  /**
   * Hydrate the event counter from persisted progress.jsonl so the next
   * appended event is exactly lastPersistedEventId + 1.
   */
  hydrateEventCounter(jobId: string): void {
    const cursor = createReplayCursor();
    const events = this.replayFrom(jobId, 0, cursor);
    let maxEventId = 0;
    for (const event of events) {
      if (event.eventId > maxEventId) maxEventId = event.eventId;
    }
    if (maxEventId > 0) {
      this.eventCounters.set(jobId, maxEventId);
    }
  }

  /** Hydrate jobStartedAt for adopted running jobs from a PersistedRuntimeRecord. */
  hydrateJobStartedAt(jobId: string, startTime: string): void {
    const ts = new Date(startTime).getTime();
    if (!Number.isNaN(ts)) {
      this.jobStartedAt.set(jobId, ts);
    }
  }

  private hasJobFile(jobId: string, fileName: string): boolean {
    try {
      this.storage.statSync(join(this.jobDir(jobId), fileName));
      return true;
    } catch {
      return false;
    }
  }

  /** Check if a launch.json exists for a job. */
  hasLaunchRecord(jobId: string): boolean {
    return this.hasJobFile(jobId, LAUNCH_FILE);
  }

  /** Check if a runtime.json exists for a job. */
  hasRuntimeRecord(jobId: string): boolean {
    return this.hasJobFile(jobId, RUNTIME_FILE);
  }

  /** Check if an exit.json exists for a job. */
  hasExitRecord(jobId: string): boolean {
    return this.hasJobFile(jobId, EXIT_FILE);
  }

  // ── Progress replay ─────────────────────────────────────────────────────

  /**
   * Replay progress events from a job starting after fromEventId (exclusive).
   * Returns all events with eventId > fromEventId, in order.
   */
  replayFrom(jobId: string, fromEventId: number, cursor: ReplayCursor): PersistedProgressRecord[] {
    const lines = this.readNewLines(this.progressPath(jobId), cursor);
    const events: PersistedProgressRecord[] = [];
    for (const line of lines) {
      try {
        const record = JSON.parse(line) as PersistedProgressRecord;
        if (typeof record.eventId === 'number' && record.eventId > fromEventId) {
          events.push(record);
        }
      } catch {
        // malformed line - skip
      }
    }
    return events;
  }

  private readNewLines(filePath: string, cursor: ReplayCursor): string[] {
    let fd: number;
    try {
      fd = this.storage.openSync(filePath, 'r');
    } catch (error: unknown) {
      if (isNoEntryError(error)) return [];
      throw error;
    }
    try {
      const chunks: string[] = [];
      const buf = Buffer.alloc(READ_CHUNK);
      let nextOffset = cursor.lastOffset;
      while (true) {
        const bytesRead = this.storage.readSync(fd, buf, 0, READ_CHUNK, nextOffset);
        if (bytesRead <= 0) break;
        nextOffset += bytesRead;
        chunks.push(buf.toString('utf-8', 0, bytesRead));
        if (bytesRead < READ_CHUNK) break;
      }
      cursor.lastOffset = nextOffset;
      if (chunks.length === 0) return [];
      const combined = cursor.remainder + chunks.join('');
      const lines = combined.split('\n');
      cursor.remainder = lines.pop() ?? '';
      return lines.filter((line) => line.length > 0);
    } finally {
      this.storage.closeSync(fd);
    }
  }

  private ensureHydrated(): void {
    if (this.hydrated) return;
    try {
      for (const entry of this.storage.readdirSync(this.storage.jobsDir(), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (!this.ownsJobOnDisk(entry.name)) continue;
        this.knownJobIds.add(entry.name);
        const record = this.readStatusFromDisk(entry.name);
        if (record && !this.statusCache.has(entry.name)) {
          this.statusCache.set(entry.name, { ...record });
          if (isLivePhase(record.phase)) this.liveCount++;
        }
      }
    } catch (error: unknown) {
      if (!isNoEntryError(error)) {
        throw error;
      }
    }
    this.hydrated = true;
  }

  private readStatusFromDisk(jobId: string): PersistedStatusRecord | null {
    try {
      const data = this.storage.readFileSync(this.statusPath(jobId), 'utf-8');
      return JSON.parse(data) as PersistedStatusRecord;
    } catch {
      return null;
    }
  }
}

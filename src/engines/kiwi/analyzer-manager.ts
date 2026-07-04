import { AsyncLocalStorage } from 'node:async_hooks';

import { backendLog } from '../../infra/backend-log.js';
import type { TimerHandle } from '../../infra/port-types.js';
import { errorMessage } from '../../infra/error-format.js';
import { decorateDispose } from '#src/expansion/scope.js';
import type { KbDeclaredAnalyzer } from '../../kb/extra-langs.js';
import type { Disposable, Runtime } from '../../runtime/ports.js';
import { inspectKiwiModelArtifact, type KiwiModelArtifactState } from './model-artifact.js';
import { loadKiwiAnalyzer, type KiwiAnalyzer } from './loader.js';

const KIWI_ANALYZER_IDLE_TTL_MS = 5 * 60 * 1000;

type ActiveKiwiHandle = {
  readonly analyzer: KiwiAnalyzer;
  readonly runtimeKey: string;
  leaseCount: number;
  closed: boolean;
};

type KiwiAnalyzerManagerOptions = {
  readonly idleTtlMs?: number;
  readonly loadAnalyzer?: (runtime: Runtime) => Promise<KiwiAnalyzer>;
  readonly inspectModelArtifact?: (runtime: Pick<Runtime, 'paths' | 'storage'>) => KiwiModelArtifactState;
  readonly logger?: (message: string) => void;
  readonly collectGarbage?: () => void;
};

type KiwiLease = {
  readonly analyzer: KiwiAnalyzer | null;
  readonly activeAnalyzers: readonly KbDeclaredAnalyzer[];
  release(): Promise<void>;
};

/** Analyzer lease state visible to Orama while a Kiwi lease is active. */
export type KiwiAnalyzerLeaseContext = {
  readonly analyzer: KiwiAnalyzer | null;
  readonly activeAnalyzers: readonly KbDeclaredAnalyzer[];
};

/** Current Kiwi analyzer lifecycle state for health/status reporting. */
export type KiwiAnalyzerManagerStatus =
  | {
      readonly state: 'unloaded';
      readonly leaseCount: 0;
    }
  | {
      readonly state: 'loading';
      readonly leaseCount: number;
    }
  | {
      readonly state: 'loaded';
      readonly leaseCount: number;
      readonly identity: KiwiAnalyzer['identity'];
    }
  | {
      readonly state: 'evicting';
      readonly leaseCount: number;
    }
  | {
      readonly state: 'degraded';
      readonly leaseCount: 0;
      readonly reason: string;
    };

export type KiwiAnalyzerLeaseReadiness =
  | {
      readonly ready: true;
    }
  | {
      readonly ready: false;
      readonly state: 'unloaded' | 'loading' | 'evicting' | 'degraded';
      readonly reason?: string;
    };

type DegradedState = {
  readonly reason: string;
  readonly modelStateKey: string;
  readonly failedAt: number;
};

export type KiwiAnalyzerDegradedEvent = {
  readonly reason: string;
  readonly modelStateKey: string;
};

export type KiwiAnalyzerDegradedObserver = (event: KiwiAnalyzerDegradedEvent) => void | Promise<void>;

/** Terminal Kiwi load failure that triggers projection degradation. */
export class KiwiAnalyzerTerminalLoadError extends Error {
  readonly degradedAnalyzers: readonly KbDeclaredAnalyzer[];

  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = 'KiwiAnalyzerTerminalLoadError';
    this.degradedAnalyzers = [];
  }
}

export function isKiwiAnalyzerTerminalLoadError(error: unknown): error is KiwiAnalyzerTerminalLoadError {
  return error instanceof KiwiAnalyzerTerminalLoadError;
}

function normalDeclaredAnalyzers(declaredAnalyzers: readonly KbDeclaredAnalyzer[]): readonly KbDeclaredAnalyzer[] {
  return [...new Set(declaredAnalyzers)].sort((left, right) => left.localeCompare(right));
}

function wantsKiwi(declaredAnalyzers: readonly KbDeclaredAnalyzer[]): boolean {
  return declaredAnalyzers.includes('ko');
}

function withoutKiwi(declaredAnalyzers: readonly KbDeclaredAnalyzer[]): readonly KbDeclaredAnalyzer[] {
  return normalDeclaredAnalyzers(declaredAnalyzers).filter((analyzer) => analyzer !== 'ko');
}

function modelStateKey(state: KiwiModelArtifactState): string {
  if (!state.installed) {
    return `missing:${state.missingFiles.join(',')}`;
  }
  const manifest = state.manifest;
  return manifest === null
    ? 'installed:unknown'
    : `installed:${manifest.kiwiNlpVersion}:${manifest.modelVersion}:${manifest.archiveSha256}:${manifest.installedAt}`;
}

function runtimeKey(runtime: Runtime): string {
  return runtime.paths.coral.engine.dataDir('kiwi');
}

function noopLease(activeAnalyzers: readonly KbDeclaredAnalyzer[]): KiwiLease {
  return {
    analyzer: null,
    activeAnalyzers,
    async release(): Promise<void> {},
  };
}

/** Owns lazy Kiwi analyzer loading, leases, idle eviction, and degradation state. */
export class KiwiAnalyzerManager {
  private readonly idleTtlMs: number;
  private readonly loadAnalyzer: (runtime: Runtime) => Promise<KiwiAnalyzer>;
  private readonly inspectModelArtifact: (runtime: Pick<Runtime, 'paths' | 'storage'>) => KiwiModelArtifactState;
  private readonly logger: (message: string) => void;
  private readonly collectGarbage?: () => void;
  private readonly leaseStorage = new AsyncLocalStorage<KiwiAnalyzer | null>();
  private activeHandle: ActiveKiwiHandle | null = null;
  private loadPromise: Promise<ActiveKiwiHandle> | null = null;
  private evictionPromise: Promise<void> | null = null;
  private idleTimer: TimerHandle | null = null;
  private idleTimerRuntime: Runtime | null = null;
  private readonly zeroLeaseWaiters: Array<() => void> = [];
  private readonly degradedObservers = new Map<Disposable, KiwiAnalyzerDegradedObserver>();
  private degraded: DegradedState | null = null;
  private lastNotifiedDegradedModelStateKey: string | null = null;

  constructor(options: KiwiAnalyzerManagerOptions = {}) {
    this.idleTtlMs = options.idleTtlMs ?? KIWI_ANALYZER_IDLE_TTL_MS;
    this.loadAnalyzer = options.loadAnalyzer ?? ((runtime) => loadKiwiAnalyzer(runtime, { installIfMissing: false }));
    this.inspectModelArtifact = options.inspectModelArtifact ?? inspectKiwiModelArtifact;
    this.logger = options.logger ?? ((message) => backendLog.warn(message));
    this.collectGarbage = options.collectGarbage;
  }

  status(): KiwiAnalyzerManagerStatus {
    if (this.evictionPromise !== null) {
      return { state: 'evicting', leaseCount: this.activeHandle?.leaseCount ?? 0 };
    }
    if (this.loadPromise !== null) {
      return { state: 'loading', leaseCount: this.activeHandle?.leaseCount ?? 0 };
    }
    if (this.activeHandle !== null && !this.activeHandle.closed) {
      return {
        state: 'loaded',
        leaseCount: this.activeHandle.leaseCount,
        identity: this.activeHandle.analyzer.identity,
      };
    }
    if (this.degraded !== null) {
      return { state: 'degraded', leaseCount: 0, reason: this.degraded.reason };
    }
    return { state: 'unloaded', leaseCount: 0 };
  }

  leaseReadiness(
    runtime: Runtime | undefined,
    declaredAnalyzers: readonly KbDeclaredAnalyzer[],
  ): KiwiAnalyzerLeaseReadiness {
    const normalized = normalDeclaredAnalyzers(declaredAnalyzers);
    if (!wantsKiwi(normalized) || runtime === undefined) {
      return { ready: true };
    }

    if (this.degraded !== null && this.modelChangedSinceFailure(runtime, this.degraded)) {
      this.degraded = null;
      this.lastNotifiedDegradedModelStateKey = null;
    }

    if (this.degraded !== null) {
      return { ready: false, state: 'degraded', reason: this.degraded.reason };
    }
    if (this.evictionPromise !== null) {
      return { ready: false, state: 'evicting' };
    }
    if (this.loadPromise !== null) {
      return { ready: false, state: 'loading' };
    }

    const key = runtimeKey(runtime);
    if (this.activeHandle !== null && !this.activeHandle.closed && this.activeHandle.runtimeKey === key) {
      return { ready: true };
    }

    return { ready: false, state: 'unloaded' };
  }

  currentAnalyzer(): KiwiAnalyzer | null {
    return this.leaseStorage.getStore() ?? null;
  }

  isTerminalLoadError(error: unknown): boolean {
    return isKiwiAnalyzerTerminalLoadError(error);
  }

  clearTerminalFailure(): void {
    this.degraded = null;
  }

  observeDegraded(scope: Disposable, observer: KiwiAnalyzerDegradedObserver): void {
    this.degradedObservers.set(scope, observer);
    decorateDispose(scope, () => {
      if (this.degradedObservers.get(scope) === observer) {
        this.degradedObservers.delete(scope);
      }
    });
  }

  effectiveDeclaredAnalyzers(
    declaredAnalyzers: readonly KbDeclaredAnalyzer[],
    runtime?: Runtime,
  ): readonly KbDeclaredAnalyzer[] {
    const normalized = normalDeclaredAnalyzers(declaredAnalyzers);
    if (!wantsKiwi(normalized)) {
      return normalized;
    }

    if (this.degraded !== null && runtime !== undefined && this.modelChangedSinceFailure(runtime, this.degraded)) {
      this.degraded = null;
      this.lastNotifiedDegradedModelStateKey = null;
    }

    return this.degraded === null ? normalized : withoutKiwi(normalized);
  }

  async withAnalyzerLease<T>(
    runtime: Runtime | undefined,
    declaredAnalyzers: readonly KbDeclaredAnalyzer[],
    run: (lease: KiwiAnalyzerLeaseContext) => T | Promise<T>,
  ): Promise<T> {
    const lease = await this.acquire(runtime, declaredAnalyzers);
    try {
      return await this.leaseStorage.run(lease.analyzer, () =>
        run({
          analyzer: lease.analyzer,
          activeAnalyzers: lease.activeAnalyzers,
        }),
      );
    } finally {
      await lease.release();
    }
  }

  async evictIdleNow(): Promise<void> {
    await this.evictLoadedAnalyzer();
  }

  async close(): Promise<void> {
    this.clearIdleTimer();
    await this.evictLoadedAnalyzer();
  }

  private async acquire(
    runtime: Runtime | undefined,
    declaredAnalyzers: readonly KbDeclaredAnalyzer[],
  ): Promise<KiwiLease> {
    const normalized = normalDeclaredAnalyzers(declaredAnalyzers);
    if (!wantsKiwi(normalized)) {
      return noopLease(normalized);
    }

    if (runtime === undefined) {
      return noopLease(normalized);
    }

    if (this.degraded !== null && this.modelChangedSinceFailure(runtime, this.degraded)) {
      this.degraded = null;
      this.lastNotifiedDegradedModelStateKey = null;
    }

    if (this.degraded !== null) {
      return noopLease(withoutKiwi(normalized));
    }

    this.clearIdleTimer();
    const handle = await this.ensureLoaded(runtime);
    handle.leaseCount += 1;
    let released = false;
    return {
      analyzer: handle.analyzer,
      activeAnalyzers: normalized,
      release: async () => {
        if (released) {
          return;
        }
        released = true;
        handle.leaseCount = Math.max(0, handle.leaseCount - 1);
        if (handle.leaseCount === 0) {
          this.resolveZeroLeaseWaiters();
          if (this.evictionPromise === null && this.activeHandle === handle) {
            this.scheduleIdleEviction(runtime);
          }
        }
      },
    };
  }

  private async ensureLoaded(runtime: Runtime): Promise<ActiveKiwiHandle> {
    await this.evictionPromise;

    const key = runtimeKey(runtime);
    if (this.activeHandle !== null && !this.activeHandle.closed && this.activeHandle.runtimeKey === key) {
      return this.activeHandle;
    }

    if (this.loadPromise !== null) {
      return this.loadPromise;
    }

    this.loadPromise = this.loadFresh(runtime, key);
    try {
      return await this.loadPromise;
    } finally {
      this.loadPromise = null;
    }
  }

  private async loadFresh(runtime: Runtime, key: string): Promise<ActiveKiwiHandle> {
    try {
      if (this.activeHandle !== null) {
        await this.disposeHandle(this.activeHandle);
      }

      const analyzer = await this.loadAnalyzer(runtime);
      const handle: ActiveKiwiHandle = {
        analyzer,
        runtimeKey: key,
        leaseCount: 0,
        closed: false,
      };
      this.activeHandle = handle;
      this.degraded = null;
      this.lastNotifiedDegradedModelStateKey = null;
      return handle;
    } catch (error: unknown) {
      this.markDegraded(runtime, error);
      throw new KiwiAnalyzerTerminalLoadError(`Kiwi analyzer load failed: ${errorMessage(error)}`, error);
    }
  }

  private markDegraded(runtime: Runtime, error: unknown): void {
    const reason = errorMessage(error);
    let stateKey: string;
    try {
      stateKey = modelStateKey(this.inspectModelArtifact(runtime));
    } catch (inspectError: unknown) {
      stateKey = `inspect-error:${errorMessage(inspectError)}`;
    }
    this.degraded = {
      reason,
      modelStateKey: stateKey,
      failedAt: runtime.time.now(),
    };
    this.logger(`[kiwi] analyzer unavailable; degrading Orama projection to Intl baseline: ${reason}`);
    this.notifyDegraded({ reason, modelStateKey: stateKey });
  }

  private notifyDegraded(event: KiwiAnalyzerDegradedEvent): void {
    if (this.lastNotifiedDegradedModelStateKey === event.modelStateKey) {
      return;
    }
    this.lastNotifiedDegradedModelStateKey = event.modelStateKey;

    for (const [scope, observer] of [...this.degradedObservers.entries()]) {
      if (this.degradedObservers.get(scope) !== observer) {
        continue;
      }
      void Promise.resolve()
        .then(() => {
          if (this.degradedObservers.get(scope) !== observer) {
            return;
          }
          return observer(event);
        })
        .catch((error: unknown) => {
          this.logger(`[kiwi] degraded observer failed: ${errorMessage(error)}`);
        });
    }
  }

  private modelChangedSinceFailure(runtime: Runtime, degraded: DegradedState): boolean {
    try {
      const state = this.inspectModelArtifact(runtime);
      return state.installed && modelStateKey(state) !== degraded.modelStateKey;
    } catch {
      return false;
    }
  }

  private scheduleIdleEviction(runtime: Runtime): void {
    const handle = this.activeHandle;
    if (handle === null || handle.closed || handle.leaseCount !== 0) {
      return;
    }

    this.clearIdleTimer();
    this.idleTimerRuntime = runtime;
    this.idleTimer = runtime.time.setTimeout(() => {
      void this.evictLoadedAnalyzer().catch((error: unknown) => {
        this.logger(`[kiwi] idle eviction failed: ${errorMessage(error)}`);
      });
    }, this.idleTtlMs);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimerRuntime !== null) {
      this.idleTimerRuntime.time.clearTimeout(this.idleTimer);
    }
    this.idleTimerRuntime = null;
    this.idleTimer = null;
  }

  private async evictLoadedAnalyzer(): Promise<void> {
    if (this.evictionPromise !== null) {
      return this.evictionPromise;
    }

    this.clearIdleTimer();
    this.evictionPromise = (async () => {
      const handle = this.activeHandle;
      if (handle === null) {
        return;
      }
      await this.disposeHandle(handle);
    })();

    try {
      await this.evictionPromise;
    } finally {
      this.evictionPromise = null;
    }
  }

  private async disposeHandle(handle: ActiveKiwiHandle): Promise<void> {
    if (handle.closed) {
      return;
    }
    if (handle.leaseCount !== 0) {
      await new Promise<void>((resolve) => {
        this.zeroLeaseWaiters.push(resolve);
      });
    }
    if (handle.closed) {
      return;
    }
    handle.closed = true;
    await handle.analyzer.dispose();
    this.collectGarbage?.();
    if (this.activeHandle === handle) {
      this.activeHandle = null;
    }
  }

  private resolveZeroLeaseWaiters(): void {
    const waiters = this.zeroLeaseWaiters.splice(0);
    for (const waiter of waiters) {
      waiter();
    }
  }
}

let singleton: KiwiAnalyzerManager | null = null;

export function getKiwiAnalyzerManager(): KiwiAnalyzerManager {
  singleton ??= new KiwiAnalyzerManager();
  return singleton;
}

export function __setKiwiAnalyzerManagerForTests(manager: KiwiAnalyzerManager | null): void {
  singleton = manager;
}

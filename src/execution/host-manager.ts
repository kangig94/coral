import { raceTimeout } from '../shared/mcp-utils.js';
import type { ProviderServerLease, ProviderServerSpec } from '../providers/types.js';
import type { ProviderServerHandle, SpawnProviderServerFn } from './engine.js';

const DEFAULT_BROKER_IDLE_MS = 300_000;
const GRACEFUL_CLOSE_FOLLOWUP_TIMEOUT_MS = 5_000;

type ProviderServerWaiter = {
  resolve: () => void;
  reject: (error: Error) => void;
  cleanup: () => void;
};

type HostStatsState = {
  liveControllers: number;
  activeTurns: number;
};

type ProviderHostEntry = {
  hostKey: string;
  spec: ProviderServerSpec;
  handle: ProviderServerHandle | null;
  spawnPromise: Promise<ProviderServerHandle> | null;
  leaseHeld: boolean;
  sharedLeaseCount: number;
  waiters: ProviderServerWaiter[];
  closingError: Error | null;
  hostStats: HostStatsState | null;
  idleTimer: NodeJS.Timeout | null;
  disposeHostNotifications: (() => void) | null;
};

export interface ProviderServerAttachment {
  rpc<R = unknown>(method: string, params: Record<string, unknown>): Promise<R>;
  subscribe(handler: (msg: { method: string; params?: Record<string, unknown> }) => void): () => void;
  closed: Promise<Error | void>;
}

export interface ProviderHostManager {
  acquireServer(spec: ProviderServerSpec, options?: { signal?: AbortSignal }): Promise<ProviderServerLease>;
  borrowLiveServer(
    spec: ProviderServerSpec,
    options: { serverGeneration?: number },
  ): Promise<ProviderServerAttachment | null>;
  drainForHandoff(): Promise<void>;
  shutdown(): Promise<void>;
}

function cloneSpec(spec: ProviderServerSpec): ProviderServerSpec {
  return {
    ...spec,
    args: [...spec.args],
    ...(spec.env ? { env: { ...spec.env } } : {}),
    ...(spec.shutdownCapability ? { shutdownCapability: { ...spec.shutdownCapability } } : {}),
  };
}

function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function waitForTimeout<T>(timeoutMs: number, value: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(value), timeoutMs);
    timer.unref?.();
  });
}

function waitForCloseWithin(closed: Promise<Error | void>, timeoutMs: number): Promise<boolean> {
  return raceTimeout(closed, timeoutMs);
}

function parseIdleTimeoutMs(raw: string | undefined): number {
  if (!raw) {
    return DEFAULT_BROKER_IDLE_MS;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return DEFAULT_BROKER_IDLE_MS;
  }
  return parsed;
}

function readHostStats(params: Record<string, unknown> | undefined): HostStatsState | null {
  if (!params) {
    return null;
  }
  const liveControllers = params.liveControllers;
  const activeTurns = params.activeTurns;
  if (
    typeof liveControllers !== 'number' ||
    !Number.isFinite(liveControllers) ||
    liveControllers < 0 ||
    typeof activeTurns !== 'number' ||
    !Number.isFinite(activeTurns) ||
    activeTurns < 0
  ) {
    return null;
  }
  return {
    liveControllers,
    activeTurns,
  };
}

export function normalizedHostEnvEntries(spec: Pick<ProviderServerSpec, 'env'>): Array<[string, string]> {
  return Object.entries(spec.env ?? {}).sort(([left], [right]) => left.localeCompare(right));
}

export function hostKeyFromSpec(spec: ProviderServerSpec): string {
  return JSON.stringify({
    provider: spec.provider,
    command: spec.command,
    args: [...spec.args],
    cwd: spec.cwd,
    env: normalizedHostEnvEntries(spec),
  });
}

export class DefaultProviderHostManager implements ProviderHostManager {
  private readonly entries = new Map<string, ProviderHostEntry>();
  private readonly idleTimeoutMs: number;
  private readonly spawnProviderServer: SpawnProviderServerFn;

  constructor(options: { idleTimeoutMs?: number; spawnProviderServer: SpawnProviderServerFn }) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? parseIdleTimeoutMs(process.env.CORAL_BROKER_IDLE_MS);
    this.spawnProviderServer = options.spawnProviderServer;
  }

  async acquireServer(spec: ProviderServerSpec, options?: { signal?: AbortSignal }): Promise<ProviderServerLease> {
    const entry = this.getOrCreateProviderServerEntry(spec);
    this.clearIdleTimer(entry);
    if (entry.spec.shared === true) {
      this.acquireSharedProviderServerLease(entry);
    } else {
      await this.waitForProviderServerLease(entry, options?.signal);
    }

    try {
      const handle = await this.ensureProviderServerHandle(entry);
      return this.createProviderServerLease(handle, entry);
    } catch (error) {
      if (entry.spec.shared === true) {
        this.releaseSharedProviderServerLease(entry);
      } else {
        this.releaseProviderServerLease(entry);
      }
      throw error;
    }
  }

  async borrowLiveServer(
    spec: ProviderServerSpec,
    options: { serverGeneration?: number },
  ): Promise<ProviderServerAttachment | null> {
    const entry = this.entries.get(hostKeyFromSpec(spec));
    if (!entry || entry.closingError) {
      return null;
    }

    const handle = entry.handle;
    if (!handle) {
      return null;
    }
    if (entry.spec.shared !== true && !entry.leaseHeld) {
      return null;
    }
    if (options.serverGeneration !== undefined && handle.generation !== options.serverGeneration) {
      return null;
    }

    this.clearIdleTimer(entry);
    return this.createProviderServerAttachment(handle);
  }

  async drainForHandoff(): Promise<void> {
    await this.closeAllProviderServerEntries('drained');
  }

  async shutdown(): Promise<void> {
    await this.closeAllProviderServerEntries('shut down');
  }

  private getOrCreateProviderServerEntry(spec: ProviderServerSpec): ProviderHostEntry {
    const hostKey = hostKeyFromSpec(spec);
    const existing = this.entries.get(hostKey);
    if (existing) {
      return existing;
    }

    const created: ProviderHostEntry = {
      hostKey,
      spec: cloneSpec(spec),
      handle: null,
      spawnPromise: null,
      leaseHeld: false,
      sharedLeaseCount: 0,
      waiters: [],
      closingError: null,
      hostStats: null,
      idleTimer: null,
      disposeHostNotifications: null,
    };
    this.entries.set(hostKey, created);
    return created;
  }

  private createProviderServerLease(handle: ProviderServerHandle, entry: ProviderHostEntry): ProviderServerLease {
    let released = false;
    return {
      rpc: <R = unknown>(method: string, params: Record<string, unknown>) => handle.rpc.request<R>(method, params),
      subscribe: (handler: (msg: { method: string; params?: Record<string, unknown> }) => void) =>
        handle.onNotification(handler),
      release: () => {
        if (released) {
          return;
        }
        released = true;
        if (entry.spec.shared === true) {
          this.releaseSharedProviderServerLease(entry);
          return;
        }
        this.releaseProviderServerLease(entry);
      },
      closed: handle.closePromise,
      generation: handle.generation,
    };
  }

  private createProviderServerAttachment(handle: ProviderServerHandle): ProviderServerAttachment {
    return {
      rpc: <R = unknown>(method: string, params: Record<string, unknown>) => handle.rpc.request<R>(method, params),
      subscribe: (handler: (msg: { method: string; params?: Record<string, unknown> }) => void) =>
        handle.onNotification(handler),
      closed: handle.closePromise,
    };
  }

  private async ensureProviderServerHandle(entry: ProviderHostEntry): Promise<ProviderServerHandle> {
    if (entry.handle) {
      return entry.handle;
    }
    if (entry.closingError) {
      throw entry.closingError;
    }
    if (entry.spawnPromise) {
      return entry.spawnPromise;
    }

    entry.spawnPromise = this.spawnProviderServer({
      provider: entry.spec.provider,
      command: entry.spec.command,
      args: entry.spec.args,
      cwd: entry.spec.cwd,
      extraEnv: entry.spec.env,
    });

    try {
      const handle = await entry.spawnPromise;
      if (entry.closingError) {
        await this.shutdownHandle(handle, entry.spec).catch(() => {});
        throw entry.closingError;
      }
      entry.handle = handle;
      this.attachHostNotificationListener(entry, handle);
      void handle.closePromise.finally(() => {
        if (entry.handle === handle) {
          entry.handle = null;
        }
        this.clearIdleTimer(entry);
        entry.disposeHostNotifications?.();
        entry.disposeHostNotifications = null;
        entry.hostStats = null;
      });
      return handle;
    } finally {
      entry.spawnPromise = null;
    }
  }

  private async waitForProviderServerLease(entry: ProviderHostEntry, signal?: AbortSignal): Promise<void> {
    if (entry.closingError) {
      throw entry.closingError;
    }
    if (!entry.leaseHeld) {
      entry.leaseHeld = true;
      return;
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const waiter: ProviderServerWaiter = {
        resolve: () => {
          if (settled) {
            return;
          }
          settled = true;
          waiter.cleanup();
          resolve();
        },
        reject: (error: Error) => {
          if (settled) {
            return;
          }
          settled = true;
          waiter.cleanup();
          reject(error);
        },
        cleanup: () => {
          signal?.removeEventListener('abort', onAbort);
          const index = entry.waiters.indexOf(waiter);
          if (index !== -1) {
            entry.waiters.splice(index, 1);
          }
        },
      };

      const onAbort = () => {
        waiter.reject(createAbortError('Aborted while waiting for a provider server lease'));
      };

      if (signal?.aborted) {
        onAbort();
        return;
      }

      signal?.addEventListener('abort', onAbort, { once: true });
      entry.waiters.push(waiter);
    });
  }

  private acquireSharedProviderServerLease(entry: ProviderHostEntry): void {
    entry.sharedLeaseCount += 1;
  }

  private releaseSharedProviderServerLease(entry: ProviderHostEntry): void {
    if (entry.sharedLeaseCount === 0) {
      return;
    }
    entry.sharedLeaseCount -= 1;
    this.maybeArmIdleTimer(entry);
  }

  private releaseProviderServerLease(entry: ProviderHostEntry): void {
    const next = entry.waiters.shift();
    if (next) {
      next.resolve();
      return;
    }
    entry.leaseHeld = false;
    this.maybeArmIdleTimer(entry);
  }

  private async closeAllProviderServerEntries(detail: string): Promise<void> {
    const entries = [...this.entries.values()];
    await Promise.all(entries.map((entry) => this.closeProviderServerEntry(entry, detail)));
  }

  private async closeProviderServerEntry(entry: ProviderHostEntry, detail: string): Promise<void> {
    this.clearIdleTimer(entry);
    entry.disposeHostNotifications?.();
    entry.disposeHostNotifications = null;
    entry.hostStats = null;
    if (!entry.closingError) {
      entry.closingError = new Error(`Provider server ${entry.spec.provider} ${detail}`);
    }
    if (this.entries.get(entry.hostKey) === entry) {
      this.entries.delete(entry.hostKey);
    }

    const waiters = entry.waiters.splice(0, entry.waiters.length);
    for (const waiter of waiters) {
      waiter.reject(entry.closingError);
    }
    entry.leaseHeld = false;
    entry.sharedLeaseCount = 0;

    const handle = entry.handle;
    entry.handle = null;
    if (handle) {
      await this.shutdownHandle(handle, entry.spec).catch(() => {});
      return;
    }

    const pendingSpawn = entry.spawnPromise;
    if (!pendingSpawn) {
      return;
    }

    const spawnedHandle = await pendingSpawn.catch(() => null);
    if (spawnedHandle) {
      await this.shutdownHandle(spawnedHandle, entry.spec).catch(() => {});
    }
  }

  private attachHostNotificationListener(entry: ProviderHostEntry, handle: ProviderServerHandle): void {
    entry.disposeHostNotifications?.();
    entry.disposeHostNotifications = null;

    if (!this.usesHostStats(entry)) {
      entry.hostStats = null;
      return;
    }

    entry.hostStats = {
      liveControllers: 0,
      activeTurns: 0,
    };
    entry.disposeHostNotifications = handle.onNotification((message) => {
      if (typeof message?.method !== 'string') {
        return;
      }
      if (message.method !== 'host/stats') {
        this.clearIdleTimer(entry);
        return;
      }

      const stats = readHostStats(message.params);
      if (!stats) {
        return;
      }
      entry.hostStats = stats;
      this.clearIdleTimer(entry);
      this.maybeArmIdleTimer(entry);
    });

    this.maybeArmIdleTimer(entry);
  }

  private usesHostStats(entry: ProviderHostEntry): boolean {
    return entry.spec.shared === true;
  }

  private activeLeaseCount(entry: ProviderHostEntry): number {
    if (entry.spec.shared === true) {
      return entry.sharedLeaseCount;
    }
    return entry.leaseHeld ? 1 : 0;
  }

  private isHostIdleFromStats(entry: ProviderHostEntry): boolean {
    return entry.hostStats?.liveControllers === 0 && entry.hostStats.activeTurns === 0;
  }

  private maybeArmIdleTimer(entry: ProviderHostEntry): void {
    if (!entry.handle || entry.closingError) {
      return;
    }
    if (entry.waiters.length > 0 || this.activeLeaseCount(entry) > 0) {
      return;
    }
    if (this.usesHostStats(entry)) {
      if (!this.isHostIdleFromStats(entry)) {
        return;
      }
    }

    this.clearIdleTimer(entry);
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = null;
      if (!this.canCloseIdleHost(entry)) {
        return;
      }
      void this.closeProviderServerEntry(entry, 'idle timeout expired').catch(() => {});
    }, this.idleTimeoutMs);
    entry.idleTimer.unref?.();
  }

  private canCloseIdleHost(entry: ProviderHostEntry): boolean {
    if (entry.closingError || this.entries.get(entry.hostKey) !== entry || !entry.handle) {
      return false;
    }
    if (entry.waiters.length > 0 || this.activeLeaseCount(entry) > 0) {
      return false;
    }
    if (this.usesHostStats(entry)) {
      return this.isHostIdleFromStats(entry);
    }
    return true;
  }

  private clearIdleTimer(entry: ProviderHostEntry): void {
    if (!entry.idleTimer) {
      return;
    }
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }

  private async shutdownHandle(handle: ProviderServerHandle, spec: ProviderServerSpec): Promise<void> {
    const capability = spec.shutdownCapability;
    if (capability) {
      const closedGracefully = await this.tryGracefulShutdown(handle, capability);
      if (closedGracefully) {
        return;
      }
    }

    await handle.close().catch(() => {});
  }

  private async tryGracefulShutdown(
    handle: ProviderServerHandle,
    capability: NonNullable<ProviderServerSpec['shutdownCapability']>,
  ): Promise<boolean> {
    handle.markExpectedClose();

    try {
      const outcome = await Promise.race([
        handle.rpc.request(capability.method, {}).then(() => 'rpc' as const),
        handle.closePromise.then(() => 'closed' as const),
        waitForTimeout(capability.timeoutMs, 'timeout' as const),
      ]);
      if (outcome === 'timeout') {
        return false;
      }
      if (outcome === 'rpc') {
        return waitForCloseWithin(handle.closePromise, GRACEFUL_CLOSE_FOLLOWUP_TIMEOUT_MS);
      }
      return true;
    } catch {
      return waitForCloseWithin(handle.closePromise, capability.timeoutMs);
    }
  }
}

export function createProviderHostManager(
  options: {
    idleTimeoutMs?: number;
    spawnProviderServer: SpawnProviderServerFn;
  },
): ProviderHostManager {
  return new DefaultProviderHostManager(options);
}

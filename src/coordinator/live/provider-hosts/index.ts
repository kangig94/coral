import type { ProviderServerLease, ProviderServerSpec } from '../../../providers/contract.js';
import type { ProviderServerHandle, SpawnProviderServerFn } from '../provider-server-transport.js';
import type { Runtime } from '../../../runtime/ports.js';
import {
  acquireSharedProviderServerLease,
  createProviderServerAttachment,
  createProviderServerLease,
  releaseProviderServerLease,
  releaseSharedProviderServerLease,
  waitForProviderServerLease,
} from './lease.js';
import { attachHostNotificationListener, clearIdleTimer, maybeArmIdleTimer, parseIdleTimeoutMs } from './idle.js';
import { closeAllProviderServerEntries, closeProviderServerEntry, shutdownHandle } from './drain.js';
import { cloneSpec, ensureProviderServerHandle } from './recovery.js';
import { hostKeyFromSpec, type ProviderHostEntry, type ProviderServerAttachment } from './state.js';
export type { ProviderHostEntry, ProviderServerAttachment } from './state.js';

export interface ProviderHostManager {
  acquireServer(spec: ProviderServerSpec, options?: { signal?: AbortSignal }): Promise<ProviderServerLease>;
  borrowLiveServer(
    spec: ProviderServerSpec,
    options: { serverGeneration?: number },
  ): Promise<ProviderServerAttachment | null>;
  drainForHandoff(signal?: AbortSignal): Promise<void>;
  shutdown(signal?: AbortSignal): Promise<void>;
}

export { hostKeyFromSpec } from './state.js';

export class DefaultProviderHostManager implements ProviderHostManager {
  private readonly entries = new Map<string, ProviderHostEntry>();
  private readonly idleTimeoutMs: number;
  private readonly spawnProviderServer: SpawnProviderServerFn;
  private readonly runtime: Pick<Runtime, 'time' | 'env'>;

  constructor(options: {
    runtime: Pick<Runtime, 'time' | 'env'>;
    idleTimeoutMs?: number;
    spawnProviderServer: SpawnProviderServerFn;
  }) {
    this.runtime = options.runtime;
    this.idleTimeoutMs = options.idleTimeoutMs ?? parseIdleTimeoutMs(this.runtime.env.get('CORAL_BROKER_IDLE_MS'));
    this.spawnProviderServer = options.spawnProviderServer;
  }

  async acquireServer(spec: ProviderServerSpec, options?: { signal?: AbortSignal }): Promise<ProviderServerLease> {
    const entry = this.getOrCreateProviderServerEntry(spec);
    this.clearIdleTimer(entry);
    if (entry.spec.shared === true) {
      acquireSharedProviderServerLease(entry);
    } else {
      await waitForProviderServerLease(entry, options?.signal);
    }

    try {
      const handle = await ensureProviderServerHandle(entry, {
        spawnProviderServer: (nextSpec) =>
          this.spawnProviderServer({
            provider: nextSpec.provider,
            command: nextSpec.command,
            args: nextSpec.args,
            cwd: nextSpec.cwd,
            extraEnv: nextSpec.env,
            ...(options?.signal ? { signal: options.signal } : {}),
            initializeRequest: nextSpec.initializeRequest,
          }),
        runtime: this.runtime,
        shutdownHandle: (handle, nextSpec) => this.shutdownHandle(handle, nextSpec),
        attachHostNotificationListener: (nextEntry, handle) => this.attachHostNotificationListener(nextEntry, handle),
        clearIdleTimer: (nextEntry) => this.clearIdleTimer(nextEntry),
      });
      return createProviderServerLease(
        handle,
        entry,
        (nextEntry) => this.releaseSharedProviderServerLease(nextEntry),
        (nextEntry) => this.releaseProviderServerLease(nextEntry),
      );
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
    return createProviderServerAttachment(handle);
  }

  async drainForHandoff(signal?: AbortSignal): Promise<void> {
    await closeAllProviderServerEntries(
      this.entries,
      'drained',
      (entry, detail, options) => this.closeProviderServerEntry(entry, detail, options),
      signal === undefined ? {} : { signal },
    );
  }

  async shutdown(signal?: AbortSignal): Promise<void> {
    await closeAllProviderServerEntries(
      this.entries,
      'shut down',
      (entry, detail, options) => this.closeProviderServerEntry(entry, detail, options),
      signal === undefined ? {} : { signal },
    );
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

  private releaseSharedProviderServerLease(entry: ProviderHostEntry): void {
    releaseSharedProviderServerLease(entry, (nextEntry) => this.maybeArmIdleTimer(nextEntry));
  }

  private releaseProviderServerLease(entry: ProviderHostEntry): void {
    releaseProviderServerLease(entry, (nextEntry) => this.maybeArmIdleTimer(nextEntry));
  }

  private attachHostNotificationListener(entry: ProviderHostEntry, handle: ProviderServerHandle): void {
    attachHostNotificationListener(entry, handle, {
      runtime: this.runtime,
      idleTimeoutMs: this.idleTimeoutMs,
      entries: this.entries,
      closeProviderServerEntry: (nextEntry, detail) => this.closeProviderServerEntry(nextEntry, detail),
    });
  }

  private maybeArmIdleTimer(entry: ProviderHostEntry): void {
    maybeArmIdleTimer(entry, {
      runtime: this.runtime,
      idleTimeoutMs: this.idleTimeoutMs,
      entries: this.entries,
      closeProviderServerEntry: (nextEntry, detail) => this.closeProviderServerEntry(nextEntry, detail),
    });
  }

  private clearIdleTimer(entry: ProviderHostEntry): void {
    clearIdleTimer(entry, this.runtime.time);
  }

  private async closeProviderServerEntry(
    entry: ProviderHostEntry,
    detail: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    await closeProviderServerEntry(entry, detail, {
      runtime: this.runtime,
      entries: this.entries,
      shutdownHandle: (handle, spec) => this.shutdownHandle(handle, spec),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  private async shutdownHandle(handle: ProviderServerHandle, spec: ProviderServerSpec): Promise<void> {
    await shutdownHandle(handle, spec, this.runtime.time);
  }
}

export function createProviderHostManager(options: {
  runtime: Pick<Runtime, 'time' | 'env'>;
  idleTimeoutMs?: number;
  spawnProviderServer: SpawnProviderServerFn;
}): ProviderHostManager {
  return new DefaultProviderHostManager(options);
}

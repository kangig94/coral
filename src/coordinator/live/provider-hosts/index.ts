import type { ProviderServerLaunch, ProviderServerLease, ProviderServerSpec } from '../../../providers/contract.js';
import type { ProviderServerHandle, SpawnProviderServerFn } from '../provider-server-transport.js';
import type { Runtime } from '../../../runtime/ports.js';
import {
  acquireSharedProviderServerLease,
  createProviderServerAttachment,
  createProviderServerLease,
  releaseProviderServerLease,
  releaseSharedProviderServerLease,
} from './lease.js';
import { attachHostNotificationListener, clearIdleTimer, maybeArmIdleTimer, parseIdleTimeoutMs } from './idle.js';
import { closeAllProviderServerEntries, closeProviderServerEntry as closeEntry, shutdownHandle } from './drain.js';
import { cloneSpec, ensureProviderServerHandle } from './recovery.js';
import { hostKeyFromSpec, type ProviderHostEntry, type ProviderServerAttachment } from './state.js';
import { AbortError, throwIfAborted } from '../../../runtime/abort.js';
export type { ProviderHostEntry, ProviderServerAttachment } from './state.js';

export interface ProviderHostManager {
  acquireServer(
    launch: ProviderServerLaunch,
    options?: { jobId?: string; signal?: AbortSignal },
  ): Promise<ProviderServerLease>;
  borrowLiveServer(
    spec: ProviderServerSpec,
    options: { serverGeneration?: number; jobId?: string },
  ): Promise<ProviderServerAttachment | null>;
  drainForHandoff(signal?: AbortSignal): Promise<void>;
  shutdown(signal?: AbortSignal): Promise<void>;
}

export { hostKeyFromSpec } from './state.js';

function foldedKey(key: string, platform: string): string {
  return platform === 'win32' ? key.toLowerCase() : key;
}

function compileLaunchEnvironment(launch: ProviderServerLaunch, platform: string): Readonly<Record<string, string>> {
  const stable = launch.host.env ?? {};
  const additions = launch.turnEnv;
  rejectCaseFoldedDuplicates(stable, platform, 'stable host environment');
  rejectCaseFoldedDuplicates(additions, platform, 'turn environment');
  if (launch.host.leaseMode === 'shared' && Object.keys(additions).length > 0) {
    throw new Error('provider_host_policy_invalid: shared host launch must not contain turn environment additions');
  }
  const stableKeys = new Map(Object.keys(stable).map((key) => [foldedKey(key, platform), key]));
  for (const key of Object.keys(additions)) {
    const stableKey = stableKeys.get(foldedKey(key, platform));
    if (stableKey !== undefined) {
      throw new Error(
        `provider_host_environment_conflict: turn environment '${key}' redefines stable host binding '${stableKey}'`,
      );
    }
  }
  return Object.freeze({ ...stable, ...additions });
}

function rejectCaseFoldedDuplicates(
  environment: Readonly<Record<string, string>>,
  platform: string,
  label: string,
): void {
  const keys = new Map<string, string>();
  for (const key of Object.keys(environment)) {
    const folded = foldedKey(key, platform);
    const prior = keys.get(folded);
    if (prior !== undefined && prior !== key) {
      throw new Error(
        `provider_host_environment_conflict: ${label} contains case-fold duplicate '${prior}' and '${key}'`,
      );
    }
    keys.set(folded, key);
  }
}

function waitForClose(operation: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return operation;
  if (signal.aborted) {
    return Promise.reject(new AbortError({ stage: 'provider_host_close_wait', reason: signal.reason }));
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(new AbortError({ stage: 'provider_host_close_wait', reason: signal.reason }));
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error('Provider host close failed.', { cause: error }));
      },
    );
  });
}

export class DefaultProviderHostManager implements ProviderHostManager {
  private readonly entries = new Map<string, ProviderHostEntry>();
  private readonly leasePolicies = new Map<string, ProviderServerSpec['leaseMode']>();
  private readonly pendingCloses = new Set<Promise<void>>();
  private exclusiveSequence = 0;
  private acceptingAcquisitions = true;
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

  async acquireServer(
    launch: ProviderServerLaunch,
    options?: { jobId?: string; signal?: AbortSignal },
  ): Promise<ProviderServerLease> {
    if (!this.acceptingAcquisitions) {
      throw new Error('provider_host_draining: provider host manager no longer accepts acquisitions');
    }
    if (options?.signal !== undefined) {
      throwIfAborted(options.signal, 'provider_host_acquire');
    }
    const spec = launch.host;
    if (spec.leaseMode === 'job-exclusive' && options?.jobId === undefined) {
      throw new Error('provider_host_policy_invalid: job-exclusive acquisition requires a job id');
    }
    const exactEnv = compileLaunchEnvironment(launch, this.runtime.env.platform());
    const entry = this.getOrCreateProviderServerEntry(spec, exactEnv, options?.jobId);
    this.clearIdleTimer(entry);
    if (entry.spec.leaseMode === 'shared') {
      acquireSharedProviderServerLease(entry);
    } else {
      entry.leaseHeld = true;
    }

    try {
      const handle = await ensureProviderServerHandle(entry, {
        spawnProviderServer: (nextSpec) =>
          this.spawnProviderServer({
            provider: nextSpec.provider,
            command: nextSpec.command,
            args: nextSpec.args,
            cwd: nextSpec.cwd,
            exactEnv: entry.exactEnv,
            ...(nextSpec.leaseMode === 'job-exclusive' && options?.signal ? { signal: options.signal } : {}),
            initializeRequest: nextSpec.initializeRequest,
            initializeTimeoutMs: nextSpec.initializeTimeoutMs,
          }),
        runtime: this.runtime,
        shutdownHandle: (handle, nextSpec) => this.shutdownHandle(handle, nextSpec),
        attachHostNotificationListener: (nextEntry, handle) => this.attachHostNotificationListener(nextEntry, handle),
        clearIdleTimer: (nextEntry) => this.clearIdleTimer(nextEntry),
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      });
      if (options?.signal !== undefined) {
        throwIfAborted(options.signal, 'provider_host_acquire_complete');
      }
      if (
        !this.acceptingAcquisitions ||
        this.entries.get(entry.hostKey) !== entry ||
        entry.closingError !== null ||
        entry.handle !== handle
      ) {
        throw entry.closingError ?? new Error('provider_host_draining: provider host acquisition lost drain race');
      }
      return createProviderServerLease(
        handle,
        entry,
        (nextEntry) => this.releaseSharedProviderServerLease(nextEntry),
        (nextEntry) => this.releaseProviderServerLease(nextEntry),
      );
    } catch (error) {
      if (entry.spec.leaseMode === 'shared') {
        this.releaseSharedProviderServerLease(entry);
      } else {
        this.releaseProviderServerLease(entry);
      }
      throw error;
    }
  }

  async borrowLiveServer(
    spec: ProviderServerSpec,
    options: { serverGeneration?: number; jobId?: string },
  ): Promise<ProviderServerAttachment | null> {
    const identityKey = hostKeyFromSpec(spec);
    if (this.leasePolicies.get(identityKey) !== spec.leaseMode) return null;
    if (spec.leaseMode === 'job-exclusive' && (options.serverGeneration === undefined || options.jobId === undefined)) {
      return null;
    }
    const candidates = [...this.entries.values()].filter(
      (entry) =>
        entry.identityKey === identityKey &&
        entry.spec.leaseMode === spec.leaseMode &&
        !entry.closingError &&
        entry.handle !== null &&
        (spec.leaseMode !== 'job-exclusive' || entry.jobId === options.jobId),
    );
    const matching =
      options.serverGeneration === undefined
        ? candidates
        : candidates.filter((entry) => entry.handle?.generation === options.serverGeneration);
    if (matching.length !== 1) {
      return null;
    }
    const entry = matching[0];
    if (entry === undefined) return null;

    const handle = entry.handle;
    if (!handle) {
      return null;
    }
    if (entry.spec.leaseMode === 'job-exclusive' && !entry.leaseHeld) {
      return null;
    }
    if (options.serverGeneration !== undefined && handle.generation !== options.serverGeneration) {
      return null;
    }

    this.clearIdleTimer(entry);
    return createProviderServerAttachment(handle);
  }

  async drainForHandoff(signal?: AbortSignal): Promise<void> {
    await this.stopAndClose('drained', signal);
  }

  async shutdown(signal?: AbortSignal): Promise<void> {
    await this.stopAndClose('shut down', signal);
  }

  private async stopAndClose(detail: string, signal?: AbortSignal): Promise<void> {
    this.acceptingAcquisitions = false;
    await closeAllProviderServerEntries(
      this.entries,
      detail,
      (entry, detail, options) => this.closeProviderServerEntry(entry, detail, options),
      signal === undefined ? {} : { signal },
    );
    await waitForClose(
      Promise.all([...this.pendingCloses]).then(() => {}),
      signal,
    );
  }

  private getOrCreateProviderServerEntry(
    spec: ProviderServerSpec,
    exactEnv: Readonly<Record<string, string>>,
    jobId: string | undefined,
  ): ProviderHostEntry {
    const identityKey = hostKeyFromSpec(spec);
    const existingPolicy = this.leasePolicies.get(identityKey);
    if (existingPolicy !== undefined && existingPolicy !== spec.leaseMode) {
      throw new Error(
        `provider_host_policy_conflict: executable identity requested as '${spec.leaseMode}' after '${existingPolicy}'`,
      );
    }
    this.leasePolicies.set(identityKey, spec.leaseMode);
    if (spec.leaseMode === 'shared') {
      const existing = this.entries.get(identityKey);
      if (existing) return existing;
    }

    const hostKey = spec.leaseMode === 'shared' ? identityKey : `${identityKey}\u0000job-${++this.exclusiveSequence}`;

    const created: ProviderHostEntry = {
      hostKey,
      identityKey,
      spec: cloneSpec(spec),
      exactEnv: Object.freeze({ ...exactEnv }),
      ...(jobId === undefined ? {} : { jobId }),
      handle: null,
      spawnPromise: null,
      leaseHeld: false,
      sharedLeaseCount: 0,
      closingError: null,
      closePromise: null,
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
    releaseProviderServerLease(entry);
    void this.closeProviderServerEntry(entry, 'job-exclusive lease released').catch(() => {});
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
    if (entry.closePromise === null) {
      const operation = closeEntry(entry, detail, {
        runtime: this.runtime,
        entries: this.entries,
        shutdownHandle: (handle, spec) => this.shutdownHandle(handle, spec),
      });
      entry.closePromise = operation;
      this.pendingCloses.add(operation);
      void operation.then(
        () => this.pendingCloses.delete(operation),
        () => this.pendingCloses.delete(operation),
      );
    }
    await waitForClose(entry.closePromise, options.signal);
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

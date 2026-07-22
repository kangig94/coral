import type { AppServerTransport, HostRef, ProviderServerSpec } from '../../../providers/contract.js';
import type { ProviderServerHandle, SpawnProviderServerFn } from '../provider-server-transport.js';
import type { Runtime } from '../../../runtime/ports.js';
import {
  acquireProviderHostPin,
  createProviderServerAttachment,
  createProviderServerLease,
  releaseProviderHostPin,
  type ProviderServerLease,
} from './lease.js';
import { attachHostNotificationListener, clearIdleTimer, maybeArmIdleTimer, parseIdleTimeoutMs } from './idle.js';
import { closeAllProviderServerEntries, closeProviderServerEntry as closeEntry, shutdownHandle } from './drain.js';
import { cloneSpec, ensureProviderServerHandle } from './recovery.js';
import { hostFingerprintFromSpec, hostKeyFromSpec, hostRefFromEntry, type ProviderHostEntry } from './state.js';
import { AbortError, throwIfAborted } from '../../../runtime/abort.js';
export type { ProviderHostEntry } from './state.js';

export interface ProviderHostManager {
  openSession(
    spec: ProviderServerSpec,
    options?: { jobId?: string; signal?: AbortSignal },
  ): Promise<ManagedAppServerSession>;
  attachSession(
    hostRef: HostRef,
    expectation: Readonly<{ spec: ProviderServerSpec; jobId: string }>,
  ): Promise<ManagedAppServerSession | null>;
  drainForHandoff(signal?: AbortSignal): Promise<void>;
  shutdown(signal?: AbortSignal): Promise<void>;
}

export type ProviderHostLifecycle = Pick<ProviderHostManager, 'drainForHandoff' | 'shutdown'>;

export type ManagedAppServerSession = Readonly<{
  session: AppServerTransport;
  hostRef: HostRef;
  close(): void;
}>;

export { hostKeyFromSpec } from './state.js';

function foldedKey(key: string, platform: string): string {
  return platform === 'win32' ? key.toLowerCase() : key;
}

function compileLaunchEnvironment(spec: ProviderServerSpec, platform: string): Readonly<Record<string, string>> {
  const environment = spec.env ?? {};
  rejectCaseFoldedDuplicates(environment, platform, 'stable host environment');
  return Object.freeze({ ...environment });
}

function assertProviderHostPolicy(spec: ProviderServerSpec): void {
  const value = spec as unknown as Record<string, unknown>;
  if (value.leaseMode === 'shared') {
    if (value.idlePolicy === 'host-stats' || value.idlePolicy === 'daemon') return;
    throw new Error("provider_host_policy_invalid: shared hosts require idlePolicy 'host-stats' or 'daemon'");
  }
  if (value.leaseMode === 'job-exclusive') {
    if (!Object.hasOwn(value, 'idlePolicy')) return;
    throw new Error('provider_host_policy_invalid: job-exclusive hosts cannot declare idlePolicy');
  }
  throw new Error("provider_host_policy_invalid: leaseMode must be 'shared' or 'job-exclusive'");
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

function isExactHostRef(value: HostRef): boolean {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof value.provider !== 'string' ||
    typeof value.instanceId !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.fingerprint)
  ) {
    return false;
  }
  const keys = Object.keys(value).sort();
  if (value.leaseMode === 'shared') {
    return keys.join('\0') === ['fingerprint', 'instanceId', 'leaseMode', 'provider'].join('\0');
  }
  return (
    value.leaseMode === 'job-exclusive' &&
    typeof value.ownerJobId === 'string' &&
    keys.join('\0') === ['fingerprint', 'instanceId', 'leaseMode', 'ownerJobId', 'provider'].join('\0')
  );
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
  private readonly pendingCloses = new Set<Promise<void>>();
  private readonly lifecyclePolicies = new Map<string, string>();
  private exclusiveSequence = 0;
  private acceptingAcquisitions = true;
  private readonly idleTimeoutMs: number;
  private readonly spawnProviderServer: SpawnProviderServerFn;
  private readonly runtime: Pick<Runtime, 'time' | 'env' | 'ids'>;

  constructor(options: {
    runtime: Pick<Runtime, 'time' | 'env' | 'ids'>;
    idleTimeoutMs?: number;
    spawnProviderServer: SpawnProviderServerFn;
  }) {
    this.runtime = options.runtime;
    this.idleTimeoutMs = options.idleTimeoutMs ?? parseIdleTimeoutMs(this.runtime.env.get('CORAL_BROKER_IDLE_MS'));
    this.spawnProviderServer = options.spawnProviderServer;
  }

  private async acquireHostLease(
    spec: ProviderServerSpec,
    options?: { jobId?: string; signal?: AbortSignal },
  ): Promise<Readonly<{ lease: ProviderServerLease; entry: ProviderHostEntry }>> {
    if (!this.acceptingAcquisitions) {
      throw new Error('provider_host_draining: provider host manager no longer accepts acquisitions');
    }
    if (options?.signal !== undefined) {
      throwIfAborted(options.signal, 'provider_host_acquire');
    }
    assertProviderHostPolicy(spec);
    if (spec.leaseMode === 'job-exclusive' && options?.jobId === undefined) {
      throw new Error('provider_host_policy_invalid: job-exclusive acquisition requires a job id');
    }
    const exactEnv = compileLaunchEnvironment(spec, this.runtime.env.platform());
    const entry = this.getOrCreateProviderServerEntry(spec, exactEnv, options?.jobId);
    this.clearIdleTimer(entry);
    acquireProviderHostPin(entry);

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
        removeEntry: (nextEntry) => {
          if (this.entries.get(nextEntry.hostKey) === nextEntry) this.entries.delete(nextEntry.hostKey);
        },
        createInstanceId: () => this.runtime.ids.uuid(),
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
      return Object.freeze({
        lease: createProviderServerLease(handle, () => this.releaseHostPin(entry)),
        entry,
      });
    } catch (error) {
      this.releaseHostPin(entry);
      throw error;
    }
  }

  async openSession(
    spec: ProviderServerSpec,
    options?: { jobId?: string; signal?: AbortSignal },
  ): Promise<ManagedAppServerSession> {
    const { lease, entry } = await this.acquireHostLease(spec, options);
    return this.managedSession(lease, hostRefFromEntry(entry));
  }

  async attachSession(
    hostRef: HostRef,
    expectation: Readonly<{ spec: ProviderServerSpec; jobId: string }>,
  ): Promise<ManagedAppServerSession | null> {
    if (!this.acceptingAcquisitions || !isExactHostRef(hostRef)) return null;
    if (
      expectation.spec.provider !== hostRef.provider ||
      expectation.spec.leaseMode !== hostRef.leaseMode ||
      hostFingerprintFromSpec(expectation.spec) !== hostRef.fingerprint ||
      (hostRef.leaseMode === 'job-exclusive' && hostRef.ownerJobId !== expectation.jobId)
    ) {
      return null;
    }
    const candidates = [...this.entries.values()].filter(
      (entry) =>
        entry.spec.provider === hostRef.provider &&
        hostFingerprintFromSpec(entry.spec) === hostRef.fingerprint &&
        entry.spec.leaseMode === hostRef.leaseMode &&
        entry.instanceId === hostRef.instanceId &&
        (hostRef.leaseMode !== 'job-exclusive' || entry.jobId === hostRef.ownerJobId) &&
        entry.closingError === null,
    );
    if (candidates.length !== 1) return null;
    const handle = candidates[0]?.handle;
    if (handle === null || handle === undefined || handle.isClosed()) return null;
    const entry = candidates[0];
    if (entry === undefined) return null;
    this.clearIdleTimer(entry);
    acquireProviderHostPin(entry);
    let closed = false;
    return Object.freeze({
      session: createProviderServerAttachment(handle),
      hostRef,
      close: () => {
        if (closed) return;
        closed = true;
        this.releaseHostPin(entry);
      },
    });
  }

  private managedSession(lease: ProviderServerLease, hostRef: HostRef): ManagedAppServerSession {
    return Object.freeze({
      session: Object.freeze({
        rpc: lease.rpc.bind(lease),
        subscribe: lease.subscribe.bind(lease),
        closed: lease.closed,
      }),
      hostRef,
      close: () => lease.release(),
    });
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
    const requestedPolicy = spec.leaseMode === 'shared' ? `${spec.leaseMode}:${spec.idlePolicy}` : spec.leaseMode;
    const existingPolicy = this.lifecyclePolicies.get(identityKey);
    if (existingPolicy !== undefined && existingPolicy !== requestedPolicy) {
      throw new Error(
        `provider_host_policy_conflict: executable identity requested as '${requestedPolicy}' after '${existingPolicy}'`,
      );
    }
    this.lifecyclePolicies.set(identityKey, requestedPolicy);
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
      ...(spec.leaseMode === 'job-exclusive' && jobId !== undefined ? { jobId } : {}),
      handle: null,
      instanceId: null,
      spawnPromise: null,
      pinCount: 0,
      closingError: null,
      closePromise: null,
      hostStats: null,
      idleTimer: null,
      disposeHostNotifications: null,
    };
    this.entries.set(hostKey, created);
    return created;
  }

  private releaseHostPin(entry: ProviderHostEntry): void {
    releaseProviderHostPin(entry);
    if (entry.pinCount > 0 || entry.closingError !== null) return;
    if (entry.spec.leaseMode === 'shared') {
      this.maybeArmIdleTimer(entry);
      return;
    }
    void this.closeProviderServerEntry(entry, 'job-exclusive host unpinned').catch(() => {});
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
  runtime: Pick<Runtime, 'time' | 'env' | 'ids'>;
  idleTimeoutMs?: number;
  spawnProviderServer: SpawnProviderServerFn;
}): ProviderHostManager {
  return new DefaultProviderHostManager(options);
}

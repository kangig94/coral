import { errorMessage } from '../infra/error-format.js';
import { isRecord } from '../infra/json.js';
import { probeProcessStartedAtSeconds } from '../infra/node-process.js';
import { MAX_BUFFER, SIGTERM_GRACE_MS } from '../infra/process-constants.js';
import { shouldUseWindowsCommandShell } from '../infra/windows-shell.js';
import { AbortError } from '../runtime/abort.js';
import type { Runtime } from '../runtime/ports.js';
import { createBuiltInProviderRegistry } from '../providers/bootstrap.js';
import { providerRequestFailed } from '../providers/fault.js';
import {
  isAbortStopCause,
  type AppServerTransport,
  type HostRef,
  type ProviderEventBody,
  type ProviderServerSpec,
  type ProviderStopCause,
} from '../providers/contract.js';
import type { AppServerHostAuthority, ManagedHostSession } from '../providers/internal/app-server-host.js';
import type {
  BoundProvider,
  BoundProviderAppServerExecutionRuntime,
  BoundProviderExecutionPreparationInput,
  BoundProviderHostPreparationInput,
} from '../providers/bound-provider-contract.js';
import { MAX_PROVIDER_REPLAY_BYTES, MAX_PROVIDER_REPLAY_EVENTS, type ProviderOperationKey } from './ledger.js';
import type { Proxy, SemanticOperationHost } from './proxy.js';
import type { ProxyPreparedAppServerOperation } from './protocol.js';

/**
 * Reconstructs and runs the live Claude/Codex kernel inside the proxy process.
 *
 * The coordinator never runs a kernel after proxy admission (plan §"Process topology, endpoint, guardian, and
 * authentication"): it prepares strict data and transactionally applies acknowledged semantic events. This
 * module is where that data turns back into a running `BoundProvider` — the proxy-local mirror of what
 * `src/jobs/shell/launch.ts` does in-process, minus everything that only makes sense with store/journal access.
 *
 * Judgement call (see the task report): a proxy-local `DefaultProviderHostManager`
 * (`src/coordinator/live/provider-hosts/index.ts`) is not legitimate here — every module that implements it
 * lives under `src/coordinator/live/`, which `tests/invariants/architecture-layering.test.ts`'s
 * `PROVIDER_PROXY_FORBIDDEN` list and `tests/invariants/provider-proxy-no-store.test.ts`'s transitive
 * reachability check both forbid `src/provider-proxy/**` from reaching, at any depth — reusing it would also
 * recurse into `ensureProxySetFor`, which spawns a *fresh* guardian/reaper/proxy set on demand. Those raw
 * primitives (`spawnProviderServerTransport`, `provider-hosts/{state,lease,idle,recovery,drain}.ts`) have no
 * coordinator or store dependency of their own — they import only `infra/`, `runtime/`, and
 * `providers/contract.ts` — so they are misplaced under `coordinator/live/` for this plan's purposes, not
 * actually coordinator-specific. Relocating them was out of this task's delegated scope (only
 * `semantic-operation.ts` and `role-main.ts`), so this file instead implements a narrower, proxy-owned host
 * authority below, built from the same `Runtime.process` primitive the coordinator's version uses. See the
 * task report for the fuller reasoning and the accepted duplication this leaves behind.
 */

// --- proxy-owned raw app-server child transport --------------------------------------------------------

const APP_SERVER_MAX_LINE_BYTES = MAX_BUFFER;
const APP_SERVER_INITIALIZE_TIMEOUT_MS = 30_000;
const APP_SERVER_SHUTDOWN_RPC_TIMEOUT_MS = 3_000;

type PendingAppServerRequest = Readonly<{
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
}>;

type SpawnedAppServer = Readonly<{
  pid: number;
  processStartedAtSeconds: number;
  transport: AppServerTransport;
  /** Best-effort graceful shutdown (the spec's own `shutdownCapability` RPC, if any) then SIGTERM/SIGKILL. */
  close(spec: ProviderServerSpec): Promise<void>;
}>;

function appServerError(provider: string, detail: string): Error {
  return new Error(`Provider server ${provider} ${detail}`);
}

/**
 * Spawns one raw app-server child and speaks newline-delimited JSON-RPC over its piped stdio. A trimmed,
 * independently-written mirror of `spawnProviderServerTransport`
 * (`src/providers/app-server-transport.ts`) restricted to what `AppServerTransport` needs —
 * `rpc`/`subscribe`/`closed` — because that module lives under the forbidden `src/coordinator/live/` tree.
 */
async function spawnAppServerChild(
  runtime: Runtime,
  spec: ProviderServerSpec,
  signal: AbortSignal,
): Promise<SpawnedAppServer> {
  if (signal.aborted) {
    throw new AbortError({ stage: `provider ${spec.provider} spawn`, reason: signal.reason });
  }

  const child = runtime.process.spawn({
    command: spec.command,
    args: spec.args,
    cwd: spec.cwd === '' ? undefined : spec.cwd,
    shell: shouldUseWindowsCommandShell(spec.command, runtime.env.platform()),
    ...(spec.env ? { env: spec.env } : {}),
  });
  const { stdin, stdout, stderr } = child;
  if (stdin === null || stdout === null || stderr === null) {
    throw appServerError(spec.provider, 'was spawned without piped stdio');
  }
  const pid = child.pid;
  if (pid === undefined) {
    throw appServerError(spec.provider, 'failed to spawn: child pid is unavailable');
  }
  const processStartedAtSeconds = probeProcessStartedAtSeconds(pid, runtime.env.platform() as NodeJS.Platform);
  if (processStartedAtSeconds === null) {
    child.kill('SIGKILL');
    throw appServerError(spec.provider, 'could not have its own start time read after spawn');
  }

  stdout.setEncoding('utf8');
  stderr.setEncoding('utf8');

  const pending = new Map<number, PendingAppServerRequest>();
  let nextRequestId = 1;
  const notificationHandlers = new Set<(message: { method: string; params?: Record<string, unknown> }) => void>();
  let stderrTail = '';
  let closed = false;
  let closeError: Error | undefined;
  let resolveClosed!: (outcome: Error | void) => void;
  const closedPromise = new Promise<Error | void>((resolve) => {
    resolveClosed = resolve;
  });

  const failAllPending = (error: Error): void => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };

  const detach = (error?: Error): void => {
    if (closed) return;
    closed = true;
    closeError = error;
    notificationHandlers.clear();
    failAllPending(error ?? appServerError(spec.provider, 'closed'));
  };

  const killChild = (): void => {
    child.kill('SIGTERM');
    const deadline = runtime.time.now() + SIGTERM_GRACE_MS;
    void (async () => {
      while (runtime.process.isAlive(pid) && runtime.time.now() < deadline) {
        await runtime.time.sleep(20);
      }
      if (runtime.process.isAlive(pid)) child.kill('SIGKILL');
    })();
  };

  const sendMessage = (message: unknown): void => {
    if (closed || stdin.destroyed) {
      throw appServerError(spec.provider, 'stdin is not available');
    }
    stdin.write(`${JSON.stringify(message)}\n`);
  };

  let lineBuffer = '';
  const handleLine = (line: string): void => {
    if (!line.trim() || closed) return;
    let message: {
      id?: number;
      method?: string;
      result?: unknown;
      error?: { code?: number; message?: string };
      params?: Record<string, unknown>;
    };
    try {
      message = JSON.parse(line) as typeof message;
    } catch (error: unknown) {
      const parseError = appServerError(spec.provider, `emitted invalid JSONL: ${errorMessage(error)}`);
      detach(parseError);
      killChild();
      return;
    }
    if (typeof message.id === 'number' && typeof message.method === 'string') {
      // This transport never accepts inbound requests from the child; refuse rather than hang the caller.
      try {
        sendMessage({ id: message.id, error: { code: -32601, message: `Unsupported request: ${message.method}` } });
      } catch {
        /* best effort */
      }
      return;
    }
    if (typeof message.id === 'number') {
      const waiter = pending.get(message.id);
      if (waiter === undefined) return;
      pending.delete(message.id);
      if (message.error) {
        waiter.reject(appServerError(spec.provider, `${waiter.method} failed: ${message.error.message ?? 'error'}`));
      } else {
        waiter.resolve(message.result);
      }
      return;
    }
    if (typeof message.method !== 'string') {
      const malformed = appServerError(spec.provider, 'emitted a malformed JSON-RPC message');
      detach(malformed);
      killChild();
      return;
    }
    for (const handler of notificationHandlers) {
      try {
        handler({ method: message.method, params: message.params });
      } catch (error: unknown) {
        backendLogNotificationFailure(spec.provider, error);
      }
    }
  };

  stdout.on('data', (chunk: string | Buffer) => {
    if (closed) return;
    lineBuffer += chunk.toString();
    if (Buffer.byteLength(lineBuffer, 'utf8') > APP_SERVER_MAX_LINE_BYTES) {
      const oversize = appServerError(spec.provider, 'emitted an oversized JSONL line');
      lineBuffer = '';
      detach(oversize);
      killChild();
      return;
    }
    let newline = lineBuffer.indexOf('\n');
    while (newline !== -1) {
      const line = lineBuffer.slice(0, newline);
      lineBuffer = lineBuffer.slice(newline + 1);
      handleLine(line);
      if (closed) return;
      newline = lineBuffer.indexOf('\n');
    }
  });
  stderr.on('data', (chunk: string | Buffer) => {
    stderrTail = `${stderrTail}${chunk.toString()}`.slice(-4096);
  });
  stdin.on('error', () => {
    if (closed) return;
    detach(appServerError(spec.provider, `stdin error (recent stderr: ${stderrTail.trim()})`));
    killChild();
  });
  child.on('error', (error: Error) => {
    const failure = appServerError(spec.provider, `failed: ${error.message}`);
    detach(failure);
    resolveClosed(failure);
  });
  child.on('close', (code, signalName) => {
    if (closed) {
      resolveClosed(closeError);
      return;
    }
    const detail = signalName ? `exited unexpectedly (signal ${signalName})` : `exited unexpectedly (exit ${code})`;
    const failure = appServerError(spec.provider, `${detail} (recent stderr: ${stderrTail.trim()})`);
    detach(failure);
    resolveClosed(failure);
  });

  const transport: AppServerTransport = {
    rpc: <R>(method: string, params: Record<string, unknown>): Promise<R> => {
      if (closed) return Promise.reject(appServerError(spec.provider, 'is closed'));
      const id = nextRequestId;
      nextRequestId += 1;
      return new Promise<R>((resolve, reject) => {
        pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject });
        try {
          sendMessage({ id, method, params });
        } catch (error: unknown) {
          pending.delete(id);
          reject(error instanceof Error ? error : appServerError(spec.provider, `failed to send ${method}`));
        }
      });
    },
    subscribe: (handler) => {
      notificationHandlers.add(handler);
      return () => notificationHandlers.delete(handler);
    },
    closed: closedPromise,
  };

  if (spec.initializeRequest !== undefined) {
    const timeoutMs = spec.initializeTimeoutMs ?? APP_SERVER_INITIALIZE_TIMEOUT_MS;
    try {
      await Promise.race([
        transport.rpc(spec.initializeRequest.method, spec.initializeRequest.params),
        runtime.time.sleep(timeoutMs).then(() => {
          throw appServerError(spec.provider, `initialize timed out after ${timeoutMs}ms`);
        }),
      ]);
    } catch (error: unknown) {
      const initError = error instanceof Error ? error : appServerError(spec.provider, 'initialize failed');
      detach(initError);
      killChild();
      throw initError;
    }
  }

  return {
    pid,
    processStartedAtSeconds,
    transport,
    close: async (closingSpec) => {
      if (closed) {
        await closedPromise;
        return;
      }
      if (closingSpec.shutdownCapability !== undefined) {
        try {
          await Promise.race([
            transport.rpc(closingSpec.shutdownCapability.method, {}),
            runtime.time.sleep(closingSpec.shutdownCapability.timeoutMs ?? APP_SERVER_SHUTDOWN_RPC_TIMEOUT_MS),
          ]);
        } catch {
          /* best effort; fall through to signal-based teardown below */
        }
      }
      killChild();
      await closedPromise;
    },
  };
}

function backendLogNotificationFailure(provider: string, error: unknown): void {
  // A notification handler throwing must not take down the child transport reading loop; this transport has
  // no logger of its own (avoids yet another cross-cutting import), so the failure is swallowed defensively
  // the same way `provider-server-transport.ts`'s own handler dispatch treats it as non-fatal to the socket.
  void provider;
  void error;
}

// --- proxy-owned app-server host authority --------------------------------------------------------------

function canonicalEnv(env: Readonly<Record<string, string>> | undefined): Readonly<Record<string, string>> {
  return Object.freeze({ ...(env ?? {}) });
}

/** Stable identity for one executable configuration, independent of lease mode — mirrors
 *  `hostKeyFromSpec` (`src/coordinator/live/provider-hosts/state.ts`), reimplemented locally because that
 *  module lives under the forbidden `src/coordinator/live/` tree (see this file's top-of-file doc comment). */
function specIdentityKey(spec: ProviderServerSpec): string {
  const canonical = {
    provider: spec.provider,
    command: spec.command,
    args: [...spec.args],
    cwd: spec.cwd,
    env: canonicalEnv(spec.env),
    initializeRequest: spec.initializeRequest ?? null,
  };
  return JSON.stringify(canonical, Object.keys(canonical).sort());
}

function specFingerprint(runtime: Runtime, spec: ProviderServerSpec): string {
  return runtime.ids.sha256(`${specIdentityKey(spec)} ${spec.leaseMode}`);
}

type HostPoolEntry = {
  readonly hostKey: string;
  readonly spec: ProviderServerSpec;
  readonly instanceId: string;
  readonly spawned: SpawnedAppServer;
  readonly jobId: string | undefined;
  refCount: number;
};

function hostKeyFor(spec: ProviderServerSpec, jobId: string | undefined): string {
  // Shared hosts pool by executable identity alone; job-exclusive hosts pool by identity *and* job, so the
  // same job's own stage-then-activate calls reuse one process while a different job never attaches to it.
  return spec.leaseMode === 'shared' ? specIdentityKey(spec) : `${specIdentityKey(spec)} job:${jobId ?? ''}`;
}

function assertLeasePolicy(spec: ProviderServerSpec, jobId: string | undefined): void {
  if (spec.leaseMode === 'job-exclusive' && jobId === undefined) {
    throw new Error('provider_host_policy_invalid: job-exclusive acquisition requires a job id');
  }
}

function hostRefFor(entry: HostPoolEntry, runtime: Runtime): HostRef {
  const identity = {
    provider: entry.spec.provider,
    fingerprint: specFingerprint(runtime, entry.spec),
    instanceId: entry.instanceId,
  } as const;
  if (entry.spec.leaseMode === 'shared') return Object.freeze({ ...identity, leaseMode: 'shared' as const });
  return Object.freeze({ ...identity, leaseMode: 'job-exclusive' as const, ownerJobId: entry.jobId as string });
}

function isMatchingHostRef(hostRef: HostRef, entry: HostPoolEntry, runtime: Runtime): boolean {
  if (hostRef.provider !== entry.spec.provider) return false;
  if (hostRef.fingerprint !== specFingerprint(runtime, entry.spec)) return false;
  if (hostRef.instanceId !== entry.instanceId) return false;
  if (hostRef.leaseMode !== entry.spec.leaseMode) return false;
  return hostRef.leaseMode !== 'job-exclusive' || hostRef.ownerJobId === entry.jobId;
}

export interface ProxyAppServerHostAuthority extends AppServerHostAuthority {
  /** The raw process identity behind an already-open `HostRef`, for the guardian containment report. `null`
   *  when the reference no longer names a live entry this authority holds. */
  rootIdentity(hostRef: HostRef): Readonly<{ pid: number; processStartedAtSeconds: number }> | null;
}

/**
 * The proxy's own narrower stand-in for `DefaultProviderHostManager`: pools app-server children by executable
 * identity (shared) or identity+job (job-exclusive, so this proxy's own stage-then-activate sequence reuses
 * one process rather than spawning twice), ref-counts sessions, and closes a pool entry once its last
 * reference releases. Deliberately does not replicate the coordinator's idle-timer-based early retirement for
 * `idleRetirement: 'host-reported'` shared hosts — every host here stays open until its last referencing
 * operation stops, which is a reported simplification (see the task report), not an attempt to reproduce that
 * policy exactly.
 */
export function createProxyAppServerHostAuthority(runtime: Runtime): ProxyAppServerHostAuthority {
  const entries = new Map<string, HostPoolEntry>();

  const managedSessionFor = (entry: HostPoolEntry): ManagedHostSession => {
    let released = false;
    entry.refCount += 1;
    return Object.freeze({
      session: entry.spawned.transport,
      hostRef: hostRefFor(entry, runtime),
      close: () => {
        if (released) return;
        released = true;
        entry.refCount -= 1;
        if (entry.refCount > 0) return;
        entries.delete(entry.hostKey);
        void entry.spawned.close(entry.spec);
      },
    });
  };

  return {
    async openSession(spec, options) {
      assertLeasePolicy(spec, options?.jobId);
      const hostKey = hostKeyFor(spec, options?.jobId);
      const existing = entries.get(hostKey);
      if (existing !== undefined) return managedSessionFor(existing);

      const signal = options?.signal ?? new AbortController().signal;
      const spawned = await spawnAppServerChild(runtime, spec, signal);
      const entry: HostPoolEntry = {
        hostKey,
        spec,
        instanceId: runtime.ids.uuid(),
        spawned,
        jobId: options?.jobId,
        refCount: 0,
      };
      entries.set(hostKey, entry);
      return managedSessionFor(entry);
    },

    async attachSession(hostRef, expectation) {
      const hostKey = hostKeyFor(expectation.spec, expectation.jobId);
      const entry = entries.get(hostKey);
      if (entry === undefined || !isMatchingHostRef(hostRef, entry, runtime)) return null;
      return managedSessionFor(entry);
    },

    rootIdentity(hostRef) {
      for (const entry of entries.values()) {
        if (isMatchingHostRef(hostRef, entry, runtime)) {
          return { pid: entry.spawned.pid, processStartedAtSeconds: entry.spawned.processStartedAtSeconds };
        }
      }
      return null;
    },
  };
}

// --- bound-provider reconstruction ----------------------------------------------------------------------

/** `ProviderContinuityBlob` (`src/sessions/continuity.ts`) structurally, without importing it: `src/sessions/`
 *  is forbidden to `provider-proxy/` (`tests/invariants/architecture-layering.test.ts`'s `PROVIDER_PROXY_FORBIDDEN`),
 *  so this derives the identical type from a field this file already legitimately imports rather than naming
 *  the origin module — TypeScript's structural typing makes the two interchangeable at every call site below. */
type DerivedPersistedContinuity = NonNullable<BoundProviderExecutionPreparationInput['persistedContinuity']>;

/** The one JSON shape `persistedContinuity` may hold once decoded off the wire: `null` (no session), or a
 *  provider-opaque record. `ProxyPreparedAppServerOperation.persistedContinuity` is typed `JsonValue | null`
 *  at the wire boundary (§Canonical Values at Boundaries) because the envelope cannot depend on any one
 *  provider's continuity shape; this is where it becomes the canonical `DerivedPersistedContinuity | undefined`
 *  the bound-provider execution contract expects. */
function derivePersistedContinuity(prepared: ProxyPreparedAppServerOperation): DerivedPersistedContinuity | undefined {
  const raw = prepared.persistedContinuity;
  if (raw === null) return undefined;
  if (!isRecord(raw)) {
    throw new TypeError(
      `Prepared operation for provider '${prepared.provider}' carried non-record persisted continuity.`,
    );
  }
  return raw as DerivedPersistedContinuity;
}

/**
 * Rebuilds the `BoundProvider` this operation names from its binding envelope. A fresh built-in registry per
 * call is cheap (pure registration, no I/O) and keeps this function free of shared mutable module state; the
 * host authority it connects is the one live thing every call shares.
 */
function rebuildBoundProvider(
  prepared: ProxyPreparedAppServerOperation,
  authority: AppServerHostAuthority,
): BoundProvider {
  const registry = createBuiltInProviderRegistry();
  registry.connectAppServerHost(authority);
  const rehydrated = registry.rehydrateBinding(prepared.binding);
  if (!rehydrated.ok) {
    throw new Error(
      `Prepared operation named provider '${prepared.provider}' with an unrehydratable binding (${rehydrated.failure.reason}).`,
    );
  }
  const bound = rehydrated.value;
  if (bound.name !== prepared.provider) {
    throw new Error(
      `Prepared operation named provider '${prepared.provider}' but its binding rehydrated to '${bound.name}'.`,
    );
  }
  if (bound.appServer === undefined) {
    throw new Error(
      `Provider '${bound.name}' has no app-server capability; this proxy runs app-server operations only.`,
    );
  }
  return bound;
}

function stagingInput(runtime: Runtime, prepared: ProxyPreparedAppServerOperation): BoundProviderHostPreparationInput {
  return {
    request: prepared.request,
    persistedContinuity: derivePersistedContinuity(prepared),
    baseEnv: prepared.baseEnv,
    platform: prepared.platform,
    storage: runtime.storage,
  };
}

function executionInput(
  runtime: Runtime,
  prepared: ProxyPreparedAppServerOperation,
): BoundProviderExecutionPreparationInput {
  return {
    request: prepared.request,
    persistedContinuity: derivePersistedContinuity(prepared),
    baseEnv: prepared.baseEnv,
    protectedEnv: prepared.protectedEnv,
    platform: prepared.platform,
    storage: runtime.storage,
  };
}

/** `runtime.continuityBridge.checkpoint()`'s value is dead for both built-in app-server providers: Claude and
 *  Codex each compose `sessionContinuity()` (`src/providers/middleware/session-continuity.ts`) into their own
 *  `run`, and that middleware constructs and injects its *own* bridge into the wrapped runtime before the
 *  inner provider ever reads this one. `src/jobs/shell/launch.ts`'s in-process `NOOP_CONTINUITY_BRIDGE` is the
 *  exact same placeholder for the exact same reason; this is that same precedent, reimplemented here because
 *  `src/jobs/` is forbidden to this domain. See the task report for why the ack-gated checkpoint property the
 *  plan describes is not implementable through this seam at all — it is a property of who calls
 *  `commitContinuityEvent`/`rejectContinuityEvent` on the *yielded* continuity events, not of this bridge. */
function missingContinuityBridge(method: string): never {
  throw new Error(`runtime.continuityBridge.${method}() called without sessionContinuity() middleware.`);
}
const NOOP_CONTINUITY_BRIDGE: BoundProviderAppServerExecutionRuntime['continuityBridge'] = {
  checkpoint: () => missingContinuityBridge('checkpoint'),
  transportClosed: () => missingContinuityBridge('transportClosed'),
};

function buildExecutionRuntime(
  runtime: Runtime,
  key: ProviderOperationKey,
  prepared: ProxyPreparedAppServerOperation,
  signal: AbortSignal,
): BoundProviderAppServerExecutionRuntime {
  return {
    transport: 'app-server',
    signal,
    time: runtime.time,
    storage: runtime.storage,
    env: runtime.env,
    ids: runtime.ids,
    jobId: key.jobId,
    persistedContinuity: derivePersistedContinuity(prepared),
    continuityBridge: NOOP_CONTINUITY_BRIDGE,
    // Pure functions of this build's own root and the request's own cwd — not job-specific data, so unlike
    // `persistedContinuity`/`request` this needs no wire field at all; the proxy derives it from its own
    // `Runtime` exactly as `LaunchOrchestrator.createProviderRuntime` derives it from the coordinator's.
    kbRoot: runtime.paths.coral.corpus.kbRoot,
    ...(prepared.request.cwd
      ? {
          coralProjects: runtime.paths.projectData(prepared.request.cwd),
          projectSource: runtime.paths.projectSource(prepared.request.cwd),
        }
      : {}),
    // `equippedTools` is intentionally omitted: it is job-specific expansion state
    // (`src/expansion/equipped-tools.ts`) that `ProxyPreparedAppServerOperationV1` does not carry, and this
    // proxy has no store to resolve it from independently. Reported gap, not a silent truncation.
    onAppServerWaiting: () => {},
    onHostRef: () => {},
  };
}

// --- per-operation kernel execution and event pumping ----------------------------------------------------

const PAUSED_POLL_INTERVAL_MS = 50;

function operationKeyString(key: ProviderOperationKey): string {
  return `${key.jobId} ${key.operationId}`;
}

type StagedOperation = {
  readonly bound: BoundProvider;
  readonly staged: Readonly<{ hostRef: HostRef; close(): void }>;
  readonly root: Readonly<{ pid: number; processStartedAtSeconds: number }>;
  readonly abortController: AbortController;
  /** Set once `stop()` is in flight, so the pump loop's catch-all can tell a deliberate stop from a genuine
   *  unprompted kernel failure and choose the right synthesized outcome (or none, for an interruption). */
  pendingStopCause: ProviderStopCause | null;
  /** Resolves once the pump loop has fully settled; `stop()` awaits this so no event can be emitted after it
   *  returns (proxy.ts transitions the ledger immediately after `stop()` resolves). `null` until `host.start`
   *  assigns it — `stop()` is only ever called once `start()` has already run (proxy.ts calls `host.stop` only
   *  from the `executing` state, which only `start()` reaches), so by the time it is read it is always set;
   *  mutated in place rather than replacing the map entry, so `start`/`stop` and the pump loop all observe the
   *  same object. */
  done: Promise<void> | null;
};

export type SemanticOperationRuntimeOptions = Readonly<{
  runtime: Runtime;
  hostAuthority: ProxyAppServerHostAuthority;
  /** The live `Proxy` this runtime pumps events into and reads ledger state from. Supplied as a getter
   *  because `createProxy` itself needs this runtime's `host` before the `Proxy` it returns can exist —
   *  the same forward-reference shape `role-main.ts` already uses for `guardianRef`/`reaperRef`. */
  getProxy(): Proxy;
}>;

export interface SemanticOperationRuntime {
  readonly host: SemanticOperationHost;
  /**
   * Ensures this operation's provider root exists — spawning the underlying app-server child only when no
   * pooled entry already serves it — without starting the operation's own turn. Idempotent per key: a retried
   * `operation.prepare.v1` (dropped reply, coordinator retry) reaches the same pooled entry rather than
   * spawning a second one, because `createProxyAppServerHostAuthority` pools by executable identity (and, for
   * job-exclusive hosts, by job) — the same identity `host.start` below resolves to when it later opens its
   * own session on the same spec.
   */
  ensureProviderRoot(
    key: ProviderOperationKey,
    prepared: ProxyPreparedAppServerOperation,
  ): Promise<Readonly<{ pid: number; processStartedAtSeconds: number }>>;
}

export function createSemanticOperationRuntime(options: SemanticOperationRuntimeOptions): SemanticOperationRuntime {
  const { runtime, hostAuthority, getProxy } = options;
  const staged = new Map<string, StagedOperation>();

  const requireStaged = (key: ProviderOperationKey): StagedOperation => {
    const entry = staged.get(operationKeyString(key));
    if (entry === undefined) {
      throw new Error(`No staged provider root for ${key.jobId}/${key.operationId}.`);
    }
    return entry;
  };

  /** Waits until this operation's own buffered-replay usage is back under both per-operation caps. An
   *  imprecise but bounded proxy for "capacity freed": `Proxy.emitProviderEvent`'s only feedback is the
   *  `paused` flag on the call that produced the event, with no push-based "resumed" signal and no proxy-wide
   *  buffer total exposed to a host — see the task report for why a proxy-wide-pressure case can wait slightly
   *  past what is strictly necessary, and why that is bounded rather than unsound. */
  const awaitEmitCapacity = async (key: ProviderOperationKey, signal: AbortSignal): Promise<void> => {
    const proxy = getProxy();
    while (!signal.aborted) {
      const entry = proxy.ledger().get(key);
      if (entry === null) return;
      if (entry.bufferedEvents.length < MAX_PROVIDER_REPLAY_EVENTS && entry.bufferedBytes < MAX_PROVIDER_REPLAY_BYTES) {
        return;
      }
      await runtime.time.sleep(PAUSED_POLL_INTERVAL_MS, { signal });
    }
  };

  const safeTransition = (
    key: ProviderOperationKey,
    next: 'terminal-awaiting-journal-ack' | 'suspended-awaiting-durable-decision',
  ): void => {
    try {
      getProxy().ledger().transition(key, next);
    } catch {
      // Already transitioned by `operation.stop.v1`'s own handler (proxy.ts) racing this natural completion —
      // see the task report's "stop racing a still-draining emit" judgement. Whichever got there first wins;
      // the loser's transition is a no-op refusal, not a defect to surface.
    }
  };

  const synthesizeAndEmitFailure = (key: ProviderOperationKey, provider: string, error: unknown): void => {
    const proxy = getProxy();
    const event: ProviderEventBody = {
      kind: 'terminal',
      terminal: {
        content: '',
        durationMs: 0,
        outcome: { kind: 'failed' },
      },
      diagnostics: {},
      failureCause: providerRequestFailed({ provider, message: errorMessage(error) }),
    };
    try {
      proxy.emitProviderEvent(key, event);
    } catch {
      /* the ledger entry is gone (already released); nothing left to notify */
    }
    safeTransition(key, 'terminal-awaiting-journal-ack');
  };

  const emitAbortedTerminal = (key: ProviderOperationKey, cause: ProviderStopCause): void => {
    if (!isAbortStopCause(cause)) return;
    const proxy = getProxy();
    const event: ProviderEventBody = {
      kind: 'terminal',
      terminal: { content: '', durationMs: 0, outcome: { kind: 'aborted', reason: cause } },
      diagnostics: {},
    };
    try {
      proxy.emitProviderEvent(key, event);
    } catch {
      /* ledger entry already gone */
    }
    safeTransition(key, 'terminal-awaiting-journal-ack');
  };

  const runPump = async (
    key: ProviderOperationKey,
    entry: StagedOperation,
    iterable: AsyncIterable<ProviderEventBody>,
  ): Promise<void> => {
    const proxy = getProxy();
    try {
      // `runPump` runs exactly once per key — `proxy.ts`'s `operation.activate.v1` handler only calls
      // `host.start` on a transition into `executing`, and a repeat activation is refused a second kernel — so
      // nothing outside this single call ever resolves `entry.done` concurrently with it.
      for await (const event of iterable) {
        const { paused } = proxy.emitProviderEvent(key, event);
        if (paused) await awaitEmitCapacity(key, entry.abortController.signal);

        if (event.kind === 'terminal') {
          safeTransition(key, 'terminal-awaiting-journal-ack');
          break;
        }
        if (event.kind === 'suspended') {
          safeTransition(key, 'suspended-awaiting-durable-decision');
          break;
        }
      }
    } catch (error: unknown) {
      const cause = entry.pendingStopCause;
      if (cause !== null) {
        // A `stop()` was already in flight when the kernel unwound — trust why we asked it to stop rather
        // than the shape of what it threw. Interruption causes (restart/handoff) emit nothing: the coordinator
        // synthesizes `session.interrupted` itself from `operation.stop.v1`'s own `suspended-awaiting-durable-
        // decision` reply, not from a provider event this proxy would have to invent.
        if (isAbortStopCause(cause)) emitAbortedTerminal(key, cause);
        return;
      }
      // Nobody asked this operation to stop; the kernel unwound on its own. A terminal must still reach the
      // coordinator (see the task report's "kernel throws mid-stream" judgement) — synthesize one rather than
      // leaving the ledger entry executing forever with nothing to end it.
      synthesizeAndEmitFailure(key, entry.bound.name, error);
    } finally {
      entry.staged.close();
    }
  };

  return {
    async ensureProviderRoot(key, prepared) {
      const keyStr = operationKeyString(key);
      const existing = staged.get(keyStr);
      if (existing !== undefined) return existing.root;

      const bound = rebuildBoundProvider(prepared, hostAuthority);
      const abortController = new AbortController();
      const appServer = bound.appServer;
      if (appServer === undefined) {
        // rebuildBoundProvider already asserts this; kept as a narrowing guard for the call below.
        throw new Error(`Provider '${bound.name}' has no app-server capability.`);
      }
      const openedStaging = await appServer.openReplacement(stagingInput(runtime, prepared), {
        jobId: key.jobId,
        signal: abortController.signal,
      });
      const root = hostAuthority.rootIdentity(openedStaging.hostRef);
      if (root === null) {
        openedStaging.close();
        throw new Error(
          `Staged provider root for ${key.jobId}/${key.operationId} vanished before it could be reported.`,
        );
      }

      const entry: StagedOperation = {
        bound,
        staged: openedStaging,
        root,
        abortController,
        pendingStopCause: null,
        done: null,
      };
      staged.set(keyStr, entry);
      return root;
    },

    host: {
      start: ({ key, prepared }) => {
        const entry = requireStaged(key);
        const bound = entry.bound;
        const preparedExecution = bound.prepareExecution(executionInput(runtime, prepared));
        if (preparedExecution.kind !== 'app-server') {
          throw new Error(
            `Provider '${bound.name}' prepared a standalone execution; this proxy runs app-server operations only.`,
          );
        }
        const executionRuntime = buildExecutionRuntime(runtime, key, prepared, entry.abortController.signal);
        const iterable = preparedExecution.execute(executionRuntime);
        // Fire-and-forget by design: `operation.activate.v1` must return once the kernel has *started*, not
        // once the whole turn has finished (`PROXY_CONTROL_RPC_TIMEOUT_MS` is 5s; a turn can run for minutes).
        // Mutated in place (not a map replace) so `stop()`'s later `requireStaged` reads the same object.
        entry.done = runPump(key, entry, iterable);
      },

      stop: async ({ key, cause }) => {
        const entry = requireStaged(key);
        entry.pendingStopCause = cause;
        entry.abortController.abort(cause);
        await (entry.done ?? Promise.resolve());
        staged.delete(operationKeyString(key));
      },
    },
  };
}

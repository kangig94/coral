import { basename, join } from 'node:path';
import { errorMessage, formatError } from '../../infra/error-format.js';
import { appendBuffer, gracefulKill, requirePipedHandles, safeKill } from './process-supervision.js';
import type { Runtime } from '../../runtime/ports.js';
import {
  KB_DAEMON_REQUEST_MESSAGE,
  KB_DAEMON_PARENT_RESPONSE_MESSAGE,
  encodeKbDaemonMessage,
  isKbDaemonAbortResult,
  isKbDaemonCurateAssistantCancelRequest,
  isKbDaemonCurateAssistantCompleteRequest,
  isKbDaemonEventMessage,
  isKbDaemonExpansionResult,
  isKbDaemonHealthResult,
  isKbDaemonJobsResult,
  isKbDaemonKbMutationResult,
  isKbDaemonKbReadHealth,
  isKbDaemonKbReadResult,
  isKbDaemonParentRequestMessage,
  isKbDaemonReadyMessage,
  isKbDaemonResponseMessage,
  type KbDaemonCurateAssistantCompleteRequest,
  type KbDaemonKbMutationRequest,
  type KbDaemonKbMutationResult,
  type KbDaemonKbReadHealth,
  type KbDaemonKbReadRequest,
  type KbDaemonKbReadResult,
  type KbDaemonRequestMethod,
  type KbDaemonResponseMessage,
  type KbDaemonAbortResult,
  type KbDaemonExpansionRequest,
  type KbDaemonExpansionResult,
  type KbDaemonEventMessage,
  type KbDaemonJobsResult,
  type KbDaemonParentRequestMessage,
} from '../../kb-daemon/protocol.js';
import { readBundleHash } from '../../infra/bundle-manifest.js';
import { pluginRootNamespace } from '../../infra/plugin-identity.js';

type DaemonProcessLike = ReturnType<Runtime['process']['spawn']>;

export type KbDaemonPhase = 'disabled' | 'starting' | 'online' | 'restarting' | 'stopping' | 'stopped' | 'failed';

export type KbDaemonExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
  at: number;
  uptimeMs: number | null;
};

export type KbDaemonHealthSnapshot = {
  enabled: boolean;
  phase: KbDaemonPhase;
  generation: number;
  pid: number | null;
  startedAt: number | null;
  readyAt: number | null;
  entrypoint?: string;
  pendingRequests?: number;
  lastHeartbeatAt?: number;
  lastHeartbeatLatencyMs?: number;
  daemonUptimeMs?: number;
  kbRead?: KbDaemonKbReadHealth;
  kbWrite?: KbDaemonKbReadHealth;
  reason?: string;
  lastExit?: KbDaemonExit;
  lastError?: string;
};

export interface KbDaemonSupervisor {
  read(): KbDaemonHealthSnapshot;
  onExit?(listener: (snapshot: KbDaemonHealthSnapshot) => void): () => void;
  start(): Promise<KbDaemonHealthSnapshot>;
  probe(): Promise<KbDaemonHealthSnapshot>;
  warmup(): Promise<KbDaemonHealthSnapshot>;
  readKb(request: KbDaemonKbReadRequest, options?: { signal?: AbortSignal }): Promise<KbDaemonKbReadResult>;
  mutateKb(request: KbDaemonKbMutationRequest): Promise<KbDaemonKbMutationResult>;
  expansionRpc(request: KbDaemonExpansionRequest): Promise<KbDaemonExpansionResult>;
  abortKbJobs?(jobIds: string[]): Promise<KbDaemonAbortResult>;
  listActiveKbJobs?(options?: { signal?: AbortSignal }): Promise<KbDaemonJobsResult>;
  stop(reason?: string, options?: { signal?: AbortSignal }): Promise<KbDaemonHealthSnapshot>;
  restart(reason?: string): Promise<KbDaemonHealthSnapshot>;
  dispose(reason?: string, options?: { signal?: AbortSignal }): Promise<void>;
}

export type KbDaemonCurateAssistantHandler = (
  request: KbDaemonCurateAssistantCompleteRequest,
  options: { signal: AbortSignal },
) => Promise<string>;

type KbDaemonSupervisorOptions = {
  runtime: Runtime;
  pluginRoot: string;
  instanceId?: string;
  entrypoint?: string;
  command?: string;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
  requestTimeoutMs?: number;
  jobRequestTimeoutMs?: number;
  backendNamespace?: string;
  bundleHash?: string;
  curateAssistant?: KbDaemonCurateAssistantHandler;
  onEvent?: (message: KbDaemonEventMessage) => void;
  log?: (message: string) => void;
};

const DEFAULT_START_TIMEOUT_MS = 5_000;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 2_000;
const DEFAULT_JOB_REQUEST_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * Convention: every CORAL_* env var the KB daemon reads from its own process.env
 * carries the `CORAL_KB_` prefix, so forwarding the whole prefix re-injects all KB
 * config (analyzers, import/marker limits, corpus-scan caps, curate timings, …) in
 * one rule. `composeChildEnv` strips inherited CORAL_* from the spawn env
 * (`infra/env-sanitize.ts`), so without this re-injection the daemon silently loses
 * every CORAL_KB_* knob.
 */
export const CORAL_KB_ENV_PREFIX = 'CORAL_KB_';

/**
 * Shared knobs whose primary owner is the parent (coordinator) process and that
 * therefore do NOT carry the `CORAL_KB_` prefix. The KB daemon reuses them, so it
 * inherits them through this explicit allowlist rather than the prefix rule. Renaming
 * them would mislabel a parent-owned, cross-cutting var as KB-specific.
 */
export const PARENT_FORWARDED_KB_ENV = ['CORAL_BOOT_FRESHNESS_TIMEOUT_MS'] as const;

/**
 * Collect the env the KB daemon inherits from its parent: every inherited `CORAL_KB_*`
 * plus the explicitly allowlisted parent-owned knobs. The caller spreads daemon-identity
 * vars (`CORAL_KB_DAEMON_*`) after these, so identity always wins over any collision.
 * The CORAL_KB_ prefix discipline this relies on is enforced by
 * `tests/invariants/kb-daemon-env-prefix.test.ts`.
 */
function collectForwardedKbDaemonEnv(env: Pick<Runtime['env'], 'get' | 'coralSnapshot'>): Record<string, string> {
  const forwarded: Record<string, string> = {};
  for (const [key, value] of Object.entries(env.coralSnapshot())) {
    if (key.startsWith(CORAL_KB_ENV_PREFIX)) {
      forwarded[key] = value;
    }
  }
  for (const name of PARENT_FORWARDED_KB_ENV) {
    const value = env.get(name);
    if (value !== undefined) {
      forwarded[name] = value;
    }
  }
  return forwarded;
}

function resolveDaemonBackendNamespace(pluginRoot: string, override: string | undefined): string {
  if (override !== undefined) {
    return override;
  }
  try {
    return pluginRootNamespace(pluginRoot);
  } catch {
    return `kb-daemon:${pluginRoot}`;
  }
}

function resolveDaemonBundleHash(pluginRoot: string, override: string | undefined): string {
  if (override !== undefined) {
    return override;
  }
  try {
    return readBundleHash(pluginRoot);
  } catch {
    return 'unknown';
  }
}

export function resolveDefaultKbDaemonEntrypoint(pluginRoot: string, currentEntrypoint = process.argv[1]): string {
  if (typeof currentEntrypoint === 'string' && basename(currentEntrypoint) === 'coral-backend.cjs') {
    return currentEntrypoint;
  }
  return join(pluginRoot, 'bridge', 'coral-backend.cjs');
}

export function createDisabledKbDaemonSupervisor(reason = 'disabled'): KbDaemonSupervisor {
  const snapshot: KbDaemonHealthSnapshot = {
    enabled: false,
    phase: 'disabled',
    generation: 0,
    pid: null,
    startedAt: null,
    readyAt: null,
    reason,
  };

  return {
    read: () => ({ ...snapshot }),
    start: async () => ({ ...snapshot }),
    probe: async () => ({ ...snapshot }),
    warmup: async () => ({ ...snapshot }),
    readKb: async () => ({
      ok: false,
      code: 'kb_disabled',
      message: `KB daemon supervisor is disabled: ${reason}`,
      detail: { reason: 'kb_daemon_disabled' },
    }),
    mutateKb: async () => ({
      ok: false,
      code: 'kb_disabled',
      message: `KB daemon supervisor is disabled: ${reason}`,
      detail: { reason: 'kb_daemon_disabled' },
    }),
    expansionRpc: async () => ({
      ok: false,
      code: 'kb_disabled',
      message: `KB daemon supervisor is disabled: ${reason}`,
      detail: { reason: 'kb_daemon_disabled' },
    }),
    onExit: () => () => {},
    abortKbJobs: async (jobIds) => ({ aborted: [], notFound: [...jobIds] }),
    listActiveKbJobs: async () => ({ active: [] }),
    stop: async () => ({ ...snapshot }),
    restart: async () => ({ ...snapshot }),
    dispose: async () => undefined,
  };
}

function withAbortableTimeout(
  runtime: Runtime,
  ms: number,
  signal: AbortSignal | undefined,
): Promise<'timeout' | 'aborted'> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve('aborted');
      return;
    }
    const timeout = runtime.time.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve('timeout');
    }, ms);
    timeout.unref?.();
    const onAbort = (): void => {
      runtime.time.clearTimeout(timeout);
      resolve('aborted');
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function waitForClose(daemonProcess: DaemonProcessLike): Promise<void> {
  return new Promise((resolve) => {
    daemonProcess.on('close', () => resolve());
  });
}

type PendingRequest = {
  generation: number;
  timeout: ReturnType<Runtime['time']['setTimeout']>;
  resolve: (response: KbDaemonResponseMessage) => void;
  reject: (error: Error) => void;
  cleanup?: () => void;
};

export function createKbDaemonSupervisor(options: KbDaemonSupervisorOptions): KbDaemonSupervisor {
  const { runtime, pluginRoot } = options;
  const command = options.command ?? process.execPath;
  const entrypoint = options.entrypoint ?? resolveDefaultKbDaemonEntrypoint(pluginRoot);
  const startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  const stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const jobRequestTimeoutMs = options.jobRequestTimeoutMs ?? DEFAULT_JOB_REQUEST_TIMEOUT_MS;
  const backendNamespace = resolveDaemonBackendNamespace(pluginRoot, options.backendNamespace);
  const bundleHash = resolveDaemonBundleHash(pluginRoot, options.bundleHash);
  const forwardedKbDaemonEnv = collectForwardedKbDaemonEnv(runtime.env);
  const parentCurateAssistant = options.curateAssistant;
  const log = options.log ?? (() => undefined);

  let phase: KbDaemonPhase = 'stopped';
  let generation = 0;
  let daemonProcess: DaemonProcessLike | null = null;
  let pid: number | null = null;
  let startedAt: number | null = null;
  let readyAt: number | null = null;
  let lastExit: KbDaemonExit | undefined;
  let lastError: string | undefined;
  let operation: Promise<unknown> | null = null;
  let probeOperation: Promise<KbDaemonHealthSnapshot> | null = null;
  let stderrBuffer = '';
  let nextRequestId = 1;
  const pendingRequests = new Map<string, PendingRequest>();
  const activeParentRequests = new Map<string, { generation: number; controller: AbortController }>();
  let lastHeartbeatAt: number | undefined;
  let lastHeartbeatLatencyMs: number | undefined;
  let daemonUptimeMs: number | undefined;
  let kbReadHealth: KbDaemonKbReadHealth | undefined;
  let kbWriteHealth: KbDaemonKbReadHealth | undefined;
  let requestRecoveryEnabled = true;
  let disposed = false;
  const exitListeners = new Set<(snapshot: KbDaemonHealthSnapshot) => void>();

  const read = (): KbDaemonHealthSnapshot => ({
    enabled: true,
    phase,
    generation,
    pid,
    startedAt,
    readyAt,
    entrypoint,
    pendingRequests: pendingRequests.size,
    ...(lastHeartbeatAt === undefined ? {} : { lastHeartbeatAt }),
    ...(lastHeartbeatLatencyMs === undefined ? {} : { lastHeartbeatLatencyMs }),
    ...(daemonUptimeMs === undefined ? {} : { daemonUptimeMs }),
    ...(kbReadHealth === undefined ? {} : { kbRead: kbReadHealth }),
    ...(kbWriteHealth === undefined ? {} : { kbWrite: kbWriteHealth }),
    ...(lastExit === undefined ? {} : { lastExit }),
    ...(lastError === undefined ? {} : { lastError }),
  });

  const setFailure = (message: string): void => {
    lastError = message;
    phase = 'failed';
    log(`[kb-daemon] ${message}`);
  };

  const notifyExitListeners = (): void => {
    const snapshot = read();
    for (const listener of exitListeners) {
      try {
        listener(snapshot);
      } catch (error: unknown) {
        log(`[kb-daemon] exit listener failed: ${formatError(error)}`);
      }
    }
  };

  const runExclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const previous = operation ?? Promise.resolve(read());
    const next = previous.catch(() => read()).then(fn);
    const wrapped = next.finally(() => {
      if (operation === wrapped) {
        operation = null;
      }
    });
    operation = wrapped;
    return wrapped;
  };

  const rejectPendingRequests = (message: string, activeGeneration?: number): void => {
    for (const [id, pending] of pendingRequests) {
      if (activeGeneration !== undefined && pending.generation !== activeGeneration) {
        continue;
      }
      runtime.time.clearTimeout(pending.timeout);
      pending.reject(new Error(message));
      pendingRequests.delete(id);
    }
  };

  const sendRequest = async (
    method: KbDaemonRequestMethod,
    params?: unknown,
    timeoutMs = requestTimeoutMs,
    signal?: AbortSignal,
  ): Promise<KbDaemonResponseMessage> => {
    const activeDaemonProcess = daemonProcess;
    if (activeDaemonProcess === null || activeDaemonProcess.stdin === null || phase !== 'online') {
      throw new Error('KB daemon is not online');
    }
    if (signal?.aborted) {
      throw new Error('KB daemon request aborted');
    }

    const requestGeneration = generation;
    const id = `${generation}:${nextRequestId++}`;
    const sentAt = runtime.time.now();
    const response = await new Promise<KbDaemonResponseMessage>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        runtime.time.clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        pendingRequests.delete(id);
      };
      const rejectWith = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const onAbort = (): void => {
        rejectWith(new Error('KB daemon request aborted'));
      };
      const timeout = runtime.time.setTimeout(() => {
        rejectWith(new Error(`KB daemon request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timeout.unref?.();
      signal?.addEventListener('abort', onAbort, { once: true });
      pendingRequests.set(id, {
        generation,
        timeout,
        resolve: (message) => {
          cleanup();
          resolve(message);
        },
        reject: rejectWith,
        cleanup,
      });
      try {
        activeDaemonProcess.stdin?.write(
          encodeKbDaemonMessage({ type: KB_DAEMON_REQUEST_MESSAGE, id, method, params }),
        );
      } catch (error: unknown) {
        rejectWith(error instanceof Error ? error : new Error(String(error)));
      }
    });
    // Only the current generation's latency is a live health signal; a
    // late-completing request from a restarted daemon must not clobber it.
    if (requestGeneration === generation) {
      lastHeartbeatLatencyMs = Math.max(0, runtime.time.now() - sentAt);
    }
    return response;
  };

  const writeParentResponse = (
    target: DaemonProcessLike,
    message: { id: string; ok: true; result: unknown } | { id: string; ok: false; error: { message: string } },
  ): void => {
    try {
      target.stdin?.write(
        encodeKbDaemonMessage({
          type: KB_DAEMON_PARENT_RESPONSE_MESSAGE,
          ...message,
        }),
      );
    } catch (error: unknown) {
      log(`[kb-daemon] failed to write parent response: ${formatError(error)}`);
    }
  };

  const parentRequestKey = (requestGeneration: number, id: string): string => `${requestGeneration}:${id}`;

  const abortActiveParentRequests = (reason: string, activeGeneration?: number): void => {
    for (const [key, entry] of activeParentRequests) {
      if (activeGeneration !== undefined && entry.generation !== activeGeneration) {
        continue;
      }
      entry.controller.abort(new Error(reason));
      activeParentRequests.delete(key);
    }
  };

  const handleParentRequest = (
    request: KbDaemonParentRequestMessage,
    target: DaemonProcessLike,
    requestGeneration: number,
  ): void => {
    switch (request.method) {
      case 'curate.assistant.complete': {
        if (!isKbDaemonCurateAssistantCompleteRequest(request.params)) {
          writeParentResponse(target, {
            id: request.id,
            ok: false,
            error: { message: 'Malformed KB daemon curate assistant request.' },
          });
          return;
        }
        if (parentCurateAssistant === undefined) {
          writeParentResponse(target, {
            id: request.id,
            ok: false,
            error: { message: 'KB daemon curate assistant parent handler is not configured.' },
          });
          return;
        }
        const params = request.params;
        const controller = new AbortController();
        const key = parentRequestKey(requestGeneration, request.id);
        activeParentRequests.set(key, { generation: requestGeneration, controller });
        void Promise.resolve()
          .then(() => parentCurateAssistant(params, { signal: controller.signal }))
          .then((result) => {
            if (activeParentRequests.get(key)?.controller !== controller) {
              return;
            }
            writeParentResponse(target, { id: request.id, ok: true, result });
          })
          .catch((error: unknown) => {
            if (activeParentRequests.get(key)?.controller !== controller) {
              return;
            }
            writeParentResponse(target, { id: request.id, ok: false, error: { message: errorMessage(error) } });
          })
          .finally(() => {
            if (activeParentRequests.get(key)?.controller === controller) {
              activeParentRequests.delete(key);
            }
          });
        return;
      }
      case 'curate.assistant.cancel': {
        if (!isKbDaemonCurateAssistantCancelRequest(request.params)) {
          writeParentResponse(target, {
            id: request.id,
            ok: false,
            error: { message: 'Malformed KB daemon curate assistant cancel request.' },
          });
          return;
        }
        const key = parentRequestKey(requestGeneration, request.params.requestId);
        const active = activeParentRequests.get(key);
        if (active !== undefined) {
          activeParentRequests.delete(key);
          active.controller.abort(
            new Error(request.params.reason ?? 'KB daemon canceled parent curate assistant request.'),
          );
        }
        writeParentResponse(target, { id: request.id, ok: true, result: { canceled: active !== undefined } });
        return;
      }
    }
  };

  const probeNow = async (): Promise<KbDaemonHealthSnapshot> => {
    try {
      const response = await sendRequest('health');
      if (!response.ok) {
        setFailure(`health probe failed: ${response.error.message}`);
        return read();
      }
      if (!isKbDaemonHealthResult(response.result)) {
        setFailure('health probe returned malformed result');
        return read();
      }
      lastHeartbeatAt = runtime.time.now();
      lastError = undefined;
      daemonUptimeMs = response.result.uptimeMs;
      kbReadHealth = response.result.kbRead;
      kbWriteHealth = response.result.kbWrite;
      pid = response.result.pid;
      return read();
    } catch (error: unknown) {
      lastError = `health probe failed: ${errorMessage(error)}`;
      return read();
    }
  };

  const probeExclusive = (): Promise<KbDaemonHealthSnapshot> => {
    if (probeOperation !== null) {
      return probeOperation;
    }
    const running = runExclusive(probeNow);
    const tracked = running.finally(() => {
      if (probeOperation === tracked) {
        probeOperation = null;
      }
    });
    probeOperation = tracked;
    return tracked;
  };

  const warmupNow = async (): Promise<KbDaemonHealthSnapshot> => {
    try {
      const response = await sendRequest('kb.warmup');
      if (!response.ok) {
        setFailure(`warmup failed: ${response.error.message}`);
        return read();
      }
      if (!isKbDaemonKbReadHealth(response.result)) {
        setFailure('warmup returned malformed KB read health');
        return read();
      }
      lastHeartbeatAt = runtime.time.now();
      kbReadHealth = response.result;
      return read();
    } catch (error: unknown) {
      lastError = `warmup failed: ${errorMessage(error)}`;
      return read();
    }
  };

  const recoverForRequest = async (
    failedGeneration: number,
    failedPhase: KbDaemonPhase,
    reason: string,
  ): Promise<KbDaemonHealthSnapshot> =>
    runExclusive(async () => {
      if (!requestRecoveryEnabled || disposed) {
        return read();
      }
      if (
        phase === 'online' &&
        daemonProcess !== null &&
        (generation !== failedGeneration || failedPhase !== 'online')
      ) {
        return read();
      }
      if (daemonProcess !== null) {
        phase = 'restarting';
        await stopNow(reason);
        if (daemonProcess !== null) {
          return read();
        }
      }
      return startNow();
    });

  const kbUnavailable = (message: string): KbDaemonKbReadResult => ({
    ok: false,
    code: 'kb_unavailable',
    message,
    detail: { reason: 'kb_daemon_unavailable' },
  });

  const sendTypedRequest = async (
    method: KbDaemonRequestMethod,
    request: unknown,
    isResult: (value: unknown) => value is KbDaemonKbReadResult,
    malformedMessage: string,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<KbDaemonKbReadResult> => {
    const response = await sendRequest(method, request, timeoutMs, signal);
    if (!response.ok) {
      return { ok: false, code: 'kb_daemon_protocol_error', message: response.error.message };
    }
    if (!isResult(response.result)) {
      return { ok: false, code: 'kb_daemon_protocol_error', message: malformedMessage };
    }
    return response.result;
  };

  const sendKbReadRequest = (
    request: KbDaemonKbReadRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<KbDaemonKbReadResult> =>
    // The JSONL daemon protocol has no per-request cancel frame yet. The signal
    // still cancels the parent-side wait promptly; daemon-side search
    // cancellation needs a protocol-level follow-up.
    sendTypedRequest(
      'kb.read',
      request,
      isKbDaemonKbReadResult,
      'KB daemon returned malformed read result.',
      undefined,
      options.signal,
    );

  const sendKbMutationRequest = (request: KbDaemonKbMutationRequest): Promise<KbDaemonKbMutationResult> => {
    const timeoutMs =
      request.method === 'createSource' || request.method === 'reindex' ? jobRequestTimeoutMs : undefined;
    return sendTypedRequest(
      'kb.mutate',
      request,
      isKbDaemonKbMutationResult,
      'KB daemon returned malformed mutation result.',
      timeoutMs,
    );
  };

  const sendExpansionRpcRequest = (request: KbDaemonExpansionRequest): Promise<KbDaemonExpansionResult> =>
    sendTypedRequest(
      'expansion.rpc',
      request,
      isKbDaemonExpansionResult,
      'KB daemon returned malformed expansion result.',
    );

  const abortKbJobsNow = async (jobIds: string[]): Promise<KbDaemonAbortResult> => {
    try {
      const response = await sendRequest('kb.abort', { jobIds });
      if (!response.ok || !isKbDaemonAbortResult(response.result)) {
        return { aborted: [], notFound: [...jobIds] };
      }
      return response.result;
    } catch {
      return { aborted: [], notFound: [...jobIds] };
    }
  };

  const listActiveKbJobsNow = async (options: { signal?: AbortSignal } = {}): Promise<KbDaemonJobsResult> => {
    try {
      const response = await sendRequest('kb.jobs', undefined, requestTimeoutMs, options.signal);
      if (!response.ok || !isKbDaemonJobsResult(response.result)) {
        return { active: [] };
      }
      return response.result;
    } catch {
      return { active: [] };
    }
  };

  const readKbNow = async (
    request: KbDaemonKbReadRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<KbDaemonKbReadResult> => {
    if (!requestRecoveryEnabled) {
      return kbUnavailable('KB daemon read request skipped: supervisor is disposing.');
    }
    if (options.signal?.aborted) {
      return kbUnavailable('KB daemon read request aborted.');
    }
    const failedGeneration = generation;
    const failedPhase = phase;
    try {
      return await sendKbReadRequest(request, options);
    } catch (error: unknown) {
      if (options.signal?.aborted) {
        return kbUnavailable('KB daemon read request aborted.');
      }
      const initialError = errorMessage(error);
      const recovered = await recoverForRequest(failedGeneration, failedPhase, 'read request recovery');
      if (recovered.phase !== 'online') {
        return kbUnavailable(`KB daemon read request failed: ${initialError}; recovery ended in ${recovered.phase}.`);
      }
      try {
        return await sendKbReadRequest(request, options);
      } catch (retryError: unknown) {
        if (options.signal?.aborted) {
          return kbUnavailable('KB daemon read request aborted.');
        }
        return kbUnavailable(
          `KB daemon read request failed after recovery: ${errorMessage(retryError)}; initial failure: ${initialError}`,
        );
      }
    }
  };

  const mutateKbNow = async (request: KbDaemonKbMutationRequest): Promise<KbDaemonKbMutationResult> => {
    if (!requestRecoveryEnabled) {
      return kbUnavailable('KB daemon mutation request skipped: supervisor is disposing.');
    }
    const failedGeneration = generation;
    const failedPhase = phase;
    if (phase !== 'online' || daemonProcess === null) {
      const recovered = await recoverForRequest(failedGeneration, failedPhase, 'mutation request recovery');
      if (recovered.phase !== 'online') {
        return kbUnavailable(`KB daemon mutation request skipped: recovery ended in ${recovered.phase}.`);
      }
    }
    try {
      return await sendKbMutationRequest(request);
    } catch (error: unknown) {
      return kbUnavailable(`KB daemon mutation request failed: ${errorMessage(error)}; request was not retried.`);
    }
  };

  const expansionRpcNow = async (request: KbDaemonExpansionRequest): Promise<KbDaemonExpansionResult> => {
    if (!requestRecoveryEnabled) {
      return kbUnavailable('KB daemon expansion request skipped: supervisor is disposing.');
    }
    const failedGeneration = generation;
    const failedPhase = phase;
    if (phase !== 'online' || daemonProcess === null) {
      const recovered = await recoverForRequest(failedGeneration, failedPhase, 'expansion request recovery');
      if (recovered.phase !== 'online') {
        return kbUnavailable(`KB daemon expansion request skipped: recovery ended in ${recovered.phase}.`);
      }
    }
    try {
      return await sendExpansionRpcRequest(request);
    } catch (error: unknown) {
      return kbUnavailable(`KB daemon expansion request failed: ${errorMessage(error)}; request was not retried.`);
    }
  };

  const startNow = async (): Promise<KbDaemonHealthSnapshot> => {
    if (disposed || daemonProcess !== null) {
      return read();
    }

    generation += 1;
    phase = 'starting';
    startedAt = runtime.time.now();
    readyAt = null;
    lastError = undefined;
    stderrBuffer = '';
    lastHeartbeatAt = undefined;
    lastHeartbeatLatencyMs = undefined;
    daemonUptimeMs = undefined;
    kbReadHealth = undefined;
    kbWriteHealth = undefined;

    let spawned: DaemonProcessLike | null = null;
    let pipedHandles: ReturnType<typeof requirePipedHandles> | undefined;
    try {
      spawned = runtime.process.spawn({
        command,
        args: [entrypoint],
        cwd: pluginRoot,
        envAdditions: {
          // Inherited CORAL_KB_* config + allowlisted parent knobs first; daemon-identity
          // vars below override any collision.
          ...forwardedKbDaemonEnv,
          CORAL_KB_DAEMON: '1',
          CORAL_KB_DAEMON_GENERATION: String(generation),
          CORAL_KB_DAEMON_PARENT_PID: String(process.pid),
          CORAL_KB_DAEMON_BACKEND_NAMESPACE: backendNamespace,
          CORAL_KB_DAEMON_BUNDLE_HASH: bundleHash,
          ...(options.instanceId === undefined ? {} : { CORAL_KB_DAEMON_INSTANCE_ID: options.instanceId }),
        },
      });
      pipedHandles = requirePipedHandles(spawned, command);
    } catch (error: unknown) {
      if (spawned !== null) {
        safeKill(spawned, 'SIGTERM');
      }
      daemonProcess = null;
      pid = null;
      setFailure(`spawn failed: ${formatError(error)}`);
      return read();
    }
    if (spawned === null || pipedHandles === undefined) {
      setFailure('spawn did not return a daemon process');
      return read();
    }

    daemonProcess = spawned;
    pid = spawned.pid ?? null;
    const activeGeneration = generation;
    const startedAtForExit = startedAt;
    const { stdin, stdout, stderr } = pipedHandles;
    stdout.setEncoding('utf-8');
    stderr.setEncoding('utf-8');
    // A write to a dead child surfaces EPIPE asynchronously as a stdin 'error'
    // event; with no listener Node re-throws it as an uncaughtException and
    // crashes the coordinator. Swallow it here — the 'close' handler below owns
    // real teardown (rejectPendingRequests / phase transition). Mirrors the
    // sibling live transports (provider-server-transport, durable-transport).
    stdin.on('error', (error: unknown) => {
      log(`[kb-daemon] stdin error: ${formatError(error)}`);
    });

    const readyPromise = new Promise<'ready' | 'closed' | 'error' | 'timeout'>((resolve) => {
      let settled = false;
      let lineBuffer = '';
      const settle = (result: 'ready' | 'closed' | 'error' | 'timeout'): void => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(result);
      };

      const timeout = runtime.time.setTimeout(() => {
        settle('timeout');
      }, startTimeoutMs);
      timeout.unref?.();

      stdout.on('data', (chunk) => {
        lineBuffer += String(chunk);
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim().length === 0) {
            continue;
          }
          try {
            const parsed = JSON.parse(line) as unknown;
            if (isKbDaemonReadyMessage(parsed)) {
              if (activeGeneration === generation && daemonProcess === spawned) {
                pid = parsed.pid;
                readyAt = parsed.readyAt;
                phase = 'online';
              }
              runtime.time.clearTimeout(timeout);
              settle('ready');
              continue;
            }
            if (isKbDaemonResponseMessage(parsed)) {
              const pending = pendingRequests.get(parsed.id);
              if (pending !== undefined) {
                runtime.time.clearTimeout(pending.timeout);
                pendingRequests.delete(parsed.id);
                pending.resolve(parsed);
              }
              continue;
            }
            if (isKbDaemonEventMessage(parsed)) {
              try {
                options.onEvent?.(parsed);
              } catch (error: unknown) {
                log(`[kb-daemon] event callback failed: ${formatError(error)}`);
              }
              continue;
            }
            if (isKbDaemonParentRequestMessage(parsed)) {
              handleParentRequest(parsed, spawned, activeGeneration);
              continue;
            }
          } catch {
            // Non-control stdout is ignored; stderr is retained for diagnostics.
          }
        }
      });

      stderr.on('data', (chunk) => {
        stderrBuffer = appendBuffer(stderrBuffer, String(chunk));
      });

      spawned.on('error', (error) => {
        lastError = `daemon process error: ${formatError(error)}`;
        runtime.time.clearTimeout(timeout);
        settle('error');
      });

      spawned.on('close', (code, signal) => {
        runtime.time.clearTimeout(timeout);
        lastExit = {
          code,
          signal,
          at: runtime.time.now(),
          uptimeMs: startedAtForExit === null ? null : Math.max(0, runtime.time.now() - startedAtForExit),
        };
        if (daemonProcess === spawned) {
          daemonProcess = null;
          pid = null;
          readyAt = null;
          rejectPendingRequests('KB daemon exited', activeGeneration);
          abortActiveParentRequests('KB daemon exited', activeGeneration);
          if (phase === 'stopping') {
            phase = 'stopped';
          } else {
            phase = 'failed';
            lastError = stderrBuffer.trim().length > 0 ? stderrBuffer.trim() : 'daemon exited';
          }
          notifyExitListeners();
        }
        settle('closed');
      });
    });

    const result = await readyPromise;
    if (result === 'error' && daemonProcess === spawned) {
      setFailure(lastError ?? 'daemon start failed');
    }
    if (result === 'timeout' && daemonProcess === spawned) {
      setFailure(`daemon did not become ready within ${startTimeoutMs}ms`);
      gracefulKill(spawned, runtime);
    }

    return read();
  };

  const stopNow = async (reason = 'stop', signal?: AbortSignal): Promise<KbDaemonHealthSnapshot> => {
    const activeDaemonProcess = daemonProcess;
    if (activeDaemonProcess === null) {
      phase = 'stopped';
      pid = null;
      readyAt = null;
      rejectPendingRequests('KB daemon stopped');
      return read();
    }

    phase = 'stopping';
    const closed = waitForClose(activeDaemonProcess).then(() => 'closed' as const);
    try {
      activeDaemonProcess.stdin?.write(
        encodeKbDaemonMessage({
          type: KB_DAEMON_REQUEST_MESSAGE,
          id: `${generation}:shutdown`,
          method: 'shutdown',
          params: { reason },
        }),
      );
      activeDaemonProcess.stdin?.end();
    } catch {
      gracefulKill(activeDaemonProcess, runtime);
    }

    const result = await Promise.race([closed, withAbortableTimeout(runtime, stopTimeoutMs, signal)]);
    if (result !== 'closed' && daemonProcess === activeDaemonProcess) {
      setFailure(
        result === 'aborted'
          ? 'daemon stop aborted by shutdown budget'
          : `daemon stop timed out after ${stopTimeoutMs}ms`,
      );
      gracefulKill(activeDaemonProcess, runtime);
    }
    rejectPendingRequests('KB daemon stopped');
    return read();
  };

  return {
    read,
    onExit: (listener) => {
      exitListeners.add(listener);
      return () => {
        exitListeners.delete(listener);
      };
    },
    start: () =>
      runExclusive(async () => {
        if (disposed) {
          return read();
        }
        requestRecoveryEnabled = true;
        return startNow();
      }),
    probe: probeExclusive,
    warmup: () => runExclusive(warmupNow),
    readKb: readKbNow,
    mutateKb: mutateKbNow,
    expansionRpc: expansionRpcNow,
    abortKbJobs: abortKbJobsNow,
    listActiveKbJobs: listActiveKbJobsNow,
    stop: (reason, stopOptions) => runExclusive(() => stopNow(reason, stopOptions?.signal)),
    restart: (reason = 'restart') =>
      runExclusive(async () => {
        if (disposed) {
          return read();
        }
        requestRecoveryEnabled = true;
        phase = 'restarting';
        await stopNow(reason);
        if (daemonProcess !== null) {
          return read();
        }
        return startNow();
      }),
    dispose: async (reason = 'dispose', disposeOptions) => {
      requestRecoveryEnabled = false;
      await runExclusive(() => {
        // Re-assert inside the exclusive turn: a start/restart queued ahead of us
        // re-enables recovery, so disabling only before runExclusive would let a
        // post-dispose read/mutate revive the daemon. This second write is load-bearing.
        requestRecoveryEnabled = false;
        // Terminal supervisor disposal is distinct from a recoverable stop. A
        // start/restart queued after this turn must not flip recovery back on.
        disposed = true;
        return stopNow(reason, disposeOptions?.signal);
      });
    },
  };
}

export function createDefaultKbDaemonSupervisor(options: KbDaemonSupervisorOptions): KbDaemonSupervisor {
  const entrypoint = options.entrypoint ?? resolveDefaultKbDaemonEntrypoint(options.pluginRoot);
  if (!options.runtime.storage.existsSync(entrypoint)) {
    throw new Error(`KB daemon entrypoint not found: ${entrypoint}`);
  }

  return createKbDaemonSupervisor({ ...options, entrypoint });
}

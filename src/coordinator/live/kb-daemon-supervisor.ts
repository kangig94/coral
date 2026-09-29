import { basename, join } from 'node:path';
import type { ChildProcessLike } from '../../infra/port-types.js';
import {
  gracefulKill,
  safeKill,
  type GracefulKillDisposition,
  type GracefulKillOutcome,
  type GracefulKillPendingDisposition,
} from '../../infra/process-supervision.js';
import { readBundleHash, resolveStrictBundleIdentity } from '../../infra/bundle-manifest.js';
import { pluginRootNamespace } from '../../infra/plugin-identity.js';
import type { Runtime } from '../../runtime/ports.js';
import type { SerializedCoralSetupError } from '../../runtime/errors.js';
import type { ResolvedStoreEpoch } from '../../store/epoch.js';
import type { SuccessionWriterGeneration } from '../../store/succession-writer-generation.js';
import {
  KB_DAEMON_REQUEST_MESSAGE,
  KB_DAEMON_PARENT_RESPONSE_MESSAGE,
  encodeKbDaemonMessage,
  isKbDaemonAbortResult,
  isKbDaemonCurateRequestCancelRequest,
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
} from '../../kb-daemon/protocol.js';
import type {
  KbDaemonAbortResult,
  KbDaemonCurateAssistantCompleteRequest,
  KbDaemonEventMessage,
  KbDaemonExpansionRequest,
  KbDaemonExpansionResult,
  KbDaemonJobsResult,
  KbDaemonKbMutationRequest,
  KbDaemonKbMutationResult,
  KbDaemonKbReadHealth,
  KbDaemonKbReadRequest,
  KbDaemonKbReadResult,
  KbDaemonRequestMethod,
  KbDaemonResponseMessage,
  KbDaemonParentRequestMessage,
  KbDaemonErrorEnvelope,
} from '../../kb-daemon/protocol.js';
import { createKbDaemonHealth } from './kb-daemon-supervisor/health.js';
import { createKbDaemonRequests } from './kb-daemon-supervisor/requests.js';
import { createKbDaemonParentRequests } from './kb-daemon-supervisor/parent-requests.js';
import { createKbDaemonStarter } from './kb-daemon-supervisor/process-start.js';
import { createKbDaemonProcessStop } from './kb-daemon-supervisor/process-stop.js';
import { createKbDaemonSupervisorState } from './kb-daemon-supervisor/state.js';
import { createKbDaemonSupervisorPorts } from './kb-daemon-supervisor/ports.js';
import { createKbDaemonServiceRequests } from './kb-daemon-supervisor/service-requests.js';

const daemonProtocol = {
  KB_DAEMON_REQUEST_MESSAGE,
  KB_DAEMON_PARENT_RESPONSE_MESSAGE,
  encodeKbDaemonMessage,
  isKbDaemonAbortResult,
  isKbDaemonCurateRequestCancelRequest,
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
} as const;

export type KbDaemonProtocolBindings = typeof daemonProtocol;

export type KbDaemonWireTypes = {
  abortResult: KbDaemonAbortResult;
  eventMessage: KbDaemonEventMessage;
  expansionRequest: KbDaemonExpansionRequest;
  expansionResult: KbDaemonExpansionResult;
  jobsResult: KbDaemonJobsResult;
  mutationRequest: KbDaemonKbMutationRequest;
  mutationResult: KbDaemonKbMutationResult;
  readHealth: KbDaemonKbReadHealth;
  readRequest: KbDaemonKbReadRequest;
  readResult: KbDaemonKbReadResult;
  requestMethod: KbDaemonRequestMethod;
  responseMessage: KbDaemonResponseMessage;
  parentRequestMessage: KbDaemonParentRequestMessage;
  errorEnvelope: KbDaemonErrorEnvelope;
};

export type DaemonProcessLike = ReturnType<Runtime['process']['spawn']>;

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
  setupError?: SerializedCoralSetupError;
};

export type KbDaemonDisposalSettlement =
  | Readonly<{ kind: 'confirmed-absent'; snapshot: KbDaemonHealthSnapshot }>
  | Readonly<{
      kind: 'holding';
      snapshot: KbDaemonHealthSnapshot;
      reason: string;
      exit: 'kb-daemon-process-close';
      retryAfter: Promise<void>;
      retry(signal?: AbortSignal): Promise<KbDaemonDisposalSettlement>;
    }>;

export interface KbDaemonSupervisor {
  read(): KbDaemonHealthSnapshot;
  onExit?(listener: (snapshot: KbDaemonHealthSnapshot) => void): () => void;
  start(store?: ResolvedStoreEpoch): Promise<KbDaemonHealthSnapshot>;
  probe(): Promise<KbDaemonHealthSnapshot>;
  warmup(): Promise<KbDaemonHealthSnapshot>;
  readKb(request: KbDaemonKbReadRequest, options?: { signal?: AbortSignal }): Promise<KbDaemonKbReadResult>;
  mutateKb(request: KbDaemonKbMutationRequest, signal?: AbortSignal): Promise<KbDaemonKbMutationResult>;
  expansionRpc(request: KbDaemonExpansionRequest, signal?: AbortSignal): Promise<KbDaemonExpansionResult>;
  abortKbJobs?(jobIds: string[]): Promise<KbDaemonAbortResult>;
  listActiveKbJobs?(options?: { signal?: AbortSignal }): Promise<KbDaemonJobsResult>;
  listActiveKbJobsForSuccession?(options?: { signal?: AbortSignal }): Promise<KbDaemonJobsResult>;
  parkWriterTurn?(signal?: AbortSignal): Promise<void>;
  reclaimWriterTurn?(generation: SuccessionWriterGeneration, signal?: AbortSignal): Promise<void>;
  stop(reason?: string, options?: { signal?: AbortSignal }): Promise<KbDaemonHealthSnapshot>;
  restart(reason?: string, signal?: AbortSignal): Promise<KbDaemonHealthSnapshot>;
  dispose(reason?: string, options?: { signal?: AbortSignal }): Promise<KbDaemonDisposalSettlement>;
}

export type KbDaemonCurateAssistantHandler = (
  request: KbDaemonCurateAssistantCompleteRequest,
  options: { signal: AbortSignal },
) => Promise<string>;

export type KbDaemonCurateUsageBudgetHandler = (options: { signal: AbortSignal }) => Promise<boolean>;

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
  curateUsageBudget?: KbDaemonCurateUsageBudgetHandler;
  onEvent?: (message: KbDaemonEventMessage) => void;
  log?: (message: string) => void;
};

/**
 * How much of a dead daemon's output may travel as its exit diagnostic.
 *
 * The retained stderr buffer is capped at `MAX_BUFFER`, which is the same ten mebibytes as the transport's
 * `MAX_FRAME_BYTES`. Handing the whole buffer to `lastError` therefore produced a health response that
 * overflowed one IPC frame by exactly the JSON around it — `frame_too_large` at 10,486,912 bytes against a
 * 10,485,760 limit — and every operator command that reads daemon health failed while the diagnostic was
 * needed most. `PROVIDER_HOST_LOG_MAX_BYTES` was the same equality in the provider host log; this is the
 * second place it lived.
 *
 * The tail, not the head: the output that explains an exit is the output nearest to it.
 */
export const KB_DAEMON_EXIT_DIAGNOSTIC_MAX_CHARS = 64 * 1024;

function daemonExitDiagnostic(stderr: string): string {
  const trimmed = stderr.trim();
  if (trimmed.length === 0) {
    return 'daemon exited';
  }
  if (trimmed.length <= KB_DAEMON_EXIT_DIAGNOSTIC_MAX_CHARS) {
    return trimmed;
  }
  return `[earlier output truncated]\n${trimmed.slice(-KB_DAEMON_EXIT_DIAGNOSTIC_MAX_CHARS)}`;
}

const kbDaemonKills = new WeakMap<ChildProcessLike, GracefulKillPendingDisposition>();

function requestKbDaemonKill(child: ChildProcessLike, runtime: Runtime): GracefulKillDisposition {
  const current = kbDaemonKills.get(child);
  if (current !== undefined) return current;
  const disposition = gracefulKill(child, runtime, (pid) => runtime.process.observeLiveness(pid));
  if ('settlement' in disposition) {
    kbDaemonKills.set(child, disposition);
    void disposition.settlement.then(() => {
      if (kbDaemonKills.get(child) === disposition) kbDaemonKills.delete(child);
    });
  }
  return disposition;
}

function kbDaemonKillFailure(outcome: Exclude<GracefulKillOutcome, { kind: 'observed-absent' }>): string {
  switch (outcome.kind) {
    case 'target-alive':
    case 'target-unobservable':
      return `KB daemon termination ${outcome.kind}: ${outcome.stage}`;
    case 'signal-failed':
      return `KB daemon termination ${outcome.kind}: ${outcome.reason}`;
  }
}

function killFailedKbDaemonSpawn(child: ChildProcessLike): void {
  safeKill(child, 'SIGTERM');
}

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

function resolveDefaultKbDaemonEntrypoint(pluginRoot: string, currentEntrypoint = process.argv[1]): string {
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
  // A nested/child caller is the normal way this failure is reached (skills and hooks run
  // `coral-cli kb ...` from inside a job Coral itself launched), and it cannot shut down the
  // coordinator its own parent job is running on. Phrase the remediation so it stays true and
  // actionable no matter which caller reads it, instead of pointing everyone at a command that
  // is refused from a child.
  const remediation =
    'Ask the operator to run `coral-cli backend shutdown` from the top-level Coral session once nothing else ' +
    'is running, or wait for the automatic idle restart (CORAL_BACKEND_IDLE_MS, default ~6h). A nested/child ' +
    'job cannot run that shutdown itself.';

  return {
    read: () => ({ ...snapshot }),
    start: async () => ({ ...snapshot }),
    probe: async () => ({ ...snapshot }),
    warmup: async () => ({ ...snapshot }),
    readKb: async () => ({
      ok: false,
      code: 'kb_disabled',
      message: `KB daemon supervisor is disabled: ${reason}`,
      remediation,
      detail: { reason: 'kb_daemon_disabled' },
    }),
    mutateKb: async () => ({
      ok: false,
      code: 'kb_disabled',
      message: `KB daemon supervisor is disabled: ${reason}`,
      remediation,
      detail: { reason: 'kb_daemon_disabled' },
    }),
    expansionRpc: async () => ({
      ok: false,
      code: 'kb_disabled',
      message: `KB daemon supervisor is disabled: ${reason}`,
      remediation,
      detail: { reason: 'kb_daemon_disabled' },
    }),
    onExit: () => () => {},
    abortKbJobs: async (jobIds) => ({ aborted: [], notFound: [...jobIds] }),
    listActiveKbJobs: async () => ({ active: [] }),
    parkWriterTurn: async () => {},
    reclaimWriterTurn: async () => {},
    stop: async () => ({ ...snapshot }),
    restart: async () => ({ ...snapshot }),
    dispose: async () => ({ kind: 'confirmed-absent', snapshot: { ...snapshot } }),
  };
}

export function createKbDaemonSupervisor(options: KbDaemonSupervisorOptions): KbDaemonSupervisor {
  const { runtime, pluginRoot } = options;
  const command = options.command ?? process.execPath;
  const entrypoint = options.entrypoint ?? resolveDefaultKbDaemonEntrypoint(pluginRoot);
  const runningIdentity = resolveStrictBundleIdentity();
  const startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  const stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const jobRequestTimeoutMs = options.jobRequestTimeoutMs ?? DEFAULT_JOB_REQUEST_TIMEOUT_MS;
  const backendNamespace = resolveDaemonBackendNamespace(pluginRoot, options.backendNamespace);
  const bundleHash = resolveDaemonBundleHash(pluginRoot, options.bundleHash);
  const forwardedKbDaemonEnv = collectForwardedKbDaemonEnv(runtime.env);
  const parentCurateAssistant = options.curateAssistant;
  const parentCurateUsageBudget = options.curateUsageBudget;
  const log = options.log ?? (() => undefined);

  const state = createKbDaemonSupervisorState();

  const { forwardDaemonStderrLine, read, setFailure, notifyExitListeners } = createKbDaemonHealth(
    runtime,
    entrypoint,
    log,
    state,
  );

  const acceptKbDaemonKill = (child: ChildProcessLike): void => {
    const disposition = requestKbDaemonKill(child, runtime);
    if (!('settlement' in disposition)) {
      setFailure(kbDaemonKillFailure(disposition));
      return;
    }
    void disposition.settlement.then((outcome) => {
      if (outcome.kind !== 'observed-absent' && state.daemonProcess === child) {
        setFailure(kbDaemonKillFailure(outcome));
      }
    });
  };

  const { runExclusive, rejectPendingRequests, sendRequest } = createKbDaemonRequests(
    runtime,
    state,
    read,
    requestTimeoutMs,
    daemonProtocol,
  );

  const { abortActiveParentRequests, handleParentRequest } = createKbDaemonParentRequests(
    state,
    log,
    parentCurateAssistant,
    parentCurateUsageBudget,
    daemonProtocol,
  );

  const serviceRequests = createKbDaemonServiceRequests(
    runtime,
    state,
    {
      sendRequest,
      setFailure,
      read,
      runExclusive,
      startNow: () => startNow(),
      stopNow: (reason) => stopNow(reason),
      requestTimeoutMs,
      jobRequestTimeoutMs,
    },
    daemonProtocol,
  );

  const { startNow } = createKbDaemonStarter(
    {
      runtime,
      pluginRoot,
      command,
      entrypoint,
      runningIdentity,
      forwardedKbDaemonEnv,
      backendNamespace,
      bundleHash,
      instanceId: options.instanceId,
      startTimeoutMs,
      onEvent: options.onEvent,
      log,
      daemonExitDiagnostic,
    },
    state,
    {
      read,
      setFailure,
      acceptKbDaemonKill,
      rejectPendingRequests,
      abortActiveParentRequests,
      notifyExitListeners,
      handleParentRequest,
      forwardDaemonStderrLine,
      killFailedSpawn: killFailedKbDaemonSpawn,
    },
    daemonProtocol,
  );

  const { stopNow } = createKbDaemonProcessStop(
    runtime,
    state,
    stopTimeoutMs,
    {
      read,
      setFailure,
      acceptKbDaemonKill,
      rejectPendingRequests,
      runExclusive,
    },
    daemonProtocol,
  );

  return createKbDaemonSupervisorPorts(state, {
    read,
    runExclusive,
    sendRequest,
    ...serviceRequests,
    startNow,
    stopNow,
    requestTimeoutMs,
  });
}

export function createDefaultKbDaemonSupervisor(options: KbDaemonSupervisorOptions): KbDaemonSupervisor {
  const entrypoint = options.entrypoint ?? resolveDefaultKbDaemonEntrypoint(options.pluginRoot);
  if (!options.runtime.storage.existsSync(entrypoint)) {
    throw new Error(`KB daemon entrypoint not found: ${entrypoint}`);
  }

  return createKbDaemonSupervisor({ ...options, entrypoint });
}

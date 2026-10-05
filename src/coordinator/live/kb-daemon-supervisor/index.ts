import { basename, join } from 'node:path';
import type { ChildProcessLike } from '../../../infra/port-types.js';
import {
  gracefulKill,
  safeKill,
  type GracefulKillDisposition,
  type GracefulKillOutcome,
  type GracefulKillPendingDisposition,
} from '../../../infra/process-supervision.js';
import { readBundleHash } from '../../../infra/bundle-manifest.js';
import { pluginRootNamespace } from '../../../infra/plugin-identity.js';
import type { Runtime } from '../../../runtime/ports.js';
import type { SerializedCoralSetupError } from '../../../runtime/errors.js';
import type { ResolvedStoreEpoch } from '../../../store/epoch/index.js';
import type { SuccessionWriterGeneration } from '../../../store/succession-writer-generation.js';
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
} from '../../../kb-daemon/protocol.js';
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
} from '../../../kb-daemon/protocol.js';
import { createKbDaemonHealth } from './health.js';
import { createKbDaemonRequests } from './requests.js';
import { createKbDaemonParentRequests } from './parent-requests.js';
import { createKbDaemonStarter } from './process-start.js';
import { createKbDaemonProcessStop } from './process-stop.js';
import { createKbDaemonSupervisorState } from './state.js';
import { createKbDaemonSupervisorPorts } from './ports.js';
import { createKbDaemonServiceRequests } from './service-requests.js';

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
  childPresence?: 'present' | 'absent';
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

export const CORAL_KB_ENV_PREFIX = 'CORAL_KB_';

export const PARENT_FORWARDED_KB_ENV = ['CORAL_BOOT_FRESHNESS_TIMEOUT_MS'] as const;

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

import { backendLog } from '../infra/backend-log.js';
import { errorMessage } from '../infra/error-format.js';
import { buildJsonRpcError } from '../infra/json-rpc.js';
import { MAX_BUFFER, SIGTERM_GRACE_MS } from '../infra/process-constants.js';
import { shouldUseWindowsCommandShell } from '../infra/windows-shell.js';
import type { ChildProcessLike } from '../infra/port-types.js';
import type { ProcessIncarnation } from '../infra/node-process.js';
import type { Runtime } from '../runtime/ports.js';
import { AbortError } from '../runtime/abort.js';
import {
  cleanupSpawnedProcessGroup,
  gracefulKill,
  observeRetainedSpawnedProcessGroup,
  observeUnattributableSpawnedProcessGroup,
  requirePipedHandles,
  retainSpawnedProcessGroupCleanup,
  type GracefulKillDisposition,
  type GracefulKillOutcome,
  type SpawnedProcessGroupAbsenceEvidence,
  type SpawnedProcessGroupCleanup,
  type SpawnedProcessGroupCleanupDisposition,
} from '../infra/process-supervision.js';
import {
  assertRecordedContainmentIdentity,
  ProcessContainmentError,
  type RecordedContainmentIdentity,
} from '../infra/process-containment.js';
import {
  appendProviderHostLog,
  createProviderHostDiagnostics,
  currentProviderHostLogSeq,
  inspectProviderHostDiagnostics,
  recordProviderResponseDiagnostic,
  type ProviderHostDiagnosticsSnapshot,
  type ProviderHostDiagnosticsState,
  type ProviderHostLogCursorSpan,
  type ProviderResponseObservationSink as HostResponseObservationSink,
} from './host-diagnostics.js';
import type {
  ProviderServerFailedSpawnOperatorAbandonment,
  ProviderServerFailedSpawnOperatorExit,
  ProviderServerFailedSpawnSubject,
} from './contract.js';

export type ProviderResponseObservationSink = HostResponseObservationSink;

export const PROVIDER_SERVER_MAX_JSONL_LINE_BYTES = MAX_BUFFER;
export const PROVIDER_SERVER_INITIALIZE_TIMEOUT_MS = 30_000;
export const PROVIDER_CONTAINMENT_ACCEPTED = Symbol('provider-containment-accepted');
export type ProviderContainmentAcceptance = typeof PROVIDER_CONTAINMENT_ACCEPTED;

class ProviderServerLineTooLargeError extends Error {
  readonly code = 'provider_server_line_too_large';
  readonly maxLineBytes: number;
  readonly observedBytes: number;

  constructor(observedBytes: number, maxLineBytes = PROVIDER_SERVER_MAX_JSONL_LINE_BYTES) {
    super(`Provider server JSONL line exceeded ${maxLineBytes} bytes (observed ${observedBytes}).`);
    this.name = 'ProviderServerLineTooLargeError';
    this.maxLineBytes = maxLineBytes;
    this.observedBytes = observedBytes;
    Object.setPrototypeOf(this, ProviderServerLineTooLargeError.prototype);
  }
}

export type ProviderHostDiagnosticReference = Readonly<{
  generation: number;
  inspect: () => ProviderHostDiagnosticsSnapshot;
}>;

export class ProviderRpcError extends Error {
  readonly requestId: number;
  readonly method: string;
  readonly rpcCode: number | undefined;
  readonly providerMessage: string | undefined;
  readonly providerData: unknown;
  readonly hostLog: ProviderHostLogCursorSpan;

  constructor(params: {
    requestId: number;
    method: string;
    rpcCode: number | undefined;
    providerMessage: string | undefined;
    providerData: unknown;
    hostLog: ProviderHostLogCursorSpan;
  }) {
    super(renderProviderRpcErrorMessage(params));
    this.name = 'ProviderRpcError';
    this.requestId = params.requestId;
    this.method = params.method;
    this.rpcCode = params.rpcCode;
    this.providerMessage = params.providerMessage;
    this.providerData = params.providerData;
    this.hostLog = Object.freeze({ ...params.hostLog });
    Object.setPrototypeOf(this, ProviderRpcError.prototype);
  }
}

export class ProviderHostFault extends Error {
  readonly provider: string;
  readonly detail: string;
  readonly data: unknown;
  readonly diagnosticRef: ProviderHostDiagnosticReference;

  constructor(provider: string, detail: string, diagnosticRef: ProviderHostDiagnosticReference, data?: unknown) {
    super(`Provider server ${provider} ${detail}`);
    this.name = 'ProviderHostFault';
    this.provider = provider;
    this.detail = detail;
    this.data = data;
    this.diagnosticRef = diagnosticRef;
    Object.setPrototypeOf(this, ProviderHostFault.prototype);
  }
}

type ProviderServerNotification = {
  method: string;
  params?: Record<string, unknown>;
};

type ProviderServerMessage = {
  id?: number;
  method?: string;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
  params?: Record<string, unknown>;
};

type ProviderServerPendingRequest = {
  method: string;
  startSeq: number;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type ProviderServerRpc = {
  request: <TResult = unknown>(method: string, params?: Record<string, unknown>) => Promise<TResult>;
  notify: (method: string, params?: Record<string, unknown>) => void;
};

export type ProviderServerHandle = {
  pid: number;
  child: ChildProcessLike;
  generation: number;
  rpc: ProviderServerRpc;
  onNotification: (handler: (message: ProviderServerNotification) => void) => () => void;
  closePromise: Promise<Error | void>;
  isClosed(): boolean;
  inspectDiagnostics: () => ProviderHostDiagnosticsSnapshot;
  markExpectedClose: () => void;
  close: (acceptCleanupHold: ProviderServerCleanupHoldAcceptor) => Promise<ProviderServerCloseDisposition>;
};

const providerServerShutdownRequests = new WeakMap<ProviderServerHandle, Map<string, Promise<unknown>>>();

/** Concurrent shutdown requests for the same handle and method must join until the active request settles. */
export function requestJoinableProviderServerShutdown(handle: ProviderServerHandle, method: string): Promise<unknown> {
  const existing = providerServerShutdownRequests.get(handle);
  const requests = existing ?? new Map<string, Promise<unknown>>();
  if (existing === undefined) providerServerShutdownRequests.set(handle, requests);
  const current = requests.get(method);
  if (current !== undefined) return current;
  const request = handle.rpc.request(method, {});
  requests.set(method, request);
  void request.then(
    () => {
      if (requests.get(method) === request) requests.delete(method);
      if (requests.size === 0) providerServerShutdownRequests.delete(handle);
    },
    () => {
      if (requests.get(method) === request) requests.delete(method);
      if (requests.size === 0) providerServerShutdownRequests.delete(handle);
    },
  );
  return request;
}

/** A provider server handle whose detached process-group identity was verified at spawn. */
export type ContainedProviderServerHandle = ProviderServerHandle &
  Readonly<{
    containmentIdentity: RecordedContainmentIdentity;
    /** Finalizes transport state after the owner has already confirmed the recorded group absent. */
    finishCloseAfterReap: () => Promise<void>;
  }>;

type ProviderServerEntry = {
  provider: string;
  child: ChildProcessLike;
  pid: number;
  generation: number;
  pending: Map<number, ProviderServerPendingRequest>;
  nextRequestId: number;
  notificationHandlers: Set<(message: ProviderServerNotification) => void>;
  stdoutBuffer: string;
  stdoutBufferBytes: number;
  diagnostics: ProviderHostDiagnosticsState;
  diagnosticRef: ProviderHostDiagnosticReference;
  observeProviderResponse: ProviderResponseObservationSink;
  closed: boolean;
  processSettlement: ProviderProcessSettlement;
  closeRequested: boolean;
  closePromise: Promise<Error | void>;
  resolveClose: (outcome: Error | void) => void;
  closeOutcome: Error | void;
};

export type SpawnProviderServerOptions = {
  provider: string;
  command: string;
  args: string[];
  cwd?: string;
  extraEnv?: Record<string, string>;
  exactEnv?: Record<string, string>;
  signal?: AbortSignal;
  initializeRequest?: {
    method: string;
    params: Record<string, unknown>;
  };
  initializeTimeoutMs?: number;
};

export type SpawnProviderServerFn = (
  options: SpawnProviderServerOptions,
  observeProviderResponse: ProviderResponseObservationSink,
  generation: number,
  recordContainment: ((containment: RecordedContainmentIdentity) => ProviderContainmentAcceptance) | undefined,
  acceptFailedSpawnCleanup: ProviderServerFailedSpawnCleanupAcceptor,
) => Promise<ContainedProviderServerHandle | HeldProviderServerSpawn>;

export type ProviderServerFailedSpawnAbsenceEvidence<ProcessGroupId extends number = number> =
  | Readonly<{ subject: Extract<ProviderServerFailedSpawnSubject, { kind: 'process' }> }>
  | Readonly<{ processGroupEvidence: SpawnedProcessGroupAbsenceEvidence<ProcessGroupId> }>;

export type ProviderServerFailedSpawnCleanupDisposition<ProcessGroupId extends number = number> =
  | Readonly<{ kind: 'observed-absent'; evidence: ProviderServerFailedSpawnAbsenceEvidence<ProcessGroupId> }>
  | Readonly<{
      kind: 'held-alive';
      subject: Extract<ProviderServerFailedSpawnSubject<ProcessGroupId>, { kind: 'process' | 'process-group' }>;
      observation: 'alive';
      operatorExit: ProviderServerFailedSpawnOperatorExit<ProcessGroupId>;
      settled: Promise<void>;
      retry(signal?: AbortSignal): Promise<ProviderServerFailedSpawnCleanupDisposition<ProcessGroupId>>;
    }>
  | Readonly<{
      kind: 'held-unobservable';
      subject: ProviderServerFailedSpawnSubject<ProcessGroupId>;
      observation: 'unobservable';
      operatorExit: ProviderServerFailedSpawnOperatorExit<ProcessGroupId>;
      settled: Promise<void>;
      retry(signal?: AbortSignal): Promise<ProviderServerFailedSpawnCleanupDisposition<ProcessGroupId>>;
    }>
  | ProviderServerFailedSpawnOperatorAbandonment<ProcessGroupId>;

export type ProviderServerFailedSpawnCleanupTerminalDisposition = Extract<
  ProviderServerFailedSpawnCleanupDisposition,
  { kind: 'observed-absent' | 'operator-abandoned' }
>;

/** An operator transfer discharges only the exact process obligation named by its accepted hold. */
export function isAcceptedProviderServerOperatorAbandonment(
  hold: Pick<ProviderServerCleanupHold, 'subject'>,
  disposition: unknown,
): disposition is ProviderServerFailedSpawnOperatorAbandonment {
  if (
    typeof disposition !== 'object' ||
    disposition === null ||
    !('kind' in disposition) ||
    disposition.kind !== 'operator-abandoned' ||
    !('processAbsenceProven' in disposition) ||
    disposition.processAbsenceProven !== false ||
    !('successor' in disposition) ||
    typeof disposition.successor !== 'object' ||
    disposition.successor === null ||
    !('owner' in disposition.successor) ||
    disposition.successor.owner !== 'operator-command' ||
    !('acceptance' in disposition.successor) ||
    disposition.successor.acceptance !== 'accepted' ||
    !('subject' in disposition) ||
    typeof disposition.subject !== 'object' ||
    disposition.subject === null ||
    !('kind' in disposition.subject) ||
    disposition.subject.kind !== hold.subject.kind
  ) {
    return false;
  }
  if (hold.subject.kind === 'process') {
    return 'pid' in disposition.subject && disposition.subject.pid === hold.subject.pid;
  }
  return 'processGroupId' in disposition.subject && disposition.subject.processGroupId === hold.subject.processGroupId;
}

export type ProviderServerCleanupHold = Extract<
  ProviderServerFailedSpawnCleanupDisposition,
  { kind: 'held-alive' | 'held-unobservable' }
>;

export type ProviderServerFailedSpawnCleanupHold = ProviderServerCleanupHold & Readonly<{ error: Error }>;

export type ProviderServerFailedSpawnCleanupOwner = 'provider-host-manager' | 'provider-proxy-root-pool';

export type ProviderServerFailedSpawnCleanupAcceptance = Readonly<{
  kind: 'accepted';
  owner: ProviderServerFailedSpawnCleanupOwner;
  settlement: Promise<void>;
}>;

export type ProviderServerFailedSpawnCleanupAcceptor = (
  hold: ProviderServerFailedSpawnCleanupHold,
) => ProviderServerFailedSpawnCleanupAcceptance;

export type ProviderServerCleanupHoldAcceptor = (
  hold: ProviderServerCleanupHold,
) => ProviderServerFailedSpawnCleanupAcceptance;

export type ProviderServerCloseDisposition =
  | Exclude<ProviderServerFailedSpawnCleanupDisposition, ProviderServerCleanupHold>
  | (ProviderServerCleanupHold & Readonly<{ successor: ProviderServerFailedSpawnCleanupAcceptance }>);

export type HeldProviderServerSpawn = ProviderServerFailedSpawnCleanupHold &
  Readonly<{
    successor: ProviderServerFailedSpawnCleanupAcceptance;
  }>;

function resolveProviderServerInitializeTimeoutMs(timeoutMs: number | undefined): number {
  return timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : PROVIDER_SERVER_INITIALIZE_TIMEOUT_MS;
}

type SpawnProviderServerTransportParams = {
  runtime: Runtime;
  options: SpawnProviderServerOptions;
  generation: number;
  observeProviderResponse: ProviderResponseObservationSink;
  detached?: boolean;
  recordContainment?: (containment: RecordedContainmentIdentity) => ProviderContainmentAcceptance;
  acceptFailedSpawnCleanup: ProviderServerFailedSpawnCleanupAcceptor;
};

export function spawnProviderServerTransport(
  params: SpawnProviderServerTransportParams & { detached: true },
): Promise<ContainedProviderServerHandle | HeldProviderServerSpawn>;
export function spawnProviderServerTransport(
  params: SpawnProviderServerTransportParams & { detached?: false },
): Promise<ProviderServerHandle | HeldProviderServerSpawn>;
export async function spawnProviderServerTransport(
  params: SpawnProviderServerTransportParams,
): Promise<ProviderServerHandle | HeldProviderServerSpawn> {
  const spawned = await spawnProviderServerProcess(params);
  if (spawned.kind !== 'spawned') return spawned;
  bindProviderServerEvents(spawned.entry, spawned.pipes, params.runtime);
  const containmentDisposition =
    params.detached === true ? await establishDetachedProviderServerIdentity(spawned.entry, params.runtime) : undefined;
  if (isHeldProviderServerSpawn(containmentDisposition)) return containmentDisposition;
  const containmentIdentity = containmentDisposition;
  if (containmentIdentity !== undefined) {
    try {
      params.recordContainment?.(containmentIdentity);
    } catch (error: unknown) {
      return settleFailedProviderServerSpawn(
        spawned.entry.processSettlement,
        params.runtime,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }
  const rpc = createProviderServerRpc(spawned.entry, params.runtime);
  const initialization = await initializeSpawnedProviderServer(
    spawned.entry,
    rpc,
    params.options,
    params.runtime,
    containmentIdentity === undefined || params.recordContainment === undefined,
  );
  if (initialization !== undefined) return initialization;
  return exposeProviderServerHandle(spawned.entry, rpc, params.runtime, containmentIdentity);
}

type ProviderServerPipes = ReturnType<typeof requirePipedHandles>;

type ProviderProcessSettlement = {
  child: ChildProcessLike;
  pid: number | null;
  detached: boolean;
  processGroupCleanup: SpawnedProcessGroupCleanup | null;
  acceptFailedSpawnCleanup: ProviderServerFailedSpawnCleanupAcceptor;
  closed: boolean;
  processClosePromise: Promise<void>;
  termination: Extract<GracefulKillDisposition, { kind: 'escalation-scheduled' }> | null;
  terminationOutcome: GracefulKillOutcome | null;
  resolve(): void;
};

type ProviderProcessSettlementEvidence = ProviderServerFailedSpawnCleanupDisposition;

function requestProviderServerKill(settlement: ProviderProcessSettlement, runtime: Runtime): GracefulKillDisposition {
  return (
    settlement.termination ?? gracefulKill(settlement.child, runtime, (pid) => runtime.process.observeLiveness(pid))
  );
}

function acceptProviderServerKill(settlement: ProviderProcessSettlement, runtime: Runtime): void {
  const disposition = requestProviderServerKill(settlement, runtime);
  if (disposition.kind !== 'escalation-scheduled') {
    settlement.terminationOutcome = disposition;
    return;
  }
  if (settlement.termination === disposition) return;
  settlement.termination = disposition;
  void disposition.settlement.then((outcome) => {
    if (settlement.termination !== disposition) return;
    settlement.termination = null;
    settlement.terminationOutcome = outcome;
  });
}

function createProviderProcessSettlement(
  child: ChildProcessLike,
  detached: boolean,
  processGroupCleanup: SpawnedProcessGroupCleanup | null,
  acceptFailedSpawnCleanup: ProviderServerFailedSpawnCleanupAcceptor,
): ProviderProcessSettlement {
  let resolve!: () => void;
  const settlement: ProviderProcessSettlement = {
    child,
    pid: child.pid ?? null,
    detached,
    processGroupCleanup,
    acceptFailedSpawnCleanup,
    closed: false,
    processClosePromise: new Promise<void>((settle) => {
      resolve = settle;
    }),
    termination: null,
    terminationOutcome: null,
    resolve: () => resolve(),
  };
  child.on('close', () => {
    if (settlement.closed) return;
    settlement.closed = true;
    settlement.resolve();
  });
  child.on('error', () => undefined);
  return settlement;
}

function mapDetachedProviderServerCleanup<ProcessGroupId extends number>(
  runtime: Runtime,
  processGroupId: ProcessGroupId | null,
  cleanup: SpawnedProcessGroupCleanupDisposition<ProcessGroupId> | null,
): ProviderServerFailedSpawnCleanupDisposition<ProcessGroupId> {
  const subject: ProviderServerFailedSpawnSubject<ProcessGroupId> =
    cleanup === null
      ? { kind: 'unattributable-process-group', processGroupId }
      : cleanup.kind === 'observed-absent'
        ? cleanup.evidence.subject
        : cleanup.subject;
  let abandoned = false;
  let resolveSettled!: () => void;
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  let activeRetry: Readonly<{ abort: AbortController; settlement: Promise<void> }> | null = null;
  const abandonment: ProviderServerFailedSpawnOperatorAbandonment<ProcessGroupId> = {
    kind: 'operator-abandoned',
    subject,
    processAbsenceProven: false,
    successor: { owner: 'operator-command', acceptance: 'accepted' },
  };
  let releaseAbandonment!: () => void;
  let acceptAbandonment!: () => void;
  const abandonmentRequested = new Promise<void>((resolve) => {
    releaseAbandonment = resolve;
  });
  const abandonmentAccepted = new Promise<void>((resolve) => {
    acceptAbandonment = resolve;
  });
  const operatorExit: ProviderServerFailedSpawnOperatorExit<ProcessGroupId> = {
    kind: 'abandon-provider-host-acquisition',
    abandon: async () => {
      abandoned = true;
      releaseAbandonment();
      const attempt = activeRetry;
      attempt?.abort.abort(new Error('provider_server_spawn_cleanup_abandoned'));
      if (attempt !== null) await attempt.settlement;
      acceptAbandonment();
      resolveSettled();
      return abandonment;
    },
  };
  const map = (
    next: SpawnedProcessGroupCleanupDisposition<ProcessGroupId> | null,
  ): ProviderServerFailedSpawnCleanupDisposition<ProcessGroupId> => {
    if (abandoned) return abandonment;
    if (next?.kind === 'observed-absent') {
      resolveSettled();
      return {
        kind: 'observed-absent',
        evidence: { processGroupEvidence: next.evidence },
      };
    }
    const retry = async (
      signal?: AbortSignal,
    ): Promise<ProviderServerFailedSpawnCleanupDisposition<ProcessGroupId>> => {
      if (abandoned) {
        await abandonmentAccepted;
        return abandonment;
      }
      await Promise.race([runtime.time.sleep(SIGTERM_GRACE_MS), abandonmentRequested]);
      if (abandoned) {
        await abandonmentAccepted;
        return abandonment;
      }
      if (next === null) {
        if (processGroupId === null) return map(null);
        const observation = observeUnattributableSpawnedProcessGroup(processGroupId, runtime);
        if (observation.kind === 'observed-absent') {
          return map(observation);
        }
        return map(null);
      }
      const abort = new AbortController();
      const attemptSignal = signal === undefined ? abort.signal : AbortSignal.any([signal, abort.signal]);
      const operation = next.retry(attemptSignal);
      const attempt = {
        abort,
        settlement: operation.then(
          () => undefined,
          () => undefined,
        ),
      };
      activeRetry = attempt;
      try {
        const outcome = await operation;
        if (abandoned) {
          await abandonmentAccepted;
          return abandonment;
        }
        return map(outcome);
      } finally {
        if (activeRetry === attempt) activeRetry = null;
      }
    };
    if (next?.kind === 'held-alive') {
      return { kind: next.kind, subject: next.subject, observation: next.observation, operatorExit, settled, retry };
    }
    return { kind: 'held-unobservable', subject, observation: 'unobservable', operatorExit, settled, retry };
  };
  return map(cleanup);
}

function isHeldProviderServerSpawn(disposition: unknown): disposition is HeldProviderServerSpawn {
  if (disposition === null || typeof disposition !== 'object' || !('kind' in disposition)) return false;
  return disposition.kind === 'held-alive' || disposition.kind === 'held-unobservable';
}

async function settleFailedProviderServerSpawn(
  settlement: ProviderProcessSettlement,
  runtime: Runtime,
  error: Error,
): Promise<HeldProviderServerSpawn> {
  const cleanup = await terminateProviderServerProcess(settlement, runtime);
  if (cleanup.kind === 'observed-absent') throw error;
  if (cleanup.kind === 'operator-abandoned') throw error;
  const hold: ProviderServerFailedSpawnCleanupHold = { ...cleanup, error };
  const successor = settlement.acceptFailedSpawnCleanup(hold);
  if (successor.kind !== 'accepted') {
    throw new Error('Provider server failed-spawn cleanup owner did not accept the obligation.', { cause: error });
  }
  return { ...hold, successor };
}

async function spawnProviderServerProcess(
  params: SpawnProviderServerTransportParams,
): Promise<
  Readonly<{ kind: 'spawned'; entry: ProviderServerEntry; pipes: ProviderServerPipes }> | HeldProviderServerSpawn
> {
  const { runtime, options, generation, observeProviderResponse } = params;
  if (options.signal?.aborted) {
    throw createProviderServerSpawnAbortError(options.provider, options.signal);
  }

  const command = options.command;
  const child = runtime.process.spawn({
    command,
    args: options.args,
    cwd: options.cwd === '' ? undefined : options.cwd,
    shell: shouldUseWindowsCommandShell(command, runtime.env.platform()),
    ...(options.exactEnv ? { env: options.exactEnv } : { envAdditions: options.extraEnv }),
    ...(params.detached === undefined ? {} : { detached: params.detached }),
  });
  const processGroupCleanup =
    params.detached === true && typeof child.pid === 'number' ? retainSpawnedProcessGroupCleanup(child) : null;
  const processSettlement = createProviderProcessSettlement(
    child,
    params.detached === true,
    processGroupCleanup,
    params.acceptFailedSpawnCleanup,
  );
  let pipes: ProviderServerPipes;
  try {
    pipes = requirePipedHandles(child, options.command);
  } catch (error: unknown) {
    return settleFailedProviderServerSpawn(
      processSettlement,
      runtime,
      error instanceof Error ? error : new Error(String(error)),
    );
  }
  if (child.pid === undefined) {
    return settleFailedProviderServerSpawn(
      processSettlement,
      runtime,
      new Error(`Failed to spawn ${options.command}: child pid is unavailable`),
    );
  }
  const pid = child.pid;
  pipes.stdout.setEncoding('utf8');
  pipes.stderr.setEncoding('utf8');

  let resolveClose!: (outcome: Error | void) => void;
  const closePromise = new Promise<Error | void>((resolve) => {
    resolveClose = resolve;
  });
  const diagnostics = createProviderHostDiagnostics();
  const entry: ProviderServerEntry = {
    provider: options.provider,
    child,
    pid,
    generation,
    pending: new Map(),
    nextRequestId: 1,
    notificationHandlers: new Set(),
    stdoutBuffer: '',
    stdoutBufferBytes: 0,
    diagnostics,
    diagnosticRef: createProviderHostDiagnosticReference(generation, diagnostics),
    observeProviderResponse,
    closed: false,
    processSettlement,
    closeRequested: false,
    closePromise,
    resolveClose,
    closeOutcome: undefined,
  };
  return Object.freeze({ kind: 'spawned', entry, pipes });
}

async function terminateProviderServerProcess(
  settlement: ProviderProcessSettlement,
  runtime: Runtime,
): Promise<ProviderProcessSettlementEvidence> {
  if (settlement.detached) {
    const disposition =
      settlement.processGroupCleanup === null
        ? null
        : await cleanupSpawnedProcessGroup(settlement.processGroupCleanup, runtime);
    return mapDetachedProviderServerCleanup(runtime, settlement.pid, disposition);
  }

  const subject = { kind: 'process', pid: settlement.pid } as const;
  let abandoned = false;
  const abandonment: ProviderServerFailedSpawnOperatorAbandonment = {
    kind: 'operator-abandoned',
    subject,
    processAbsenceProven: false,
    successor: { owner: 'operator-command', acceptance: 'accepted' },
  };
  const operatorExit: ProviderServerFailedSpawnOperatorExit = {
    kind: 'abandon-provider-host-acquisition',
    abandon: async () => {
      abandoned = true;
      return abandonment;
    },
  };
  const observedAbsent = (): ProviderProcessSettlementEvidence => ({
    kind: 'observed-absent',
    evidence: { subject },
  });
  const retry = async (signal?: AbortSignal): Promise<ProviderProcessSettlementEvidence> => {
    if (settlement.closed) return observedAbsent();
    if (settlement.terminationOutcome?.kind === 'observed-absent') return observedAbsent();
    if (abandoned) return abandonment;
    if (signal?.aborted) {
      return {
        kind: 'held-unobservable',
        subject,
        observation: 'unobservable',
        operatorExit,
        settled: settlement.processClosePromise,
        retry,
      };
    }

    acceptProviderServerKill(settlement, runtime);
    if (settlement.closed) return observedAbsent();
    if (settlement.pid !== null) {
      try {
        const liveness = runtime.process.observeLiveness(settlement.pid);
        if (settlement.closed) return observedAbsent();
        if (liveness === 'absent') return observedAbsent();
        if (liveness === 'alive') {
          return {
            kind: 'held-alive',
            subject,
            observation: liveness,
            operatorExit,
            settled: settlement.processClosePromise,
            retry,
          };
        }
      } catch {
        // Exact close evidence remains authoritative when direct liveness observation cannot answer.
      }
    }
    if (settlement.closed) return observedAbsent();
    return {
      kind: 'held-unobservable',
      subject,
      observation: 'unobservable',
      operatorExit,
      settled: settlement.processClosePromise,
      retry,
    };
  };
  return retry();
}

function terminateUnownedProviderServer(
  entry: ProviderServerEntry,
  runtime: Runtime,
): Promise<ProviderProcessSettlementEvidence> {
  return terminateProviderServerProcess(entry.processSettlement, runtime);
}

async function establishDetachedProviderServerIdentity(
  entry: ProviderServerEntry,
  runtime: Runtime,
): Promise<RecordedContainmentIdentity | HeldProviderServerSpawn> {
  const cleanup = entry.processSettlement.processGroupCleanup;
  if (cleanup === null) {
    const error = new ProcessContainmentError(
      'process_identity_unverified',
      `The spawned ${entry.provider} provider server (pid ${entry.pid}) has no retained process-group cleanup authority.`,
      { provider: entry.provider, pid: entry.pid },
    );
    return settleFailedProviderServerSpawn(entry.processSettlement, runtime, error);
  }

  const observation = observeRetainedSpawnedProcessGroup(cleanup, runtime);
  if (observation.kind !== 'held-alive') {
    const error = new ProcessContainmentError(
      'process_identity_unverified',
      `The spawned ${entry.provider} provider server (pid ${entry.pid}) has no attributable live process group.`,
      { provider: entry.provider, pid: entry.pid },
    );
    return settleFailedProviderServerSpawn(entry.processSettlement, runtime, error);
  }

  let incarnation: ProcessIncarnation | null;
  try {
    incarnation = runtime.process.readProcessIncarnation(entry.pid, runtime.env.platform() as NodeJS.Platform);
  } catch {
    incarnation = null;
  }
  if (incarnation === null) {
    const error = new ProcessContainmentError(
      'process_identity_unverified',
      `Could not record the incarnation of the spawned ${entry.provider} provider server (pid ${entry.pid}).`,
      { provider: entry.provider, pid: entry.pid },
    );
    return settleFailedProviderServerSpawn(entry.processSettlement, runtime, error);
  }

  const containmentIdentity = Object.freeze({ pid: entry.pid, incarnation, processGroupId: entry.pid });
  try {
    assertRecordedContainmentIdentity(containmentIdentity);
  } catch (error: unknown) {
    return settleFailedProviderServerSpawn(
      entry.processSettlement,
      runtime,
      error instanceof Error ? error : new Error(String(error)),
    );
  }
  return containmentIdentity;
}

function bindProviderServerEvents(entry: ProviderServerEntry, pipes: ProviderServerPipes, runtime: Runtime): void {
  const finalizeClose = (outcome?: Error): void => {
    if (outcome) entry.closeOutcome = outcome;
    detachProviderServer(entry, outcome);
    entry.resolveClose(entry.closeRequested ? undefined : entry.closeOutcome);
  };

  pipes.stdout.on('data', (chunk: string | Buffer) => {
    handleProviderServerStdout(entry, chunk, runtime);
  });
  pipes.stderr.on('data', (chunk: string | Buffer) => {
    appendProviderHostLog(entry.diagnostics, {
      observedAt: runtime.time.now(),
      stream: 'stderr',
      text: chunk.toString(),
    });
  });
  pipes.stdin.on('error', (error: Error) => {
    if (entry.closed) return;
    const stdinError = createProviderHostFault(entry, `stdin error: ${error.message}`);
    backendLog.error(stdinError.message, error);
    detachProviderServer(entry, stdinError);
    acceptProviderServerKill(entry.processSettlement, runtime);
  });
  entry.child.on('error', (error: Error) => {
    const closeError = createProviderHostFault(entry, `failed: ${error.message}`);
    if (!entry.closeRequested) backendLog.error(`Provider server ${entry.provider} failed`, error);
    detachProviderServer(entry, closeError);
    entry.resolveClose(entry.closeRequested ? undefined : closeError);
  });
  entry.child.on('close', (code, signal) => {
    if (entry.closed) {
      entry.resolveClose(entry.closeRequested ? undefined : entry.closeOutcome);
      return;
    }

    let closeError: Error | undefined;
    if (!entry.closeRequested) {
      const detail = signal ? `exited unexpectedly (signal ${signal})` : `exited unexpectedly (exit ${code})`;
      closeError = createProviderHostFault(entry, detail);
      if (code !== 0 || signal !== null) backendLog.error(closeError.message);
    }
    finalizeClose(closeError);
  });
}

function createProviderServerRpc(entry: ProviderServerEntry, runtime: Runtime): ProviderServerRpc {
  return {
    request: <TResult = unknown>(method: string, params: Record<string, unknown> = {}): Promise<TResult> => {
      if (entry.closed) return Promise.reject(createProviderHostFault(entry, 'is closed'));
      const id = entry.nextRequestId;
      entry.nextRequestId += 1;

      return new Promise<TResult>((resolve, reject) => {
        const startSeq = currentProviderHostLogSeq(entry.diagnostics);
        entry.pending.set(id, { method, startSeq, resolve: resolve as (value: unknown) => void, reject });
        try {
          sendProviderServerMessage(entry, { id, method, params });
        } catch (error) {
          entry.pending.delete(id);
          reject(error instanceof Error ? error : createProviderHostFault(entry, `failed to send ${method}`));
        }
      });
    },
    notify: (method: string, params: Record<string, unknown> = {}): void => {
      if (entry.closed) return;
      try {
        sendProviderServerMessage(entry, { method, params });
      } catch (error) {
        const notifyError = error instanceof Error ? error : createProviderHostFault(entry, `failed to send ${method}`);
        backendLog.error(notifyError.message, error);
        detachProviderServer(entry, notifyError);
        acceptProviderServerKill(entry.processSettlement, runtime);
      }
    },
  };
}

async function initializeSpawnedProviderServer(
  entry: ProviderServerEntry,
  rpc: ProviderServerRpc,
  options: SpawnProviderServerOptions,
  runtime: Runtime,
  killOnFailure: boolean,
): Promise<HeldProviderServerSpawn | void> {
  if (options.initializeRequest === undefined) return;
  try {
    await initializeProviderServer({
      entry,
      rpc,
      request: options.initializeRequest,
      timeoutMs: options.initializeTimeoutMs,
      runtime,
      signal: options.signal,
    });
  } catch (error) {
    const initError = error instanceof Error ? error : createProviderHostFault(entry, `initialize failed`);
    detachProviderServer(entry, initError);
    if (killOnFailure) {
      return settleFailedProviderServerSpawn(entry.processSettlement, runtime, initError);
    }
    throw initError;
  }
}

function exposeProviderServerHandle(
  entry: ProviderServerEntry,
  rpc: ProviderServerRpc,
  runtime: Runtime,
  containmentIdentity?: RecordedContainmentIdentity,
): ProviderServerHandle {
  return {
    pid: entry.pid,
    child: entry.child,
    generation: entry.generation,
    ...(containmentIdentity === undefined
      ? {}
      : {
          containmentIdentity,
          finishCloseAfterReap: async (): Promise<void> => {
            beginProviderServerShutdown(entry, 'closed');
            await entry.closePromise;
          },
        }),
    rpc,
    onNotification: (handler) => {
      if (entry.closed) return () => {};
      entry.notificationHandlers.add(handler);
      return () => {
        entry.notificationHandlers.delete(handler);
      };
    },
    closePromise: entry.closePromise,
    isClosed: () => entry.closed,
    inspectDiagnostics: entry.diagnosticRef.inspect,
    markExpectedClose: () => {
      entry.closeRequested = true;
    },
    close: async (acceptCleanupHold) => {
      shutdownProviderServer(entry, 'closed', runtime);
      const cleanup = await terminateUnownedProviderServer(entry, runtime);
      if (cleanup.kind !== 'held-alive' && cleanup.kind !== 'held-unobservable') return cleanup;
      const successor = acceptCleanupHold(cleanup);
      if (successor.kind !== 'accepted') {
        throw new Error('Provider server close cleanup owner did not accept the obligation.');
      }
      return { ...cleanup, successor };
    },
  };
}

function initializeProviderServer(params: {
  entry: ProviderServerEntry;
  rpc: ProviderServerRpc;
  request: NonNullable<SpawnProviderServerOptions['initializeRequest']>;
  timeoutMs?: number;
  runtime: Runtime;
  signal?: AbortSignal;
}): Promise<unknown> {
  const { entry, rpc, request, runtime, signal } = params;
  const timeoutMs = resolveProviderServerInitializeTimeoutMs(params.timeoutMs);
  if (signal?.aborted) {
    return Promise.reject(createProviderServerInitializeAbortError(entry, signal));
  }

  let timeoutHandle: ReturnType<Runtime['time']['setTimeout']> | null = null;
  let abortHandler: (() => void) | null = null;

  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = runtime.time.setTimeout(() => {
      reject(createProviderHostFault(entry, `initialize timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timeoutHandle.unref?.();
  });

  const abort =
    signal === undefined
      ? null
      : new Promise<never>((_, reject) => {
          abortHandler = () => reject(createProviderServerInitializeAbortError(entry, signal));
          signal.addEventListener('abort', abortHandler, { once: true });
        });

  return Promise.race([rpc.request(request.method, request.params), timeout, ...(abort ? [abort] : [])]).finally(() => {
    if (timeoutHandle !== null) {
      runtime.time.clearTimeout(timeoutHandle);
    }
    if (abortHandler !== null && signal !== undefined) {
      signal.removeEventListener('abort', abortHandler);
    }
  });
}

function createProviderServerSpawnAbortError(provider: string, signal: AbortSignal): Error {
  return new AbortError({ stage: `provider ${provider} spawn`, reason: signal.reason });
}

function createProviderServerInitializeAbortError(entry: ProviderServerEntry, signal: AbortSignal): Error {
  // Canonical abort vocabulary (src/runtime/abort.ts) — preserves signal.reason
  // so callers can distinguish a user abort from a deadline abort. Constructing
  // the error locally is forbidden by the architecture-boundary invariant.
  const reason = signal.reason;
  return new AbortError({ stage: `provider ${entry.provider} initialize`, reason });
}

function renderProviderRpcErrorMessage(params: {
  method: string;
  rpcCode: number | undefined;
  providerMessage: string | undefined;
  providerData: unknown;
}): string {
  const code = params.rpcCode === undefined ? '' : ` [code=${params.rpcCode}]`;
  const cause = params.providerMessage === undefined ? '' : `: ${params.providerMessage}`;
  const data = params.providerData === undefined ? '' : `; data=${JSON.stringify(params.providerData)}`;
  return `${params.method} failed${code}${cause}${data}`;
}

function createProviderHostDiagnosticReference(
  generation: number,
  diagnostics: ProviderHostDiagnosticsState,
): ProviderHostDiagnosticReference {
  return Object.freeze({
    generation,
    inspect: () => inspectProviderHostDiagnostics(diagnostics),
  });
}

function createProviderHostFault(entry: ProviderServerEntry, detail: string, data?: unknown): ProviderHostFault {
  return new ProviderHostFault(entry.provider, detail, entry.diagnosticRef, data);
}

function rejectPendingProviderRequests(entry: ProviderServerEntry, error: Error): void {
  for (const pending of entry.pending.values()) {
    pending.reject(error);
  }
  entry.pending.clear();
}

function detachProviderServer(entry: ProviderServerEntry, error?: Error): void {
  if (entry.closed) return;
  entry.closed = true;
  if (error) {
    entry.closeOutcome = error;
  }
  entry.notificationHandlers.clear();
  rejectPendingProviderRequests(entry, error ?? createProviderHostFault(entry, 'closed'));
}

function encodeProviderServerMessage(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

function sendProviderServerMessage(entry: ProviderServerEntry, message: unknown): void {
  const stdin = entry.child.stdin;
  if (entry.closed || !stdin || stdin.destroyed) {
    throw createProviderHostFault(entry, 'stdin is not available');
  }
  const encoded = encodeProviderServerMessage(message);
  try {
    stdin.write(encoded);
  } catch (error) {
    throw createProviderHostFault(entry, `stdin error: ${errorMessage(error)}`);
  }
}

function handleProviderServerStdout(entry: ProviderServerEntry, chunk: string | Buffer, runtime: Runtime): void {
  if (entry.closed) return;

  const text = chunk.toString();
  let start = 0;
  while (start < text.length) {
    const newlineIndex = text.indexOf('\n', start);
    if (newlineIndex === -1) {
      appendProviderServerLineFragment(entry, text.slice(start), runtime);
      return;
    }

    const fragmentEnd =
      newlineIndex > start && text.charCodeAt(newlineIndex - 1) === 13 ? newlineIndex - 1 : newlineIndex;
    if (!appendProviderServerLineFragment(entry, text.slice(start, fragmentEnd), runtime)) {
      return;
    }

    const line = entry.stdoutBuffer;
    entry.stdoutBuffer = '';
    entry.stdoutBufferBytes = 0;
    handleProviderServerLine(entry, line, runtime);
    if (entry.closed) return;
    start = newlineIndex + 1;
  }
}

function appendProviderServerLineFragment(entry: ProviderServerEntry, fragment: string, runtime: Runtime): boolean {
  if (fragment.length === 0) {
    return true;
  }

  const fragmentBytes = Buffer.byteLength(fragment, 'utf8');
  const observedBytes = entry.stdoutBufferBytes + fragmentBytes;
  if (observedBytes > PROVIDER_SERVER_MAX_JSONL_LINE_BYTES) {
    const lineError = new ProviderServerLineTooLargeError(observedBytes);
    const protocolError = createProviderHostFault(entry, 'emitted an oversized JSONL line', {
      code: lineError.code,
      maxLineBytes: lineError.maxLineBytes,
      observedBytes: lineError.observedBytes,
    });
    backendLog.error(protocolError.message, lineError);
    entry.stdoutBuffer = '';
    entry.stdoutBufferBytes = 0;
    detachProviderServer(entry, protocolError);
    acceptProviderServerKill(entry.processSettlement, runtime);
    return false;
  }

  entry.stdoutBuffer += fragment;
  entry.stdoutBufferBytes = observedBytes;
  return true;
}

function handleProviderServerLine(entry: ProviderServerEntry, line: string, runtime: Runtime): void {
  if (!line.trim() || entry.closed) return;

  const message = parseProviderServerLine(entry, line, runtime);
  if (message === undefined) return;

  if (typeof message.id === 'number' && typeof message.method === 'string') {
    handleProviderServerRequest(entry, message.id, message.method, runtime);
  } else if (typeof message.id === 'number') {
    handleProviderServerResponse(entry, message.id, message);
  } else {
    handleProviderServerNotification(entry, message, runtime);
  }
}

function parseProviderServerLine(
  entry: ProviderServerEntry,
  line: string,
  runtime: Runtime,
): ProviderServerMessage | undefined {
  try {
    return JSON.parse(line) as ProviderServerMessage;
  } catch (error) {
    const parseError = createProviderHostFault(entry, 'emitted invalid JSONL', {
      line,
      message: errorMessage(error),
    });
    backendLog.error(parseError.message, error);
    detachProviderServer(entry, parseError);
    acceptProviderServerKill(entry.processSettlement, runtime);
    return undefined;
  }
}

function handleProviderServerRequest(
  entry: ProviderServerEntry,
  requestId: number,
  method: string,
  runtime: Runtime,
): void {
  try {
    sendProviderServerMessage(entry, {
      id: requestId,
      error: buildJsonRpcError(-32601, `Unsupported provider-server request: ${method}`),
    });
  } catch (error) {
    const protocolError =
      error instanceof Error ? error : createProviderHostFault(entry, 'failed to answer server request');
    backendLog.error(protocolError.message, error);
    detachProviderServer(entry, protocolError);
    acceptProviderServerKill(entry.processSettlement, runtime);
  }
}

function handleProviderServerResponse(
  entry: ProviderServerEntry,
  requestId: number,
  message: ProviderServerMessage,
): void {
  const endSeq = currentProviderHostLogSeq(entry.diagnostics);
  const pending = entry.pending.get(requestId);
  if (!pending) return;
  const diagnostic = recordProviderResponseDiagnostic(entry.diagnostics, {
    generation: entry.generation,
    requestId,
    method: pending.method,
    response: message.error
      ? Object.freeze({
          kind: 'failure',
          rpcCode: message.error.code,
          providerMessage: message.error.message,
          providerData: message.error.data,
        })
      : Object.freeze({ kind: 'success' }),
    startSeq: pending.startSeq,
    endSeq,
  });
  entry.observeProviderResponse(diagnostic);
  entry.pending.delete(requestId);

  if (message.error) {
    pending.reject(
      new ProviderRpcError({
        requestId,
        method: pending.method,
        rpcCode: message.error.code,
        providerMessage: message.error.message,
        providerData: message.error.data,
        hostLog: diagnostic.hostLog,
      }),
    );
    return;
  }

  pending.resolve(message.result);
}

function handleProviderServerNotification(
  entry: ProviderServerEntry,
  message: ProviderServerMessage,
  runtime: Runtime,
): void {
  if (typeof message.method !== 'string') {
    const protocolError = createProviderHostFault(entry, 'emitted a malformed JSON-RPC message', message);
    backendLog.error(protocolError.message);
    detachProviderServer(entry, protocolError);
    acceptProviderServerKill(entry.processSettlement, runtime);
    return;
  }

  const notification: ProviderServerNotification = {
    method: message.method,
    params: message.params,
  };
  for (const handler of entry.notificationHandlers) {
    try {
      handler(notification);
    } catch (error) {
      const dispatchError = createProviderHostFault(entry, `notification handler failed: ${errorMessage(error)}`);
      backendLog.error(dispatchError.message, error);
      if (!entry.closed) {
        detachProviderServer(entry, dispatchError);
        acceptProviderServerKill(entry.processSettlement, runtime);
      }
      return;
    }
  }
}

function beginProviderServerShutdown(entry: ProviderServerEntry, detail: string): void {
  if (entry.closed) return;
  entry.closeRequested = true;
  detachProviderServer(entry, createProviderHostFault(entry, detail));
}

function shutdownProviderServer(entry: ProviderServerEntry, detail: string, runtime: Runtime): void {
  beginProviderServerShutdown(entry, detail);
  acceptProviderServerKill(entry.processSettlement, runtime);
}

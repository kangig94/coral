import type { Server, ServerResponse } from 'node:http';
import { formatError } from '../infra/error-format.js';
import type { DiscussSessionStore } from '../discuss/shell/session-store.js';
import type { IdleTimer } from './live/idle.js';
import type { TimePort } from '../infra/port-types.js';
import type { Runtime } from '../runtime/ports.js';
import type { ProviderHostLifecycle, ProviderHostQuiescenceReceipt } from './live/provider-hosts/index.js';
import type { IpcListener } from '../transport/ipc/server.js';
import type { HandoffQuiescePort } from './execution-service.js';
import type { StoreServicesRef } from './composition/store-services-ref.js';
import type { RuntimeComponentRegistry } from './runtime-components/registry.js';
import type { KbDaemonSupervisor } from './live/kb-daemon-supervisor.js';
import type { ProviderProxyAuthorityRegistry, ProviderProxySetAuthority } from './live/provider-proxy/authority.js';
import type { TerminateAllDisposition } from './live/admission.js';
import {
  processIncarnationProbeRegistrySize,
  terminateProcessIncarnationProbes,
  type ProcessIncarnationProbeCleanupDisposition,
} from '../infra/node-process.js';

export const SHUTDOWN_DRAIN_TIMEOUT_MS = 10_000;
export const HANDOFF_DRAIN_TIMEOUT_MS = 30_000;
export const SHUTDOWN_POLL_MS = 50;

/**
 * Shutdown mode derived from reason. Determines child process and job handling:
 * - handoff: preserve wrappers/children for recovery; do NOT mark jobs as error or kill children
 * - hard: kill children and mark jobs as error
 */
export type ShutdownMode = 'handoff' | 'hard';

function shutdownModeFromReason(reason: string): ShutdownMode {
  if (reason === 'replaced' || reason === 'sigterm') return 'handoff';
  return 'hard';
}

export type LifecycleWiringState = {
  ownershipCheckerTeardown: (() => void) | null;
};

type ShutdownHoldReason =
  | 'process-incarnation-probes-unsettled'
  | 'lifecycle-reactor-disposal-unsettled'
  | 'required-shutdown-step-unsettled';

type ShutdownHoldExit =
  | 'process-incarnation-probe-child-close'
  | 'lifecycle-reactor-disposal-settlement'
  | 'required-cleanup-capability-confirmation-or-durable-operator-abandonment'
  | 'authority-release-settlement';

export type ShutdownOperatorAction =
  | Readonly<{
      kind: 'retained-job-containment';
      jobId: string;
      provider: string;
      jobDir: string;
      actionCommand: string;
    }>
  | Readonly<{
      kind: 'provider-proxy-set-containment';
      proxyInstanceId: string;
      inspectCommand: 'coral-cli backend status';
      actionCommand: 'coral-cli backend provider-proxy-set abandon <set-token>';
    }>;

type ShutdownRetainedAuthority = Readonly<{
  ipcSocket: boolean;
  providerControlProxyInstanceIds: readonly string[];
  cleanupObligations: readonly string[];
  operatorActions: readonly ShutdownOperatorAction[];
}>;

type FinalizationDisposition =
  | Readonly<{ disposition: 'settled' }>
  | Readonly<{
      disposition: 'held';
      reason: Exclude<ShutdownHoldReason, 'required-shutdown-step-unsettled'>;
      exit: ShutdownHoldExit;
      retryAfter: Promise<void>;
      continue?: () => Promise<FinalizationDisposition>;
    }>;

export type ShutdownSequenceDisposition =
  | Readonly<{ disposition: 'settled' }>
  | Readonly<{
      disposition: 'held';
      reason: ShutdownHoldReason;
      exit: ShutdownHoldExit;
      retryAfter: Promise<void>;
      deferredFailures: readonly ShutdownDeferredFailure[];
      retainedAuthority: ShutdownRetainedAuthority;
      retry(): Promise<ShutdownSequenceDisposition>;
    }>;

interface ShutdownRuntimeState {
  setLifecycle(state: 'starting' | 'kernel-ready' | 'running' | 'draining' | 'stopped'): void;
  readonly components: RuntimeComponentRegistry;
}

type RunShutdownSequenceContext = {
  reason: string;
  state: LifecycleWiringState;
  teardownRecoveryCoordinator: () => Promise<void>;
  runtimeState: ShutdownRuntimeState;
  idleTimer: IdleTimer;
  closeServerFn: (server: Server) => Promise<void>;
  closeIpcServerFn?: (listener: IpcListener) => Promise<void>;
  waitForInflightDrain: (
    idleTimer: IdleTimer,
    timeoutMs: number,
    time: Pick<Runtime['time'], 'clearInterval' | 'now' | 'setInterval'>,
  ) => Promise<void>;
  server: Server;
  ipcServer?: IpcListener;
  streamResponses: Set<ServerResponse>;
  runtime: Runtime;
  markJobsAsErrorFn: (message: string, signal: AbortSignal) => void | Promise<void>;
  providerHostManager: ProviderHostLifecycle;
  providerProxyAuthority?: ProviderProxyAuthorityRegistry;
  kbDaemonSupervisor?: KbDaemonSupervisor;
  storeServicesRef: StoreServicesRef;
  terminateAllFn: (signal: AbortSignal) => TerminateAllDisposition | Promise<TerminateAllDisposition>;
  handoffQuiescePorts: () => readonly HandoffQuiescePort[];
  disposeLifecycleReactor: () => void | Promise<void>;
  hooks: { onShutdown(mode: ShutdownMode, signal: AbortSignal): Promise<void> };
  discussStores: Map<string, DiscussSessionStore>;
  log: (message: string) => void;
};

/**
 * Run an async finalizer against the remaining drain budget.
 *
 * The `signal` passed to `task` aborts when the budget timer wins the race.
 * Finalizers must honor it at suspension points: the timeout race makes the
 * shutdown sequence return within budget, while signal cooperation prevents
 * the finalizer from continuing as orphan async work until process exit.
 *
 * The timeout sleep uses `time.sleep(ms, { signal })` and is aborted in
 * `finally` so a finalizer that wins the race leaves no pending timer behind
 * (important for fake-timer test discipline).
 */
async function withBudget<T>(
  label: string,
  task: (signal: AbortSignal) => Promise<T>,
  remainingDrain: () => number,
  time: Pick<TimePort, 'sleep'>,
  log: (message: string) => void,
): Promise<T | undefined> {
  const budget = remainingDrain();
  if (budget <= 0) {
    log(`${label}: skipped (drain budget exhausted)\n`);
    return undefined;
  }
  const timedOut = Symbol('timedOut');
  const taskAbort = new AbortController();
  const timeoutAbort = new AbortController();
  try {
    const result = await Promise.race<T | typeof timedOut>([
      task(taskAbort.signal),
      time.sleep(budget, { signal: timeoutAbort.signal }).then(() => timedOut),
    ]);
    if (result === timedOut) {
      taskAbort.abort();
      log(`${label}: exceeded drain budget after ${budget}ms\n`);
      return undefined;
    }
    return result;
  } finally {
    timeoutAbort.abort();
  }
}

/**
 * Why a required step failed. Distinguishing them matters because they are not equally recoverable: a
 * rejection names something that went wrong, while `unconfirmed` names a step that completed without
 * proving what it was for — which shutdown must never read as success.
 */
export type RequiredShutdownStepReason = 'budget-exhausted' | 'timed-out' | 'rejected' | 'unconfirmed';

export class RequiredShutdownStepError extends Error {
  readonly label: string;
  readonly reason: RequiredShutdownStepReason;

  constructor(label: string, reason: RequiredShutdownStepReason, detail: string) {
    super(`Required shutdown step '${label}' ${reason}: ${detail}`);
    this.name = 'RequiredShutdownStepError';
    this.label = label;
    this.reason = reason;
    Object.setPrototypeOf(this, RequiredShutdownStepError.prototype);
  }
}

/**
 * What a required step must prove before shutdown may call itself clean. A step that ran to completion but
 * could not confirm its effect is a failure: "the reap RPC returned" is not "the containment is gone".
 */
export type ShutdownStepConfirmation = Readonly<{ confirmed: true }> | Readonly<{ confirmed: false; detail: string }>;

async function withRequiredBudget(
  label: string,
  task: (signal: AbortSignal) => Promise<ShutdownStepConfirmation>,
  remainingDrain: () => number,
  time: Pick<TimePort, 'sleep'>,
): Promise<void> {
  const budget = remainingDrain();
  if (budget <= 0) {
    const taskResult = task(AbortSignal.abort());
    // Observed so a rejection is never unhandled, but deliberately not awaited: there is no budget to wait
    // in, and the synchronous prefix of the task — the triggers — has already run by the time it returns.
    void taskResult.catch(() => {});
    throw new RequiredShutdownStepError(label, 'budget-exhausted', 'no drain budget remained');
  }
  const timedOut = Symbol('timedOut');
  const taskAbort = new AbortController();
  const timeoutAbort = new AbortController();
  const taskResult = task(taskAbort.signal);
  let result: ShutdownStepConfirmation | typeof timedOut;
  try {
    result = await Promise.race<ShutdownStepConfirmation | typeof timedOut>([
      taskResult,
      time.sleep(budget, { signal: timeoutAbort.signal }).then(() => timedOut),
    ]);
  } catch (error: unknown) {
    throw new RequiredShutdownStepError(label, 'rejected', formatError(error));
  } finally {
    timeoutAbort.abort();
  }
  if (result === timedOut) {
    taskAbort.abort();
    throw new RequiredShutdownStepError(label, 'timed-out', `exceeded ${budget}ms`);
  }
  if (!result.confirmed) {
    throw new RequiredShutdownStepError(label, 'unconfirmed', result.detail);
  }
}

export type ShutdownDeferredFailure = {
  readonly label: string;
  readonly error: unknown;
};

type ShutdownFailure = ShutdownDeferredFailure;

type PendingRequiredShutdownStep = Readonly<{
  label: string;
  task: (signal: AbortSignal) => Promise<ShutdownStepConfirmation>;
}>;

type UnresolvedChildProcess = Extract<TerminateAllDisposition, { kind: 'unresolved-at-deadline' }>['processes'][number];

function unresolvedChildProcessDetail(process: UnresolvedChildProcess): string {
  switch (process.kind) {
    case 'ownership-retained':
      return `pid ${process.pid}: ${process.reason}`;
    case 'signal-refused':
      return `pid ${process.pid}: ${process.reason}`;
    case 'signal-failed':
      return `pid ${process.pid}: ${process.signal} ${process.reason}`;
    case 'target-unobservable':
    case 'target-alive':
      return `pid ${process.pid}: ${process.kind} ${process.stage}`;
  }
}

function childTerminationConfirmation(disposition: TerminateAllDisposition): ShutdownStepConfirmation {
  if (disposition.kind === 'all-observed-absent') return { confirmed: true };
  const observations = disposition.processes.map(unresolvedChildProcessDetail).join('; ');
  const retainedLaunches = disposition.retainedLaunches
    .map((launch) => `${launch.provider}:${launch.jobDir} awaiting wrapper identity`)
    .join('; ');
  const retainedProcesses = disposition.retainedProcesses
    .map((process) => `${process.provider}:${process.jobDir} pgid ${process.containment.processGroupId}`)
    .join('; ');
  const retained = [retainedLaunches, retainedProcesses].filter((detail) => detail.length > 0).join('; ');
  const actionCommands = [...disposition.retainedLaunches, ...disposition.retainedProcesses].flatMap((process) =>
    process.jobId === undefined ? [] : [`coral-cli abort ${process.jobId}`],
  );
  return {
    confirmed: false,
    detail:
      `${disposition.cleanupHandles} cleanup handle(s) and ${disposition.pendingLaunches} pending launch(es) ` +
      `remain owned by ${disposition.owner}` +
      `${observations.length === 0 && retained.length === 0 ? '' : ` (${[observations, retained].filter(Boolean).join('; ')})`}. ` +
      (actionCommands.length === 0
        ? 'No durable job identity was returned for an operator action.'
        : `Run ${actionCommands.join(', ')}; the durable containment row remains visible until discharge.`),
  };
}

async function processIncarnationProbeConfirmation(
  signal: AbortSignal,
  log: (message: string) => void,
): Promise<FinalizationDisposition> {
  const cleanup = await terminateProcessIncarnationProbes(signal).then(
    (disposition) => ({ outcome: 'observed' as const, disposition }),
    (error: unknown) => ({ outcome: 'failed' as const, error }),
  );
  if (cleanup.outcome === 'failed') {
    throw new Error(`process incarnation probe cleanup rejected: ${formatError(cleanup.error)}`, {
      cause: cleanup.error,
    });
  }

  const disposition: ProcessIncarnationProbeCleanupDisposition = cleanup.disposition;
  if (disposition.disposition === 'settled') return { disposition: 'settled' };

  const detail = disposition.unsettled
    .map(({ pid, reason, exit }) => `pid ${pid ?? 'unknown'}: ${reason}; exit=${exit}`)
    .join('; ');
  log(`process incarnation probe shutdown held (${detail})\n`);
  return {
    disposition: 'held',
    reason: 'process-incarnation-probes-unsettled',
    exit: 'process-incarnation-probe-child-close',
    retryAfter: disposition.untilSettled,
  };
}

async function lifecycleReactorDisposalConfirmation(
  disposeLifecycleReactor: () => void | Promise<void>,
  remainingDrain: () => number,
  time: Pick<TimePort, 'sleep'>,
): Promise<FinalizationDisposition> {
  const budget = remainingDrain();
  if (budget <= 0) {
    throw new Error('lifecycle reactor disposal did not start before the shutdown deadline');
  }
  const deadline = { outcome: 'deadline' as const };
  const timeoutAbort = new AbortController();
  const disposal = Promise.resolve()
    .then(() => disposeLifecycleReactor())
    .then(
      () => ({ outcome: 'settled' as const }),
      (error: unknown) => ({ outcome: 'failed' as const, error }),
    );
  try {
    const outcome = await Promise.race([
      disposal,
      time.sleep(budget, { signal: timeoutAbort.signal }).then(() => deadline),
    ]);
    if (outcome.outcome === 'deadline') {
      const continuation = disposal.then<FinalizationDisposition>((settled) => {
        if (settled.outcome === 'failed') {
          throw new Error(`lifecycle reactor disposal rejected: ${formatError(settled.error)}`, {
            cause: settled.error,
          });
        }
        return { disposition: 'settled' };
      });
      return {
        disposition: 'held',
        reason: 'lifecycle-reactor-disposal-unsettled',
        exit: 'lifecycle-reactor-disposal-settlement',
        retryAfter: continuation.then(
          () => undefined,
          () => undefined,
        ),
        continue: () => continuation,
      };
    }
    if (outcome.outcome === 'failed') {
      throw new Error(`lifecycle reactor disposal rejected: ${formatError(outcome.error)}`, {
        cause: outcome.error,
      });
    }
    return { disposition: 'settled' };
  } finally {
    timeoutAbort.abort();
  }
}

function recordShutdownFailure(
  failures: ShutdownFailure[],
  label: string,
  error: unknown,
  log: (message: string) => void,
): void {
  failures.push({ label, error });
  log(`${label} failed during shutdown: ${formatError(error)}\n`);
}

async function runShutdownStep(
  failures: ShutdownFailure[],
  label: string,
  task: () => unknown | Promise<unknown>,
  log: (message: string) => void,
): Promise<boolean> {
  try {
    await task();
    return true;
  } catch (error: unknown) {
    recordShutdownFailure(failures, label, error, log);
    return false;
  }
}

function observeShutdownTask(
  failures: ShutdownFailure[],
  label: string,
  task: Promise<void>,
  log: (message: string) => void,
): Promise<void> {
  return task.catch((error: unknown) => {
    recordShutdownFailure(failures, label, error, log);
  });
}

/**
 * Reaps every live set and confirms the containment is gone. Used by `hard`, and by `handoff` for the
 * sets whose containment must not survive this coordinator.
 */
async function reapProviderProxySets(
  sets: readonly ProviderProxySetAuthority[],
  acquisitionHolds: ProviderHostQuiescenceReceipt['acquisitionCleanupHolds'],
  signal: AbortSignal,
): Promise<ShutdownStepConfirmation> {
  // Every set is triggered before any is awaited: one slow reap must not consume another's share of a
  // budget they are all spending at once.
  const setOutcomes = Promise.allSettled(sets.map((set) => set.stopAndReap(signal)));
  const acquisitionOutcomes = Promise.allSettled(acquisitionHolds.map((hold) => hold.recoveryCapability.retry(signal)));
  const [outcomes, holdOutcomes] = await Promise.all([setOutcomes, acquisitionOutcomes]);
  const unconfirmed = outcomes.flatMap((outcome, index) => {
    const proxy = sets[index].proxyInstanceId;
    if (outcome.status === 'rejected') return [`${proxy}: ${formatError(outcome.reason)}`];
    return 'unconfirmed' in outcome.value ? [`${proxy}: ${outcome.value.unconfirmed}`] : [];
  });
  const unconfirmedHolds = holdOutcomes.flatMap((outcome, index) => {
    const hold = acquisitionHolds[index];
    const label =
      hold.kind === 'provider_proxy_acquisition_held'
        ? 'acquisition guardian ' + hold.guardianIdentity.pid
        : 'pending acquisition ' + hold.target;
    if (outcome.status === 'rejected') return [label + ': ' + formatError(outcome.reason)];
    return outcome.value.kind === 'held' ? [label + ': ' + outcome.value.reason] : [];
  });
  const failures = [...unconfirmed, ...unconfirmedHolds];
  return failures.length === 0 ? { confirmed: true } : { confirmed: false, detail: failures.join('; ') };
}

/**
 * The IPC socket release, hoisted out of the sequence body so the containment invariant keeps its meaning:
 * an await written inside `runShutdownSequence` is uncontained even when it sits in a nested closure, and
 * weakening the rule to admit this one would admit every future one too.
 */
async function releaseIpcSocket(
  ipcServer: IpcListener | undefined,
  closeIpcServerFn: ((listener: IpcListener) => Promise<void>) | undefined,
): Promise<void> {
  if (ipcServer === undefined || closeIpcServerFn === undefined) return;
  await closeIpcServerFn(ipcServer);
}

type AuthorityReleaseCapability = {
  readonly label: string;
  readonly proxyInstanceId?: string;
  readonly release: () => void | Promise<void>;
  state:
    | Readonly<{ kind: 'pending' }>
    | Readonly<{ kind: 'in-flight'; settlement: Promise<Readonly<{ ok: true } | { ok: false; error: unknown }>> }>
    | Readonly<{ kind: 'settled' }>;
};

type AuthorityReleaseOutcome = Readonly<{ ok: true } | { ok: false; error: unknown }>;

function startAuthorityRelease(capability: AuthorityReleaseCapability): Promise<AuthorityReleaseOutcome> {
  if (capability.state.kind === 'settled') return Promise.resolve<AuthorityReleaseOutcome>({ ok: true });
  if (capability.state.kind === 'in-flight') return capability.state.settlement;
  let release: Promise<void>;
  try {
    release = Promise.resolve(capability.release());
  } catch (error: unknown) {
    release = Promise.reject(error instanceof Error ? error : new Error(formatError(error), { cause: error }));
  }
  const settlement = release.then<AuthorityReleaseOutcome, AuthorityReleaseOutcome>(
    () => {
      capability.state = { kind: 'settled' };
      return { ok: true };
    },
    (error: unknown) => {
      capability.state = { kind: 'pending' };
      return { ok: false, error };
    },
  );
  capability.state = { kind: 'in-flight', settlement };
  return settlement;
}

/** Every capability starts in array order; an in-flight or settled capability is never invoked again. */
async function settleAuthorityReleases(
  capabilities: readonly AuthorityReleaseCapability[],
): Promise<ShutdownStepConfirmation> {
  const outcomes = await Promise.all(capabilities.map(startAuthorityRelease));
  const failures = outcomes.flatMap((outcome, index) =>
    outcome.ok ? [] : [`${capabilities[index].label}: ${formatError(outcome.error)}`],
  );
  return failures.length === 0 ? { confirmed: true } : { confirmed: false, detail: failures.join('; ') };
}

function throwShutdownFailures(failures: readonly ShutdownFailure[]): void {
  if (failures.length === 0) return;
  throw new AggregateError(
    failures.map(({ label, error }) => new Error(`${label}: ${formatError(error)}`, { cause: error })),
    `Coral backend shutdown retained ownership after ${failures.length} finalizer failure${failures.length === 1 ? '' : 's'}.`,
  );
}

export async function runShutdownSequence({
  reason,
  state,
  teardownRecoveryCoordinator,
  runtimeState,
  idleTimer,
  closeServerFn,
  closeIpcServerFn,
  waitForInflightDrain,
  server,
  ipcServer,
  streamResponses,
  runtime,
  markJobsAsErrorFn,
  providerHostManager,
  kbDaemonSupervisor,
  storeServicesRef,
  terminateAllFn,
  handoffQuiescePorts,
  disposeLifecycleReactor,
  hooks,
  discussStores,
  log,
}: RunShutdownSequenceContext): Promise<ShutdownSequenceDisposition> {
  const failures: ShutdownFailure[] = [];
  const pendingRequiredSteps: PendingRequiredShutdownStep[] = [];
  const requiredFailures: ShutdownFailure[] = [];
  const runStep = (label: string, task: () => unknown | Promise<unknown>): Promise<boolean> =>
    runShutdownStep(failures, label, task, log);
  const observeTask = (label: string, task: Promise<void>): Promise<void> =>
    observeShutdownTask(failures, label, task, log);
  const mode = shutdownModeFromReason(reason);
  const drainTimeout = mode === 'handoff' ? HANDOFF_DRAIN_TIMEOUT_MS : SHUTDOWN_DRAIN_TIMEOUT_MS;

  log(`Coral backend shutting down (${reason}, mode=${mode})...\n`);
  runtimeState.setLifecycle('draining');
  idleTimer.stopWatching();

  const drainDeadline = runtime.time.now() + drainTimeout;
  const remainingDrain = (): number => Math.max(0, drainDeadline - runtime.time.now());
  const waitForObservedShutdownTask = (task: Promise<void>): Promise<void> =>
    Promise.race([task, runtime.time.sleep(remainingDrain())]);
  const runBudgetedStep = (label: string, task: (signal: AbortSignal) => Promise<void>): Promise<boolean> =>
    runStep(label, () => withBudget(label, task, remainingDrain, runtime.time, log));
  const runRequiredBudgetedStep = (
    label: string,
    task: (signal: AbortSignal) => Promise<ShutdownStepConfirmation>,
    retainForRetry = true,
  ): Promise<boolean> =>
    withRequiredBudget(label, task, remainingDrain, runtime.time).then(
      () => true,
      (error: unknown) => {
        if (retainForRetry) {
          recordShutdownFailure(requiredFailures, label, error, log);
          pendingRequiredSteps.push({ label, task });
        } else {
          recordShutdownFailure(failures, label, error, log);
        }
        return false;
      },
    );
  const retainRequiredFailureAsFatal = (label: string): void => {
    const pendingIndex = pendingRequiredSteps.length - 1;
    if (pendingRequiredSteps[pendingIndex]?.label === label) pendingRequiredSteps.splice(pendingIndex, 1);
    const failureIndex = requiredFailures.length - 1;
    if (requiredFailures[failureIndex]?.label !== label) return;
    const [failure] = requiredFailures.splice(failureIndex, 1);
    if (failure !== undefined) failures.push(failure);
  };

  let liveProxySets: readonly ProviderProxySetAuthority[] = [];
  let acquisitionCleanupHolds: ProviderHostQuiescenceReceipt['acquisitionCleanupHolds'] = [];
  let retainedJobOperatorActions: readonly ShutdownOperatorAction[] = [];
  const providerHostQuiescence: { receipt: ProviderHostQuiescenceReceipt | null } = { receipt: null };
  const refreshProviderCleanupObligations = (): void => {
    const cleanupObligations = providerHostManager.cleanupObligations?.() ?? providerHostQuiescence.receipt;
    liveProxySets = cleanupObligations?.liveProxySets ?? [];
    acquisitionCleanupHolds = cleanupObligations?.acquisitionCleanupHolds ?? [];
  };
  const settleProviderCleanup = (
    sets: readonly ProviderProxySetAuthority[],
    signal: AbortSignal,
  ): Promise<ShutdownStepConfirmation> =>
    reapProviderProxySets(sets, acquisitionCleanupHolds, signal).then((confirmation) => {
      if (confirmation.confirmed) acquisitionCleanupHolds = [];
      return confirmation;
    });

  // IPC authority must remain bound until every finalization obligation is decisively settled.
  const serverClosed = observeTask(
    'server close',
    Promise.resolve().then(() => closeServerFn(server)),
  );
  await runStep('inflight drain', () => waitForInflightDrain(idleTimer, remainingDrain(), runtime.time));
  await runStep('server connection close', () => server.closeAllConnections());
  for (const stream of streamResponses) {
    await runStep('stream response close', () => stream.end());
  }
  await waitForObservedShutdownTask(serverClosed);
  await runBudgetedStep('recovery coordinator teardown', teardownRecoveryCoordinator);
  await runStep('ownership checker teardown', () => state.ownershipCheckerTeardown?.());
  state.ownershipCheckerTeardown = null;

  if (kbDaemonSupervisor !== undefined) {
    await runBudgetedStep('kb child shutdown', async (signal) => {
      await kbDaemonSupervisor.dispose(reason, { signal });
    });
  }

  if (mode === 'hard') {
    let storeServicesAvailable = false;
    await runStep('store services availability check', () => {
      storeServicesAvailable = storeServicesRef.tryGet() !== null;
    });
    const providerHostsQuiesced = await runRequiredBudgetedStep('provider host shutdown', async (signal) => {
      providerHostQuiescence.receipt = await providerHostManager.shutdown(signal);
      return { confirmed: true };
    });
    refreshProviderCleanupObligations();
    let providerContainmentAbsent = true;
    if (!providerHostsQuiesced) {
      if (liveProxySets.length === 0 && acquisitionCleanupHolds.length === 0) {
        retainRequiredFailureAsFatal('provider host shutdown');
      } else {
        pendingRequiredSteps[pendingRequiredSteps.length - 1] = {
          label: 'provider host shutdown',
          task: (signal) =>
            providerHostManager.shutdown(signal).then((receipt) => {
              providerHostQuiescence.receipt = receipt;
              refreshProviderCleanupObligations();
              return liveProxySets.length > 0 || acquisitionCleanupHolds.length > 0
                ? settleProviderCleanup(liveProxySets, signal)
                : { confirmed: true };
            }),
        };
      }
      providerContainmentAbsent = false;
    } else if (liveProxySets.length > 0 || acquisitionCleanupHolds.length > 0) {
      providerContainmentAbsent = await runRequiredBudgetedStep('provider proxy stop and reap', async (signal) =>
        settleProviderCleanup(liveProxySets, signal),
      );
    }
    let childTerminationDisposition: TerminateAllDisposition | null = null;
    const childContainmentAbsent = await runRequiredBudgetedStep('child termination', async (signal) => {
      const disposition = await terminateAllFn(signal);
      childTerminationDisposition = disposition;
      retainedJobOperatorActions =
        disposition.kind === 'all-observed-absent'
          ? []
          : [...disposition.retainedLaunches, ...disposition.retainedProcesses].flatMap((retained) =>
              retained.jobId === undefined
                ? []
                : [
                    {
                      kind: 'retained-job-containment' as const,
                      jobId: retained.jobId,
                      provider: retained.provider,
                      jobDir: retained.jobDir,
                      actionCommand: `coral-cli abort ${retained.jobId}`,
                    },
                  ],
            );
      return childTerminationConfirmation(disposition);
    });
    if (!childContainmentAbsent && (childTerminationDisposition === null || retainedJobOperatorActions.length === 0)) {
      retainRequiredFailureAsFatal('child termination');
    }
    if (storeServicesAvailable && providerHostsQuiesced && providerContainmentAbsent && childContainmentAbsent) {
      await runBudgetedStep('crashed job terminalization', async (signal) => {
        await markJobsAsErrorFn('Backend shutting down', signal);
      });
    }
  } else {
    // Phase A2 is a durability fence, not a best-effort drain. Admission is
    // closed synchronously, then every write already admitted by the old daemon
    // settles before host shutdown or replacement recovery may proceed.
    let quiescePorts: readonly HandoffQuiescePort[] = [];
    await runStep('app-server handoff quiesce discovery', () => {
      quiescePorts = handoffQuiescePorts();
    });
    for (const port of quiescePorts) {
      await runRequiredBudgetedStep(
        'app-server handoff quiesce',
        async () => {
          await port.quiesceAppServerJobsForHandoff();
          return { confirmed: true };
        },
        false,
      );
    }
    const providerHostsDrained = await runRequiredBudgetedStep('provider host drain for handoff', async (signal) => {
      providerHostQuiescence.receipt = await providerHostManager.drainForHandoff(signal);
      return { confirmed: true };
    });
    refreshProviderCleanupObligations();
    if (!providerHostsDrained) {
      if (liveProxySets.length === 0 && acquisitionCleanupHolds.length === 0) {
        retainRequiredFailureAsFatal('provider host drain for handoff');
      } else {
        pendingRequiredSteps[pendingRequiredSteps.length - 1] = {
          label: 'provider host drain for handoff',
          task: (signal) =>
            providerHostManager.drainForHandoff(signal).then((receipt) => {
              providerHostQuiescence.receipt = receipt;
              refreshProviderCleanupObligations();
              return acquisitionCleanupHolds.length === 0 ? { confirmed: true } : settleProviderCleanup([], signal);
            }),
        };
      }
    } else if (acquisitionCleanupHolds.length > 0) {
      await runRequiredBudgetedStep('provider proxy acquisition cleanup', async (signal) =>
        settleProviderCleanup([], signal),
      );
    }
  }

  await runBudgetedStep('components disposeAll', async (signal) => runtimeState.components.disposeAll(signal));
  await runBudgetedStep('hooks.onShutdown', async (signal) => hooks.onShutdown(mode, signal));
  for (const [source, store] of discussStores) {
    await runStep(`discuss store '${source}' dispose`, () => store.dispose());
  }

  const providerReleaseCapabilities = new Map<
    string,
    Readonly<{ heartbeat: AuthorityReleaseCapability; control: AuthorityReleaseCapability }>
  >();
  const synchronizeProviderReleaseCapabilities = (): void => {
    for (const set of liveProxySets) {
      if (providerReleaseCapabilities.has(set.proxyInstanceId)) continue;
      providerReleaseCapabilities.set(set.proxyInstanceId, {
        heartbeat: {
          label: `heartbeats ${set.proxyInstanceId}`,
          proxyInstanceId: set.proxyInstanceId,
          release: () => set.stopHeartbeats(),
          state: { kind: 'pending' },
        },
        control: {
          label: `control ${set.proxyInstanceId}`,
          proxyInstanceId: set.proxyInstanceId,
          release: () => set.initiateControlClose(),
          state: { kind: 'pending' },
        },
      });
    }
  };
  const ipcReleaseCapability: AuthorityReleaseCapability | null =
    ipcServer === undefined || closeIpcServerFn === undefined
      ? null
      : {
          label: 'IPC socket',
          release: () => releaseIpcSocket(ipcServer, closeIpcServerFn),
          state: { kind: 'pending' },
        };
  let authorityReleaseAttempt: Promise<ShutdownStepConfirmation> | null = null;
  let authorityReleaseAttemptOutcome: ShutdownStepConfirmation | null = null;
  const authorityRelease: PendingRequiredShutdownStep = {
    label: 'provider control and IPC authority release',
    task: () => {
      if (authorityReleaseAttempt !== null) return authorityReleaseAttempt;
      authorityReleaseAttemptOutcome = null;
      synchronizeProviderReleaseCapabilities();
      const releases = [...providerReleaseCapabilities.values()];
      authorityReleaseAttempt = settleAuthorityReleases([
        ...releases.map(({ heartbeat }) => heartbeat),
        ...releases.map(({ control }) => control),
      ])
        .then((providerControlConfirmation) => {
          if (!providerControlConfirmation.confirmed) return providerControlConfirmation;
          return ipcReleaseCapability === null
            ? ({ confirmed: true } as const)
            : settleAuthorityReleases([ipcReleaseCapability]);
        })
        .then((outcome) => {
          authorityReleaseAttemptOutcome = outcome;
          return outcome;
        });
      return authorityReleaseAttempt;
    },
  };
  const failFinalization = (label: string, error: unknown): never => {
    recordShutdownFailure(failures, label, error, log);
    throwShutdownFailures(failures);
    throw new Error(`${label} failed without a recorded cause`, { cause: error });
  };
  const attemptReactorFinalization = (remaining: () => number): Promise<FinalizationDisposition> =>
    lifecycleReactorDisposalConfirmation(disposeLifecycleReactor, remaining, runtime.time).then(
      (disposition) => disposition,
      (error: unknown) => failFinalization('lifecycle reactor dispose', error),
    );
  const attemptFinalization = (remaining: () => number): Promise<FinalizationDisposition> => {
    if (processIncarnationProbeRegistrySize() === 0) return attemptReactorFinalization(remaining);
    return withBudget(
      'process incarnation probe shutdown',
      (signal) => processIncarnationProbeConfirmation(signal, log),
      remaining,
      runtime.time,
      log,
    ).then(
      (probeDisposition) => {
        if (probeDisposition === undefined) {
          return failFinalization(
            'process incarnation probe shutdown',
            new RequiredShutdownStepError(
              'process incarnation probe shutdown',
              'budget-exhausted',
              'no cleanup settlement was retained',
            ),
          );
        }
        return probeDisposition.disposition === 'held' ? probeDisposition : attemptReactorFinalization(remaining);
      },
      (error: unknown) => failFinalization('process incarnation probe shutdown', error),
    );
  };

  const retainedAuthority = (pending: readonly PendingRequiredShutdownStep[]): ShutdownRetainedAuthority => {
    synchronizeProviderReleaseCapabilities();
    const retainedProviderIds = [...providerReleaseCapabilities.entries()].flatMap(([proxyInstanceId, release]) =>
      release.heartbeat.state.kind === 'settled' && release.control.state.kind === 'settled' ? [] : [proxyInstanceId],
    );
    const providerActions: ShutdownOperatorAction[] = retainedProviderIds.map((proxyInstanceId) => ({
      kind: 'provider-proxy-set-containment',
      proxyInstanceId,
      inspectCommand: 'coral-cli backend status',
      actionCommand: 'coral-cli backend provider-proxy-set abandon <set-token>',
    }));
    const providerCleanupObligations = acquisitionCleanupHolds.map((hold) =>
      hold.kind === 'provider_proxy_acquisition_held'
        ? `provider acquisition guardian pid ${hold.guardianIdentity.pid}`
        : `provider acquisition ${hold.target}`,
    );
    return {
      ipcSocket: ipcReleaseCapability !== null && ipcReleaseCapability.state.kind !== 'settled',
      providerControlProxyInstanceIds: retainedProviderIds,
      cleanupObligations: [...pending.map(({ label }) => label), ...providerCleanupObligations],
      operatorActions: [...retainedJobOperatorActions, ...providerActions],
    };
  };

  const clearAuthorityReleaseAttempt = (): void => {
    authorityReleaseAttempt = null;
    authorityReleaseAttemptOutcome = null;
  };

  const retryAuthorityRelease = (): Promise<ShutdownSequenceDisposition> => {
    const retryDeadline = runtime.time.now() + drainTimeout;
    const remainingRetry = (): number => Math.max(0, retryDeadline - runtime.time.now());
    return attemptAuthorityRelease(remainingRetry);
  };

  const continueAuthorityRelease = (attempt: Promise<ShutdownStepConfirmation>): Promise<ShutdownSequenceDisposition> =>
    attempt.then(
      (outcome) => {
        if (outcome.confirmed) return { disposition: 'settled' } as const;
        if (authorityReleaseAttempt === attempt) clearAuthorityReleaseAttempt();
        return retryAuthorityRelease();
      },
      (error: unknown) => {
        if (authorityReleaseAttempt === attempt) clearAuthorityReleaseAttempt();
        return authorityReleaseFailureDisposition(error);
      },
    );

  const authorityReleaseFailureDisposition = (error: unknown): ShutdownSequenceDisposition => {
    if (authorityReleaseAttemptOutcome?.confirmed === true) return { disposition: 'settled' };
    const releaseFailures: ShutdownFailure[] = [];
    recordShutdownFailure(releaseFailures, authorityRelease.label, error, log);
    const retained = retainedAuthority([authorityRelease]);
    const deadlineInterrupted =
      error instanceof RequiredShutdownStepError &&
      (error.reason === 'timed-out' || error.reason === 'budget-exhausted');
    const retainedAttempt =
      deadlineInterrupted && authorityReleaseAttemptOutcome === null ? authorityReleaseAttempt : null;
    if (retainedAttempt === null) clearAuthorityReleaseAttempt();
    if (retainedAttempt === null && retained.operatorActions.length === 0) {
      failures.push(...releaseFailures);
      throwShutdownFailures(failures);
    }
    return {
      disposition: 'held',
      reason: 'required-shutdown-step-unsettled',
      exit:
        retainedAttempt === null
          ? 'required-cleanup-capability-confirmation-or-durable-operator-abandonment'
          : 'authority-release-settlement',
      retryAfter:
        retainedAttempt === null
          ? runtime.time.sleep(SHUTDOWN_POLL_MS)
          : retainedAttempt.then(
              () => undefined,
              () => undefined,
            ),
      deferredFailures: releaseFailures,
      retainedAuthority: retained,
      retry: () => (retainedAttempt === null ? retryAuthorityRelease() : continueAuthorityRelease(retainedAttempt)),
    };
  };

  function attemptAuthorityRelease(remaining: () => number): Promise<ShutdownSequenceDisposition> {
    return withRequiredBudget(authorityRelease.label, authorityRelease.task, remaining, runtime.time).then(
      () => ({ disposition: 'settled' as const }),
      (error: unknown) => authorityReleaseFailureDisposition(error),
    );
  }

  function continueFinalization(
    pending: readonly PendingRequiredShutdownStep[],
    finalizationContinuation?: () => Promise<FinalizationDisposition>,
  ): Promise<ShutdownSequenceDisposition> {
    const retryDeadline = runtime.time.now() + drainTimeout;
    const remainingRetry = (): number => Math.max(0, retryDeadline - runtime.time.now());
    const stillPending: PendingRequiredShutdownStep[] = [];
    const retryFailures: ShutdownFailure[] = [];

    let retries = Promise.resolve();
    for (const step of pending) {
      retries = retries.then(() =>
        withRequiredBudget(step.label, step.task, remainingRetry, runtime.time).catch((error: unknown) => {
          recordShutdownFailure(retryFailures, step.label, error, log);
          stillPending.push(step);
        }),
      );
    }
    return retries
      .then(() =>
        finalizationContinuation === undefined
          ? attemptFinalization(remainingRetry)
          : finalizationContinuation().catch((error: unknown) => failFinalization('lifecycle reactor dispose', error)),
      )
      .then((finalization) => completeFinalization(finalization, stillPending, retryFailures, remainingRetry));
  }

  function completeFinalization(
    finalization: FinalizationDisposition,
    pending: readonly PendingRequiredShutdownStep[],
    pendingFailures: readonly ShutdownFailure[],
    remaining: () => number,
  ): Promise<ShutdownSequenceDisposition> {
    throwShutdownFailures(failures);
    if (pending.length > 0) {
      return Promise.resolve<ShutdownSequenceDisposition>({
        disposition: 'held',
        reason: 'required-shutdown-step-unsettled',
        exit: 'required-cleanup-capability-confirmation-or-durable-operator-abandonment',
        retryAfter: runtime.time.sleep(SHUTDOWN_POLL_MS),
        deferredFailures: [...failures, ...pendingFailures],
        retainedAuthority: retainedAuthority(pending),
        retry: () =>
          continueFinalization(pending, finalization.disposition === 'held' ? finalization.continue : undefined),
      });
    }
    if (finalization.disposition === 'held') {
      return Promise.resolve<ShutdownSequenceDisposition>({
        disposition: 'held',
        reason: finalization.reason,
        exit: finalization.exit,
        retryAfter: finalization.retryAfter,
        deferredFailures: [...failures, ...pendingFailures],
        retainedAuthority: retainedAuthority(pending),
        retry: () => continueFinalization(pending, finalization.continue),
      });
    }

    throwShutdownFailures(failures);
    return attemptAuthorityRelease(remaining);
  }

  return attemptFinalization(remainingDrain).then((finalization) =>
    completeFinalization(finalization, pendingRequiredSteps, requiredFailures, remainingDrain),
  );
}

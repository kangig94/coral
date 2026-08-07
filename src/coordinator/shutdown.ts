import type { Server, ServerResponse } from 'node:http';
import { formatError } from '../infra/error-format.js';
import type { DiscussSessionStore } from '../discuss/shell/session-store.js';
import type { IdleTimer } from './live/idle.js';
import type { TimePort } from '../infra/port-types.js';
import type { Runtime } from '../runtime/ports.js';
import type { ProviderHostLifecycle } from './live/provider-hosts/index.js';
import type { IpcListener } from '../transport/ipc/server.js';
import type { HandoffQuiescePort } from './execution-service.js';
import type { StoreServicesRef } from './composition/store-services-ref.js';
import type { RuntimeComponentRegistry } from './runtime-components/registry.js';
import type { KbDaemonSupervisor } from './live/kb-daemon-supervisor.js';
import type { ProviderProxyAuthorityRegistry, ProviderProxySetAuthority } from './live/provider-proxy/authority.js';

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
  /**
   * The live guardian/reaper/proxy sets. Absent until the lazy acquisition path has created one, which is
   * every shutdown that ran no provider work.
   */
  providerProxyAuthority?: ProviderProxyAuthorityRegistry;
  kbDaemonSupervisor?: KbDaemonSupervisor;
  storeServicesRef: StoreServicesRef;
  terminateAllFn: () => void;
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

/**
 * A budgeted step whose failure is fatal to the shutdown rather than best-effort.
 *
 * It differs from `withBudget` in exactly the ways a required step must: an exhausted budget, a lost race, a
 * rejection, and an unconfirmed result all throw instead of logging. The exhausted-budget case still invokes
 * the task once, with an already-aborted signal, because a step whose job is to *trigger* releases must
 * trigger them even when there is no time left to confirm them — skipping the call would leave controls and
 * sockets held by a process that is exiting anyway.
 */
async function withRequiredBudget(
  label: string,
  task: (signal: AbortSignal) => Promise<ShutdownStepConfirmation>,
  remainingDrain: () => number,
  time: Pick<TimePort, 'sleep'>,
): Promise<void> {
  const budget = remainingDrain();
  if (budget <= 0) {
    // Observed so a rejection is never unhandled, but deliberately not awaited: there is no budget to wait
    // in, and the synchronous prefix of the task — the triggers — has already run by the time it returns.
    void task(AbortSignal.abort()).catch(() => {});
    throw new RequiredShutdownStepError(label, 'budget-exhausted', 'no drain budget remained');
  }
  const timedOut = Symbol('timedOut');
  const taskAbort = new AbortController();
  const timeoutAbort = new AbortController();
  let result: ShutdownStepConfirmation | typeof timedOut;
  try {
    result = await Promise.race<ShutdownStepConfirmation | typeof timedOut>([
      task(taskAbort.signal),
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

type ShutdownFailure = {
  readonly label: string;
  readonly error: unknown;
};

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
): Promise<void> {
  try {
    await task();
  } catch (error: unknown) {
    recordShutdownFailure(failures, label, error, log);
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
 * proxies that carry nothing — a set with no live operation has nothing to hand off, so leaving it running
 * would strand a carrier no successor will ever adopt.
 */
async function reapProviderProxySets(
  sets: readonly ProviderProxySetAuthority[],
  signal: AbortSignal,
): Promise<ShutdownStepConfirmation> {
  // Every set is triggered before any is awaited: one slow reap must not consume another's share of a
  // budget they are all spending at once.
  const outcomes = await Promise.allSettled(sets.map((set) => set.stopAndReap(signal)));
  const unconfirmed = outcomes.flatMap((outcome, index) => {
    const proxy = sets[index].proxyInstanceId;
    if (outcome.status === 'rejected') return [`${proxy}: ${formatError(outcome.reason)}`];
    return 'unconfirmed' in outcome.value ? [`${proxy}: ${outcome.value.unconfirmed}`] : [];
  });
  return unconfirmed.length === 0 ? { confirmed: true } : { confirmed: false, detail: unconfirmed.join('; ') };
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

/**
 * The ordered release boundary at the end of a handoff.
 *
 * Its whole purpose is that no single failure — synchronous or asynchronous — can suppress a later trigger.
 * Every heartbeat stop, then every control close, then the IPC socket release, is invoked synchronously and
 * in that order before any of them is awaited; a synchronous throw from one is caught and folded into the
 * same outcome as an asynchronous rejection, so it cannot skip the triggers queued after it. A control whose
 * close rejects — or a heartbeat stop that throws — must not keep the socket bound, because the socket is
 * what the successor is waiting on, and a successor that cannot bind waits out the full adoption window for
 * no reason.
 */
async function releaseHandoffAuthority(
  sets: readonly ProviderProxySetAuthority[],
  releaseIpcSocket: () => Promise<void>,
  signal: AbortSignal,
): Promise<ShutdownStepConfirmation> {
  // A synchronous throw becomes a rejected promise here instead of escaping: escaping would abort this
  // function before the triggers queued after it ever ran, which is exactly the failure this boundary rules
  // out. Calling `fn()` inside the try — not deferring it to a microtask — is also what makes every trigger
  // below run synchronously, in the order written, before any of them is awaited.
  const trigger = (fn: () => void | Promise<void>): Promise<void> => {
    try {
      return Promise.resolve(fn());
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  };

  const releases = [
    ...sets.map((set) => ({
      label: `heartbeats ${set.proxyInstanceId}`,
      settled: trigger(() => set.stopHeartbeats()),
    })),
    ...sets.map((set) => ({
      label: `control ${set.proxyInstanceId}`,
      settled: trigger(() => set.initiateControlClose()),
    })),
    { label: 'IPC socket release', settled: trigger(releaseIpcSocket) },
  ];

  const outcomes = await Promise.allSettled(releases.map((entry) => entry.settled));
  const failures = outcomes.flatMap((outcome, index) =>
    outcome.status === 'rejected' ? [`${releases[index].label}: ${formatError(outcome.reason)}`] : [],
  );
  if (signal.aborted) failures.push('release boundary was aborted before every confirmation arrived');
  return failures.length === 0 ? { confirmed: true } : { confirmed: false, detail: failures.join('; ') };
}

function throwShutdownFailures(failures: readonly ShutdownFailure[]): void {
  if (failures.length === 0) return;
  throw new AggregateError(
    failures.map(({ label, error }) => new Error(`${label}: ${formatError(error)}`, { cause: error })),
    `Coral backend shutdown completed with ${failures.length} finalizer failure${failures.length === 1 ? '' : 's'}.`,
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
  providerProxyAuthority,
  kbDaemonSupervisor,
  storeServicesRef,
  terminateAllFn,
  handoffQuiescePorts,
  disposeLifecycleReactor,
  hooks,
  discussStores,
  log,
}: RunShutdownSequenceContext): Promise<void> {
  const failures: ShutdownFailure[] = [];
  const runStep = (label: string, task: () => unknown | Promise<unknown>): Promise<void> =>
    runShutdownStep(failures, label, task, log);
  const observeTask = (label: string, task: Promise<void>): Promise<void> =>
    observeShutdownTask(failures, label, task, log);
  const mode = shutdownModeFromReason(reason);
  /** Sets that reached the release boundary with nothing redeemable behind them. */
  const handoffReapCandidates: ProviderProxySetAuthority[] = [];
  const drainTimeout = mode === 'handoff' ? HANDOFF_DRAIN_TIMEOUT_MS : SHUTDOWN_DRAIN_TIMEOUT_MS;

  log(`Coral backend shutting down (${reason}, mode=${mode})...\n`);
  runtimeState.setLifecycle('draining');
  idleTimer.stopWatching();

  const drainDeadline = runtime.time.now() + drainTimeout;
  const remainingDrain = (): number => Math.max(0, drainDeadline - runtime.time.now());
  const waitForObservedShutdownTask = (task: Promise<void>): Promise<void> =>
    Promise.race([task, runtime.time.sleep(remainingDrain())]);
  const runBudgetedStep = (label: string, task: (signal: AbortSignal) => Promise<void>): Promise<void> =>
    runStep(label, () => withBudget(label, task, remainingDrain, runtime.time, log));
  // A required step's failure is recorded like any other, so `throwShutdownFailures` still aggregates it —
  // what "required" changes is that skipping, timing out, or finishing unconfirmed all become failures
  // instead of a log line.
  const runRequiredBudgetedStep = (
    label: string,
    task: (signal: AbortSignal) => Promise<ShutdownStepConfirmation>,
  ): Promise<void> => runStep(label, () => withRequiredBudget(label, task, remainingDrain, runtime.time));
  // `liveSets()` is a call-time snapshot, not a live cursor (see its doc): reading it again after this
  // shutdown has itself reaped some of what it returned is not guaranteed to exclude those sets, which would
  // let an already-torn-down set re-enter a later required step and fail it a second time for the same
  // underlying reap. So this is still read exactly once per branch below — but not here, at the top of the
  // sequence: acquisition is fire-and-forget (`ensureProxySetFor`), so a set can still be settling when this
  // function starts, and a snapshot taken this early would read before `providerHostManager.shutdown()` /
  // `drainForHandoff()` has even run. Its own `stopAndClose` aborts every acquisition still in flight before
  // it awaits anything (see that abort's own doc), which is what makes a snapshot taken right after that call
  // returns — not here — safe to treat as final: nothing still pending can add to it afterward.
  let liveProxySets: readonly ProviderProxySetAuthority[] = [];

  // Stop accepting HTTP/user-facing work first; the IPC socket stays bound
  // until all handoff finalizers complete or consume the budget, so the
  // replacement daemon cannot run startup recovery against partial state.
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
  await runStep('recovery coordinator teardown', teardownRecoveryCoordinator);
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
    if (storeServicesAvailable) {
      await runBudgetedStep('crashed job terminalization', async (signal) => {
        await markJobsAsErrorFn('Backend shutting down', signal);
      });
    }
    await runBudgetedStep('provider host shutdown', async (signal) => providerHostManager.shutdown(signal));
    // Read only now, after `shutdown()` (and the `stopAndClose` abort inside it) has returned: see the
    // declaration above for why reading this any earlier would miss a set that finishes acquiring during
    // host shutdown.
    liveProxySets = providerProxyAuthority?.liveSets() ?? [];
    // Before the caught per-handle child termination, because that path terminates handles this coordinator
    // still owns; the detached sets outlive it and have to be reaped by identity, not by handle. Skipped
    // outright when there is nothing to reap: a required step with no work must not fail for want of budget.
    if (liveProxySets.length > 0) {
      await runRequiredBudgetedStep('provider proxy stop and reap', async (signal) =>
        reapProviderProxySets(liveProxySets, signal),
      );
    }
    await runStep('child termination', terminateAllFn);
  } else {
    // Phase A2 is a durability fence, not a best-effort drain. Admission is
    // closed synchronously, then every write already admitted by the old daemon
    // settles before host shutdown or replacement recovery may proceed.
    let quiescePorts: readonly HandoffQuiescePort[] = [];
    await runStep('app-server handoff quiesce discovery', () => {
      quiescePorts = handoffQuiescePorts();
    });
    for (const port of quiescePorts) {
      await runStep('app-server handoff quiesce', () => port.quiesceAppServerJobsForHandoff());
    }
    await runBudgetedStep('provider host drain for handoff', async (signal) =>
      providerHostManager.drainForHandoff(signal),
    );
    // Same reasoning as the hard-mode read above: taken only after `drainForHandoff()` has aborted every
    // acquisition still in flight, so nothing settling afterward can be missing from it.
    liveProxySets = providerProxyAuthority?.liveSets() ?? [];
    for (const set of liveProxySets) {
      // Snapshot and install per proxy, each in its own step: a grant that fails for one carrier must
      // hard-transition that carrier alone rather than stranding every other operation behind one EOF.
      await runBudgetedStep(`provider proxy handoff grant '${set.proxyInstanceId}'`, async (signal) => {
        const operations = await set.snapshotOperations(signal);
        if (operations.length === 0) {
          handoffReapCandidates.push(set);
          return;
        }
        try {
          await set.installHandoffGrant(operations, signal);
        } catch (error: unknown) {
          // The failed carrier goes down here rather than at exit: leaving it live with no redeemable grant
          // would leave a successor with nothing to adopt and a containment nobody is releasing.
          handoffReapCandidates.push(set);
          throw error;
        }
      });
    }
    // A set with no live operation has nothing to hand off, so it is reaped with the same required
    // semantics `hard` uses — including the ones whose grant install just failed.
    if (handoffReapCandidates.length > 0) {
      await runRequiredBudgetedStep('provider proxy handoff reap', async (signal) =>
        reapProviderProxySets(handoffReapCandidates, signal),
      );
    }
  }

  await runBudgetedStep('components disposeAll', async (signal) => runtimeState.components.disposeAll(signal));
  await runBudgetedStep('hooks.onShutdown', async (signal) => hooks.onShutdown(mode, signal));
  for (const [source, store] of discussStores) {
    await runStep(`discuss store '${source}' dispose`, () => store.dispose());
  }
  await runStep('lifecycle reactor dispose', disposeLifecycleReactor);

  // Socket release is the last step before lifecycle stop / process exit.
  // No async work may run between this resolution and `onStopped()`; that
  // structural invariant is what makes "socket bound = old daemon authority"
  // hold across the handoff window.
  // Sets already reaped above (nothing to hand off, or a failed grant install) are gone from the guardian/
  // reaper/proxy trio; re-offering them to the release boundary would retry a close against containment that
  // no longer exists and fail the required step a second time for the same underlying reap.
  const alreadyReaped = new Set(handoffReapCandidates);
  const handoffReleaseCandidates = liveProxySets.filter((set) => !alreadyReaped.has(set));

  if (mode === 'handoff' && handoffReleaseCandidates.length > 0) {
    // One ordered boundary rather than a socket close beside a separate control close. Control loss makes
    // the installed grants redeemable without moving either enforcer's challenge-derived deadline, and the
    // socket release that immediately follows lets the successor bind instead of waiting out the adoption
    // window it was never meant to spend.
    //
    // Only when carriers exist. The required semantics protect the handoff of a *carrier*; applying them to
    // a shutdown that ran no provider work would turn a slow-but-harmless drain into a non-zero exit for a
    // property nothing was relying on.
    await runRequiredBudgetedStep('provider proxy handoff authority release', async (signal) =>
      releaseHandoffAuthority(handoffReleaseCandidates, () => releaseIpcSocket(ipcServer, closeIpcServerFn), signal),
    );
  } else if (ipcServer && closeIpcServerFn) {
    const ipcServerClosed = observeTask(
      'IPC socket release',
      Promise.resolve().then(() => closeIpcServerFn(ipcServer)),
    );
    await waitForObservedShutdownTask(ipcServerClosed);
  }

  throwShutdownFailures(failures);
}

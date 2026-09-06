import type { Server, ServerResponse } from 'node:http';
import type { DiscussSessionStore } from '../discuss/shell/session-store.js';
import { formatError } from '../infra/error-format.js';
import {
  terminateProcessIncarnationProbes,
  type ProcessIncarnationProbeCleanupDisposition,
} from '../infra/node-process.js';
import { createJoinableSettlementTask, type SettlementConfirmation } from '../obligation/settlement.js';
import type { Runtime } from '../runtime/ports.js';
import type { IpcListener } from '../transport/ipc/server.js';
import type { StoreServicesRef } from './composition/store-services-ref.js';
import type { HandoffQuiescePort } from './execution-service.js';
import type { TerminateAllDisposition } from './live/admission.js';
import type { IdleTimer } from './live/idle.js';
import type {
  ProviderHostCleanupObligations,
  ProviderHostLifecycle,
  ProviderHostQuiescenceReceipt,
} from './live/provider-hosts/index.js';
import type { KbDaemonSupervisor } from './live/kb-daemon-supervisor.js';
import type { ProviderProxyAuthorityRegistry, ProviderProxySetAuthority } from './live/provider-proxy/authority.js';
import type { RuntimeComponentRegistry } from './runtime-components/registry.js';
import type { ProviderOperationReconcilerStopDisposition } from './services/provider-operation-reconciler.js';
import {
  createShutdownSettlementLedger,
  type ProcessExitRemainder,
  type ProcessExitRemainderAcceptance,
  type ShutdownAuthorityReleaseBoundary,
  type ShutdownObligation,
  type ShutdownOperatorAction,
  type ShutdownRetainedAuthorityContribution,
  type ShutdownSequenceDisposition,
} from './shutdown-settlement.js';

export const SHUTDOWN_DRAIN_TIMEOUT_MS = 10_000;
export const HANDOFF_DRAIN_TIMEOUT_MS = 30_000;
export const SHUTDOWN_POLL_MS = 50;

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
  providerProxyAuthority?: ProviderProxyAuthorityRegistry;
  stopProviderOperationReconciler?: () => ProviderOperationReconcilerStopDisposition;
  kbDaemonSupervisor?: KbDaemonSupervisor;
  storeServicesRef: StoreServicesRef;
  terminateAllFn: (signal: AbortSignal) => TerminateAllDisposition | Promise<TerminateAllDisposition>;
  handoffQuiescePorts: () => readonly HandoffQuiescePort[];
  disposeLifecycleReactor: () => void | Promise<void>;
  hooks: { onShutdown(mode: ShutdownMode, signal: AbortSignal): Promise<void> };
  discussStores: Map<string, DiscussSessionStore>;
  log: (message: string) => void;
  acceptProcessExitRemainder?: (remainder: ProcessExitRemainder) => ProcessExitRemainderAcceptance;
};

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

function childTerminationConfirmation(disposition: TerminateAllDisposition): SettlementConfirmation {
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
    process.jobId === undefined ? [] : [`coral-cli abort jobs ${process.jobId}`],
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

async function reapProviderProxySets(
  sets: readonly ProviderProxySetAuthority[],
  acquisitionHolds: ProviderHostQuiescenceReceipt['acquisitionCleanupHolds'],
  signal: AbortSignal,
): Promise<SettlementConfirmation> {
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

async function releaseIpcSocket(
  ipcServer: IpcListener | undefined,
  closeIpcServerFn: ((listener: IpcListener) => Promise<void>) | undefined,
): Promise<void> {
  if (ipcServer === undefined || closeIpcServerFn === undefined) return;
  await closeIpcServerFn(ipcServer);
}

type AuthorityReleaseOutcome = Readonly<{ ok: true } | { ok: false; error: unknown }>;

type AuthorityReleaseCapability = {
  readonly label: string;
  readonly release: () => void | Promise<void>;
  state:
    | Readonly<{ kind: 'pending' }>
    | Readonly<{ kind: 'in-flight'; settlement: Promise<AuthorityReleaseOutcome> }>
    | Readonly<{ kind: 'settled' }>;
};

function startAuthorityRelease(capability: AuthorityReleaseCapability): Promise<AuthorityReleaseOutcome> {
  if (capability.state.kind === 'settled') return Promise.resolve({ ok: true });
  if (capability.state.kind === 'in-flight') return capability.state.settlement;
  const release = Promise.resolve().then(capability.release);
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

async function settleAuthorityReleases(
  capabilities: readonly AuthorityReleaseCapability[],
): Promise<SettlementConfirmation> {
  const outcomes = await Promise.all(capabilities.map(startAuthorityRelease));
  const failures = outcomes.flatMap((outcome, index) =>
    outcome.ok ? [] : [`${capabilities[index].label}: ${formatError(outcome.error)}`],
  );
  return failures.length === 0 ? { confirmed: true } : { confirmed: false, detail: failures.join('; ') };
}

function confirmedTask(task: () => unknown | Promise<unknown>): Promise<SettlementConfirmation> {
  return Promise.resolve()
    .then(task)
    .then(() => ({ confirmed: true }));
}

function cleanupContribution(
  label: string,
  extra: ShutdownRetainedAuthorityContribution = {},
): ShutdownRetainedAuthorityContribution {
  return { ...extra, cleanupObligations: [label, ...(extra.cleanupObligations ?? [])] };
}

function retainedChildActions(disposition: TerminateAllDisposition | null): readonly ShutdownOperatorAction[] {
  if (disposition === null || disposition.kind === 'all-observed-absent') return [];
  return [...disposition.retainedLaunches, ...disposition.retainedProcesses].flatMap((retained) =>
    retained.jobId === undefined
      ? []
      : [
          {
            kind: 'retained-job-containment' as const,
            jobId: retained.jobId,
            provider: retained.provider,
            jobDir: retained.jobDir,
            actionCommand: `coral-cli abort jobs ${retained.jobId}`,
          },
        ],
  );
}

function closingHostDetail(closing: ProviderHostCleanupObligations['closingHosts'][number]): string {
  const containment = closing.containment;
  return containment === null
    ? `${closing.label} containment unconfirmed; exit=closing settlement`
    : `${closing.label} pid ${containment.pid} pgid ${containment.processGroupId}; exit=closing settlement`;
}

function providerCleanupConfirmation(
  cleanup: SettlementConfirmation,
  closingHosts: ProviderHostCleanupObligations['closingHosts'],
  representationReleaseHolds: ProviderHostCleanupObligations['representationReleaseHolds'],
): SettlementConfirmation {
  if (!cleanup.confirmed) return cleanup;
  const pending = [
    ...closingHosts.map(closingHostDetail),
    ...representationReleaseHolds.map(
      (hold) =>
        `${hold.label}: ${hold.pendingOperations.join(', ') || 'capsule retirement'}; ` +
        `disposition=${hold.disposition.kind}; exit=${hold.exit}`,
    ),
  ];
  return pending.length === 0 ? cleanup : { confirmed: false, detail: pending.join('; ') };
}

/** Authority release must remain behind the settlement ledger's no-successor gate. */
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
  stopProviderOperationReconciler,
  kbDaemonSupervisor,
  storeServicesRef,
  terminateAllFn,
  handoffQuiescePorts,
  disposeLifecycleReactor,
  hooks,
  discussStores,
  log,
  acceptProcessExitRemainder,
}: RunShutdownSequenceContext): Promise<ShutdownSequenceDisposition> {
  const mode = shutdownModeFromReason(reason);
  const budgetMs = mode === 'handoff' ? HANDOFF_DRAIN_TIMEOUT_MS : SHUTDOWN_DRAIN_TIMEOUT_MS;
  const ledger = createShutdownSettlementLedger({
    budgetMs,
    time: runtime.time,
    log,
    pollMs: SHUTDOWN_POLL_MS,
    ...(acceptProcessExitRemainder === undefined ? {} : { acceptProcessExitRemainder }),
  });

  log(`Coral backend shutting down (${reason}, mode=${mode})...\n`);
  runtimeState.setLifecycle('draining');
  idleTimer.stopWatching();

  const serverClose = createJoinableSettlementTask(() => closeServerFn(server));
  serverClose.start();

  await ledger.run({
    label: 'inflight drain',
    task: () => confirmedTask(() => waitForInflightDrain(idleTimer, ledger.remainingBudgetMs(), runtime.time)),
    retainedAuthority: () => cleanupContribution('inflight drain'),
    remainder: { owner: 'process-exit' },
  });

  await ledger.run({
    label: 'server connection close',
    task: () => confirmedTask(() => server.closeAllConnections()),
    retainedAuthority: () => cleanupContribution('server connection close'),
    remainder: { owner: 'process-exit' },
  });

  for (const [index, stream] of [...streamResponses].entries()) {
    const label = `stream response close ${index + 1}`;
    await ledger.run({
      label,
      task: () => confirmedTask(() => stream.end()),
      retainedAuthority: () => cleanupContribution(label),
      remainder: { owner: 'process-exit' },
    });
  }

  await ledger.run({
    label: 'server close',
    task: () => confirmedTask(serverClose.run),
    retainedAuthority: () => cleanupContribution('server close'),
    remainder: { owner: 'process-exit' },
  });

  await ledger.run({
    label: 'recovery coordinator teardown',
    task: () => confirmedTask(teardownRecoveryCoordinator),
    retainedAuthority: () => cleanupContribution('recovery coordinator teardown'),
    remainder: { owner: 'none' },
  });

  const ownershipCheckerTeardownFn = state.ownershipCheckerTeardown;
  await ledger.run({
    label: 'ownership checker teardown',
    task: () =>
      confirmedTask(() => {
        ownershipCheckerTeardownFn?.();
        state.ownershipCheckerTeardown = null;
      }),
    retainedAuthority: () => cleanupContribution('ownership checker teardown'),
    remainder: { owner: 'process-exit' },
  });

  if (kbDaemonSupervisor !== undefined) {
    let kbDaemonHold: Awaited<ReturnType<KbDaemonSupervisor['dispose']>> | null = null;
    await ledger.run({
      label: 'kb child shutdown',
      task: async (signal) => {
        kbDaemonHold = await kbDaemonSupervisor.dispose(reason, { signal });
        return kbDaemonHold.kind === 'confirmed-absent'
          ? { confirmed: true }
          : { confirmed: false, detail: kbDaemonHold.reason };
      },
      retainedAuthority: () => cleanupContribution('kb child shutdown'),
      remainder: { owner: 'none' },
      hold: () =>
        kbDaemonHold?.kind === 'holding'
          ? {
              reason: 'kb-daemon-shutdown-unsettled',
              exit: kbDaemonHold.exit,
              retryAfter: kbDaemonHold.retryAfter,
            }
          : {
              reason: 'required-shutdown-step-unsettled',
              exit: 'required-cleanup-capability-confirmation-or-durable-operator-abandonment',
            },
    });
  }

  let providerCleanup: ProviderHostCleanupObligations = {
    liveProxySets: providerProxyAuthority?.liveSets() ?? [],
    acquisitionCleanupHolds: [],
    closingHosts: [],
    representationReleaseHolds: [],
  };
  const refreshProviderCleanup = (receipt?: ProviderHostQuiescenceReceipt): void => {
    const snapshot = providerHostManager.cleanupObligations?.() ?? receipt;
    if (snapshot === undefined) return;
    providerCleanup = {
      ...snapshot,
      representationReleaseHolds: 'representationReleaseHolds' in snapshot ? snapshot.representationReleaseHolds : [],
    };
  };
  const providerRetainedAuthority = (label: string): ShutdownRetainedAuthorityContribution => {
    refreshProviderCleanup();
    const providerControlProxyInstanceIds = providerCleanup.liveProxySets.map(({ proxyInstanceId }) => proxyInstanceId);
    const representationReleaseRetryProxyInstanceIds = new Set(
      providerCleanup.representationReleaseHolds.flatMap((hold) =>
        hold.disposition.kind === 'fatal-successor-pending' ? [] : [hold.proxyInstanceId],
      ),
    );
    const fatalRepresentationReleaseProxyInstanceIds = providerCleanup.representationReleaseHolds.flatMap((hold) =>
      hold.disposition.kind === 'fatal-successor-pending' ? [hold.proxyInstanceId] : [],
    );
    const operatorActionProxyInstanceIds = [
      ...new Set([
        ...providerControlProxyInstanceIds.filter(
          (proxyInstanceId) => !representationReleaseRetryProxyInstanceIds.has(proxyInstanceId),
        ),
        ...fatalRepresentationReleaseProxyInstanceIds,
      ]),
    ];
    const operatorActions: ShutdownOperatorAction[] = operatorActionProxyInstanceIds.map((proxyInstanceId) => ({
      kind: 'provider-proxy-set-containment',
      proxyInstanceId,
      inspectCommand: 'coral-cli backend status',
      actionCommand: 'coral-cli backend provider-proxy-set abandon <set-token>',
    }));
    const acquisitionLabels = providerCleanup.acquisitionCleanupHolds.map((hold) =>
      hold.kind === 'provider_proxy_acquisition_held'
        ? `provider acquisition guardian pid ${hold.guardianIdentity.pid}`
        : `provider acquisition ${hold.target}`,
    );
    const representationReleaseLabels = providerCleanup.representationReleaseHolds.flatMap((hold) => [
      hold.label,
      ...hold.pendingOperations,
    ]);
    return cleanupContribution(label, {
      providerControlProxyInstanceIds,
      cleanupObligations: [
        ...acquisitionLabels,
        ...representationReleaseLabels,
        ...providerCleanup.closingHosts.map(closingHostDetail),
      ],
      operatorActions,
    });
  };
  const providerHold = () => {
    refreshProviderCleanup();
    const representationReleaseRetryPending = providerCleanup.representationReleaseHolds.some(
      ({ disposition }) => disposition.kind !== 'fatal-successor-pending',
    );
    const cleanupSettlements = [
      ...providerCleanup.closingHosts.map(({ settlement }) => settlement),
      ...providerCleanup.representationReleaseHolds.map(({ settlement }) => settlement),
    ];
    return {
      reason: 'required-shutdown-step-unsettled' as const,
      exit: representationReleaseRetryPending
        ? ('provider-proxy-set-release-retry' as const)
        : ('required-cleanup-capability-confirmation-or-durable-operator-abandonment' as const),
      ...(cleanupSettlements.length === 0
        ? {}
        : { retryAfter: Promise.allSettled(cleanupSettlements).then(() => undefined) }),
    };
  };
  let providerRecoveryObligation: ShutdownObligation | null = null;
  let providerOperationMutationDrain: ProviderOperationReconcilerStopDisposition | null = null;
  let providerOperationMutationHold: Extract<ProviderOperationReconcilerStopDisposition, { kind: 'holding' }> | null =
    null;
  const providerOperationMutationDrainObligation: ShutdownObligation = {
    label: 'provider operation mutation drain',
    task: async () => {
      if (providerRecoveryObligation === null || !ledger.isDischarged(providerRecoveryObligation)) {
        return {
          confirmed: false,
          detail: 'provider operation mutation admission remains open while provider recovery is held',
        };
      }
      if (providerOperationMutationDrain === null) {
        providerOperationMutationDrain = stopProviderOperationReconciler?.() ?? { kind: 'drained' as const };
        providerOperationMutationHold =
          providerOperationMutationDrain.kind === 'holding' ? providerOperationMutationDrain : null;
      }
      if (providerOperationMutationDrain.kind === 'holding') {
        await providerOperationMutationDrain.retryAfter;
        providerOperationMutationDrain = stopProviderOperationReconciler?.() ?? { kind: 'drained' as const };
      }
      providerOperationMutationHold =
        providerOperationMutationDrain.kind === 'holding' ? providerOperationMutationDrain : null;
      return providerOperationMutationDrain.kind === 'drained'
        ? { confirmed: true }
        : {
            confirmed: false,
            detail: `provider operation mutations remain admitted; exit=${providerOperationMutationDrain.exit}`,
          };
    },
    retainedAuthority: () =>
      cleanupContribution('provider operation mutation drain', {
        ipcSocket: true,
        providerControlProxyInstanceIds:
          providerProxyAuthority?.liveSets().map(({ proxyInstanceId }) => proxyInstanceId) ?? [],
        cleanupObligations: providerOperationMutationHold?.pendingMutations ?? [],
      }),
    remainder: { owner: 'none' },
    hold: () =>
      providerOperationMutationHold === null
        ? {
            reason: 'required-shutdown-step-unsettled',
            exit: 'required-cleanup-capability-confirmation-or-durable-operator-abandonment',
          }
        : {
            reason: 'provider-operation-mutations-unsettled',
            exit: providerOperationMutationHold.exit,
            retryAfter: providerOperationMutationHold.retryAfter,
          },
  };

  if (mode === 'hard') {
    let storeServicesAvailable = false;
    const storeServicesCheck: ShutdownObligation = {
      label: 'store services availability check',
      task: () =>
        confirmedTask(() => {
          storeServicesAvailable = storeServicesRef.tryGet() !== null;
        }),
      retainedAuthority: () => cleanupContribution('store services availability check'),
      remainder: { owner: 'successor-recovery', via: 'startup store recovery' },
    };
    await ledger.run(storeServicesCheck);

    const providerHostShutdown: ShutdownObligation = {
      label: 'provider host shutdown',
      task: async (signal) => {
        let receipt: ProviderHostQuiescenceReceipt | undefined;
        try {
          receipt = await providerHostManager.shutdown(signal);
        } finally {
          refreshProviderCleanup(receipt);
        }
        const cleanup = await reapProviderProxySets(
          providerCleanup.liveProxySets,
          providerCleanup.acquisitionCleanupHolds,
          signal,
        );
        refreshProviderCleanup();
        if (cleanup.confirmed) providerCleanup = { ...providerCleanup, acquisitionCleanupHolds: [] };
        return providerCleanupConfirmation(
          cleanup,
          providerCleanup.closingHosts,
          providerCleanup.representationReleaseHolds,
        );
      },
      retainedAuthority: () => providerRetainedAuthority('provider host shutdown'),
      remainder: { owner: 'none' },
      hold: providerHold,
    };
    providerRecoveryObligation = providerHostShutdown;
    await ledger.run(providerHostShutdown);
    await ledger.run(providerOperationMutationDrainObligation);

    let childTerminationDisposition: TerminateAllDisposition | null = null;
    const childTermination: ShutdownObligation = {
      label: 'child termination',
      task: async (signal) => {
        childTerminationDisposition = await terminateAllFn(signal);
        return childTerminationConfirmation(childTerminationDisposition);
      },
      retainedAuthority: () =>
        cleanupContribution('child termination', {
          operatorActions: retainedChildActions(childTerminationDisposition),
        }),
      remainder: { owner: 'none' },
    };
    await ledger.run(childTermination);

    const crashedJobTerminalization: ShutdownObligation = {
      label: 'crashed job terminalization',
      task: (signal) => {
        if (!ledger.isDischarged(storeServicesCheck)) {
          return Promise.resolve({ confirmed: false, detail: 'terminalization awaits the store availability check' });
        }
        if (!storeServicesAvailable) return Promise.resolve({ confirmed: true });
        if (
          !ledger.isDischarged(providerHostShutdown) ||
          !ledger.isDischarged(providerOperationMutationDrainObligation) ||
          !ledger.isDischarged(childTermination)
        ) {
          return Promise.resolve({
            confirmed: false,
            detail: 'terminalization awaits provider-host recovery, mutation drain, and child containment discharge',
          });
        }
        return confirmedTask(() => markJobsAsErrorFn('Backend shutting down', signal));
      },
      retainedAuthority: () => cleanupContribution('crashed job terminalization'),
      remainder: { owner: 'successor-recovery', via: 'startup liveness recovery' },
    };
    await ledger.run(crashedJobTerminalization);
  } else {
    await ledger.run({
      label: 'app-server handoff quiesce',
      task: async () => {
        const outcomes = await Promise.allSettled(
          handoffQuiescePorts().map((port) => port.quiesceAppServerJobsForHandoff()),
        );
        const failures = outcomes.flatMap((outcome, index) =>
          outcome.status === 'rejected' ? [`port ${index + 1}: ${formatError(outcome.reason)}`] : [],
        );
        return failures.length === 0 ? { confirmed: true } : { confirmed: false, detail: failures.join('; ') };
      },
      retainedAuthority: () => cleanupContribution('app-server handoff quiesce'),
      remainder: { owner: 'none' },
    });

    const providerHostDrain: ShutdownObligation = {
      label: 'provider host drain for handoff',
      task: async (signal) => {
        let receipt: ProviderHostQuiescenceReceipt | undefined;
        try {
          receipt = await providerHostManager.drainForHandoff(signal);
        } finally {
          refreshProviderCleanup(receipt);
        }
        const cleanup = await reapProviderProxySets([], providerCleanup.acquisitionCleanupHolds, signal);
        refreshProviderCleanup();
        if (cleanup.confirmed) providerCleanup = { ...providerCleanup, acquisitionCleanupHolds: [] };
        return providerCleanupConfirmation(
          cleanup,
          providerCleanup.closingHosts,
          providerCleanup.representationReleaseHolds,
        );
      },
      retainedAuthority: () => providerRetainedAuthority('provider host drain for handoff'),
      remainder: { owner: 'none' },
      hold: providerHold,
    };
    providerRecoveryObligation = providerHostDrain;
    await ledger.run(providerHostDrain);
    await ledger.run(providerOperationMutationDrainObligation);
  }

  await ledger.run({
    label: 'components disposeAll',
    task: (signal) =>
      ledger.isDischarged(providerOperationMutationDrainObligation)
        ? confirmedTask(() => runtimeState.components.disposeAll(signal))
        : Promise.resolve({ confirmed: false, detail: 'component disposal awaits provider operation mutation drain' }),
    retainedAuthority: () => cleanupContribution('components disposeAll'),
    remainder: { owner: 'process-exit' },
  });

  await ledger.run({
    label: 'hooks.onShutdown',
    task: (signal) => confirmedTask(() => hooks.onShutdown(mode, signal)),
    retainedAuthority: () => cleanupContribution('hooks.onShutdown'),
    remainder: { owner: 'process-exit' },
  });

  for (const [source, store] of discussStores) {
    const label = `discuss store '${source}' dispose`;
    await ledger.run({
      label,
      task: () => confirmedTask(() => store.dispose()),
      retainedAuthority: () => cleanupContribution(label),
      remainder: { owner: 'process-exit' },
    });
  }

  let probeRetryAfter: Promise<void> | null = null;
  await ledger.run({
    label: 'process incarnation probe shutdown',
    task: async (signal) => {
      const disposition: ProcessIncarnationProbeCleanupDisposition = await terminateProcessIncarnationProbes(signal);
      if (disposition.disposition === 'settled') {
        probeRetryAfter = null;
        return { confirmed: true };
      }
      probeRetryAfter = disposition.untilSettled;
      const detail = disposition.unsettled
        .map((hold) =>
          'key' in hold
            ? `probe ${hold.key}: ${hold.reason}; exit=${hold.exit}`
            : `pid ${hold.pid ?? 'unknown'}: ${hold.reason}; exit=${hold.exit}`,
        )
        .join('; ');
      log(`process incarnation probe shutdown held (${detail})\n`);
      return { confirmed: false, detail };
    },
    retainedAuthority: () => cleanupContribution('process incarnation probe shutdown'),
    remainder: { owner: 'none' },
    hold: () =>
      probeRetryAfter === null
        ? {
            reason: 'required-shutdown-step-unsettled',
            exit: 'required-cleanup-capability-confirmation-or-durable-operator-abandonment',
          }
        : {
            reason: 'process-incarnation-probes-unsettled',
            exit: 'process-incarnation-probe-settlement',
            retryAfter: probeRetryAfter,
          },
  });

  const reactorDisposal = createJoinableSettlementTask(disposeLifecycleReactor);
  await ledger.run({
    label: 'lifecycle reactor dispose',
    task: () => confirmedTask(reactorDisposal.run),
    retainedAuthority: () => cleanupContribution('lifecycle reactor dispose'),
    remainder: { owner: 'none' },
    hold: () => {
      const settlement = reactorDisposal.settlement();
      return settlement === null
        ? {
            reason: 'required-shutdown-step-unsettled',
            exit: 'required-cleanup-capability-confirmation-or-durable-operator-abandonment',
          }
        : {
            reason: 'lifecycle-reactor-disposal-unsettled',
            exit: 'lifecycle-reactor-disposal-settlement',
            retryAfter: settlement,
          };
    },
  });

  const providerReleaseCapabilities = new Map<
    ProviderProxySetAuthority,
    Readonly<{ heartbeat: AuthorityReleaseCapability; control: AuthorityReleaseCapability }>
  >();
  let authorityReleaseGeneration = 0;
  const synchronizeProviderReleaseCapabilities = (): void => {
    const sets = new Set([...(providerProxyAuthority?.liveSets() ?? []), ...providerCleanup.liveProxySets]);
    let changed = false;
    for (const set of sets) {
      if (providerReleaseCapabilities.has(set)) continue;
      providerReleaseCapabilities.set(set, {
        heartbeat: {
          label: `heartbeats ${set.proxyInstanceId}`,
          release: () => set.stopHeartbeats(),
          state: { kind: 'pending' },
        },
        control: {
          label: `control ${set.proxyInstanceId}`,
          release: () => set.initiateControlClose(),
          state: { kind: 'pending' },
        },
      });
      changed = true;
    }
    if (changed) authorityReleaseGeneration += 1;
  };
  const ipcReleaseCapability: AuthorityReleaseCapability | null =
    ipcServer === undefined || closeIpcServerFn === undefined
      ? null
      : {
          label: 'IPC socket',
          release: () => releaseIpcSocket(ipcServer, closeIpcServerFn),
          state: { kind: 'pending' },
        };
  const authorityReleaseSettlements = (): readonly Promise<AuthorityReleaseOutcome>[] => {
    const capabilities = [...providerReleaseCapabilities.values()].flatMap(({ heartbeat, control }) => [
      heartbeat,
      control,
    ]);
    if (ipcReleaseCapability !== null) capabilities.push(ipcReleaseCapability);
    return capabilities.flatMap((capability) =>
      capability.state.kind === 'in-flight' ? [capability.state.settlement] : [],
    );
  };
  type AuthorityReleaseSnapshot = Readonly<{
    generation: number;
    heartbeats: readonly AuthorityReleaseCapability[];
    controls: readonly AuthorityReleaseCapability[];
    ipc: AuthorityReleaseCapability | null;
  }>;
  const authorityReleaseSnapshots = new WeakMap<object, AuthorityReleaseSnapshot>();
  const snapshotAuthorityRelease = (): AuthorityReleaseSnapshot => {
    const releases = [...providerReleaseCapabilities.values()];
    return {
      generation: authorityReleaseGeneration,
      heartbeats: releases.map(({ heartbeat }) => heartbeat),
      controls: releases.map(({ control }) => control),
      ipc: ipcReleaseCapability,
    };
  };
  const sameCapabilities = (
    left: readonly AuthorityReleaseCapability[],
    right: readonly AuthorityReleaseCapability[],
  ): boolean => left.length === right.length && left.every((capability, index) => capability === right[index]);
  const authorityRelease: ShutdownAuthorityReleaseBoundary = {
    label: 'provider control and IPC authority release',
    prepare: () => {
      synchronizeProviderReleaseCapabilities();
      const token = Object.freeze({});
      authorityReleaseSnapshots.set(token, snapshotAuthorityRelease());
      return Promise.resolve({ confirmed: true, token });
    },
    commit: (token) => {
      synchronizeProviderReleaseCapabilities();
      const prepared = authorityReleaseSnapshots.get(token);
      const current = snapshotAuthorityRelease();
      if (
        prepared === undefined ||
        prepared.generation !== current.generation ||
        !sameCapabilities(prepared.heartbeats, current.heartbeats) ||
        !sameCapabilities(prepared.controls, current.controls) ||
        prepared.ipc !== current.ipc
      ) {
        return Promise.resolve({ confirmed: false, detail: 'authority capabilities changed after preparation' });
      }
      return settleAuthorityReleases([...prepared.heartbeats, ...prepared.controls]).then((providerControl) => {
        if (!providerControl.confirmed) return providerControl;
        return prepared.ipc === null ? { confirmed: true as const } : settleAuthorityReleases([prepared.ipc]);
      });
    },
    retainedAuthority: () => {
      refreshProviderCleanup();
      synchronizeProviderReleaseCapabilities();
      const representationReleaseRetryProxyInstanceIds = new Set(
        providerCleanup.representationReleaseHolds.flatMap((hold) =>
          hold.disposition.kind === 'fatal-successor-pending' ? [] : [hold.proxyInstanceId],
        ),
      );
      const fatalRepresentationReleaseProxyInstanceIds = providerCleanup.representationReleaseHolds.flatMap((hold) =>
        hold.disposition.kind === 'fatal-successor-pending' ? [hold.proxyInstanceId] : [],
      );
      const retainedProviderIds = [
        ...new Set(
          [...providerReleaseCapabilities.entries()].flatMap(([set, release]) =>
            release.heartbeat.state.kind === 'settled' && release.control.state.kind === 'settled'
              ? []
              : [set.proxyInstanceId],
          ),
        ),
      ];
      const operatorActionProxyInstanceIds = [
        ...new Set([
          ...retainedProviderIds.filter(
            (proxyInstanceId) => !representationReleaseRetryProxyInstanceIds.has(proxyInstanceId),
          ),
          ...fatalRepresentationReleaseProxyInstanceIds,
        ]),
      ];
      return cleanupContribution('provider control and IPC authority release', {
        ipcSocket: ipcReleaseCapability !== null && ipcReleaseCapability.state.kind !== 'settled',
        providerControlProxyInstanceIds: retainedProviderIds,
        operatorActions: operatorActionProxyInstanceIds.map((proxyInstanceId) => ({
          kind: 'provider-proxy-set-containment',
          proxyInstanceId,
          inspectCommand: 'coral-cli backend status',
          actionCommand: 'coral-cli backend provider-proxy-set abandon <set-token>',
        })),
      });
    },
    hold: (settlement) => {
      const inFlight = authorityReleaseSettlements();
      return settlement.cause === 'timed-out' && inFlight.length > 0
        ? {
            reason: 'required-shutdown-step-unsettled',
            exit: 'authority-release-settlement',
            retryAfter: Promise.all(inFlight).then(() => undefined),
          }
        : {
            reason: 'required-shutdown-step-unsettled',
            exit: 'required-cleanup-capability-confirmation-or-durable-operator-abandonment',
          };
    },
  };

  return ledger.gate(authorityRelease);
}

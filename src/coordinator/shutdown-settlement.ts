import { formatError } from '../infra/error-format.js';
import type { TimePort } from '../infra/port-types.js';
import {
  SettlementLedger,
  type DeclinedSettlementObligation,
  type RemainderSettlementRole,
  type Settlement,
  type SettlementAuthorityReleaseBoundary,
  type SettlementDisposition,
  type SettlementHold,
  type SettlementObligation,
} from '../obligation/settlement.js';
import type { ShutdownObligationSubject } from '../obligation/shutdown-abandonment.js';

export type UndischargedRemainder =
  | Readonly<{ owner: 'process-exit' }>
  | Readonly<{ owner: 'successor-recovery'; via: string }>
  | Readonly<{ owner: 'none' }>;

export type ShutdownHoldReason =
  | 'kb-daemon-shutdown-unsettled'
  | 'process-incarnation-probes-unsettled'
  | 'lifecycle-reactor-disposal-unsettled'
  | 'provider-operation-mutations-unsettled'
  | 'required-shutdown-step-unsettled';

export type ShutdownHoldExit =
  | 'kb-daemon-process-close'
  | 'process-incarnation-probe-settlement'
  | 'lifecycle-reactor-disposal-settlement'
  | 'admitted-provider-operation-mutation-settlement'
  | 'provider-operation-mutation-admission-availability'
  | 'provider-proxy-set-release-retry'
  | 'durable-operator-abandonment'
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
    }>
  | Readonly<{
      kind: 'shutdown-obligation-abandonment';
      subject: ShutdownObligationSubject;
      inspectCommand: 'coral-cli backend shutdown-recovery status';
      actionCommand: `coral-cli backend shutdown-recovery abandon ${ShutdownObligationSubject}`;
    }>;

export type ShutdownRetainedAuthority = Readonly<{
  ipcSocket: boolean;
  providerControlProxyInstanceIds: readonly string[];
  cleanupObligations: readonly string[];
  operatorActions: readonly ShutdownOperatorAction[];
}>;

export type ShutdownDeferredFailure = Readonly<{
  label: string;
  error: unknown;
}>;

export type ProcessExitRemainder = Readonly<{
  owner: 'process-exit';
  deferredFailures: readonly ShutdownDeferredFailure[];
}>;

export type ProcessExitRemainderAcceptance =
  | Readonly<{ kind: 'accepted'; remainder: ProcessExitRemainder; requestExit: () => void }>
  | Readonly<{ kind: 'refused'; detail: string }>;

type AcceptedProcessExitRemainder = Extract<ProcessExitRemainderAcceptance, { kind: 'accepted' }>;

export type ShutdownSequenceDisposition = SettlementDisposition<
  'process-exit',
  ShutdownHoldReason,
  ShutdownHoldExit,
  ShutdownDeferredFailure,
  ShutdownRetainedAuthority,
  AcceptedProcessExitRemainder
>;

export type ShutdownRetainedAuthorityContribution = Readonly<{
  ipcSocket?: boolean;
  providerControlProxyInstanceIds?: readonly string[];
  cleanupObligations?: readonly string[];
  operatorActions?: readonly ShutdownOperatorAction[];
}>;

export type ShutdownHold = SettlementHold<ShutdownHoldReason, ShutdownHoldExit>;

export type ShutdownObligation = SettlementObligation<
  UndischargedRemainder,
  ShutdownRetainedAuthorityContribution,
  ShutdownHoldReason,
  ShutdownHoldExit
>;

export type ShutdownAuthorityReleaseBoundary = SettlementAuthorityReleaseBoundary<
  ShutdownRetainedAuthorityContribution,
  ShutdownHoldReason,
  ShutdownHoldExit
>;

export type ShutdownSettlementLedger = SettlementLedger<
  UndischargedRemainder,
  ShutdownRetainedAuthorityContribution,
  ShutdownRetainedAuthority,
  ShutdownHoldReason,
  ShutdownHoldExit,
  'process-exit',
  AcceptedProcessExitRemainder,
  ShutdownDeferredFailure
>;

export type ShutdownSettlementLedgerOptions = Readonly<{
  budgetMs: number;
  time: Pick<TimePort, 'monotonicNow' | 'sleep'>;
  log: (message: string) => void;
  pollMs: number;
  acceptProcessExitRemainder?: (remainder: ProcessExitRemainder) => ProcessExitRemainderAcceptance;
}>;

function unique<T>(values: readonly T[]): readonly T[] {
  return [...new Set(values)];
}

function operatorActionKey(action: ShutdownOperatorAction): string {
  switch (action.kind) {
    case 'retained-job-containment':
      return `${action.kind}:${action.jobId}:${action.jobDir}`;
    case 'provider-proxy-set-containment':
      return `${action.kind}:${action.proxyInstanceId}`;
    case 'shutdown-obligation-abandonment':
      return `${action.kind}:${action.subject}`;
  }
}

function foldRetainedAuthority(
  contributions: readonly ShutdownRetainedAuthorityContribution[],
): ShutdownRetainedAuthority {
  const actions = new Map<string, ShutdownOperatorAction>();
  for (const contribution of contributions) {
    for (const action of contribution.operatorActions ?? []) actions.set(operatorActionKey(action), action);
  }
  return {
    ipcSocket: contributions.some(({ ipcSocket }) => ipcSocket === true),
    providerControlProxyInstanceIds: unique(
      contributions.flatMap(({ providerControlProxyInstanceIds }) => providerControlProxyInstanceIds ?? []),
    ),
    cleanupObligations: unique(contributions.flatMap(({ cleanupObligations }) => cleanupObligations ?? [])),
    operatorActions: [...actions.values()],
  };
}

function defaultHold(): ShutdownHold {
  return {
    reason: 'required-shutdown-step-unsettled',
    exit: 'durable-operator-abandonment',
  };
}

function declinedFailure(
  label: string,
  settlement: Extract<Settlement, { kind: 'declined' }>,
): ShutdownDeferredFailure {
  return {
    label,
    error: settlement.error ?? new Error(`${settlement.cause}: ${settlement.detail}`),
  };
}

function remainderRole(remainder: UndischargedRemainder): RemainderSettlementRole {
  switch (remainder.owner) {
    case 'none':
      return 'blocking';
    case 'process-exit':
      return 'delegable';
    case 'successor-recovery':
      return 'successor';
  }
}

function acceptProcessExitRemainder(
  declined: readonly DeclinedSettlementObligation<
    UndischargedRemainder,
    ShutdownRetainedAuthorityContribution,
    ShutdownHoldReason,
    ShutdownHoldExit
  >[],
  accept: (remainder: ProcessExitRemainder) => ProcessExitRemainderAcceptance,
  log: (message: string) => void,
): AcceptedProcessExitRemainder | null {
  const deferredFailures = declined.map(({ obligation, settlement }) => declinedFailure(obligation.label, settlement));
  const remainder: ProcessExitRemainder = { owner: 'process-exit', deferredFailures };
  try {
    const acceptance = accept(remainder);
    if (acceptance.kind === 'accepted') {
      if (acceptance.remainder === remainder) return acceptance;
      log('process-exit remainder acceptance did not identify the offered remainder\n');
      return null;
    }
    log(`process-exit remainder acceptance refused: ${acceptance.detail}\n`);
  } catch (error: unknown) {
    log(`process-exit remainder acceptance failed: ${formatError(error)}\n`);
  }
  return null;
}

export function createShutdownSettlementLedger(options: ShutdownSettlementLedgerOptions): ShutdownSettlementLedger {
  const accept = options.acceptProcessExitRemainder;
  return new SettlementLedger<
    UndischargedRemainder,
    ShutdownRetainedAuthorityContribution,
    ShutdownRetainedAuthority,
    ShutdownHoldReason,
    ShutdownHoldExit,
    'process-exit',
    AcceptedProcessExitRemainder,
    ShutdownDeferredFailure
  >({
    budgetMs: options.budgetMs,
    time: options.time,
    log: options.log,
    pollMs: options.pollMs,
    remainderRole,
    boundaryRemainder: { owner: 'none' },
    delegatedOwner: 'process-exit',
    ...(accept === undefined
      ? {}
      : {
          acceptDelegatedRemainder: (declined) => acceptProcessExitRemainder(declined, accept, options.log),
        }),
    acceptedFailures: (acceptance) => acceptance.remainder.deferredFailures,
    failure: declinedFailure,
    foldRetainedAuthority,
    defaultHold,
  });
}

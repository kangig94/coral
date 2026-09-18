import { formatError } from '../infra/error-format.js';
import type { TimePort } from '../infra/port-types.js';
import {
  SettlementLedger,
  type Settlement,
  type SettlementAuthorityReleaseBoundary,
  type SettlementDisposition,
  type SettlementObligation,
} from '../obligation/settlement.js';
import type { DurableCliRuntimePublicationEvidence } from './live/durable-transport.js';

export type SuccessorRecoveryEvidence =
  | Readonly<{ kind: 'startup-adoption'; processes: readonly DurableCliRuntimePublicationEvidence[] }>
  | Readonly<{ kind: 'startup-store-recovery' }>
  | Readonly<{ kind: 'startup-liveness-recovery' }>;

export type UndischargedRemainder =
  | Readonly<{ owner: 'process-exit' }>
  | Readonly<{ owner: 'successor-recovery'; evidence: SuccessorRecoveryEvidence }>;

export type ShutdownHoldReason = 'required-shutdown-step-unsettled';

export type ShutdownHoldExit = 'shutdown-budget-exhaustion' | 'authority-release-settlement';

export type ShutdownRetainedAuthority = Readonly<{
  ipcSocket: boolean;
  providerControlProxyInstanceIds: readonly string[];
  cleanupObligations: readonly string[];
}>;

export type ShutdownUndischarged = Readonly<{
  label: string;
  remainder: UndischargedRemainder;
  settlement: Readonly<Pick<Extract<Settlement, { kind: 'declined' }>, 'cause' | 'detail'>>;
}>;

export type ProcessExitRemainder = Readonly<{
  undischarged: readonly ShutdownUndischarged[];
}>;

export type ProcessExitRemainderAcceptance =
  | Readonly<{ kind: 'accepted'; remainder: ProcessExitRemainder; requestExit: (exitCode: number) => void }>
  | Readonly<{ kind: 'refused'; detail: string }>;

type AcceptedProcessExitRemainder = Extract<ProcessExitRemainderAcceptance, { kind: 'accepted' }>;

export type ShutdownSequenceDisposition = SettlementDisposition<
  ShutdownHoldReason,
  ShutdownHoldExit,
  ShutdownUndischarged,
  ShutdownRetainedAuthority,
  AcceptedProcessExitRemainder
>;

export type ShutdownRetainedAuthorityContribution = Readonly<{
  ipcSocket?: boolean;
  providerControlProxyInstanceIds?: readonly string[];
  cleanupObligations?: readonly string[];
}>;

export type ShutdownObligation = SettlementObligation<UndischargedRemainder, ShutdownRetainedAuthorityContribution>;

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
  AcceptedProcessExitRemainder,
  ShutdownUndischarged
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

function foldRetainedAuthority(
  contributions: readonly ShutdownRetainedAuthorityContribution[],
): ShutdownRetainedAuthority {
  return {
    ipcSocket: contributions.some(({ ipcSocket }) => ipcSocket === true),
    providerControlProxyInstanceIds: unique(
      contributions.flatMap(({ providerControlProxyInstanceIds }) => providerControlProxyInstanceIds ?? []),
    ),
    cleanupObligations: unique(contributions.flatMap(({ cleanupObligations }) => cleanupObligations ?? [])),
  };
}

function declinedFailure(
  label: string,
  remainder: UndischargedRemainder,
  settlement: Extract<Settlement, { kind: 'declined' }>,
): ShutdownUndischarged {
  return {
    label,
    remainder,
    settlement: { cause: settlement.cause, detail: settlement.detail },
  };
}

function acceptProcessExitRemainder(
  undischarged: readonly ShutdownUndischarged[],
  accept: (remainder: ProcessExitRemainder) => ProcessExitRemainderAcceptance,
  log: (message: string) => void,
): AcceptedProcessExitRemainder | null {
  const remainder: ProcessExitRemainder = { undischarged };
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
    AcceptedProcessExitRemainder,
    ShutdownUndischarged
  >({
    budgetMs: options.budgetMs,
    time: options.time,
    log: options.log,
    pollMs: options.pollMs,
    boundaryRemainder: { owner: 'process-exit' },
    ...(accept === undefined
      ? {}
      : {
          acceptDelegatedRemainder: (undischarged) => acceptProcessExitRemainder(undischarged, accept, options.log),
        }),
    acceptedUndischarged: (acceptance) => acceptance.remainder.undischarged,
    acceptanceFailureLabel: 'process-exit-remainder-acceptance',
    failure: declinedFailure,
    foldRetainedAuthority,
  });
}

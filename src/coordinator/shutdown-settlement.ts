import { formatError } from '../infra/error-format.js';
import type { TimePort } from '../infra/port-types.js';
import type {
  ShutdownHoldExit,
  ShutdownHoldReason,
  ShutdownRemainderSubject,
  ShutdownRetainedAuthority,
  ShutdownUndischarged,
  UndischargedRemainder,
} from '../infra/shutdown-contract.js';
import {
  SettlementLedger,
  type Settlement,
  type SettlementAuthorityReleaseBoundary,
  type SettlementDisposition,
  type SettlementObligation,
} from '../obligation/settlement.js';

export type ShutdownDeclinedSettlement = ShutdownUndischarged['settlement'];

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

export type ShutdownObligationLabel =
  | 'inflight drain'
  | 'server connection close'
  | `stream response close ${number}`
  | 'server close'
  | 'recovery coordinator teardown'
  | 'ownership checker teardown'
  | 'kb child shutdown'
  | 'provider operation mutation drain'
  | 'store services availability check'
  | 'provider host shutdown'
  | 'pending launch settlement'
  | 'child termination'
  | 'crashed job terminalization'
  | 'app-server handoff quiesce'
  | 'provider host drain for handoff'
  | 'components disposeAll'
  | 'hooks.onShutdown'
  | 'discuss store dispose'
  | 'process incarnation probe shutdown'
  | 'lifecycle reactor dispose'
  | 'store epoch sweep cancellation'
  | 'succession attempt settlement'
  | 'succession connection handover'
  | `provider proxy lifecycle fatal incident${'' | ` ${number}`}`;

export type ShutdownObligation<Label extends string = ShutdownObligationLabel> = SettlementObligation<
  UndischargedRemainder,
  ShutdownRetainedAuthorityContribution,
  ShutdownRemainderSubject
> &
  Readonly<{ label: Label }>;

export type ShutdownAuthorityReleaseBoundary = SettlementAuthorityReleaseBoundary<
  ShutdownRetainedAuthorityContribution,
  ShutdownHoldReason,
  ShutdownHoldExit
>;

type BaseShutdownSettlementLedger = SettlementLedger<
  UndischargedRemainder,
  ShutdownRetainedAuthorityContribution,
  ShutdownRetainedAuthority,
  ShutdownHoldReason,
  ShutdownHoldExit,
  AcceptedProcessExitRemainder,
  ShutdownUndischarged,
  ShutdownRemainderSubject
>;

export type ShutdownSettlementLedger<Label extends string = ShutdownObligationLabel> = Omit<
  BaseShutdownSettlementLedger,
  'run'
> &
  Readonly<{
    run: (obligation: ShutdownObligation<Label>) => ReturnType<BaseShutdownSettlementLedger['run']>;
  }>;

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
  subject?: ShutdownRemainderSubject,
): ShutdownUndischarged {
  const { kind: _kind, ...evidence } = settlement;
  return {
    label,
    ...(subject === undefined ? {} : { subject }),
    remainder,
    settlement: evidence,
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

export function createShutdownSettlementLedger<Label extends string = ShutdownObligationLabel>(
  options: ShutdownSettlementLedgerOptions,
): ShutdownSettlementLedger<Label> {
  const accept = options.acceptProcessExitRemainder;
  return new SettlementLedger<
    UndischargedRemainder,
    ShutdownRetainedAuthorityContribution,
    ShutdownRetainedAuthority,
    ShutdownHoldReason,
    ShutdownHoldExit,
    AcceptedProcessExitRemainder,
    ShutdownUndischarged,
    ShutdownRemainderSubject
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

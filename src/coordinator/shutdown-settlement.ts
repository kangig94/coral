import { formatError } from '../infra/error-format.js';
import type { TimePort } from '../infra/port-types.js';
import { isAbortError } from '../runtime/abort.js';

export type StepSettlement =
  | Readonly<{ kind: 'discharged' }>
  | Readonly<{
      kind: 'declined';
      cause: 'rejected' | 'timed-out' | 'budget-exhausted' | 'unconfirmed' | 'aborted';
      detail: string;
      error?: unknown;
    }>;

export type ShutdownStepConfirmation = Readonly<{ confirmed: true }> | Readonly<{ confirmed: false; detail: string }>;

export type UndischargedRemainder =
  | Readonly<{ owner: 'process-exit' }>
  | Readonly<{ owner: 'successor-recovery'; via: string }>
  | Readonly<{ owner: 'none' }>;

export type ShutdownHoldReason =
  | 'process-incarnation-probes-unsettled'
  | 'lifecycle-reactor-disposal-unsettled'
  | 'required-shutdown-step-unsettled';

export type ShutdownHoldExit =
  | 'process-incarnation-probe-settlement'
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

export type ShutdownAuthorityPreparation =
  | Readonly<{ confirmed: true; token: object }>
  | Readonly<{ confirmed: false; detail: string }>;

export type ShutdownAuthorityReleaseBoundary = Readonly<{
  label: string;
  prepare: (signal: AbortSignal) => Promise<ShutdownAuthorityPreparation>;
  commit: (token: object, signal: AbortSignal) => Promise<ShutdownStepConfirmation>;
  retainedAuthority: () => ShutdownRetainedAuthorityContribution;
  hold?: (settlement: Extract<StepSettlement, { kind: 'declined' }>) => ShutdownHold;
}>;

type AcceptedProcessExitRemainder = Extract<ProcessExitRemainderAcceptance, { kind: 'accepted' }>;

export type ShutdownSequenceDisposition =
  | Readonly<{ disposition: 'settled' }>
  | Readonly<{
      disposition: 'delegated';
      owner: 'process-exit';
      deferredFailures: readonly ShutdownDeferredFailure[];
      acceptance: AcceptedProcessExitRemainder;
    }>
  | Readonly<{
      disposition: 'transfer-pending';
      owner: 'process-exit';
      reason: ShutdownHoldReason;
      exit: ShutdownHoldExit;
      retryAfter: Promise<void>;
      deferredFailures: readonly ShutdownDeferredFailure[];
      acceptance: AcceptedProcessExitRemainder;
      boundaryFailure: ShutdownDeferredFailure;
      retainedAuthority: ShutdownRetainedAuthority;
      retry(): Promise<ShutdownSequenceDisposition>;
    }>
  | Readonly<{
      disposition: 'held';
      reason: ShutdownHoldReason;
      exit: ShutdownHoldExit;
      retryAfter: Promise<void>;
      deferredFailures: readonly ShutdownDeferredFailure[];
      retainedAuthority: ShutdownRetainedAuthority;
      retry(): Promise<ShutdownSequenceDisposition>;
    }>;

export type ShutdownRetainedAuthorityContribution = Readonly<{
  ipcSocket?: boolean;
  providerControlProxyInstanceIds?: readonly string[];
  cleanupObligations?: readonly string[];
  operatorActions?: readonly ShutdownOperatorAction[];
}>;

type ShutdownHold = Readonly<{
  reason: ShutdownHoldReason;
  exit: ShutdownHoldExit;
  retryAfter?: Promise<void>;
}>;

export type ShutdownObligation = Readonly<{
  label: string;
  task: (signal: AbortSignal) => Promise<ShutdownStepConfirmation>;
  retainedAuthority: () => ShutdownRetainedAuthorityContribution;
  remainder: UndischargedRemainder;
  hold?: (settlement: Extract<StepSettlement, { kind: 'declined' }>) => ShutdownHold;
}>;

type ObligationState = Readonly<{ kind: 'pending' }> | Readonly<{ kind: 'settled'; settlement: StepSettlement }>;

type DeclinedObligation = Readonly<{
  obligation: ShutdownObligation;
  settlement: Extract<StepSettlement, { kind: 'declined' }>;
}>;

type BoundaryPreparationAttempt =
  | Readonly<{ kind: 'prepared'; settlement: Extract<StepSettlement, { kind: 'discharged' }>; token: object }>
  | Readonly<{ kind: 'declined'; settlement: Extract<StepSettlement, { kind: 'declined' }> }>;

type GateResolution =
  | Readonly<{ kind: 'initial' }>
  | Readonly<{
      kind: 'held';
      boundaryFailure: Extract<StepSettlement, { kind: 'declined' }> | null;
      retry?: () => Promise<ShutdownSequenceDisposition>;
    }>
  | Readonly<{ kind: 'committed'; acceptance: AcceptedProcessExitRemainder | null }>
  | Readonly<{
      kind: 'transfer-pending';
      acceptance: AcceptedProcessExitRemainder;
      failure: Extract<StepSettlement, { kind: 'declined' }>;
    }>;

export type ShutdownSettlementLedgerOptions = Readonly<{
  budgetMs: number;
  time: Pick<TimePort, 'now' | 'sleep'>;
  log: (message: string) => void;
  pollMs: number;
  acceptProcessExitRemainder?: (remainder: ProcessExitRemainder) => ProcessExitRemainderAcceptance;
}>;

type JoinableOutcome<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: unknown }>;

export type JoinableShutdownTask<T> = Readonly<{
  start(): void;
  run(): Promise<T>;
  settlement(): Promise<void> | null;
}>;

/** A retry may start a new attempt only after the preceding attempt has settled. */
export function createJoinableShutdownTask<T>(task: () => T | Promise<T>): JoinableShutdownTask<T> {
  let state:
    | Readonly<{ kind: 'pending' }>
    | Readonly<{ kind: 'in-flight'; outcome: Promise<JoinableOutcome<T>> }>
    | Readonly<{ kind: 'settled'; value: T }> = { kind: 'pending' };

  const start = (): Promise<JoinableOutcome<T>> => {
    if (state.kind === 'settled') return Promise.resolve<JoinableOutcome<T>>({ ok: true, value: state.value });
    if (state.kind === 'in-flight') return state.outcome;
    const outcome = Promise.resolve()
      .then(task)
      .then<JoinableOutcome<T>, JoinableOutcome<T>>(
        (value) => {
          state = { kind: 'settled', value };
          return { ok: true, value };
        },
        (error: unknown) => {
          state = { kind: 'pending' };
          return { ok: false, error };
        },
      );
    state = { kind: 'in-flight', outcome };
    return outcome;
  };

  return {
    start: () => {
      void start();
    },
    run: async () => {
      const outcome = await start();
      if (outcome.ok) return outcome.value;
      throw outcome.error;
    },
    settlement: () =>
      state.kind === 'in-flight'
        ? state.outcome.then(() => undefined)
        : state.kind === 'settled'
          ? Promise.resolve()
          : null,
  };
}

function declinedFailure(
  label: string,
  settlement: Extract<StepSettlement, { kind: 'declined' }>,
): ShutdownDeferredFailure {
  return {
    label,
    error: settlement.error ?? new Error(`${settlement.cause}: ${settlement.detail}`),
  };
}

function unique<T>(values: readonly T[]): readonly T[] {
  return [...new Set(values)];
}

function operatorActionKey(action: ShutdownOperatorAction): string {
  return action.kind === 'retained-job-containment'
    ? `${action.kind}:${action.jobId}:${action.jobDir}`
    : `${action.kind}:${action.proxyInstanceId}`;
}

function foldRetainedAuthority(
  entries: readonly Readonly<{ obligation: ShutdownObligation; state: ObligationState }>[],
  additionalContributions: readonly ShutdownRetainedAuthorityContribution[] = [],
): ShutdownRetainedAuthority {
  const contributions = [
    ...entries
      .filter(({ state }) => state.kind !== 'settled' || state.settlement.kind !== 'discharged')
      .map(({ obligation }) => obligation.retainedAuthority()),
    ...additionalContributions,
  ];
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
    exit: 'required-cleanup-capability-confirmation-or-durable-operator-abandonment',
  };
}

async function settleStep(
  obligation: ShutdownObligation,
  remainingBudget: () => number,
  time: Pick<TimePort, 'sleep'>,
  log: (message: string) => void,
): Promise<StepSettlement> {
  const budget = remainingBudget();
  if (budget <= 0) {
    const settlement = {
      kind: 'declined',
      cause: 'budget-exhausted',
      detail: 'no drain budget remained',
    } as const;
    log(`${obligation.label}: skipped (drain budget exhausted)\n`);
    return settlement;
  }

  const timedOut = Symbol('timedOut');
  const taskAbort = new AbortController();
  const timeoutAbort = new AbortController();
  try {
    const result = await Promise.race<ShutdownStepConfirmation | typeof timedOut>([
      obligation.task(taskAbort.signal),
      time.sleep(budget, { signal: timeoutAbort.signal }).then(() => timedOut),
    ]);
    if (result === timedOut) {
      taskAbort.abort();
      const settlement = {
        kind: 'declined',
        cause: 'timed-out',
        detail: `exceeded ${budget}ms`,
      } as const;
      log(`${obligation.label}: exceeded drain budget after ${budget}ms\n`);
      return settlement;
    }
    if (!result.confirmed) {
      const settlement = { kind: 'declined', cause: 'unconfirmed', detail: result.detail } as const;
      log(`${obligation.label} unconfirmed during shutdown: ${result.detail}\n`);
      return settlement;
    }
    return { kind: 'discharged' };
  } catch (error: unknown) {
    const settlement = {
      kind: 'declined',
      cause: isAbortError(error) ? 'aborted' : 'rejected',
      detail: formatError(error),
      error,
    } as const;
    log(`${obligation.label} failed during shutdown: ${formatError(error)}\n`);
    return settlement;
  } finally {
    timeoutAbort.abort();
  }
}

/** Authority release is forbidden while an obligation without a successor remains declined. */
export class ShutdownSettlementLedger {
  private readonly entries = new Map<ShutdownObligation, ObligationState>();
  private readonly options: ShutdownSettlementLedgerOptions;
  private deadline: number;

  constructor(options: ShutdownSettlementLedgerOptions) {
    this.options = options;
    this.deadline = options.time.now() + options.budgetMs;
  }

  private register(obligation: ShutdownObligation): void {
    if (!this.entries.has(obligation)) this.entries.set(obligation, { kind: 'pending' });
  }

  private remainingBudget = (): number => Math.max(0, this.deadline - this.options.time.now());

  remainingBudgetMs(): number {
    return this.remainingBudget();
  }

  isDischarged(obligation: ShutdownObligation): boolean {
    const state = this.entries.get(obligation);
    return state?.kind === 'settled' && state.settlement.kind === 'discharged';
  }

  async run(obligation: ShutdownObligation): Promise<StepSettlement> {
    this.register(obligation);
    const prior = this.entries.get(obligation);
    if (prior?.kind === 'settled' && prior.settlement.kind === 'discharged') return prior.settlement;
    const settlement = await settleStep(obligation, this.remainingBudget, this.options.time, this.options.log);
    this.entries.set(obligation, { kind: 'settled', settlement });
    return settlement;
  }

  private runWithBudget(obligation: ShutdownObligation, budgetMs: number): Promise<StepSettlement> {
    this.deadline = this.options.time.now() + budgetMs;
    return this.run(obligation);
  }

  private declinedEntries(): readonly DeclinedObligation[] {
    return [...this.entries].flatMap(([obligation, state]) =>
      state.kind === 'settled' && state.settlement.kind === 'declined'
        ? [{ obligation, settlement: state.settlement }]
        : [],
    );
  }

  private acceptProcessExitRemainder(declined: readonly DeclinedObligation[]): AcceptedProcessExitRemainder | null {
    const accept = this.options.acceptProcessExitRemainder;
    if (accept === undefined) return null;
    const deferredFailures = declined.map(({ obligation, settlement }) =>
      declinedFailure(obligation.label, settlement),
    );
    const remainder: ProcessExitRemainder = { owner: 'process-exit', deferredFailures };
    try {
      const acceptance = accept(remainder);
      if (acceptance.kind === 'accepted') {
        if (acceptance.remainder === remainder) return acceptance;
        this.options.log('process-exit remainder acceptance did not identify the offered remainder\n');
        return null;
      }
      this.options.log(`process-exit remainder acceptance refused: ${acceptance.detail}\n`);
    } catch (error: unknown) {
      this.options.log(`process-exit remainder acceptance failed: ${formatError(error)}\n`);
    }
    return null;
  }

  private boundaryObligation(
    boundary: ShutdownAuthorityReleaseBoundary,
    task: (signal: AbortSignal) => Promise<ShutdownStepConfirmation>,
  ): ShutdownObligation {
    return {
      label: boundary.label,
      task,
      retainedAuthority: boundary.retainedAuthority,
      remainder: { owner: 'none' },
      ...(boundary.hold === undefined ? {} : { hold: boundary.hold }),
    };
  }

  private async prepareBoundary(
    boundary: ShutdownAuthorityReleaseBoundary,
    budgetMs: number | null,
  ): Promise<BoundaryPreparationAttempt> {
    let token: object | null = null;
    const preparation = this.boundaryObligation(boundary, async (signal) => {
      const result = await boundary.prepare(signal);
      if (!result.confirmed) return result;
      token = result.token;
      return { confirmed: true };
    });
    if (budgetMs !== null) this.deadline = this.options.time.now() + budgetMs;
    const settlement = await settleStep(preparation, this.remainingBudget, this.options.time, this.options.log);
    if (settlement.kind === 'declined') return { kind: 'declined', settlement };
    if (token === null) throw new Error('authority preparation discharged without a token');
    return { kind: 'prepared', settlement, token };
  }

  private async commitBoundary(
    boundary: ShutdownAuthorityReleaseBoundary,
    token: object,
    budgetMs: number | null,
  ): Promise<StepSettlement> {
    const commit = this.boundaryObligation(boundary, (signal) => boundary.commit(token, signal));
    if (budgetMs !== null) this.deadline = this.options.time.now() + budgetMs;
    return settleStep(commit, this.remainingBudget, this.options.time, this.options.log);
  }

  private retainedAuthority(
    boundary: ShutdownAuthorityReleaseBoundary,
    processExitAccepted: boolean,
  ): ShutdownRetainedAuthority {
    const entries = [...this.entries]
      .filter(([obligation]) => !processExitAccepted || obligation.remainder.owner !== 'process-exit')
      .map(([obligation, state]) => ({ obligation, state }));
    return foldRetainedAuthority(entries, [boundary.retainedAuthority()]);
  }

  private async retryAcceptedTransfer(
    boundary: ShutdownAuthorityReleaseBoundary,
    acceptance: AcceptedProcessExitRemainder,
  ): Promise<ShutdownSequenceDisposition> {
    const attemptBudgetMs = Math.max(1, Math.floor(this.options.budgetMs / 2));
    const preparation = await this.prepareBoundary(boundary, attemptBudgetMs);
    if (preparation.kind === 'declined') {
      return this.gate(boundary, {
        kind: 'transfer-pending',
        acceptance,
        failure: preparation.settlement,
      });
    }
    const commit = await this.commitBoundary(boundary, preparation.token, attemptBudgetMs);
    return commit.kind === 'discharged'
      ? this.gate(boundary, { kind: 'committed', acceptance })
      : this.gate(boundary, { kind: 'transfer-pending', acceptance, failure: commit });
  }

  private async retryDeclined(boundary: ShutdownAuthorityReleaseBoundary): Promise<ShutdownSequenceDisposition> {
    const declined = this.declinedEntries();
    const blocking = declined.filter(({ obligation }) => obligation.remainder.owner === 'none');
    const processExit = declined.filter(({ obligation }) => obligation.remainder.owner === 'process-exit');
    const successorRecovery = declined.filter(({ obligation }) => obligation.remainder.owner === 'successor-recovery');
    const attemptCount = blocking.length + processExit.length + successorRecovery.length + 2;
    const attemptBudgetMs = Math.max(1, Math.floor(this.options.budgetMs / attemptCount));

    for (const { obligation } of blocking) await this.runWithBudget(obligation, attemptBudgetMs);
    const preparation = await this.prepareBoundary(boundary, attemptBudgetMs);
    for (const { obligation } of processExit) await this.runWithBudget(obligation, attemptBudgetMs);
    for (const { obligation } of successorRecovery) await this.runWithBudget(obligation, attemptBudgetMs);

    const authorityBlocked = this.declinedEntries().some(
      ({ obligation }) => obligation.remainder.owner !== 'process-exit',
    );
    if (authorityBlocked) return this.gate(boundary, { kind: 'held', boundaryFailure: null });
    if (preparation.kind === 'declined') {
      return this.gate(boundary, { kind: 'held', boundaryFailure: preparation.settlement });
    }

    const remainingProcessExit = this.declinedEntries().filter(
      ({ obligation }) => obligation.remainder.owner === 'process-exit',
    );
    const processExitAcceptance =
      remainingProcessExit.length === 0 ? null : this.acceptProcessExitRemainder(remainingProcessExit);
    if (remainingProcessExit.length > 0 && processExitAcceptance === null) {
      return this.gate(boundary, { kind: 'held', boundaryFailure: null });
    }

    const commit = await this.commitBoundary(boundary, preparation.token, attemptBudgetMs);
    if (commit.kind === 'declined') {
      return processExitAcceptance === null
        ? this.gate(boundary, {
            kind: 'held',
            boundaryFailure: commit,
            retry: () => this.retryCleanTransfer(boundary),
          })
        : this.gate(boundary, {
            kind: 'transfer-pending',
            acceptance: processExitAcceptance,
            failure: commit,
          });
    }
    return this.gate(boundary, { kind: 'committed', acceptance: processExitAcceptance });
  }

  private async retryCleanTransfer(boundary: ShutdownAuthorityReleaseBoundary): Promise<ShutdownSequenceDisposition> {
    const attemptBudgetMs = Math.max(1, Math.floor(this.options.budgetMs / 2));
    const preparation = await this.prepareBoundary(boundary, attemptBudgetMs);
    if (preparation.kind === 'declined') {
      return this.gate(boundary, {
        kind: 'held',
        boundaryFailure: preparation.settlement,
        retry: () => this.retryCleanTransfer(boundary),
      });
    }
    const commit = await this.commitBoundary(boundary, preparation.token, attemptBudgetMs);
    return commit.kind === 'discharged'
      ? this.gate(boundary, { kind: 'committed', acceptance: null })
      : this.gate(boundary, {
          kind: 'held',
          boundaryFailure: commit,
          retry: () => this.retryCleanTransfer(boundary),
        });
  }

  async gate(
    boundary: ShutdownAuthorityReleaseBoundary,
    resolution: GateResolution = { kind: 'initial' },
  ): Promise<ShutdownSequenceDisposition> {
    if (resolution.kind === 'held') {
      const declined = this.declinedEntries();
      const primary =
        declined.find(({ obligation }) => obligation.remainder.owner === 'none') ??
        declined.find(({ obligation }) => obligation.remainder.owner === 'successor-recovery') ??
        declined[0];
      const hold =
        primary === undefined && resolution.boundaryFailure !== null
          ? (boundary.hold?.(resolution.boundaryFailure) ?? defaultHold())
          : (primary?.obligation.hold?.(primary.settlement) ?? defaultHold());
      return {
        disposition: 'held',
        reason: hold.reason,
        exit: hold.exit,
        retryAfter: hold.retryAfter ?? this.options.time.sleep(this.options.pollMs),
        deferredFailures: [
          ...declined.map(({ obligation, settlement }) => declinedFailure(obligation.label, settlement)),
          ...(resolution.boundaryFailure === null ? [] : [declinedFailure(boundary.label, resolution.boundaryFailure)]),
        ],
        retainedAuthority: this.retainedAuthority(boundary, false),
        retry: resolution.retry ?? (() => this.retryDeclined(boundary)),
      };
    }
    if (resolution.kind === 'committed') {
      return resolution.acceptance === null
        ? { disposition: 'settled' }
        : {
            disposition: 'delegated',
            owner: 'process-exit',
            deferredFailures: resolution.acceptance.remainder.deferredFailures,
            acceptance: resolution.acceptance,
          };
    }
    if (resolution.kind === 'transfer-pending') {
      const hold = boundary.hold?.(resolution.failure) ?? defaultHold();
      return {
        disposition: 'transfer-pending',
        owner: 'process-exit',
        reason: hold.reason,
        exit: hold.exit,
        retryAfter: hold.retryAfter ?? this.options.time.sleep(this.options.pollMs),
        deferredFailures: resolution.acceptance.remainder.deferredFailures,
        acceptance: resolution.acceptance,
        boundaryFailure: declinedFailure(boundary.label, resolution.failure),
        retainedAuthority: this.retainedAuthority(boundary, true),
        retry: () => this.retryAcceptedTransfer(boundary, resolution.acceptance),
      };
    }

    const authorityBlocked = this.declinedEntries().some(
      ({ obligation }) => obligation.remainder.owner !== 'process-exit',
    );
    if (authorityBlocked) return this.gate(boundary, { kind: 'held', boundaryFailure: null });

    const preparation = await this.prepareBoundary(boundary, null);
    if (preparation.kind === 'declined') {
      return this.gate(boundary, { kind: 'held', boundaryFailure: preparation.settlement });
    }

    const processExit = this.declinedEntries().filter(
      ({ obligation }) => obligation.remainder.owner === 'process-exit',
    );
    const processExitAcceptance = processExit.length === 0 ? null : this.acceptProcessExitRemainder(processExit);
    if (processExit.length > 0 && processExitAcceptance === null) {
      return this.gate(boundary, { kind: 'held', boundaryFailure: null });
    }

    const commit = await this.commitBoundary(boundary, preparation.token, null);
    if (commit.kind === 'declined') {
      return processExitAcceptance === null
        ? this.gate(boundary, {
            kind: 'held',
            boundaryFailure: commit,
            retry: () => this.retryCleanTransfer(boundary),
          })
        : this.gate(boundary, {
            kind: 'transfer-pending',
            acceptance: processExitAcceptance,
            failure: commit,
          });
    }
    return this.gate(boundary, { kind: 'committed', acceptance: processExitAcceptance });
  }
}

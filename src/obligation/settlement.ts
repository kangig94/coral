import { formatError, serializeThrown, type SerializedThrown } from '../infra/error-format.js';
import type { TimePort } from '../infra/port-types.js';
import { isAbortError } from '../runtime/abort.js';

export type Settlement =
  | Readonly<{ kind: 'discharged' }>
  | Readonly<{ kind: 'declined'; cause: 'rejected' | 'aborted'; error: SerializedThrown }>
  | Readonly<{ kind: 'declined'; cause: 'timed-out'; budgetMs: number }>
  | Readonly<{ kind: 'declined'; cause: 'budget-exhausted' }>
  | Readonly<{ kind: 'declined'; cause: 'unconfirmed'; detail: string }>;

export type SettlementConfirmation = Readonly<{ confirmed: true }> | Readonly<{ confirmed: false; detail: string }>;

export type SettlementHold<Reason, Exit> = Readonly<{
  reason: Reason;
  exit: Exit;
  retryAfter?: Promise<void>;
}>;

export type SettlementObligation<Remainder, RetainedAuthorityContribution, FailureContext = never> = Readonly<{
  label: string;
  failureContext?: FailureContext;
  task: (signal: AbortSignal) => Promise<SettlementConfirmation>;
  retainedAuthority: () => RetainedAuthorityContribution;
  remainder: () => Remainder;
}>;

export type SettlementAuthorityPreparation =
  | Readonly<{ confirmed: true; token: object }>
  | Readonly<{ confirmed: false; detail: string }>;

export type SettlementAuthorityReleaseBoundary<RetainedAuthorityContribution, Reason, Exit> = Readonly<{
  label: string;
  prepare: (signal: AbortSignal) => Promise<SettlementAuthorityPreparation>;
  commit: (token: object, signal: AbortSignal) => Promise<SettlementConfirmation>;
  retainedAuthority: () => RetainedAuthorityContribution;
  hold: (settlement: Extract<Settlement, { kind: 'declined' }>) => SettlementHold<Reason, Exit>;
}>;

export type SettledSettlementDisposition = Readonly<{ disposition: 'settled' }>;

export type DelegatedSettlementDisposition<Failure, Acceptance> = Readonly<{
  disposition: 'delegated';
  undischarged: readonly Failure[];
  acceptance: Acceptance;
}>;

export type UnacceptedSettlementDisposition<Failure> = Readonly<{
  disposition: 'unaccepted';
  undischarged: readonly Failure[];
}>;

export interface HeldSettlementDisposition<Reason, Exit, Failure, RetainedAuthority, Disposition> {
  readonly disposition: 'held';
  readonly reason: Reason;
  readonly exit: Exit;
  readonly retryAfter: Promise<void>;
  readonly undischarged: readonly Failure[];
  readonly retainedAuthority: RetainedAuthority;
  readonly attemptsStarted: number;
  readonly attemptLimit: number;
  readonly retry: () => Promise<Disposition>;
}

export type SettlementDisposition<Reason, Exit, Failure, RetainedAuthority, Acceptance> =
  | SettledSettlementDisposition
  | DelegatedSettlementDisposition<Failure, Acceptance>
  | UnacceptedSettlementDisposition<Failure>
  | HeldSettlementDisposition<
      Reason,
      Exit,
      Failure,
      RetainedAuthority,
      SettlementDisposition<Reason, Exit, Failure, RetainedAuthority, Acceptance>
    >;

export type SettlementLedgerSnapshot<Reason, Exit, Failure, RetainedAuthority> = Readonly<{
  elapsedMs: number;
  boundMs: number;
  attempt: Readonly<{ started: number; limit: number }>;
  lastDeclined?: Readonly<{
    attempt: number;
    reason: Reason;
    exit: Exit;
    undischarged: readonly Failure[];
    retainedAuthority: RetainedAuthority;
  }>;
}>;

export class SettlementGate<
  Reason,
  Exit,
  Failure,
  RetainedAuthority,
  Acceptance,
  Disposition = SettlementDisposition<Reason, Exit, Failure, RetainedAuthority, Acceptance>,
> {
  settled(): SettledSettlementDisposition {
    return { disposition: 'settled' };
  }

  delegated(
    value: Omit<DelegatedSettlementDisposition<Failure, Acceptance>, 'disposition'>,
  ): DelegatedSettlementDisposition<Failure, Acceptance> {
    return { disposition: 'delegated', ...value };
  }

  unaccepted(
    value: Omit<UnacceptedSettlementDisposition<Failure>, 'disposition'>,
  ): UnacceptedSettlementDisposition<Failure> {
    return { disposition: 'unaccepted', ...value };
  }

  held(
    value: Omit<HeldSettlementDisposition<Reason, Exit, Failure, RetainedAuthority, Disposition>, 'disposition'>,
  ): HeldSettlementDisposition<Reason, Exit, Failure, RetainedAuthority, Disposition> {
    return { disposition: 'held', ...value };
  }
}

export type DeclinedSettlementObligation<Remainder, RetainedAuthorityContribution, FailureContext = never> = Readonly<{
  obligation: SettlementObligation<Remainder, RetainedAuthorityContribution, FailureContext>;
  settlement: Extract<Settlement, { kind: 'declined' }>;
}>;

type ObligationState = Readonly<{ kind: 'pending' }> | Readonly<{ kind: 'settled'; settlement: Settlement }>;

type SettlementAttempt<T> = Readonly<{
  abort: AbortController;
  outcome: Promise<T>;
}>;

type BoundaryAttemptState =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{ kind: 'preparing'; attempt: SettlementAttempt<SettlementAuthorityPreparation> }>
  | Readonly<{ kind: 'prepared'; token: object }>
  | Readonly<{ kind: 'committing'; token: object; attempt: SettlementAttempt<SettlementConfirmation> }>;

type BoundaryPreparationAttempt =
  | Readonly<{ kind: 'prepared'; settlement: Extract<Settlement, { kind: 'discharged' }>; token: object }>
  | Readonly<{ kind: 'declined'; settlement: Extract<Settlement, { kind: 'declined' }> }>;

type RemainderAcceptanceState<Acceptance, Failure> =
  | Readonly<{ kind: 'unattempted' }>
  | Readonly<{ kind: 'accepted'; acceptance: Acceptance }>
  | Readonly<{ kind: 'failed'; failure: Failure }>;

export const BOUNDARY_TRANSFER_ATTEMPT_LIMIT = 3;

type GateResolution =
  | Readonly<{ kind: 'held'; boundaryFailure: Extract<Settlement, { kind: 'declined' }> }>
  | Readonly<{ kind: 'terminal'; boundaryFailure: Extract<Settlement, { kind: 'declined' }> | null }>;

export type SettlementLedgerOptions<
  Remainder,
  RetainedAuthorityContribution,
  RetainedAuthority,
  Acceptance,
  Failure,
  FailureContext = never,
> = Readonly<{
  budgetMs: number;
  time: Pick<TimePort, 'monotonicNow' | 'sleep'>;
  log: (message: string) => void;
  pollMs: number;
  boundaryRemainder: Remainder;
  acceptDelegatedRemainder?: (undischarged: readonly Failure[]) => Acceptance | null;
  acceptedUndischarged: (acceptance: Acceptance) => readonly Failure[];
  acceptanceFailureLabel: string;
  failure: (
    label: string,
    remainder: Remainder,
    settlement: Extract<Settlement, { kind: 'declined' }>,
    context?: FailureContext,
  ) => Failure;
  foldRetainedAuthority: (contributions: readonly RetainedAuthorityContribution[]) => RetainedAuthority;
}>;

type JoinableOutcome<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: unknown }>;

export type JoinableSettlementTask<T> = Readonly<{
  start(): void;
  run(): Promise<T>;
}>;

/** A retry may start a new attempt only after the preceding attempt has settled. */
export function createJoinableSettlementTask<T>(task: () => T | Promise<T>): JoinableSettlementTask<T> {
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
  };
}

function startSettlementAttempt<T>(task: (signal: AbortSignal) => Promise<T>): SettlementAttempt<T> {
  const abort = new AbortController();
  return {
    abort,
    outcome: Promise.resolve().then(() => task(abort.signal)),
  };
}

type AttemptSettlement<T> =
  | Readonly<{ settlement: Settlement; kind: 'completed'; value?: T }>
  | Readonly<{
      settlement: Extract<Settlement, { kind: 'declined' }> & Readonly<{ cause: 'timed-out' }>;
      kind: 'in-flight';
    }>;

async function settleAttempt<T>(
  label: string,
  attempt: SettlementAttempt<T>,
  confirmation: (value: T) => SettlementConfirmation,
  remainingBudget: () => number,
  time: Pick<TimePort, 'sleep'>,
  log: (message: string) => void,
): Promise<AttemptSettlement<T>> {
  const budget = remainingBudget();
  if (budget <= 0) {
    const settlement = {
      kind: 'declined',
      cause: 'budget-exhausted',
    } as const;
    log(`${label}: skipped (drain budget exhausted)\n`);
    return { kind: 'completed', settlement };
  }

  const timedOut = Symbol('timedOut');
  const timeoutAbort = new AbortController();
  try {
    const result = await Promise.race<T | typeof timedOut>([
      attempt.outcome,
      time.sleep(budget, { signal: timeoutAbort.signal }).then(() => timedOut),
    ]);
    if (result === timedOut) {
      attempt.abort.abort();
      const settlement = {
        kind: 'declined',
        cause: 'timed-out',
        budgetMs: budget,
      } as const;
      log(`${label}: exceeded drain budget after ${budget}ms\n`);
      return { kind: 'in-flight', settlement };
    }
    const confirmed = confirmation(result);
    if (!confirmed.confirmed) {
      const settlement = { kind: 'declined', cause: 'unconfirmed', detail: confirmed.detail } as const;
      log(`${label} settlement unconfirmed: ${confirmed.detail}\n`);
      return { kind: 'completed', settlement, value: result };
    }
    return { kind: 'completed', settlement: { kind: 'discharged' }, value: result };
  } catch (error: unknown) {
    const settlement = {
      kind: 'declined',
      cause: isAbortError(error) ? 'aborted' : 'rejected',
      error: serializeThrown(error),
    } as const;
    log(`${label} settlement failed: ${formatError(error)}\n`);
    return { kind: 'completed', settlement };
  } finally {
    timeoutAbort.abort();
  }
}

/** Boundary exhaustion must terminate without rerunning registered obligations. */
export class SettlementLedger<
  Remainder,
  RetainedAuthorityContribution,
  RetainedAuthority,
  Reason,
  Exit,
  Acceptance,
  Failure,
  FailureContext = never,
> {
  private readonly dispositions = new SettlementGate<Reason, Exit, Failure, RetainedAuthority, Acceptance>();
  private readonly entries = new Map<
    SettlementObligation<Remainder, RetainedAuthorityContribution, FailureContext>,
    ObligationState
  >();
  private readonly obligationAttempts = new Map<
    SettlementObligation<Remainder, RetainedAuthorityContribution, FailureContext>,
    SettlementAttempt<SettlementConfirmation>
  >();
  private readonly boundaryAttempts = new WeakMap<
    SettlementAuthorityReleaseBoundary<RetainedAuthorityContribution, Reason, Exit>,
    BoundaryAttemptState
  >();
  private readonly boundaryTransferAttemptsStarted = new WeakMap<
    SettlementAuthorityReleaseBoundary<RetainedAuthorityContribution, Reason, Exit>,
    number
  >();
  private latestBoundaryTransferAttemptsStarted = 0;
  private readonly options: SettlementLedgerOptions<
    Remainder,
    RetainedAuthorityContribution,
    RetainedAuthority,
    Acceptance,
    Failure,
    FailureContext
  >;
  private readonly startedMonotonicMs: bigint;
  private readonly initialDeadlineMonotonicMs: bigint;
  private deadlineMonotonicMs: bigint;
  private terminalDeadlineMonotonicMs: bigint;
  private retrySlotDeadlines: readonly bigint[] | null = null;
  private terminalReachedMonotonicMs: bigint | null = null;
  private lastDeclined:
    | NonNullable<SettlementLedgerSnapshot<Reason, Exit, Failure, RetainedAuthority>['lastDeclined']>
    | undefined;
  private remainderAcceptance: RemainderAcceptanceState<Acceptance, Failure> = { kind: 'unattempted' };

  constructor(
    options: SettlementLedgerOptions<
      Remainder,
      RetainedAuthorityContribution,
      RetainedAuthority,
      Acceptance,
      Failure,
      FailureContext
    >,
  ) {
    this.options = options;
    this.startedMonotonicMs = options.time.monotonicNow();
    this.initialDeadlineMonotonicMs = this.startedMonotonicMs + BigInt(options.budgetMs);
    this.deadlineMonotonicMs = this.initialDeadlineMonotonicMs;
    this.terminalDeadlineMonotonicMs =
      this.initialDeadlineMonotonicMs + BigInt((BOUNDARY_TRANSFER_ATTEMPT_LIMIT - 1) * this.boundaryRetryBudgetMs());
  }

  private register(obligation: SettlementObligation<Remainder, RetainedAuthorityContribution, FailureContext>): void {
    if (!this.entries.has(obligation)) this.entries.set(obligation, { kind: 'pending' });
  }

  private remainingBudgetUntil(deadlineMonotonicMs: bigint): number {
    return Math.max(0, Number(deadlineMonotonicMs - this.options.time.monotonicNow()));
  }

  private remainingBudget = (): number => this.remainingBudgetUntil(this.deadlineMonotonicMs);

  remainingBudgetMs(): number {
    return this.remainingBudget();
  }

  snapshot(): SettlementLedgerSnapshot<Reason, Exit, Failure, RetainedAuthority> {
    const now = this.terminalReachedMonotonicMs ?? this.options.time.monotonicNow();
    return {
      elapsedMs: Math.max(0, Number(now - this.startedMonotonicMs)),
      boundMs:
        this.terminalReachedMonotonicMs === null ? Math.max(0, Number(this.terminalDeadlineMonotonicMs - now)) : 0,
      attempt: {
        started: this.latestBoundaryTransferAttemptsStarted,
        limit: BOUNDARY_TRANSFER_ATTEMPT_LIMIT,
      },
      ...(this.lastDeclined === undefined ? {} : { lastDeclined: this.lastDeclined }),
    };
  }

  private boundaryRetryBudgetMs(): number {
    return Math.max(1, Math.floor(this.options.budgetMs / 2));
  }

  private createRetrySchedule(): void {
    if (this.retrySlotDeadlines !== null) return;
    const firstHeldAt = this.options.time.monotonicNow();
    const retryBudgetMs = this.boundaryRetryBudgetMs();
    this.retrySlotDeadlines = Array.from(
      { length: BOUNDARY_TRANSFER_ATTEMPT_LIMIT - 1 },
      (_, index) => firstHeldAt + BigInt((index + 1) * retryBudgetMs),
    );
    const terminalDeadline = this.retrySlotDeadlines[this.retrySlotDeadlines.length - 1];
    if (terminalDeadline !== undefined) this.terminalDeadlineMonotonicMs = terminalDeadline;
  }

  private waitForRetrySlot(boundaryRetryAfter: Promise<void> | undefined, attemptsStarted: number): Promise<void> {
    const slotDeadline = this.retrySlotDeadlines?.[attemptsStarted - 1];
    if (slotDeadline === undefined) throw new Error('boundary hold has no remaining retry slot');
    const remainingToSlot = Number(slotDeadline - this.options.time.monotonicNow());
    const slot = remainingToSlot <= 0 ? Promise.resolve() : this.options.time.sleep(remainingToSlot);
    return Promise.race([boundaryRetryAfter ?? this.options.time.sleep(this.options.pollMs), slot]);
  }

  isDischarged(obligation: SettlementObligation<Remainder, RetainedAuthorityContribution, FailureContext>): boolean {
    const state = this.entries.get(obligation);
    return state?.kind === 'settled' && state.settlement.kind === 'discharged';
  }

  async run(
    obligation: SettlementObligation<Remainder, RetainedAuthorityContribution, FailureContext>,
  ): Promise<Settlement> {
    this.register(obligation);
    const prior = this.entries.get(obligation);
    if (prior?.kind === 'settled') return prior.settlement;
    if (this.remainingBudget() <= 0) {
      const settlement = {
        kind: 'declined',
        cause: 'budget-exhausted',
      } as const;
      this.options.log(`${obligation.label}: skipped (drain budget exhausted)\n`);
      this.entries.set(obligation, { kind: 'settled', settlement });
      return settlement;
    }
    let attempt = this.obligationAttempts.get(obligation);
    if (attempt === undefined) {
      attempt = startSettlementAttempt(obligation.task);
      this.obligationAttempts.set(obligation, attempt);
      const trackedAttempt = attempt;
      void trackedAttempt.outcome.then(
        (confirmation) => {
          if (this.obligationAttempts.get(obligation) !== trackedAttempt) return;
          this.obligationAttempts.delete(obligation);
          this.entries.set(obligation, {
            kind: 'settled',
            settlement: confirmation.confirmed
              ? { kind: 'discharged' }
              : { kind: 'declined', cause: 'unconfirmed', detail: confirmation.detail },
          });
        },
        (error: unknown) => {
          if (this.obligationAttempts.get(obligation) !== trackedAttempt) return;
          this.obligationAttempts.delete(obligation);
          this.entries.set(obligation, {
            kind: 'settled',
            settlement: {
              kind: 'declined',
              cause: isAbortError(error) ? 'aborted' : 'rejected',
              error: serializeThrown(error),
            },
          });
        },
      );
    }
    const result = await settleAttempt(
      obligation.label,
      attempt,
      (confirmation) => confirmation,
      this.remainingBudget,
      this.options.time,
      this.options.log,
    );
    if (result.kind === 'in-flight' && this.obligationAttempts.get(obligation) !== attempt) {
      const settled = this.entries.get(obligation);
      if (settled?.kind === 'settled') return settled.settlement;
    }
    this.entries.set(obligation, { kind: 'settled', settlement: result.settlement });
    return result.settlement;
  }

  private declinedEntries(): readonly DeclinedSettlementObligation<
    Remainder,
    RetainedAuthorityContribution,
    FailureContext
  >[] {
    return [...this.entries].flatMap(([obligation, state]) =>
      state.kind === 'settled' && state.settlement.kind === 'declined'
        ? [{ obligation, settlement: state.settlement }]
        : [],
    );
  }

  private acceptDelegatedRemainder(undischarged: readonly Failure[]): Acceptance | null {
    return this.options.acceptDelegatedRemainder?.(undischarged) ?? null;
  }

  private async prepareBoundary(
    boundary: SettlementAuthorityReleaseBoundary<RetainedAuthorityContribution, Reason, Exit>,
    attemptDeadlineMonotonicMs: bigint,
  ): Promise<BoundaryPreparationAttempt> {
    const state = this.boundaryAttempts.get(boundary) ?? { kind: 'idle' };
    if (state.kind === 'prepared' || state.kind === 'committing') {
      return { kind: 'prepared', settlement: { kind: 'discharged' }, token: state.token };
    }
    if (this.remainingBudgetUntil(attemptDeadlineMonotonicMs) <= 0) {
      const settlement = {
        kind: 'declined',
        cause: 'budget-exhausted',
      } as const;
      this.options.log(`${boundary.label}: skipped (drain budget exhausted)\n`);
      return { kind: 'declined', settlement };
    }
    const attempt = state.kind === 'preparing' ? state.attempt : startSettlementAttempt(boundary.prepare);
    this.boundaryAttempts.set(boundary, { kind: 'preparing', attempt });
    const result = await settleAttempt(
      boundary.label,
      attempt,
      (preparation) => (preparation.confirmed ? { confirmed: true } : { confirmed: false, detail: preparation.detail }),
      () => this.remainingBudgetUntil(attemptDeadlineMonotonicMs),
      this.options.time,
      this.options.log,
    );
    if (result.kind === 'in-flight') return { kind: 'declined', settlement: result.settlement };
    if (result.settlement.kind === 'declined') {
      if (this.boundaryAttempts.get(boundary)?.kind === 'preparing') {
        this.boundaryAttempts.set(boundary, { kind: 'idle' });
      }
      return { kind: 'declined', settlement: result.settlement };
    }
    if (result.value === undefined || !result.value.confirmed) {
      throw new Error('authority preparation discharged without a token');
    }
    this.boundaryAttempts.set(boundary, { kind: 'prepared', token: result.value.token });
    return { kind: 'prepared', settlement: result.settlement, token: result.value.token };
  }

  private async commitBoundary(
    boundary: SettlementAuthorityReleaseBoundary<RetainedAuthorityContribution, Reason, Exit>,
    token: object,
    attemptDeadlineMonotonicMs: bigint,
  ): Promise<Settlement> {
    if (this.remainingBudgetUntil(attemptDeadlineMonotonicMs) <= 0) {
      const settlement = {
        kind: 'declined',
        cause: 'budget-exhausted',
      } as const;
      this.options.log(`${boundary.label}: skipped (drain budget exhausted)\n`);
      return settlement;
    }
    const state = this.boundaryAttempts.get(boundary) ?? { kind: 'idle' };
    const commitToken = state.kind === 'committing' ? state.token : token;
    const attempt =
      state.kind === 'committing'
        ? state.attempt
        : startSettlementAttempt((signal) => boundary.commit(commitToken, signal));
    this.boundaryAttempts.set(boundary, { kind: 'committing', token: commitToken, attempt });
    const result = await settleAttempt(
      boundary.label,
      attempt,
      (confirmation) => confirmation,
      () => this.remainingBudgetUntil(attemptDeadlineMonotonicMs),
      this.options.time,
      this.options.log,
    );
    if (result.kind === 'completed' && this.boundaryAttempts.get(boundary)?.kind === 'committing') {
      this.boundaryAttempts.set(boundary, { kind: 'idle' });
    }
    return result.settlement;
  }

  private retainedAuthority(
    boundary: SettlementAuthorityReleaseBoundary<RetainedAuthorityContribution, Reason, Exit>,
  ): RetainedAuthority {
    const contributions = [...this.entries]
      .filter(([, state]) => state.kind !== 'settled' || state.settlement.kind !== 'discharged')
      .map(([obligation]) => obligation.retainedAuthority());
    return this.options.foldRetainedAuthority([...contributions, boundary.retainedAuthority()]);
  }

  private verifyRemainderAcceptance(undischarged: readonly Failure[]): void {
    if (this.remainderAcceptance.kind !== 'unattempted') return;
    if (this.options.acceptDelegatedRemainder === undefined && undischarged.length === 0) return;
    const acceptance = this.acceptDelegatedRemainder(undischarged);
    if (acceptance !== null) {
      this.remainderAcceptance = { kind: 'accepted', acceptance };
      return;
    }
    this.remainderAcceptance = {
      kind: 'failed',
      failure: this.options.failure(this.options.acceptanceFailureLabel, this.options.boundaryRemainder, {
        kind: 'declined',
        cause: 'unconfirmed',
        detail: 'process-exit remainder acceptance was not verified',
      }),
    };
  }

  private acceptedRemainder(): Acceptance | null {
    return this.remainderAcceptance.kind === 'accepted' ? this.remainderAcceptance.acceptance : null;
  }

  private namedLosses(
    boundary: SettlementAuthorityReleaseBoundary<RetainedAuthorityContribution, Reason, Exit>,
    boundaryFailure: Extract<Settlement, { kind: 'declined' }> | null,
  ): readonly Failure[] {
    const offered = [
      ...this.declinedEntries().map(({ obligation, settlement }) =>
        this.options.failure(obligation.label, obligation.remainder(), settlement, obligation.failureContext),
      ),
      ...(boundaryFailure === null
        ? []
        : [this.options.failure(boundary.label, this.options.boundaryRemainder, boundaryFailure)]),
    ];
    const accepted =
      this.remainderAcceptance.kind === 'accepted'
        ? this.options.acceptedUndischarged(this.remainderAcceptance.acceptance)
        : offered;
    return [...accepted, ...(this.remainderAcceptance.kind === 'failed' ? [this.remainderAcceptance.failure] : [])];
  }

  private async attemptBoundaryTransfer(
    boundary: SettlementAuthorityReleaseBoundary<RetainedAuthorityContribution, Reason, Exit>,
    attemptDeadlineMonotonicMs: bigint,
  ): Promise<SettlementDisposition<Reason, Exit, Failure, RetainedAuthority, Acceptance>> {
    this.deadlineMonotonicMs = attemptDeadlineMonotonicMs;
    const attemptsStarted = (this.boundaryTransferAttemptsStarted.get(boundary) ?? 0) + 1;
    this.boundaryTransferAttemptsStarted.set(boundary, attemptsStarted);
    this.latestBoundaryTransferAttemptsStarted = attemptsStarted;
    this.remainderAcceptance = { kind: 'unattempted' };

    const preparation = await this.prepareBoundary(boundary, attemptDeadlineMonotonicMs);
    if (preparation.kind === 'declined') {
      return this.resolve(boundary, { kind: 'held', boundaryFailure: preparation.settlement });
    }

    const commit = await this.commitBoundary(boundary, preparation.token, attemptDeadlineMonotonicMs);
    return commit.kind === 'discharged'
      ? this.resolve(boundary, { kind: 'terminal', boundaryFailure: null })
      : this.declinedTransfer(boundary, commit);
  }

  private declinedTransfer(
    boundary: SettlementAuthorityReleaseBoundary<RetainedAuthorityContribution, Reason, Exit>,
    failure: Extract<Settlement, { kind: 'declined' }>,
  ): SettlementDisposition<Reason, Exit, Failure, RetainedAuthority, Acceptance> {
    return this.resolve(boundary, { kind: 'held', boundaryFailure: failure });
  }

  private retryBoundaryTransfer(
    boundary: SettlementAuthorityReleaseBoundary<RetainedAuthorityContribution, Reason, Exit>,
  ): Promise<SettlementDisposition<Reason, Exit, Failure, RetainedAuthority, Acceptance>> {
    const attemptsStarted = this.boundaryTransferAttemptsStarted.get(boundary) ?? 0;
    const retryDeadline = this.retrySlotDeadlines?.[attemptsStarted - 1];
    if (retryDeadline === undefined) throw new Error('boundary retry has no scheduled slot');
    return this.attemptBoundaryTransfer(boundary, retryDeadline);
  }

  private createHeldDisposition(
    boundary: SettlementAuthorityReleaseBoundary<RetainedAuthorityContribution, Reason, Exit>,
    resolution: Extract<GateResolution, { kind: 'held' }>,
  ): HeldSettlementDisposition<
    Reason,
    Exit,
    Failure,
    RetainedAuthority,
    SettlementDisposition<Reason, Exit, Failure, RetainedAuthority, Acceptance>
  > {
    this.createRetrySchedule();
    const hold = boundary.hold(resolution.boundaryFailure);
    const attemptsStarted = this.boundaryTransferAttemptsStarted.get(boundary) ?? 0;
    const undischarged = this.namedLosses(boundary, resolution.boundaryFailure);
    const retainedAuthority = this.retainedAuthority(boundary);
    this.lastDeclined = {
      attempt: attemptsStarted,
      reason: hold.reason,
      exit: hold.exit,
      undischarged,
      retainedAuthority,
    };
    return this.dispositions.held({
      reason: hold.reason,
      exit: hold.exit,
      retryAfter: this.waitForRetrySlot(hold.retryAfter, attemptsStarted),
      undischarged,
      retainedAuthority,
      attemptsStarted,
      attemptLimit: BOUNDARY_TRANSFER_ATTEMPT_LIMIT,
      retry: () => this.retryBoundaryTransfer(boundary),
    });
  }

  private resolve(
    boundary: SettlementAuthorityReleaseBoundary<RetainedAuthorityContribution, Reason, Exit>,
    resolution: GateResolution,
  ): SettlementDisposition<Reason, Exit, Failure, RetainedAuthority, Acceptance> {
    const boundaryAttemptsStarted = this.boundaryTransferAttemptsStarted.get(boundary) ?? 0;
    if (boundaryAttemptsStarted >= BOUNDARY_TRANSFER_ATTEMPT_LIMIT && resolution.kind !== 'terminal') {
      return this.resolve(boundary, { kind: 'terminal', boundaryFailure: resolution.boundaryFailure });
    }
    switch (resolution.kind) {
      case 'held':
        return this.createHeldDisposition(boundary, resolution);
      case 'terminal': {
        this.terminalReachedMonotonicMs ??= this.options.time.monotonicNow();
        const offered = this.namedLosses(boundary, resolution.boundaryFailure);
        if (offered.length === 0) return this.dispositions.settled();
        this.verifyRemainderAcceptance(offered);
        const undischarged = this.namedLosses(boundary, resolution.boundaryFailure);
        const acceptance = this.acceptedRemainder();
        return acceptance === null
          ? this.dispositions.unaccepted({ undischarged })
          : this.dispositions.delegated({ undischarged, acceptance });
      }
    }
  }

  gate(
    boundary: SettlementAuthorityReleaseBoundary<RetainedAuthorityContribution, Reason, Exit>,
  ): Promise<SettlementDisposition<Reason, Exit, Failure, RetainedAuthority, Acceptance>> {
    return this.attemptBoundaryTransfer(boundary, this.initialDeadlineMonotonicMs);
  }
}

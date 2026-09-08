import { formatError } from '../infra/error-format.js';
import type { TimePort } from '../infra/port-types.js';
import { isAbortError } from '../runtime/abort.js';

export type Settlement =
  | Readonly<{ kind: 'discharged' }>
  | Readonly<{
      kind: 'declined';
      cause: 'rejected' | 'timed-out' | 'budget-exhausted' | 'unconfirmed' | 'aborted';
      detail: string;
      error?: unknown;
    }>;

export type SettlementConfirmation = Readonly<{ confirmed: true }> | Readonly<{ confirmed: false; detail: string }>;

export type SettlementHold<Reason, Exit> = Readonly<{
  reason: Reason;
  exit: Exit;
  retryAfter?: Promise<void>;
}>;

export type SettlementObligation<Remainder, RetainedAuthorityContribution, Reason, Exit> = Readonly<{
  label: string;
  task: (signal: AbortSignal) => Promise<SettlementConfirmation>;
  retainedAuthority: () => RetainedAuthorityContribution;
  remainder: Remainder;
  hold?: (settlement: Extract<Settlement, { kind: 'declined' }>) => SettlementHold<Reason, Exit>;
}>;

export type SettlementAuthorityPreparation =
  | Readonly<{ confirmed: true; token: object }>
  | Readonly<{ confirmed: false; detail: string }>;

export type SettlementAuthorityReleaseBoundary<RetainedAuthorityContribution, Reason, Exit> = Readonly<{
  label: string;
  prepare: (signal: AbortSignal) => Promise<SettlementAuthorityPreparation>;
  commit: (token: object, signal: AbortSignal) => Promise<SettlementConfirmation>;
  retainedAuthority: () => RetainedAuthorityContribution;
  hold?: (settlement: Extract<Settlement, { kind: 'declined' }>) => SettlementHold<Reason, Exit>;
}>;

export type SettledSettlementDisposition = Readonly<{ disposition: 'settled' }>;

export type DelegatedSettlementDisposition<Owner, Failure, Acceptance> = Readonly<{
  disposition: 'delegated';
  owner: Owner;
  deferredFailures: readonly Failure[];
  acceptance: Acceptance;
}>;

export type HeldSettlementDisposition<Reason, Exit, Failure, RetainedAuthority, Disposition> = Readonly<{
  disposition: 'held';
  reason: Reason;
  exit: Exit;
  retryAfter: Promise<void>;
  deferredFailures: readonly Failure[];
  retainedAuthority: RetainedAuthority;
  retry(): Promise<Disposition>;
}>;

export type TransferPendingSettlementDisposition<
  Owner,
  Reason,
  Exit,
  Failure,
  RetainedAuthority,
  Acceptance,
  Disposition,
> = Readonly<{
  disposition: 'transfer-pending';
  owner: Owner;
  reason: Reason;
  exit: Exit;
  retryAfter: Promise<void>;
  deferredFailures: readonly Failure[];
  acceptance: Acceptance;
  boundaryFailure: Failure;
  retainedAuthority: RetainedAuthority;
  retry(): Promise<Disposition>;
}>;

export type SettlementDisposition<Owner, Reason, Exit, Failure, RetainedAuthority, Acceptance> =
  | SettledSettlementDisposition
  | DelegatedSettlementDisposition<Owner, Failure, Acceptance>
  | Readonly<{
      disposition: 'transfer-pending';
      owner: Owner;
      reason: Reason;
      exit: Exit;
      retryAfter: Promise<void>;
      deferredFailures: readonly Failure[];
      acceptance: Acceptance;
      boundaryFailure: Failure;
      retainedAuthority: RetainedAuthority;
      retry(): Promise<SettlementDisposition<Owner, Reason, Exit, Failure, RetainedAuthority, Acceptance>>;
    }>
  | Readonly<{
      disposition: 'held';
      reason: Reason;
      exit: Exit;
      retryAfter: Promise<void>;
      deferredFailures: readonly Failure[];
      retainedAuthority: RetainedAuthority;
      retry(): Promise<SettlementDisposition<Owner, Reason, Exit, Failure, RetainedAuthority, Acceptance>>;
    }>;

export class SettlementGate<
  Owner,
  Reason,
  Exit,
  Failure,
  RetainedAuthority,
  Acceptance,
  Disposition = SettlementDisposition<Owner, Reason, Exit, Failure, RetainedAuthority, Acceptance>,
> {
  settled(): SettledSettlementDisposition {
    return { disposition: 'settled' };
  }

  delegated(
    value: Omit<DelegatedSettlementDisposition<Owner, Failure, Acceptance>, 'disposition'>,
  ): DelegatedSettlementDisposition<Owner, Failure, Acceptance> {
    return { disposition: 'delegated', ...value };
  }

  held(
    value: Omit<HeldSettlementDisposition<Reason, Exit, Failure, RetainedAuthority, Disposition>, 'disposition'>,
  ): HeldSettlementDisposition<Reason, Exit, Failure, RetainedAuthority, Disposition> {
    return { disposition: 'held', ...value };
  }

  transferPending(
    value: Omit<
      TransferPendingSettlementDisposition<Owner, Reason, Exit, Failure, RetainedAuthority, Acceptance, Disposition>,
      'disposition'
    >,
  ): TransferPendingSettlementDisposition<Owner, Reason, Exit, Failure, RetainedAuthority, Acceptance, Disposition> {
    return { disposition: 'transfer-pending', ...value };
  }
}

export type RemainderSettlementRole = 'blocking' | 'delegable' | 'successor';

export type DeclinedSettlementObligation<Remainder, RetainedAuthorityContribution, Reason, Exit> = Readonly<{
  obligation: SettlementObligation<Remainder, RetainedAuthorityContribution, Reason, Exit>;
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

type GateResolution<Acceptance, Disposition> =
  | Readonly<{ kind: 'initial' }>
  | Readonly<{
      kind: 'held';
      boundaryFailure: Extract<Settlement, { kind: 'declined' }> | null;
      retry?: () => Promise<Disposition>;
    }>
  | Readonly<{ kind: 'committed'; acceptance: Acceptance | null }>
  | Readonly<{
      kind: 'transfer-pending';
      acceptance: Acceptance;
      failure: Extract<Settlement, { kind: 'declined' }>;
    }>;

export type SettlementLedgerOptions<
  Remainder,
  RetainedAuthorityContribution,
  RetainedAuthority,
  Reason,
  Exit,
  Owner,
  Acceptance,
  Failure,
> = Readonly<{
  budgetMs: number;
  time: Pick<TimePort, 'monotonicNow' | 'sleep'>;
  log: (message: string) => void;
  pollMs: number;
  remainderRole: (remainder: Remainder) => RemainderSettlementRole;
  boundaryRemainder: Remainder;
  delegatedOwner: Owner;
  acceptDelegatedRemainder?: (
    declined: readonly DeclinedSettlementObligation<Remainder, RetainedAuthorityContribution, Reason, Exit>[],
  ) => Acceptance | null;
  acceptedFailures: (acceptance: Acceptance) => readonly Failure[];
  failure: (label: string, settlement: Extract<Settlement, { kind: 'declined' }>) => Failure;
  foldRetainedAuthority: (contributions: readonly RetainedAuthorityContribution[]) => RetainedAuthority;
  defaultHold: () => SettlementHold<Reason, Exit>;
}>;

type JoinableOutcome<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: unknown }>;

export type JoinableSettlementTask<T> = Readonly<{
  start(): void;
  run(): Promise<T>;
  settlement(): Promise<void> | null;
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
    settlement: () =>
      state.kind === 'in-flight'
        ? state.outcome.then(() => undefined)
        : state.kind === 'settled'
          ? Promise.resolve()
          : null,
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
      detail: 'no drain budget remained',
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
        detail: `exceeded ${budget}ms`,
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
      detail: formatError(error),
      error,
    } as const;
    log(`${label} settlement failed: ${formatError(error)}\n`);
    return { kind: 'completed', settlement };
  } finally {
    timeoutAbort.abort();
  }
}

/** Authority release is forbidden while an obligation without an accepted successor remains declined. */
export class SettlementLedger<
  Remainder,
  RetainedAuthorityContribution,
  RetainedAuthority,
  Reason,
  Exit,
  Owner,
  Acceptance,
  Failure,
> {
  private readonly dispositions = new SettlementGate<Owner, Reason, Exit, Failure, RetainedAuthority, Acceptance>();
  private readonly entries = new Map<
    SettlementObligation<Remainder, RetainedAuthorityContribution, Reason, Exit>,
    ObligationState
  >();
  private readonly obligationAttempts = new Map<
    SettlementObligation<Remainder, RetainedAuthorityContribution, Reason, Exit>,
    SettlementAttempt<SettlementConfirmation>
  >();
  private readonly boundaryAttempts = new WeakMap<
    SettlementAuthorityReleaseBoundary<RetainedAuthorityContribution, Reason, Exit>,
    BoundaryAttemptState
  >();
  private readonly options: SettlementLedgerOptions<
    Remainder,
    RetainedAuthorityContribution,
    RetainedAuthority,
    Reason,
    Exit,
    Owner,
    Acceptance,
    Failure
  >;
  private deadlineMonotonicMs: bigint;

  constructor(
    options: SettlementLedgerOptions<
      Remainder,
      RetainedAuthorityContribution,
      RetainedAuthority,
      Reason,
      Exit,
      Owner,
      Acceptance,
      Failure
    >,
  ) {
    this.options = options;
    this.deadlineMonotonicMs = options.time.monotonicNow() + BigInt(options.budgetMs);
  }

  private register(obligation: SettlementObligation<Remainder, RetainedAuthorityContribution, Reason, Exit>): void {
    if (!this.entries.has(obligation)) this.entries.set(obligation, { kind: 'pending' });
  }

  private remainingBudget = (): number =>
    Math.max(0, Number(this.deadlineMonotonicMs - this.options.time.monotonicNow()));

  remainingBudgetMs(): number {
    return this.remainingBudget();
  }

  isDischarged(obligation: SettlementObligation<Remainder, RetainedAuthorityContribution, Reason, Exit>): boolean {
    const state = this.entries.get(obligation);
    return state?.kind === 'settled' && state.settlement.kind === 'discharged';
  }

  async run(
    obligation: SettlementObligation<Remainder, RetainedAuthorityContribution, Reason, Exit>,
  ): Promise<Settlement> {
    this.register(obligation);
    const prior = this.entries.get(obligation);
    if (prior?.kind === 'settled' && prior.settlement.kind === 'discharged') return prior.settlement;
    if (this.remainingBudget() <= 0) {
      const settlement = {
        kind: 'declined',
        cause: 'budget-exhausted',
        detail: 'no drain budget remained',
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
              detail: formatError(error),
              error,
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

  private runWithBudget(
    obligation: SettlementObligation<Remainder, RetainedAuthorityContribution, Reason, Exit>,
    budgetMs: number,
  ): Promise<Settlement> {
    this.deadlineMonotonicMs = this.options.time.monotonicNow() + BigInt(budgetMs);
    return this.run(obligation);
  }

  private declinedEntries(): readonly DeclinedSettlementObligation<
    Remainder,
    RetainedAuthorityContribution,
    Reason,
    Exit
  >[] {
    return [...this.entries].flatMap(([obligation, state]) =>
      state.kind === 'settled' && state.settlement.kind === 'declined'
        ? [{ obligation, settlement: state.settlement }]
        : [],
    );
  }

  private acceptDelegatedRemainder(
    declined: readonly DeclinedSettlementObligation<Remainder, RetainedAuthorityContribution, Reason, Exit>[],
  ): Acceptance | null {
    return this.options.acceptDelegatedRemainder?.(declined) ?? null;
  }

  private async prepareBoundary(
    boundary: SettlementAuthorityReleaseBoundary<RetainedAuthorityContribution, Reason, Exit>,
    budgetMs: number | null,
  ): Promise<BoundaryPreparationAttempt> {
    if (budgetMs !== null) {
      this.deadlineMonotonicMs = this.options.time.monotonicNow() + BigInt(budgetMs);
    }
    const state = this.boundaryAttempts.get(boundary) ?? { kind: 'idle' };
    if (state.kind === 'prepared' || state.kind === 'committing') {
      return { kind: 'prepared', settlement: { kind: 'discharged' }, token: state.token };
    }
    if (this.remainingBudget() <= 0) {
      const settlement = {
        kind: 'declined',
        cause: 'budget-exhausted',
        detail: 'no drain budget remained',
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
      this.remainingBudget,
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
    budgetMs: number | null,
  ): Promise<Settlement> {
    if (budgetMs !== null) {
      this.deadlineMonotonicMs = this.options.time.monotonicNow() + BigInt(budgetMs);
    }
    if (this.remainingBudget() <= 0) {
      const settlement = {
        kind: 'declined',
        cause: 'budget-exhausted',
        detail: 'no drain budget remained',
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
      this.remainingBudget,
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
    delegatedRemainderAccepted: boolean,
  ): RetainedAuthority {
    const contributions = [...this.entries]
      .filter(
        ([obligation, state]) =>
          (state.kind !== 'settled' || state.settlement.kind !== 'discharged') &&
          (!delegatedRemainderAccepted || this.options.remainderRole(obligation.remainder) !== 'delegable'),
      )
      .map(([obligation]) => obligation.retainedAuthority());
    return this.options.foldRetainedAuthority([...contributions, boundary.retainedAuthority()]);
  }

  private async retryAcceptedTransfer(
    boundary: SettlementAuthorityReleaseBoundary<RetainedAuthorityContribution, Reason, Exit>,
    acceptance: Acceptance,
  ): Promise<SettlementDisposition<Owner, Reason, Exit, Failure, RetainedAuthority, Acceptance>> {
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

  private async retryDeclined(
    boundary: SettlementAuthorityReleaseBoundary<RetainedAuthorityContribution, Reason, Exit>,
  ): Promise<SettlementDisposition<Owner, Reason, Exit, Failure, RetainedAuthority, Acceptance>> {
    const declined = this.declinedEntries();
    const blocking = declined.filter(
      ({ obligation }) => this.options.remainderRole(obligation.remainder) === 'blocking',
    );
    const delegable = declined.filter(
      ({ obligation }) => this.options.remainderRole(obligation.remainder) === 'delegable',
    );
    const successor = declined.filter(
      ({ obligation }) => this.options.remainderRole(obligation.remainder) === 'successor',
    );
    const attemptCount = blocking.length + delegable.length + successor.length + 2;
    const attemptBudgetMs = Math.max(1, Math.floor(this.options.budgetMs / attemptCount));

    for (const { obligation } of blocking) await this.runWithBudget(obligation, attemptBudgetMs);
    const preparation = await this.prepareBoundary(boundary, attemptBudgetMs);
    for (const { obligation } of delegable) await this.runWithBudget(obligation, attemptBudgetMs);
    for (const { obligation } of successor) await this.runWithBudget(obligation, attemptBudgetMs);

    const authorityBlocked = this.declinedEntries().some(
      ({ obligation }) => this.options.remainderRole(obligation.remainder) !== 'delegable',
    );
    if (authorityBlocked) return this.gate(boundary, { kind: 'held', boundaryFailure: null });
    if (preparation.kind === 'declined') {
      return this.gate(boundary, { kind: 'held', boundaryFailure: preparation.settlement });
    }

    const remainingDelegable = this.declinedEntries().filter(
      ({ obligation }) => this.options.remainderRole(obligation.remainder) === 'delegable',
    );
    const acceptance = remainingDelegable.length === 0 ? null : this.acceptDelegatedRemainder(remainingDelegable);
    if (remainingDelegable.length > 0 && acceptance === null) {
      return this.gate(boundary, { kind: 'held', boundaryFailure: null });
    }

    const commit = await this.commitBoundary(boundary, preparation.token, attemptBudgetMs);
    if (commit.kind === 'declined') {
      return acceptance === null
        ? this.gate(boundary, {
            kind: 'held',
            boundaryFailure: commit,
            retry: () => this.retryCleanTransfer(boundary),
          })
        : this.gate(boundary, {
            kind: 'transfer-pending',
            acceptance,
            failure: commit,
          });
    }
    return this.gate(boundary, { kind: 'committed', acceptance });
  }

  private async retryCleanTransfer(
    boundary: SettlementAuthorityReleaseBoundary<RetainedAuthorityContribution, Reason, Exit>,
  ): Promise<SettlementDisposition<Owner, Reason, Exit, Failure, RetainedAuthority, Acceptance>> {
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
    boundary: SettlementAuthorityReleaseBoundary<RetainedAuthorityContribution, Reason, Exit>,
    resolution: GateResolution<
      Acceptance,
      SettlementDisposition<Owner, Reason, Exit, Failure, RetainedAuthority, Acceptance>
    > = { kind: 'initial' },
  ): Promise<SettlementDisposition<Owner, Reason, Exit, Failure, RetainedAuthority, Acceptance>> {
    if (resolution.kind === 'held') {
      const declined = this.declinedEntries();
      const primary =
        declined.find(({ obligation }) => this.options.remainderRole(obligation.remainder) === 'blocking') ??
        declined.find(({ obligation }) => this.options.remainderRole(obligation.remainder) === 'successor') ??
        declined[0];
      const hold =
        primary === undefined && resolution.boundaryFailure !== null
          ? (boundary.hold?.(resolution.boundaryFailure) ?? this.options.defaultHold())
          : (primary?.obligation.hold?.(primary.settlement) ?? this.options.defaultHold());
      return this.dispositions.held({
        reason: hold.reason,
        exit: hold.exit,
        retryAfter: hold.retryAfter ?? this.options.time.sleep(this.options.pollMs),
        deferredFailures: [
          ...declined.map(({ obligation, settlement }) => this.options.failure(obligation.label, settlement)),
          ...(resolution.boundaryFailure === null
            ? []
            : [this.options.failure(boundary.label, resolution.boundaryFailure)]),
        ],
        retainedAuthority: this.retainedAuthority(boundary, false),
        retry: resolution.retry ?? (() => this.retryDeclined(boundary)),
      });
    }
    if (resolution.kind === 'committed') {
      return resolution.acceptance === null
        ? this.dispositions.settled()
        : this.dispositions.delegated({
            owner: this.options.delegatedOwner,
            deferredFailures: this.options.acceptedFailures(resolution.acceptance),
            acceptance: resolution.acceptance,
          });
    }
    if (resolution.kind === 'transfer-pending') {
      const hold = boundary.hold?.(resolution.failure) ?? this.options.defaultHold();
      return this.dispositions.transferPending({
        owner: this.options.delegatedOwner,
        reason: hold.reason,
        exit: hold.exit,
        retryAfter: hold.retryAfter ?? this.options.time.sleep(this.options.pollMs),
        deferredFailures: this.options.acceptedFailures(resolution.acceptance),
        acceptance: resolution.acceptance,
        boundaryFailure: this.options.failure(boundary.label, resolution.failure),
        retainedAuthority: this.retainedAuthority(boundary, true),
        retry: () => this.retryAcceptedTransfer(boundary, resolution.acceptance),
      });
    }

    const authorityBlocked = this.declinedEntries().some(
      ({ obligation }) => this.options.remainderRole(obligation.remainder) !== 'delegable',
    );
    if (authorityBlocked) return this.gate(boundary, { kind: 'held', boundaryFailure: null });

    const preparation = await this.prepareBoundary(boundary, null);
    if (preparation.kind === 'declined') {
      return this.gate(boundary, { kind: 'held', boundaryFailure: preparation.settlement });
    }

    const delegable = this.declinedEntries().filter(
      ({ obligation }) => this.options.remainderRole(obligation.remainder) === 'delegable',
    );
    const acceptance = delegable.length === 0 ? null : this.acceptDelegatedRemainder(delegable);
    if (delegable.length > 0 && acceptance === null) {
      return this.gate(boundary, { kind: 'held', boundaryFailure: null });
    }

    const commit = await this.commitBoundary(boundary, preparation.token, null);
    if (commit.kind === 'declined') {
      return acceptance === null
        ? this.gate(boundary, {
            kind: 'held',
            boundaryFailure: commit,
            retry: () => this.retryCleanTransfer(boundary),
          })
        : this.gate(boundary, {
            kind: 'transfer-pending',
            acceptance,
            failure: commit,
          });
    }
    return this.gate(boundary, { kind: 'committed', acceptance });
  }
}

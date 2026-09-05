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
  time: Pick<TimePort, 'now' | 'sleep'>;
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

async function settleObligation<Remainder, RetainedAuthorityContribution, Reason, Exit>(
  obligation: SettlementObligation<Remainder, RetainedAuthorityContribution, Reason, Exit>,
  remainingBudget: () => number,
  time: Pick<TimePort, 'sleep'>,
  log: (message: string) => void,
): Promise<Settlement> {
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
    const result = await Promise.race<SettlementConfirmation | typeof timedOut>([
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
      log(`${obligation.label} settlement unconfirmed: ${result.detail}\n`);
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
    log(`${obligation.label} settlement failed: ${formatError(error)}\n`);
    return settlement;
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
  private deadline: number;

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
    this.deadline = options.time.now() + options.budgetMs;
  }

  private register(obligation: SettlementObligation<Remainder, RetainedAuthorityContribution, Reason, Exit>): void {
    if (!this.entries.has(obligation)) this.entries.set(obligation, { kind: 'pending' });
  }

  private remainingBudget = (): number => Math.max(0, this.deadline - this.options.time.now());

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
    const settlement = await settleObligation(obligation, this.remainingBudget, this.options.time, this.options.log);
    this.entries.set(obligation, { kind: 'settled', settlement });
    return settlement;
  }

  private runWithBudget(
    obligation: SettlementObligation<Remainder, RetainedAuthorityContribution, Reason, Exit>,
    budgetMs: number,
  ): Promise<Settlement> {
    this.deadline = this.options.time.now() + budgetMs;
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

  private boundaryObligation(
    boundary: SettlementAuthorityReleaseBoundary<RetainedAuthorityContribution, Reason, Exit>,
    task: (signal: AbortSignal) => Promise<SettlementConfirmation>,
  ): SettlementObligation<Remainder, RetainedAuthorityContribution, Reason, Exit> {
    return {
      label: boundary.label,
      task,
      retainedAuthority: boundary.retainedAuthority,
      remainder: this.options.boundaryRemainder,
      ...(boundary.hold === undefined ? {} : { hold: boundary.hold }),
    };
  }

  private async prepareBoundary(
    boundary: SettlementAuthorityReleaseBoundary<RetainedAuthorityContribution, Reason, Exit>,
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
    const settlement = await settleObligation(preparation, this.remainingBudget, this.options.time, this.options.log);
    if (settlement.kind === 'declined') return { kind: 'declined', settlement };
    if (token === null) throw new Error('authority preparation discharged without a token');
    return { kind: 'prepared', settlement, token };
  }

  private async commitBoundary(
    boundary: SettlementAuthorityReleaseBoundary<RetainedAuthorityContribution, Reason, Exit>,
    token: object,
    budgetMs: number | null,
  ): Promise<Settlement> {
    const commit = this.boundaryObligation(boundary, (signal) => boundary.commit(token, signal));
    if (budgetMs !== null) this.deadline = this.options.time.now() + budgetMs;
    return settleObligation(commit, this.remainingBudget, this.options.time, this.options.log);
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

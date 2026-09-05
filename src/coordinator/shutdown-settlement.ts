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

export type ShutdownSettlementLedgerOptions = Readonly<{
  budgetMs: number;
  time: Pick<TimePort, 'now' | 'sleep'>;
  log: (message: string) => void;
  pollMs: number;
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
): ShutdownRetainedAuthority {
  const contributions = entries
    .filter(({ state }) => state.kind !== 'settled' || state.settlement.kind !== 'discharged')
    .map(({ obligation }) => obligation.retainedAuthority());
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

  private declinedEntries(): readonly Readonly<{
    obligation: ShutdownObligation;
    settlement: Extract<StepSettlement, { kind: 'declined' }>;
  }>[] {
    return [...this.entries].flatMap(([obligation, state]) =>
      state.kind === 'settled' && state.settlement.kind === 'declined'
        ? [{ obligation, settlement: state.settlement }]
        : [],
    );
  }

  private async retryDeclined(authorityRelease: ShutdownObligation): Promise<ShutdownSequenceDisposition> {
    this.deadline = this.options.time.now() + this.options.budgetMs;
    const declined = this.declinedEntries();
    for (const { obligation } of declined) await this.run(obligation);
    return this.gate(authorityRelease);
  }

  async gate(authorityRelease: ShutdownObligation): Promise<ShutdownSequenceDisposition> {
    this.register(authorityRelease);
    const blocking = this.declinedEntries().filter(({ obligation }) => obligation.remainder.owner === 'none');
    if (blocking.length === 0) await this.run(authorityRelease);

    const declined = this.declinedEntries();
    if (declined.length === 0) return { disposition: 'settled' };

    const primary = declined.find(({ obligation }) => obligation.remainder.owner === 'none') ?? declined[0];
    const hold = primary.obligation.hold?.(primary.settlement) ?? defaultHold();
    return {
      disposition: 'held',
      reason: hold.reason,
      exit: hold.exit,
      retryAfter: hold.retryAfter ?? this.options.time.sleep(this.options.pollMs),
      deferredFailures: declined.map(({ obligation, settlement }) => declinedFailure(obligation.label, settlement)),
      retainedAuthority: foldRetainedAuthority([...this.entries].map(([obligation, state]) => ({ obligation, state }))),
      retry: () => this.retryDeclined(authorityRelease),
    };
  }
}

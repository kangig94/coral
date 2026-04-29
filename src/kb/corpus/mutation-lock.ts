import type { TimerHandle } from '../../infra/port-types.js';
import type { CorpusSnapshot } from './snapshot.js';

export const DEFAULT_MUTATION_LOCK_TIMEOUT_MS = 30_000;

/**
 * Cooperative grace window between deadline abort and recording the blocked
 * diagnostic. Cooperative `fn` paths usually settle within microseconds of
 * the abort signal; the grace prevents transient deadline-then-settle from
 * surfacing as `mutationBlocked` on `/health`.
 */
const MUTATION_DEADLINE_GRACE_MS = 100;

/**
 * Options for a single `withMutationLock` call.
 *
 * `timeoutMs` overrides the runtime default — use a longer window for heavy
 * paths (e.g. `kb reindex`, `kb source import`) that legitimately exceed 30s.
 * The deadline aborts the composed signal but does NOT release the lock; the
 * lock transfers to the next caller only when `fn` actually settles
 * (success/failure/abort propagation). Stuck non-cooperative mutations
 * surface on `/health.subsystems.kb.mutationBlocked` instead.
 *
 * `signal` lets callers compose external aborts (e.g. user `coral-cli abort`)
 * with the internal deadline. Both abort the same composed signal that `fn`
 * receives; reasons remain distinguishable — caller's `signal.reason`
 * propagates verbatim while the deadline aborts with
 * `{ kind: 'mutation_deadline', timeoutMs }`.
 */
export interface KbMutationLockOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Reason value attached to the deadline abort on the composed signal. */
export interface KbMutationDeadlineReason {
  kind: 'mutation_deadline';
  timeoutMs: number;
}

export interface KbMutationLockContext<TIndex, TPublication, TLane, TOpaqueDelta = unknown> {
  startIndex: TIndex;
  pendingMutationLane: TLane | null;
  /**
   * Operator-facing identifier of the in-flight write (e.g. `note_write`,
   * `source_import`). Captured at grace-end time and surfaced through
   * `KbMutationLockDiagnostics.owner` on `/health.subsystems.kb.mutationBlocked`.
   * Writers set this immediately after acquiring the lock so a deadline that
   * fires after the work begins reports the right owner. The fallback
   * sentinel `'unknown'` (see `?? 'unknown'` below) means the deadline + grace
   * window elapsed before any write set this field — typically a writer that
   * blocked on initial bookkeeping rather than the actual mutation.
   */
  pendingMutationReason?: string;
  publication: TPublication | null;
  pendingOpaqueDeltas: TOpaqueDelta[];
}

export interface KbMutationLockRunner<
  TIndex,
  TPublication extends { snapshot: CorpusSnapshot },
  TLane,
  TOpaqueDelta = unknown,
> {
  cloneStartIndex(): TIndex;
  getCurrentLock(): Promise<void>;
  setCurrentLock(lock: Promise<void>): void;
  setActiveContext(context: KbMutationLockContext<TIndex, TPublication, TLane, TOpaqueDelta> | null): void;
  finalizePendingMutation(context: KbMutationLockContext<TIndex, TPublication, TLane, TOpaqueDelta>): void | Promise<void>;
  enqueuePublication(publication: TPublication): void;
  hasQueuedPublications(): boolean;
  processPublishQueue(): Promise<void> | void;
}

export interface KbMutationLockTimePort {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle | null): void;
}

export interface CreateKbMutationLockOptions {
  /** Per-controller default; per-call `options.timeoutMs` overrides. */
  defaultTimeoutMs?: number;
  /** Required time port (§16 #50: no ambient setTimeout). */
  time: KbMutationLockTimePort;
}

/**
 * Snapshot of mutation-lock diagnostic state. `blocked: true` means a
 * deadline has aborted the active mutation but `fn` has not yet settled,
 * and the cooperative grace window has elapsed. Cleared as soon as `fn`
 * settles (success or failure or abort propagation).
 */
export type KbMutationLockDiagnostics =
  | { blocked: false }
  | { blocked: true; owner: string; ageMs: number; signaledAtMs: number };

export interface KbMutationLockController<
  TIndex,
  TPublication extends { snapshot: CorpusSnapshot },
  TLane,
  TOpaqueDelta = unknown,
> {
  withMutationLock<TResult>(
    fn: (
      lockCtx: KbMutationLockContext<TIndex, TPublication, TLane, TOpaqueDelta>,
      args: { signal: AbortSignal },
    ) => Promise<TResult> | TResult,
    options?: KbMutationLockOptions,
  ): Promise<TResult>;
  diagnostics(): KbMutationLockDiagnostics;
}

export function createKbMutationLock<
  TIndex,
  TPublication extends { snapshot: CorpusSnapshot },
  TLane,
  TOpaqueDelta = unknown,
>(
  runner: KbMutationLockRunner<TIndex, TPublication, TLane, TOpaqueDelta>,
  controllerOptions: CreateKbMutationLockOptions,
): KbMutationLockController<TIndex, TPublication, TLane, TOpaqueDelta> {
  const defaultTimeoutMs = controllerOptions.defaultTimeoutMs ?? DEFAULT_MUTATION_LOCK_TIMEOUT_MS;
  const time = controllerOptions.time;
  let blockedState: { owner: string; signaledAtMs: number } | null = null;

  return {
    async withMutationLock<TResult>(
      fn: (
        lockCtx: KbMutationLockContext<TIndex, TPublication, TLane, TOpaqueDelta>,
        args: { signal: AbortSignal },
      ) => Promise<TResult> | TResult,
      options: KbMutationLockOptions = {},
    ): Promise<TResult> {
      const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
      const previous = runner.getCurrentLock();
      let release!: () => void;
      runner.setCurrentLock(
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );

      await previous;

      const lockContext: KbMutationLockContext<TIndex, TPublication, TLane, TOpaqueDelta> = {
        startIndex: runner.cloneStartIndex(),
        pendingMutationLane: null,
        pendingMutationReason: undefined,
        publication: null,
        pendingOpaqueDeltas: [],
      };
      runner.setActiveContext(lockContext);

      // Compose caller-supplied signal + internal deadline timer onto a single
      // signal handed to `fn`. Aborting either source aborts the composed
      // signal; reasons stay distinguishable (caller reason vs deadline reason)
      // because the deadline only aborts when the caller hasn't already.
      const callerSignal = options.signal;
      const composedController = new AbortController();
      const onCallerAbort = (): void => {
        if (!composedController.signal.aborted) {
          composedController.abort(callerSignal?.reason);
        }
      };
      if (callerSignal !== undefined) {
        if (callerSignal.aborted) {
          composedController.abort(callerSignal.reason);
        } else {
          callerSignal.addEventListener('abort', onCallerAbort, { once: true });
        }
      }

      let graceHandle: TimerHandle | null = null;
      const deadlineReason: KbMutationDeadlineReason = { kind: 'mutation_deadline', timeoutMs };
      const deadlineHandle: TimerHandle = time.setTimeout(() => {
        if (!composedController.signal.aborted) {
          composedController.abort(deadlineReason);
        }
        const signaledAtMs = time.now();
        graceHandle = time.setTimeout(() => {
          // Owner is captured at grace-end time, not deadline time, so a
          // cooperative `fn` that settles inside the grace window never
          // surfaces on `/health.subsystems.kb.mutationBlocked`. The
          // `'unknown'` sentinel means the deadline fired before any write
          // committed `pendingMutationReason` — see JSDoc on the field.
          blockedState = {
            owner: lockContext.pendingMutationReason ?? 'unknown',
            signaledAtMs,
          };
        }, MUTATION_DEADLINE_GRACE_MS);
      }, timeoutMs);

      let succeeded = false;
      let result!: TResult;
      let deferredError: unknown = null;

      try {
        result = await fn(lockContext, { signal: composedController.signal });
        succeeded = true;
      } catch (error: unknown) {
        deferredError = error;
      } finally {
        time.clearTimeout(deadlineHandle);
        time.clearTimeout(graceHandle);
        callerSignal?.removeEventListener('abort', onCallerAbort);
        blockedState = null;

        try {
          if (succeeded) {
            await runner.finalizePendingMutation(lockContext);
          }
        } catch (error: unknown) {
          deferredError = error;
          succeeded = false;
        }

        runner.setActiveContext(null);
        if (succeeded && lockContext.publication !== null) {
          runner.enqueuePublication(lockContext.publication);
        }
        release();
        if (runner.hasQueuedPublications()) {
          void runner.processPublishQueue();
        }
      }

      if (deferredError !== null) {
        throw deferredError instanceof Error
          ? deferredError
          : new Error('KB mutation lock finalization failed.', { cause: deferredError });
      }

      return result;
    },
    diagnostics(): KbMutationLockDiagnostics {
      if (blockedState === null) {
        return { blocked: false };
      }
      return {
        blocked: true,
        owner: blockedState.owner,
        ageMs: Math.max(0, time.now() - blockedState.signaledAtMs),
        signaledAtMs: blockedState.signaledAtMs,
      };
    },
  };
}

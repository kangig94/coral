import type { TimerHandle } from '../../infra/port-types.js';
import type { CorpusSnapshot } from './snapshot.js';

export const DEFAULT_MUTATION_LOCK_TIMEOUT_MS = 30_000;

/**
 * Options for a single `withMutationLock` call.
 *
 * `timeoutMs` overrides the runtime default — use a longer window for heavy
 * paths (e.g. `kb reindex`, `kb source import`) that legitimately exceed 30s.
 * The hard upper bound prevents a wedged operation from stalling every queued
 * caller indefinitely (spec §6.4 deadline policy).
 */
export interface KbMutationLockOptions {
  timeoutMs?: number;
}

export interface KbMutationLockContext<TIndex, TPublication, TLane, TOpaqueDelta = unknown> {
  startIndex: TIndex;
  pendingMutationLane: TLane | null;
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
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle | null): void;
}

export interface CreateKbMutationLockOptions {
  /** Per-controller default; per-call `options.timeoutMs` overrides. */
  defaultTimeoutMs?: number;
  /** Required time port (§16 #50: no ambient setTimeout). */
  time: KbMutationLockTimePort;
}

export class KbMutationStuckError extends Error {
  readonly code = 'kb_mutation_stuck';
  readonly timeoutMs: number;
  readonly previousReason?: string;

  constructor(timeoutMs: number, previousReason?: string) {
    const detail = previousReason ? ` (previous: ${previousReason})` : '';
    super(`KB mutation lock exceeded ${timeoutMs}ms${detail}.`);
    this.name = 'KbMutationStuckError';
    this.timeoutMs = timeoutMs;
    if (previousReason !== undefined) {
      this.previousReason = previousReason;
    }
    Object.setPrototypeOf(this, KbMutationStuckError.prototype);
  }
}

export function createKbMutationLock<
  TIndex,
  TPublication extends { snapshot: CorpusSnapshot },
  TLane,
  TOpaqueDelta = unknown,
>(
  runner: KbMutationLockRunner<TIndex, TPublication, TLane, TOpaqueDelta>,
  controllerOptions: CreateKbMutationLockOptions,
): {
  withMutationLock<TResult>(fn: () => Promise<TResult> | TResult, options?: KbMutationLockOptions): Promise<TResult>;
} {
  const defaultTimeoutMs = controllerOptions.defaultTimeoutMs ?? DEFAULT_MUTATION_LOCK_TIMEOUT_MS;
  const time = controllerOptions.time;
  let lastReason: string | undefined;

  return {
    async withMutationLock<TResult>(
      fn: () => Promise<TResult> | TResult,
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

      let succeeded = false;
      let result!: TResult;
      let deferredError: unknown = null;

      let timeoutHandle: TimerHandle | null = null;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = time.setTimeout(() => {
          reject(new KbMutationStuckError(timeoutMs, lastReason));
        }, timeoutMs);
      });

      try {
        result = await Promise.race([Promise.resolve().then(() => fn()), timeoutPromise]);
        succeeded = true;
      } catch (error: unknown) {
        deferredError = error;
      } finally {
        time.clearTimeout(timeoutHandle);
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
        lastReason = lockContext.pendingMutationReason;
        release();
        if (runner.hasQueuedPublications()) {
          void runner.processPublishQueue();
        }
      }

      if (deferredError !== null) {
        if (deferredError instanceof KbMutationStuckError) {
          throw deferredError;
        }
        throw deferredError instanceof Error
          ? deferredError
          : new Error('KB mutation lock finalization failed.', { cause: deferredError });
      }

      return result;
    },
  };
}

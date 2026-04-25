import type { CorpusSnapshot } from './snapshot.js';

export type KbMutationLockOptions = Record<string, never>;

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

export function createKbMutationLock<
  TIndex,
  TPublication extends { snapshot: CorpusSnapshot },
  TLane,
  TOpaqueDelta = unknown,
>(
  runner: KbMutationLockRunner<TIndex, TPublication, TLane, TOpaqueDelta>,
): {
  withMutationLock<TResult>(fn: () => Promise<TResult> | TResult, options?: KbMutationLockOptions): Promise<TResult>;
} {
  return {
    async withMutationLock<TResult>(
      fn: () => Promise<TResult> | TResult,
      options: KbMutationLockOptions = {},
    ): Promise<TResult> {
      void options;
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

      try {
        result = await fn();
        succeeded = true;
      } finally {
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
  };
}

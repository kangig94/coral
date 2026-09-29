import { formatError } from '../../../infra/error-format.js';
import type { AttemptRetry } from '../../../infra/upgrade-intent.js';
import {
  observeSuccessionServing,
  refuseSuccessionAttempt,
  type SuccessionWriterEntitlement,
} from '../../../store/succession-writer-generation.js';
import { TRANSIENT_RETRY_BASE_MS } from '../attempt-retry.js';
import type { CommitState, CommitWindow, SuccessionCommitPorts } from './index.js';
import { TransientCommitFailure } from './failure.js';

const SERVING_POLL_MS = 25;

type ServingDependencies = Readonly<{
  retirementServes: (attemptId: string, incumbentEpochKey: string) => boolean;
  retryAfterFailure: (error: unknown) => AttemptRetry;
}>;

function createServingObservation(
  ports: SuccessionCommitPorts,
  state: CommitState,
  retirementServes: ServingDependencies['retirementServes'],
) {
  const { runtime } = ports;

  async function acceptServing(
    window: CommitWindow,
    writer: SuccessionWriterEntitlement,
    serving: NonNullable<ReturnType<typeof observeSuccessionServing>>,
  ): Promise<void> {
    const { attempt, preparation, recovering } = window;
    if (
      (serving.epochKey !== preparation.epochKey && !retirementServes(attempt.attemptId, preparation.epochKey)) ||
      serving.controlGeneration <= writer.generation.generation
    ) {
      throw new Error('Durable serving record does not match the prepared takeover.');
    }
    if (!recovering) {
      const committed = await ports.reconciler().commit(attempt.attemptId);
      if (committed.kind !== 'committed') {
        ports.log(`Succession serves, but completion receipt is ${committed.kind}.\n`);
      }
    }
    await ports.interposition.at('incumbent-release', { recovery: recovering });
  }

  /** Resolves once the successor durably serves the prepared takeover; every other ending throws. */
  async function awaitServing(window: CommitWindow, writer: SuccessionWriterEntitlement): Promise<void> {
    const { attempt, deadlineAt } = window;
    for (;;) {
      const serving = observeSuccessionServing(runtime, attempt.attemptId);
      if (serving !== null) {
        await acceptServing(window, writer, serving);
        return;
      }
      if (window.hold !== null) throw new Error(window.hold);
      if (state.attemptAbort.signal.aborted) throw new Error('Incumbent shutdown aborted the uncommitted attempt.');
      if (attempt.child.exitCode !== null || attempt.child.signalCode !== null) {
        throw new TransientCommitFailure('Successor exited before durable serving.');
      }
      if (runtime.time.now() >= deadlineAt) throw new Error('Successor missed its serving deadline.');
      await runtime.time.sleep(SERVING_POLL_MS);
    }
  }

  return awaitServing;
}

export function createCommitServing(
  ports: SuccessionCommitPorts,
  state: CommitState,
  dependencies: ServingDependencies,
) {
  const { runtime } = ports;
  const { retirementServes, retryAfterFailure } = dependencies;
  const awaitServing = createServingObservation(ports, state, retirementServes);

  /** At its deadline the successor fences itself, so whatever it reports afterwards is that deadline's doing. */
  const retryAfterWindowFailure = (window: CommitWindow, error: unknown): AttemptRetry =>
    error instanceof TransientCommitFailure && error.obligationChange
      ? retryAfterFailure(error)
      : !state.attemptAbort.signal.aborted && runtime.time.now() >= window.deadlineAt
        ? { kind: 'transient', retryAfterMs: TRANSIENT_RETRY_BASE_MS }
        : retryAfterFailure(error);

  /**
   * Decides a failed window before its successor is reaped: a successor that has not recorded serving by now never
   * can, whether or not it has taken the writer generation yet.
   */
  async function successorServesBeforeRefusal(window: CommitWindow): Promise<'serving' | 'refused' | 'unresolved'> {
    if (window.writer === null) return 'refused';
    for (;;) {
      try {
        return refuseSuccessionAttempt(runtime, window.attempt.attemptId, window.deadlineAt).kind;
      } catch (error: unknown) {
        ports.log(`Failed succession window could not refuse its attempt: ${formatError(error)}\n`);
        if (runtime.time.now() >= window.deadlineAt) return 'unresolved';
        await runtime.time.sleep(SERVING_POLL_MS);
      }
    }
  }

  return { awaitServing, retryAfterWindowFailure, successorServesBeforeRefusal };
}

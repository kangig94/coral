import { formatError } from '../../../infra/error-format.js';
import { observeProcessLiveness, probeProcessIncarnation } from '../../../infra/node-process.js';
import { gracefulKillByPid } from '../../../infra/process-supervision.js';
import { SENTINEL_TIMING } from '../../../infra/sentinel-timing.js';
import { readUpgradeIntent } from '../../../infra/upgrade-intent.js';
import type { Runtime } from '../../../runtime/ports.js';
import type { SuccessionAttempt } from '../attempt-child.js';

type ObservedAbsent = Readonly<{ kind: 'observed-absent' }>;

function verifyAttemptIdentity(runtime: Runtime, attempt: SuccessionAttempt, required: boolean): void {
  const recorded = readUpgradeIntent(runtime.paths.coral.coordinator.runDir);
  const identityRecord = recorded.kind === 'readable' ? recorded.intent.attemptChild : null;
  if (
    required &&
    (identityRecord?.attemptId !== attempt.attemptId ||
      identityRecord.pid !== attempt.childIdentity.pid ||
      identityRecord.incarnation !== attempt.childIdentity.incarnation)
  ) {
    throw new Error('Failed successor identity does not match the durable attempt record.');
  }
}

async function waitForSentinelRetirement(runtime: Runtime, attempt: SuccessionAttempt): Promise<void> {
  if (attempt.child.exitCode !== null || attempt.child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const onExit = (): void => finish(null);
    const timeout = runtime.time.setTimeout(
      () => finish(new Error('Succession sentinel did not retire its child within its grace')),
      SENTINEL_TIMING.graceMs + 5_000,
    );
    const finish = (error: Error | null): void => {
      if (settled) return;
      settled = true;
      runtime.time.clearTimeout(timeout);
      attempt.child.off('exit', onExit);
      if (error === null) resolve();
      else reject(error);
    };
    attempt.child.once('exit', onExit);
    if (attempt.child.connected) {
      attempt.child.send({ kind: 'coral-sentinel-retire-child' }, (error) => {
        if (error !== null) finish(error);
      });
    }
  });
}

async function reapSentinelAttempt(runtime: Runtime, attempt: SuccessionAttempt): Promise<ObservedAbsent> {
  await waitForSentinelRetirement(runtime, attempt);
  const { pid, incarnation } = attempt.childIdentity;
  const observed = probeProcessIncarnation(pid);
  if (observeProcessLiveness(pid) === 'absent' || (observed !== null && observed !== incarnation)) {
    return { kind: 'observed-absent' };
  }
  throw new Error('Succession sentinel exited before its coordinator was proven absent.');
}

async function reapOwnedAttempt(runtime: Runtime, attempt: SuccessionAttempt): Promise<ObservedAbsent> {
  const { pid, incarnation } = attempt.childIdentity;
  if (attempt.child.exitCode !== null || attempt.child.signalCode !== null) return { kind: 'observed-absent' };
  if (probeProcessIncarnation(pid) !== incarnation) {
    throw new Error('Failed successor identity cannot be verified for reaping.');
  }
  // The owned child's exit is decisive absence evidence; reaping must not wait for the escalation deadline.
  const exited = new Promise<ObservedAbsent>((resolve) => {
    if (attempt.child.exitCode !== null || attempt.child.signalCode !== null) resolve({ kind: 'observed-absent' });
    else attempt.child.once('exit', () => resolve({ kind: 'observed-absent' }));
  });
  const termination = gracefulKillByPid(runtime, pid, incarnation);
  if (termination.kind !== 'escalation-scheduled') {
    throw new Error(`Failed successor reaping was ${termination.kind}.`);
  }
  const settled = await Promise.race([termination.settlement, exited]);
  if (settled.kind !== 'observed-absent') {
    throw new Error(`Failed successor reaping remained ${settled.kind}.`);
  }
  return settled;
}

export function createCommitAttemptReaper(runtime: Runtime) {
  async function reapAttempt(attempt: SuccessionAttempt, requireDurableIdentity: boolean): Promise<ObservedAbsent> {
    verifyAttemptIdentity(runtime, attempt, requireDurableIdentity);
    return attempt.child.coordinatorPid !== undefined
      ? reapSentinelAttempt(runtime, attempt)
      : reapOwnedAttempt(runtime, attempt);
  }

  /**
   * Unproven absence of a failed child holds the child, never the incumbent: the incumbent's later reclaim
   * advances the writer generation, which refuses every write the child could still attempt.
   */
  async function abortAndReap(attempt: SuccessionAttempt, requireDurableIdentity = true): Promise<string | null> {
    await attempt.abort().catch(() => {});
    try {
      void (await reapAttempt(attempt, requireDurableIdentity));
      return null;
    } catch (error: unknown) {
      return `failed successor ${attempt.childIdentity.pid} absence is unproven (${formatError(error)}); the writer generation fence refuses its writes`;
    }
  }

  return { abortAndReap };
}

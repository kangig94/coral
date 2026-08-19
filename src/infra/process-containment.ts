import {
  isProcessIncarnation,
  probeProcessIncarnation,
  type ProcessIncarnation,
  type ProcessLiveness,
} from './node-process.js';
import type { MonotonicClock, MonotonicInstant } from './monotonic-clock.js';
import {
  CONTAINMENT_DISAPPEARANCE_CONFIRM_MS,
  CONTAINMENT_PROCESS_CONTROL_CALL_MAX_MS,
  SIGKILL_GRACE_MS,
  SIGTERM_GRACE_MS,
} from './process-constants.js';

/** How often a disappearance wait re-observes its targets. Shared by every caller that polls for a signalled
 *  process or process group to disappear, so the poll interval has exactly one owner rather than being
 *  hand-retyped per caller and drifting the moment one of them changes without the others. */
export const ABSENCE_POLL_MS = 25;

/** A recorded process identity that is safe to target only while both fields match. */
export type RecordedProcessIdentity = Readonly<{
  pid: number;
  incarnation: ProcessIncarnation;
}>;

/** A detached process leader and the process group it established. */
export type RecordedContainmentIdentity = RecordedProcessIdentity &
  Readonly<{
    processGroupId: number;
  }>;

/** Runtime capabilities required to reap one recorded containment. */
export type ProcessContainmentEnvironment<Scope extends symbol> = {
  /**
   * The largest recorded set this containment will act on. It is injected because "how many targets" is the
   * caller's bound, not a process-control constant — naming a provider concept here would put a domain
   * vocabulary in infra.
   */
  readonly maxRecordedRoots: number;
  readonly clock: MonotonicClock<Scope>;
  readonly process: {
    kill(pid: number, signal: NodeJS.Signals | 0): boolean;
    observeLiveness(pid: number): ProcessLiveness;
  };
  readonly platform: NodeJS.Platform;
  readonly readProcessIncarnation?: (pid: number, platform: NodeJS.Platform) => ProcessIncarnation | null;
  readonly signal?: AbortSignal;
};

function containmentAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Recorded containment reclamation was aborted.', { cause: signal.reason });
}

function assertContainmentAuthorized(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw containmentAbortError(signal);
}

/** Closed failures reported by recorded-containment teardown. */
export type ProcessContainmentErrorCode = 'process_identity_unverified' | 'process_containment_reap_failed';

/** A fail-closed recorded-containment teardown failure. */
export class ProcessContainmentError extends Error {
  readonly code: ProcessContainmentErrorCode;
  readonly context: Readonly<Record<string, unknown>>;

  constructor(code: ProcessContainmentErrorCode, message: string, context: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = 'ProcessContainmentError';
    this.code = code;
    this.context = context;
    Object.setPrototypeOf(this, ProcessContainmentError.prototype);
  }
}

type TargetObservation = 'absent' | 'present';

type RecordedSetObservation = Readonly<{
  containment: TargetObservation;
  recordedRoots: readonly TargetObservation[];
}>;

function reapFailure(message: string, context: Readonly<Record<string, unknown>> = {}): ProcessContainmentError {
  return new ProcessContainmentError('process_containment_reap_failed', message, context);
}

function assertPositiveSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ProcessContainmentError('process_identity_unverified', `${field} must be a positive safe integer.`, {
      field,
      value,
    });
  }
}

function assertProcessIdentity(identity: RecordedProcessIdentity, field: string): void {
  assertPositiveSafeInteger(identity.pid, `${field}.pid`);
  if (!isProcessIncarnation(identity.incarnation)) {
    throw new ProcessContainmentError(
      'process_identity_unverified',
      `${field}.incarnation must be a non-empty incarnation token.`,
      { field: `${field}.incarnation`, value: identity.incarnation },
    );
  }
}

/** Verifies that a recorded containment names its detached process-group leader. */
export function assertRecordedContainmentIdentity(containment: RecordedContainmentIdentity): void {
  assertProcessIdentity(containment, 'containment');
  assertPositiveSafeInteger(containment.processGroupId, 'containment.processGroupId');
  if (containment.processGroupId !== containment.pid) {
    throw new ProcessContainmentError(
      'process_identity_unverified',
      'Recorded containment is not a detached process-group leader.',
      { pid: containment.pid, processGroupId: containment.processGroupId },
    );
  }
}

function assertRecordedSet(
  containment: RecordedContainmentIdentity,
  recordedRoots: readonly RecordedProcessIdentity[],
  maxRecordedRoots: number,
): void {
  if (recordedRoots.length > maxRecordedRoots) {
    throw reapFailure(`Recorded target count exceeds the ${maxRecordedRoots} limit.`, {
      observed: recordedRoots.length,
      limit: maxRecordedRoots,
    });
  }

  assertRecordedContainmentIdentity(containment);
  for (const [index, root] of recordedRoots.entries()) {
    assertProcessIdentity(root, `recordedRoots[${index}]`);
  }
}

function readIncarnation<Scope extends symbol>(
  identity: RecordedProcessIdentity,
  environment: ProcessContainmentEnvironment<Scope>,
): ProcessIncarnation | null {
  const read = environment.readProcessIncarnation ?? probeProcessIncarnation;
  try {
    return read(identity.pid, environment.platform);
  } catch {
    return null;
  }
}

function observeProcessIdentity<Scope extends symbol>(
  identity: RecordedProcessIdentity,
  environment: ProcessContainmentEnvironment<Scope>,
): TargetObservation {
  const observedIncarnation = readIncarnation(identity, environment);
  if (observedIncarnation === identity.incarnation) {
    return 'present';
  }
  if (observedIncarnation !== null) {
    return 'absent';
  }
  if (environment.process.observeLiveness(identity.pid) === 'absent') {
    return 'absent';
  }
  throw new ProcessContainmentError(
    'process_identity_unverified',
    `Refusing to signal pid=${identity.pid} because its process incarnation is unavailable while it is alive.`,
    { pid: identity.pid },
  );
}

function observeContainment<Scope extends symbol>(
  containment: RecordedContainmentIdentity,
  environment: ProcessContainmentEnvironment<Scope>,
): TargetObservation {
  const observedIncarnation = readIncarnation(containment, environment);
  if (observedIncarnation !== null && observedIncarnation !== containment.incarnation) {
    // A mismatched incarnation proves that pid no longer identifies the recorded leader, not that every member
    // of its old group is gone. Do not probe or signal -processGroupId after reuse because the numeric group can
    // no longer be proven ours. This can strand original members: the guarantee is never to signal the wrong
    // group, not always to reap ours.
    return 'absent';
  }
  if (observedIncarnation === null && environment.process.observeLiveness(containment.pid) !== 'absent') {
    throw new ProcessContainmentError(
      'process_identity_unverified',
      `Refusing to signal process group ${containment.processGroupId} because its leader incarnation is unavailable while pid=${containment.pid} is alive.`,
      { pid: containment.pid, processGroupId: containment.processGroupId },
    );
  }

  // Three answers, and only two of them may decide. A group observed absent is absent; one observed alive is
  // present and may be signalled. A group that could not be observed authorizes nothing — reading it as
  // present would deliver SIGTERM and then SIGKILL to a numeric group nobody saw.
  const groupLiveness = environment.process.observeLiveness(-containment.processGroupId);
  if (groupLiveness === 'unknown') {
    throw new ProcessContainmentError(
      'process_identity_unverified',
      `Refusing to signal process group ${containment.processGroupId} because its liveness could not be observed.`,
      { pid: containment.pid, processGroupId: containment.processGroupId },
    );
  }
  if (observedIncarnation === containment.incarnation && groupLiveness === 'absent') {
    return 'absent';
  }
  // A detached group remains signalable after its verified leader exits; treating leader exit as group
  // absence would strand the containment's remaining members.
  return groupLiveness === 'alive' ? 'present' : 'absent';
}

function observeRecordedSet<Scope extends symbol>(
  containment: RecordedContainmentIdentity,
  recordedRoots: readonly RecordedProcessIdentity[],
  environment: ProcessContainmentEnvironment<Scope>,
): RecordedSetObservation {
  const roots: TargetObservation[] = [];
  let firstFailure: unknown;
  let containmentObservation: TargetObservation = 'absent';

  try {
    containmentObservation = observeContainment(containment, environment);
  } catch (error: unknown) {
    firstFailure = error;
  }
  for (const root of recordedRoots) {
    try {
      roots.push(observeProcessIdentity(root, environment));
    } catch (error: unknown) {
      firstFailure ??= error;
      roots.push('absent');
    }
  }
  if (firstFailure instanceof Error) throw firstFailure;
  if (firstFailure !== undefined) {
    throw reapFailure('Recorded containment observation failed.');
  }
  return { containment: containmentObservation, recordedRoots: roots };
}

function allRecordedTargetsAbsent(observation: RecordedSetObservation): boolean {
  return observation.containment === 'absent' && observation.recordedRoots.every((root) => root === 'absent');
}

function assertSignalCallWithinBounds<Scope extends symbol>(
  callStartedAt: MonotonicInstant<Scope>,
  exitDeadline: MonotonicInstant<Scope>,
  environment: ProcessContainmentEnvironment<Scope>,
): void {
  const now = environment.clock.now();
  const callDurationMs = environment.clock.millisecondsBetween(callStartedAt, now);
  if (callDurationMs > CONTAINMENT_PROCESS_CONTROL_CALL_MAX_MS) {
    throw reapFailure(
      `Recorded containment process-control call exceeded ${CONTAINMENT_PROCESS_CONTROL_CALL_MAX_MS}ms.`,
      {
        callDurationMs,
        limit: CONTAINMENT_PROCESS_CONTROL_CALL_MAX_MS,
      },
    );
  }
  if (environment.clock.compare(now, exitDeadline) > 0) {
    throw reapFailure('Recorded containment process-control call exceeded the exit deadline.', {
      remainingMs: environment.clock.millisecondsBetween(now, exitDeadline),
    });
  }
}

function signalRecordedSet<Scope extends symbol>(
  containment: RecordedContainmentIdentity,
  recordedRoots: readonly RecordedProcessIdentity[],
  observation: RecordedSetObservation,
  signal: NodeJS.Signals,
  exitDeadline: MonotonicInstant<Scope>,
  environment: ProcessContainmentEnvironment<Scope>,
): void {
  assertContainmentAuthorized(environment.signal);
  const callStartedAt = environment.clock.now();
  if (environment.clock.compare(callStartedAt, exitDeadline) >= 0) {
    throw reapFailure(`Recorded containment had no time remaining for ${signal}.`, {
      remainingMs: environment.clock.millisecondsBetween(callStartedAt, exitDeadline),
    });
  }

  const signalPid = (pid: number): void => {
    // The model bounds each process-control call, not the sweep: with a full recorded set a sweep of fast
    // syscalls would otherwise exceed the per-call bound and abandon a reap that was progressing fine. The
    // sweep as a whole stays bounded by `exitDeadline`, which every step below still checks.
    const thisCallStartedAt = environment.clock.now();
    assertContainmentAuthorized(environment.signal);
    assertSignalCallWithinBounds(thisCallStartedAt, exitDeadline, environment);
    environment.process.kill(pid, signal);
    assertSignalCallWithinBounds(thisCallStartedAt, exitDeadline, environment);
  };

  try {
    if (observation.containment === 'present' && observeContainment(containment, environment) === 'present') {
      signalPid(-containment.processGroupId);
    }
    for (const [index, root] of recordedRoots.entries()) {
      if (observation.recordedRoots[index] === 'present' && observeProcessIdentity(root, environment) === 'present') {
        signalPid(root.pid);
      }
    }
  } catch (error: unknown) {
    if (error instanceof ProcessContainmentError) throw error;
    throw reapFailure(`Recorded containment ${signal} delivery failed.`, { signal });
  }
}

async function sleepWhileAuthorized<Scope extends symbol>(
  milliseconds: number,
  environment: ProcessContainmentEnvironment<Scope>,
): Promise<void> {
  const signal = environment.signal;
  if (signal === undefined) {
    await environment.clock.sleep(milliseconds);
    return;
  }
  assertContainmentAuthorized(signal);
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => reject(containmentAbortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    void environment.clock.sleep(milliseconds).then(
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error('Containment wait failed.', { cause: error }));
      },
    );
  });
  assertContainmentAuthorized(signal);
}

async function waitForAbsence<Scope extends symbol>(
  containment: RecordedContainmentIdentity,
  recordedRoots: readonly RecordedProcessIdentity[],
  waitDeadline: MonotonicInstant<Scope>,
  environment: ProcessContainmentEnvironment<Scope>,
): Promise<boolean> {
  while (true) {
    assertContainmentAuthorized(environment.signal);
    if (allRecordedTargetsAbsent(observeRecordedSet(containment, recordedRoots, environment))) {
      return true;
    }
    const remainingMs = environment.clock.millisecondsBetween(environment.clock.now(), waitDeadline);
    if (remainingMs <= 0) return false;
    await sleepWhileAuthorized(Math.min(ABSENCE_POLL_MS, remainingMs), environment);
  }
}

async function confirmAbsence<Scope extends symbol>(
  containment: RecordedContainmentIdentity,
  recordedRoots: readonly RecordedProcessIdentity[],
  exitDeadline: MonotonicInstant<Scope>,
  environment: ProcessContainmentEnvironment<Scope>,
): Promise<boolean> {
  const confirmationDeadline = environment.clock.shiftMilliseconds(
    environment.clock.now(),
    CONTAINMENT_DISAPPEARANCE_CONFIRM_MS,
  );
  if (environment.clock.compare(confirmationDeadline, exitDeadline) > 0) return false;

  while (environment.clock.compare(environment.clock.now(), confirmationDeadline) < 0) {
    assertContainmentAuthorized(environment.signal);
    if (!allRecordedTargetsAbsent(observeRecordedSet(containment, recordedRoots, environment))) {
      return false;
    }
    // Observing the set can outlast the remaining window; clamping keeps that from becoming a negative
    // sleep, which would throw outside this module's closed failure set and report an absent set as failed.
    const remainingMs = environment.clock.millisecondsBetween(environment.clock.now(), confirmationDeadline);
    await sleepWhileAuthorized(Math.max(0, Math.min(ABSENCE_POLL_MS, remainingMs)), environment);
  }
  return allRecordedTargetsAbsent(observeRecordedSet(containment, recordedRoots, environment));
}

/**
 * Reaps exactly the recorded group and additional recorded process identities before one absolute deadline.
 */
export async function reapRecordedContainment<Scope extends symbol>(
  containment: RecordedContainmentIdentity,
  recordedRoots: readonly RecordedProcessIdentity[],
  exitDeadline: MonotonicInstant<Scope>,
  environment: ProcessContainmentEnvironment<Scope>,
): Promise<void> {
  assertContainmentAuthorized(environment.signal);
  assertRecordedSet(containment, recordedRoots, environment.maxRecordedRoots);

  let observation = observeRecordedSet(containment, recordedRoots, environment);
  if (allRecordedTargetsAbsent(observation)) {
    if (await confirmAbsence(containment, recordedRoots, exitDeadline, environment)) return;
    throw reapFailure('Recorded containment absence could not be confirmed before the exit deadline.');
  }

  signalRecordedSet(containment, recordedRoots, observation, 'SIGTERM', exitDeadline, environment);
  const termWaitDeadline = environment.clock.earlier(
    exitDeadline,
    environment.clock.shiftMilliseconds(environment.clock.now(), SIGTERM_GRACE_MS),
  );
  if (await waitForAbsence(containment, recordedRoots, termWaitDeadline, environment)) {
    if (await confirmAbsence(containment, recordedRoots, exitDeadline, environment)) return;
    throw reapFailure('Recorded containment absence could not be confirmed before the exit deadline.');
  }

  assertContainmentAuthorized(environment.signal);
  observation = observeRecordedSet(containment, recordedRoots, environment);
  signalRecordedSet(containment, recordedRoots, observation, 'SIGKILL', exitDeadline, environment);
  const killWaitDeadline = environment.clock.earlier(
    exitDeadline,
    environment.clock.shiftMilliseconds(environment.clock.now(), SIGKILL_GRACE_MS),
  );
  if (
    (await waitForAbsence(containment, recordedRoots, killWaitDeadline, environment)) &&
    (await confirmAbsence(containment, recordedRoots, exitDeadline, environment))
  ) {
    return;
  }

  throw reapFailure('Recorded containment remained present at the exit deadline.', {
    remainingMs: environment.clock.millisecondsBetween(environment.clock.now(), exitDeadline),
  });
}

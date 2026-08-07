import { probeProcessStartedAtSeconds } from './node-process.js';
import type { MonotonicClock, MonotonicInstant } from './monotonic-clock.js';
import {
  PROXY_DISAPPEARANCE_CONFIRM_MS,
  PROXY_PROCESS_CONTROL_CALL_MAX_MS,
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
  processStartedAtSeconds: number;
}>;

/** The detached proxy leader and the process group it established. */
export type RecordedContainmentIdentity = RecordedProcessIdentity &
  Readonly<{
    processGroupId: number;
  }>;

/** Runtime capabilities required to reap one recorded containment. */
export type ProcessContainmentEnvironment<Scope extends symbol = symbol> = {
  /**
   * The largest recorded set this containment will act on. It is injected because "how many targets" is the
   * caller's bound, not a process-control constant — naming a provider concept here would put a domain
   * vocabulary in infra.
   */
  readonly maxRecordedRoots: number;
  readonly clock: MonotonicClock<Scope>;
  readonly process: {
    kill(pid: number, signal: NodeJS.Signals | 0): boolean;
    isAlive(pid: number): boolean;
  };
  readonly platform: NodeJS.Platform;
  readonly readProcessStartedAtSeconds?: (pid: number, platform: NodeJS.Platform) => number | null;
};

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
  providerRoots: readonly TargetObservation[];
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
  if (!Number.isSafeInteger(identity.processStartedAtSeconds) || identity.processStartedAtSeconds < 0) {
    throw new ProcessContainmentError(
      'process_identity_unverified',
      `${field}.processStartedAtSeconds must be a non-negative safe integer.`,
      { field: `${field}.processStartedAtSeconds`, value: identity.processStartedAtSeconds },
    );
  }
}

function assertRecordedSet(
  containment: RecordedContainmentIdentity,
  providerRoots: readonly RecordedProcessIdentity[],
  maxRecordedRoots: number,
): void {
  if (providerRoots.length > maxRecordedRoots) {
    throw reapFailure(`Recorded target count exceeds the ${maxRecordedRoots} limit.`, {
      observed: providerRoots.length,
      limit: maxRecordedRoots,
    });
  }

  assertProcessIdentity(containment, 'containment');
  assertPositiveSafeInteger(containment.processGroupId, 'containment.processGroupId');
  if (containment.processGroupId !== containment.pid) {
    throw new ProcessContainmentError(
      'process_identity_unverified',
      'Recorded containment is not a detached process-group leader.',
      { pid: containment.pid, processGroupId: containment.processGroupId },
    );
  }
  for (const [index, root] of providerRoots.entries()) {
    assertProcessIdentity(root, `providerRoots[${index}]`);
  }
}

function readStartedAt<Scope extends symbol>(
  identity: RecordedProcessIdentity,
  environment: ProcessContainmentEnvironment<Scope>,
): number | null {
  const read = environment.readProcessStartedAtSeconds ?? probeProcessStartedAtSeconds;
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
  const observedStartedAt = readStartedAt(identity, environment);
  if (observedStartedAt === identity.processStartedAtSeconds) {
    return 'present';
  }
  if (observedStartedAt !== null) {
    return 'absent';
  }
  if (!environment.process.isAlive(identity.pid)) {
    return 'absent';
  }
  throw new ProcessContainmentError(
    'process_identity_unverified',
    `Refusing to signal pid=${identity.pid} because its process start time is unavailable while it is alive.`,
    { pid: identity.pid },
  );
}

function observeContainment<Scope extends symbol>(
  containment: RecordedContainmentIdentity,
  environment: ProcessContainmentEnvironment<Scope>,
): TargetObservation {
  const observedStartedAt = readStartedAt(containment, environment);
  if (observedStartedAt !== null && observedStartedAt !== containment.processStartedAtSeconds) {
    return 'absent';
  }
  if (observedStartedAt === null && environment.process.isAlive(containment.pid)) {
    throw new ProcessContainmentError(
      'process_identity_unverified',
      `Refusing to signal process group ${containment.processGroupId} because its leader start time is unavailable while pid=${containment.pid} is alive.`,
      { pid: containment.pid, processGroupId: containment.processGroupId },
    );
  }

  const groupIsAlive = environment.process.isAlive(-containment.processGroupId);
  if (observedStartedAt === containment.processStartedAtSeconds && !groupIsAlive) {
    return 'absent';
  }
  // A detached group remains signalable after its verified leader exits; treating
  // leader exit as group absence would strand the proxy's in-group children.
  return groupIsAlive ? 'present' : 'absent';
}

function observeRecordedSet<Scope extends symbol>(
  containment: RecordedContainmentIdentity,
  providerRoots: readonly RecordedProcessIdentity[],
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
  for (const root of providerRoots) {
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
  return { containment: containmentObservation, providerRoots: roots };
}

function allRecordedTargetsAbsent(observation: RecordedSetObservation): boolean {
  return observation.containment === 'absent' && observation.providerRoots.every((root) => root === 'absent');
}

function assertSignalCallWithinBounds<Scope extends symbol>(
  callStartedAt: MonotonicInstant<Scope>,
  exitDeadline: MonotonicInstant<Scope>,
  environment: ProcessContainmentEnvironment<Scope>,
): void {
  const now = environment.clock.now();
  const callDurationMs = environment.clock.millisecondsBetween(callStartedAt, now);
  if (callDurationMs > PROXY_PROCESS_CONTROL_CALL_MAX_MS) {
    throw reapFailure(`Recorded containment process-control call exceeded ${PROXY_PROCESS_CONTROL_CALL_MAX_MS}ms.`, {
      callDurationMs,
      limit: PROXY_PROCESS_CONTROL_CALL_MAX_MS,
    });
  }
  if (environment.clock.compare(now, exitDeadline) > 0) {
    throw reapFailure('Recorded containment process-control call exceeded the exit deadline.', {
      remainingMs: environment.clock.millisecondsBetween(now, exitDeadline),
    });
  }
}

function signalRecordedSet<Scope extends symbol>(
  containment: RecordedContainmentIdentity,
  providerRoots: readonly RecordedProcessIdentity[],
  observation: RecordedSetObservation,
  signal: NodeJS.Signals,
  exitDeadline: MonotonicInstant<Scope>,
  environment: ProcessContainmentEnvironment<Scope>,
): void {
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
    assertSignalCallWithinBounds(thisCallStartedAt, exitDeadline, environment);
    environment.process.kill(pid, signal);
    assertSignalCallWithinBounds(thisCallStartedAt, exitDeadline, environment);
  };

  try {
    if (observation.containment === 'present' && observeContainment(containment, environment) === 'present') {
      signalPid(-containment.processGroupId);
    }
    for (const [index, root] of providerRoots.entries()) {
      if (observation.providerRoots[index] === 'present' && observeProcessIdentity(root, environment) === 'present') {
        signalPid(root.pid);
      }
    }
  } catch (error: unknown) {
    if (error instanceof ProcessContainmentError) throw error;
    throw reapFailure(`Recorded containment ${signal} delivery failed.`, { signal });
  }
}

async function waitForAbsence<Scope extends symbol>(
  containment: RecordedContainmentIdentity,
  providerRoots: readonly RecordedProcessIdentity[],
  waitDeadline: MonotonicInstant<Scope>,
  environment: ProcessContainmentEnvironment<Scope>,
): Promise<boolean> {
  while (true) {
    if (allRecordedTargetsAbsent(observeRecordedSet(containment, providerRoots, environment))) {
      return true;
    }
    const remainingMs = environment.clock.millisecondsBetween(environment.clock.now(), waitDeadline);
    if (remainingMs <= 0) return false;
    await environment.clock.sleep(Math.min(ABSENCE_POLL_MS, remainingMs));
  }
}

async function confirmAbsence<Scope extends symbol>(
  containment: RecordedContainmentIdentity,
  providerRoots: readonly RecordedProcessIdentity[],
  exitDeadline: MonotonicInstant<Scope>,
  environment: ProcessContainmentEnvironment<Scope>,
): Promise<boolean> {
  const confirmationDeadline = environment.clock.shiftMilliseconds(
    environment.clock.now(),
    PROXY_DISAPPEARANCE_CONFIRM_MS,
  );
  if (environment.clock.compare(confirmationDeadline, exitDeadline) > 0) return false;

  while (environment.clock.compare(environment.clock.now(), confirmationDeadline) < 0) {
    if (!allRecordedTargetsAbsent(observeRecordedSet(containment, providerRoots, environment))) {
      return false;
    }
    // Observing the set can outlast the remaining window; clamping keeps that from becoming a negative
    // sleep, which would throw outside this module's closed failure set and report an absent set as failed.
    const remainingMs = environment.clock.millisecondsBetween(environment.clock.now(), confirmationDeadline);
    await environment.clock.sleep(Math.max(0, Math.min(ABSENCE_POLL_MS, remainingMs)));
  }
  return allRecordedTargetsAbsent(observeRecordedSet(containment, providerRoots, environment));
}

/**
 * Reaps exactly the recorded proxy group and provider-root identities before one absolute deadline.
 */
export async function reapRecordedContainment<Scope extends symbol>(
  containment: RecordedContainmentIdentity,
  providerRoots: readonly RecordedProcessIdentity[],
  exitDeadline: MonotonicInstant<Scope>,
  environment: ProcessContainmentEnvironment<Scope>,
): Promise<void> {
  assertRecordedSet(containment, providerRoots, environment.maxRecordedRoots);

  let observation = observeRecordedSet(containment, providerRoots, environment);
  if (allRecordedTargetsAbsent(observation)) {
    if (await confirmAbsence(containment, providerRoots, exitDeadline, environment)) return;
    throw reapFailure('Recorded containment absence could not be confirmed before the exit deadline.');
  }

  signalRecordedSet(containment, providerRoots, observation, 'SIGTERM', exitDeadline, environment);
  const termWaitDeadline = environment.clock.earlier(
    exitDeadline,
    environment.clock.shiftMilliseconds(environment.clock.now(), SIGTERM_GRACE_MS),
  );
  if (await waitForAbsence(containment, providerRoots, termWaitDeadline, environment)) {
    if (await confirmAbsence(containment, providerRoots, exitDeadline, environment)) return;
    throw reapFailure('Recorded containment absence could not be confirmed before the exit deadline.');
  }

  observation = observeRecordedSet(containment, providerRoots, environment);
  signalRecordedSet(containment, providerRoots, observation, 'SIGKILL', exitDeadline, environment);
  const killWaitDeadline = environment.clock.earlier(
    exitDeadline,
    environment.clock.shiftMilliseconds(environment.clock.now(), SIGKILL_GRACE_MS),
  );
  if (
    (await waitForAbsence(containment, providerRoots, killWaitDeadline, environment)) &&
    (await confirmAbsence(containment, providerRoots, exitDeadline, environment))
  ) {
    return;
  }

  throw reapFailure('Recorded containment remained present at the exit deadline.', {
    remainingMs: environment.clock.millisecondsBetween(environment.clock.now(), exitDeadline),
  });
}

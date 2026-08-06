import { probeProcessStartedAtSeconds } from './node-process.js';
import {
  MAX_PROXY_OPERATION_LEDGERS,
  PROXY_DISAPPEARANCE_CONFIRM_MS,
  PROXY_PROCESS_CONTROL_CALL_MAX_MS,
  SIGKILL_GRACE_MS,
  SIGTERM_GRACE_MS,
} from './process-constants.js';

const ABSENCE_POLL_MS = 25;

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

/** The monotonic elapsed-time surface used by one containment attempt. */
export interface ProcessContainmentClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** Runtime capabilities required to reap one recorded containment. */
export interface ProcessContainmentEnvironment {
  readonly clock: ProcessContainmentClock;
  readonly process: {
    kill(pid: number, signal: NodeJS.Signals | 0): boolean;
    isAlive(pid: number): boolean;
  };
  readonly platform: NodeJS.Platform;
  readonly readProcessStartedAtSeconds?: (pid: number, platform: NodeJS.Platform) => number | null;
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
  exitDeadline: number,
): void {
  if (!Number.isFinite(exitDeadline)) {
    throw reapFailure('Recorded containment exit deadline must be finite.', { exitDeadline });
  }
  if (providerRoots.length > MAX_PROXY_OPERATION_LEDGERS) {
    throw reapFailure(`Recorded provider-root count exceeds the ${MAX_PROXY_OPERATION_LEDGERS} target cap.`, {
      observed: providerRoots.length,
      limit: MAX_PROXY_OPERATION_LEDGERS,
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

function readStartedAt(identity: RecordedProcessIdentity, environment: ProcessContainmentEnvironment): number | null {
  const read = environment.readProcessStartedAtSeconds ?? probeProcessStartedAtSeconds;
  try {
    return read(identity.pid, environment.platform);
  } catch {
    return null;
  }
}

function observeProcessIdentity(
  identity: RecordedProcessIdentity,
  environment: ProcessContainmentEnvironment,
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

function observeContainment(
  containment: RecordedContainmentIdentity,
  environment: ProcessContainmentEnvironment,
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

function observeRecordedSet(
  containment: RecordedContainmentIdentity,
  providerRoots: readonly RecordedProcessIdentity[],
  environment: ProcessContainmentEnvironment,
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

function assertSignalCallWithinBounds(
  callStartedAt: number,
  exitDeadline: number,
  environment: ProcessContainmentEnvironment,
): void {
  const now = environment.clock.now();
  const callDurationMs = now - callStartedAt;
  if (callDurationMs > PROXY_PROCESS_CONTROL_CALL_MAX_MS) {
    throw reapFailure(`Recorded containment process-control call exceeded ${PROXY_PROCESS_CONTROL_CALL_MAX_MS}ms.`, {
      callDurationMs,
      limit: PROXY_PROCESS_CONTROL_CALL_MAX_MS,
    });
  }
  if (now > exitDeadline) {
    throw reapFailure('Recorded containment process-control call exceeded the exit deadline.', {
      exitDeadline,
      observedAt: now,
    });
  }
}

function signalRecordedSet(
  containment: RecordedContainmentIdentity,
  providerRoots: readonly RecordedProcessIdentity[],
  observation: RecordedSetObservation,
  signal: NodeJS.Signals,
  exitDeadline: number,
  environment: ProcessContainmentEnvironment,
): void {
  const callStartedAt = environment.clock.now();
  if (callStartedAt >= exitDeadline) {
    throw reapFailure(`Recorded containment had no time remaining for ${signal}.`, {
      exitDeadline,
      observedAt: callStartedAt,
    });
  }

  const signalPid = (pid: number): void => {
    assertSignalCallWithinBounds(callStartedAt, exitDeadline, environment);
    environment.process.kill(pid, signal);
    assertSignalCallWithinBounds(callStartedAt, exitDeadline, environment);
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

async function waitForAbsence(
  containment: RecordedContainmentIdentity,
  providerRoots: readonly RecordedProcessIdentity[],
  waitDeadline: number,
  environment: ProcessContainmentEnvironment,
): Promise<boolean> {
  while (true) {
    if (allRecordedTargetsAbsent(observeRecordedSet(containment, providerRoots, environment))) {
      return true;
    }
    const remainingMs = waitDeadline - environment.clock.now();
    if (remainingMs <= 0) return false;
    await environment.clock.sleep(Math.min(ABSENCE_POLL_MS, remainingMs));
  }
}

async function confirmAbsence(
  containment: RecordedContainmentIdentity,
  providerRoots: readonly RecordedProcessIdentity[],
  exitDeadline: number,
  environment: ProcessContainmentEnvironment,
): Promise<boolean> {
  const confirmationDeadline = environment.clock.now() + PROXY_DISAPPEARANCE_CONFIRM_MS;
  if (confirmationDeadline > exitDeadline) return false;

  while (environment.clock.now() < confirmationDeadline) {
    if (!allRecordedTargetsAbsent(observeRecordedSet(containment, providerRoots, environment))) {
      return false;
    }
    await environment.clock.sleep(Math.min(ABSENCE_POLL_MS, confirmationDeadline - environment.clock.now()));
  }
  return allRecordedTargetsAbsent(observeRecordedSet(containment, providerRoots, environment));
}

/**
 * Reaps exactly the recorded proxy group and provider-root identities before one absolute deadline.
 */
export async function reapRecordedContainment(
  containment: RecordedContainmentIdentity,
  providerRoots: readonly RecordedProcessIdentity[],
  exitDeadline: number,
  environment: ProcessContainmentEnvironment,
): Promise<void> {
  assertRecordedSet(containment, providerRoots, exitDeadline);

  let observation = observeRecordedSet(containment, providerRoots, environment);
  if (allRecordedTargetsAbsent(observation)) {
    if (await confirmAbsence(containment, providerRoots, exitDeadline, environment)) return;
    throw reapFailure('Recorded containment absence could not be confirmed before the exit deadline.');
  }

  signalRecordedSet(containment, providerRoots, observation, 'SIGTERM', exitDeadline, environment);
  const termWaitDeadline = Math.min(exitDeadline, environment.clock.now() + SIGTERM_GRACE_MS);
  if (await waitForAbsence(containment, providerRoots, termWaitDeadline, environment)) {
    if (await confirmAbsence(containment, providerRoots, exitDeadline, environment)) return;
    throw reapFailure('Recorded containment absence could not be confirmed before the exit deadline.');
  }

  observation = observeRecordedSet(containment, providerRoots, environment);
  signalRecordedSet(containment, providerRoots, observation, 'SIGKILL', exitDeadline, environment);
  const killWaitDeadline = Math.min(exitDeadline, environment.clock.now() + SIGKILL_GRACE_MS);
  if (
    (await waitForAbsence(containment, providerRoots, killWaitDeadline, environment)) &&
    (await confirmAbsence(containment, providerRoots, exitDeadline, environment))
  ) {
    return;
  }

  throw reapFailure('Recorded containment remained present at the exit deadline.', {
    exitDeadline,
    observedAt: environment.clock.now(),
  });
}

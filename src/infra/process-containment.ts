import { z } from 'zod';

import {
  incarnationMayAuthorizeSignal,
  isProcessIncarnation,
  MAX_PROCESS_INCARNATION_LENGTH,
  probeProcessIncarnation,
  type AsyncRecordedProcessObserver,
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
import type { ProcessIdentityObservation } from './port-types.js';

/** How often a disappearance wait re-observes its targets. Shared by every caller that polls for a signalled
 *  process or process group to disappear, so the poll interval has exactly one owner rather than being
 *  hand-retyped per caller and drifting the moment one of them changes without the others. */
export const ABSENCE_POLL_MS = 25;

/** A recorded process identity that is safe to target only while both fields match. */
export type RecordedProcessIdentity = Readonly<{
  pid: number;
  incarnation: ProcessIncarnation;
}>;

export const recordedProcessIdentitySchema: z.ZodType<RecordedProcessIdentity> = z
  .object({
    pid: z.number().int().positive().safe(),
    incarnation: z.string().min(1).max(MAX_PROCESS_INCARNATION_LENGTH) as unknown as z.ZodType<ProcessIncarnation>,
  })
  .strict()
  .readonly();

/** A detached process leader and the process group it established. */
export type RecordedContainmentIdentity = RecordedProcessIdentity &
  Readonly<{
    processGroupId: number;
  }>;

export type RecordedContainmentObservationSubject = RecordedContainmentIdentity &
  Readonly<{
    childRoot: RecordedProcessIdentity | null;
  }>;

/** Observation authority must not expose process-control capability. */
export type ProcessContainmentObservationEnvironment = {
  readonly process: {
    observeLiveness(pid: number): ProcessLiveness;
    readonly observeRecordedProcessAsync?: AsyncRecordedProcessObserver;
    readonly observeProcessIdentities?: (
      owners: readonly RecordedProcessIdentity[],
      deadlineMs: number,
    ) => Promise<readonly ProcessIdentityObservation[]>;
  };
  readonly platform: NodeJS.Platform;
  readonly readProcessIncarnation?: (pid: number, platform: NodeJS.Platform) => ProcessIncarnation | null;
};

/** Runtime capabilities required to reap one recorded containment. */
export type ProcessContainmentEnvironment<Scope extends symbol> = ProcessContainmentObservationEnvironment & {
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
  readonly knownLiveChildFor?: (pid: number) =>
    | Readonly<{
        pid: number;
        hasExited(): boolean;
      }>
    | undefined;
  /** Revalidates the caller's authority immediately before each process-control signal. */
  readonly assertSignalAuthorized?: () => void;
  /** Reports only signals whose process-control call returned success. */
  readonly onSignal?: (effect: Readonly<{ pid: number; signal: NodeJS.Signals }>) => void;
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

type TargetObservation = 'absent' | 'present' | 'recorded-group-unattributable';

type RecordedSetObservation = Readonly<{
  containment: TargetObservation;
  recordedRoots: readonly TargetObservation[];
}>;

type RecordedSetAbsenceVerdict = 'absent' | 'not-confirmed' | 'recorded-group-unattributable';

type AsyncTargetObservation =
  | Readonly<{ kind: 'observed'; observation: TargetObservation }>
  | Readonly<{ kind: 'unobservable'; reason: 'deadline' | 'identity' }>;

type AsyncRecordedSetObservation =
  | Readonly<{ kind: 'observed'; observation: RecordedSetObservation }>
  | Readonly<{ kind: 'unobservable'; reason: 'deadline' | 'identity' }>;

type AsyncRecordedSetAbsenceVerdict = RecordedSetAbsenceVerdict | 'unobservable-deadline' | 'unobservable-identity';

function throwObservationFailure(reason: 'deadline' | 'identity', deadlineName: string): never {
  if (reason === 'deadline') {
    throw reapFailure(`Recorded containment observation could not complete before the ${deadlineName}.`);
  }
  throw new ProcessContainmentError(
    'process_identity_unverified',
    'Recorded containment liveness could not be observed.',
  );
}

function requireObservedSet(result: AsyncRecordedSetObservation, deadlineName: string): RecordedSetObservation {
  if (result.kind === 'unobservable') throwObservationFailure(result.reason, deadlineName);
  return result.observation;
}

function requireAbsenceVerdict(
  verdict: AsyncRecordedSetAbsenceVerdict,
  deadlineName: string,
): RecordedSetAbsenceVerdict {
  if (verdict === 'unobservable-deadline') throwObservationFailure('deadline', deadlineName);
  if (verdict === 'unobservable-identity') throwObservationFailure('identity', deadlineName);
  return verdict;
}

export type RecordedContainmentObservation =
  | Readonly<{ kind: 'alive' }>
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'unobservable'; reason: string }>;

export type RecordedContainmentAbortResult =
  | Readonly<{ kind: 'accepted' }>
  | Readonly<{ kind: 'refused'; reason: string }>;

export type RecordedContainmentReapResult =
  | Readonly<{ kind: 'containment-absent' }>
  | Readonly<{ kind: 'recorded-group-unattributable' }>;

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

function readIncarnation(
  identity: RecordedProcessIdentity,
  environment: ProcessContainmentObservationEnvironment,
): ProcessIncarnation | null {
  const read = environment.readProcessIncarnation ?? probeProcessIncarnation;
  try {
    return read(identity.pid, environment.platform);
  } catch {
    return null;
  }
}

function observeProcessIdentity(
  identity: RecordedProcessIdentity,
  environment: ProcessContainmentObservationEnvironment,
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

function observeContainment(
  containment: RecordedContainmentIdentity,
  environment: ProcessContainmentObservationEnvironment,
): TargetObservation {
  const observedIncarnation = readIncarnation(containment, environment);
  if (observedIncarnation !== null && observedIncarnation !== containment.incarnation) {
    // A mismatched incarnation proves that pid no longer identifies the recorded leader, not that every member
    // of its old group is gone. The group probe may prove absence, but observed life or an unanswered probe
    // cannot prove the numeric group is still ours and therefore authorizes no signal. This can strand original
    // members: the guarantee is never to signal the wrong group, not always to reap ours.
    return environment.process.observeLiveness(-containment.processGroupId) === 'absent'
      ? 'absent'
      : 'recorded-group-unattributable';
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

function observeRecordedSetSynchronously(
  containment: RecordedContainmentIdentity,
  recordedRoots: readonly RecordedProcessIdentity[],
  environment: ProcessContainmentObservationEnvironment,
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

function observationMayStart<Scope extends symbol>(
  deadline: MonotonicInstant<Scope>,
  environment: ProcessContainmentEnvironment<Scope>,
  allowAtDeadline = false,
): boolean {
  const comparison = environment.clock.compare(environment.clock.now(), deadline);
  return comparison < 0 || (allowAtDeadline && comparison === 0);
}

async function observeProcessIdentityAsync<Scope extends symbol>(
  identity: RecordedProcessIdentity,
  deadline: MonotonicInstant<Scope>,
  environment: ProcessContainmentEnvironment<Scope>,
  allowAtDeadline = false,
): Promise<AsyncTargetObservation> {
  if (!observationMayStart(deadline, environment, allowAtDeadline)) {
    return { kind: 'unobservable', reason: 'deadline' };
  }
  if (knownLiveChildMayAuthorizeSignal(identity, environment)) {
    return { kind: 'observed', observation: 'present' };
  }
  const observe = environment.process.observeRecordedProcessAsync;
  let liveness: ProcessLiveness;
  if (observe !== undefined) {
    liveness = await observe(identity, environment.signal);
  } else {
    const observeMany = environment.process.observeProcessIdentities;
    if (observeMany !== undefined) {
      const remainingMs = environment.clock.millisecondsBetween(environment.clock.now(), deadline);
      const [result] = await observeMany([identity], remainingMs);
      if (result === undefined || result.evidence.kind === 'unobservable') {
        return { kind: 'unobservable', reason: 'identity' };
      }
      liveness =
        result.evidence.kind === 'pid-absent' || result.evidence.incarnation !== identity.incarnation
          ? 'absent'
          : 'alive';
    } else {
      return { kind: 'unobservable', reason: 'identity' };
    }
  }
  assertContainmentAuthorized(environment.signal);
  if (environment.clock.compare(environment.clock.now(), deadline) > 0) {
    return { kind: 'unobservable', reason: 'deadline' };
  }
  if (liveness === 'unknown') return { kind: 'unobservable', reason: 'identity' };
  return { kind: 'observed', observation: liveness === 'alive' ? 'present' : 'absent' };
}

async function observeContainmentAsync<Scope extends symbol>(
  containment: RecordedContainmentIdentity,
  deadline: MonotonicInstant<Scope>,
  environment: ProcessContainmentEnvironment<Scope>,
  allowAtDeadline = false,
): Promise<AsyncTargetObservation> {
  const leader = await observeProcessIdentityAsync(containment, deadline, environment, allowAtDeadline);
  if (leader.kind === 'unobservable') return leader;
  if (!observationMayStart(deadline, environment, allowAtDeadline)) {
    return { kind: 'unobservable', reason: 'deadline' };
  }

  const groupLiveness = environment.process.observeLiveness(-containment.processGroupId);
  if (groupLiveness === 'unknown') {
    return leader.observation === 'absent'
      ? { kind: 'observed', observation: 'recorded-group-unattributable' }
      : { kind: 'unobservable', reason: 'identity' };
  }
  if (groupLiveness === 'absent') return { kind: 'observed', observation: 'absent' };
  return leader.observation === 'present'
    ? { kind: 'observed', observation: 'present' }
    : { kind: 'observed', observation: 'recorded-group-unattributable' };
}

async function observeRecordedSet<Scope extends symbol>(
  containment: RecordedContainmentIdentity,
  recordedRoots: readonly RecordedProcessIdentity[],
  deadline: MonotonicInstant<Scope>,
  environment: ProcessContainmentEnvironment<Scope>,
): Promise<AsyncRecordedSetObservation> {
  const containmentResult = await observeContainmentAsync(containment, deadline, environment);
  if (containmentResult.kind === 'unobservable') return containmentResult;
  if (containmentResult.observation === 'recorded-group-unattributable') {
    return {
      kind: 'observed',
      observation: { containment: containmentResult.observation, recordedRoots: [] },
    };
  }

  const roots: TargetObservation[] = [];
  for (const root of recordedRoots) {
    const result = await observeProcessIdentityAsync(root, deadline, environment);
    if (result.kind === 'unobservable') return result;
    roots.push(result.observation);
  }
  return {
    kind: 'observed',
    observation: { containment: containmentResult.observation, recordedRoots: roots },
  };
}

async function observeRecordedSetAbsence<Scope extends symbol>(
  containment: RecordedContainmentIdentity,
  recordedRoots: readonly RecordedProcessIdentity[],
  deadline: MonotonicInstant<Scope>,
  environment: ProcessContainmentEnvironment<Scope>,
  allowAtDeadline = false,
): Promise<AsyncRecordedSetAbsenceVerdict> {
  const containmentResult = await observeContainmentAsync(containment, deadline, environment, allowAtDeadline);
  if (containmentResult.kind === 'unobservable') return `unobservable-${containmentResult.reason}`;
  if (containmentResult.observation === 'recorded-group-unattributable') {
    return 'recorded-group-unattributable';
  }
  if (containmentResult.observation === 'present') return 'not-confirmed';

  for (const root of recordedRoots) {
    const result = await observeProcessIdentityAsync(root, deadline, environment, allowAtDeadline);
    if (result.kind === 'unobservable') return `unobservable-${result.reason}`;
    if (result.observation !== 'absent') return 'not-confirmed';
  }
  return 'absent';
}

function allRecordedTargetsAbsent(observation: RecordedSetObservation): boolean {
  return observation.containment === 'absent' && observation.recordedRoots.every((root) => root === 'absent');
}

function recordedSetAbsenceVerdict(observation: RecordedSetObservation): RecordedSetAbsenceVerdict {
  if (observation.containment === 'recorded-group-unattributable') return 'recorded-group-unattributable';
  return allRecordedTargetsAbsent(observation) ? 'absent' : 'not-confirmed';
}

/** Absence requires the group and every recorded root to be absent; unanswerable evidence remains unobservable. */
export function observeRecordedContainment(
  subject: RecordedContainmentObservationSubject,
  environment: ProcessContainmentObservationEnvironment,
): RecordedContainmentObservation {
  try {
    const recordedRoots = subject.childRoot === null ? [] : [subject.childRoot];
    assertRecordedSet(subject, recordedRoots, 1);
    const verdict = recordedSetAbsenceVerdict(observeRecordedSetSynchronously(subject, recordedRoots, environment));
    if (verdict === 'absent') return { kind: 'absent' };
    if (verdict === 'not-confirmed') return { kind: 'alive' };
    return { kind: 'unobservable', reason: 'the recorded process group is no longer attributable' };
  } catch (error: unknown) {
    return {
      kind: 'unobservable',
      reason: error instanceof Error ? error.message : 'recorded containment observation failed',
    };
  }
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

type RecordedSetSignalResult = Readonly<{ kind: 'delivered'; count: number }> | Readonly<{ kind: 'refused' }>;

function knownLiveChildMayAuthorizeSignal<Scope extends symbol>(
  identity: RecordedProcessIdentity,
  environment: ProcessContainmentEnvironment<Scope>,
): boolean {
  const child = environment.knownLiveChildFor?.(identity.pid);
  return child?.pid === identity.pid && child.hasExited() === false;
}

function identityMayAuthorizeSignal<Scope extends symbol>(
  identity: RecordedProcessIdentity,
  environment: ProcessContainmentEnvironment<Scope>,
): boolean {
  if (!incarnationMayAuthorizeSignal(environment.platform))
    return knownLiveChildMayAuthorizeSignal(identity, environment);
  return true;
}

function deliverSignal<Scope extends symbol>(
  pid: number,
  signal: NodeJS.Signals,
  exitDeadline: MonotonicInstant<Scope>,
  environment: ProcessContainmentEnvironment<Scope>,
): boolean {
  const callStartedAt = environment.clock.now();
  assertContainmentAuthorized(environment.signal);
  assertSignalCallWithinBounds(callStartedAt, exitDeadline, environment);
  environment.assertSignalAuthorized?.();
  const delivered = environment.process.kill(pid, signal);
  if (delivered) environment.onSignal?.({ pid, signal });
  assertSignalCallWithinBounds(callStartedAt, exitDeadline, environment);
  return delivered;
}

async function signalRecordedSet<Scope extends symbol>(
  containment: RecordedContainmentIdentity,
  recordedRoots: readonly RecordedProcessIdentity[],
  observation: RecordedSetObservation,
  signal: NodeJS.Signals,
  exitDeadline: MonotonicInstant<Scope>,
  environment: ProcessContainmentEnvironment<Scope>,
): Promise<RecordedSetSignalResult> {
  assertContainmentAuthorized(environment.signal);
  if (environment.clock.compare(environment.clock.now(), exitDeadline) >= 0) {
    throw reapFailure(`Recorded containment had no time remaining for ${signal}.`, {
      remainingMs: environment.clock.millisecondsBetween(environment.clock.now(), exitDeadline),
    });
  }

  let delivered = 0;
  let refused = false;
  try {
    if (observation.containment === 'present') {
      const refreshed = await observeContainmentAsync(containment, exitDeadline, environment);
      if (refreshed.kind === 'unobservable' || refreshed.observation === 'recorded-group-unattributable') {
        return { kind: 'refused' };
      }
      if (refreshed.observation === 'present') {
        if (!identityMayAuthorizeSignal(containment, environment)) refused = true;
        else if (deliverSignal(-containment.processGroupId, signal, exitDeadline, environment)) delivered += 1;
      }
    }
    for (const [index, root] of recordedRoots.entries()) {
      if (observation.recordedRoots[index] !== 'present') continue;
      const refreshed = await observeProcessIdentityAsync(root, exitDeadline, environment);
      if (refreshed.kind === 'unobservable') return { kind: 'refused' };
      if (refreshed.observation !== 'present') continue;
      if (!identityMayAuthorizeSignal(root, environment)) {
        refused = true;
        continue;
      }
      if (deliverSignal(root.pid, signal, exitDeadline, environment)) delivered += 1;
    }
  } catch (error: unknown) {
    if (error instanceof ProcessContainmentError) throw error;
    throw reapFailure(`Recorded containment ${signal} delivery failed.`, { signal });
  }
  return refused ? { kind: 'refused' } : { kind: 'delivered', count: delivered };
}

function signalRecordedSetSynchronously<Scope extends symbol>(
  containment: RecordedContainmentIdentity,
  recordedRoots: readonly RecordedProcessIdentity[],
  observation: RecordedSetObservation,
  signal: NodeJS.Signals,
  exitDeadline: MonotonicInstant<Scope>,
  environment: ProcessContainmentEnvironment<Scope>,
): RecordedSetSignalResult {
  let delivered = 0;
  let refused = false;
  try {
    if (observation.containment === 'present' && observeContainment(containment, environment) === 'present') {
      if (!identityMayAuthorizeSignal(containment, environment)) refused = true;
      else if (deliverSignal(-containment.processGroupId, signal, exitDeadline, environment)) delivered += 1;
    }
    for (const [index, root] of recordedRoots.entries()) {
      if (observation.recordedRoots[index] === 'present' && observeProcessIdentity(root, environment) === 'present') {
        if (!identityMayAuthorizeSignal(root, environment)) {
          refused = true;
          continue;
        }
        if (deliverSignal(root.pid, signal, exitDeadline, environment)) delivered += 1;
      }
    }
  } catch (error: unknown) {
    if (error instanceof ProcessContainmentError) throw error;
    throw reapFailure(`Recorded containment ${signal} delivery failed.`, { signal });
  }
  return refused ? { kind: 'refused' } : { kind: 'delivered', count: delivered };
}

/** A recycled leader forbids every signal, and a signal attempt cannot erase a refusal disposition. */
export function abortRecordedContainment<Scope extends symbol>(
  subject: RecordedContainmentObservationSubject,
  exitDeadline: MonotonicInstant<Scope>,
  environment: ProcessContainmentEnvironment<Scope>,
): RecordedContainmentAbortResult {
  try {
    const recordedRoots = subject.childRoot === null ? [] : [subject.childRoot];
    assertRecordedSet(subject, recordedRoots, 1);
    const leaderIncarnation = readIncarnation(subject, environment);
    if (leaderIncarnation !== null && leaderIncarnation !== subject.incarnation) {
      return { kind: 'refused', reason: 'the recorded containment leader pid has been recycled' };
    }

    const observation = observeRecordedSetSynchronously(subject, recordedRoots, environment);
    const verdict = recordedSetAbsenceVerdict(observation);
    if (verdict === 'recorded-group-unattributable') {
      return { kind: 'refused', reason: 'the recorded process group is no longer attributable' };
    }
    if (verdict === 'absent') return { kind: 'accepted' };

    const delivery = signalRecordedSetSynchronously(
      subject,
      recordedRoots,
      observation,
      'SIGTERM',
      exitDeadline,
      environment,
    );
    const targeted =
      (observation.containment === 'present' ? 1 : 0) +
      observation.recordedRoots.filter((root) => root === 'present').length;
    if (delivery.kind === 'refused') {
      return { kind: 'refused', reason: 'the platform cannot authorize every recorded containment signal' };
    }
    if (delivery.count === targeted) return { kind: 'accepted' };

    return observeRecordedContainment(subject, environment).kind === 'absent'
      ? { kind: 'accepted' }
      : { kind: 'refused', reason: 'SIGTERM was not accepted for every recorded containment target' };
  } catch (error: unknown) {
    return {
      kind: 'refused',
      reason: error instanceof Error ? error.message : 'recorded containment abort was refused',
    };
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
): Promise<RecordedSetAbsenceVerdict> {
  while (true) {
    assertContainmentAuthorized(environment.signal);
    const remainingMs = environment.clock.millisecondsBetween(environment.clock.now(), waitDeadline);
    if (remainingMs <= 0) return 'not-confirmed';
    const verdict = requireAbsenceVerdict(
      await observeRecordedSetAbsence(containment, recordedRoots, waitDeadline, environment),
      'wait deadline',
    );
    if (verdict !== 'not-confirmed') return verdict;
    const remainingAfterObservationMs = environment.clock.millisecondsBetween(environment.clock.now(), waitDeadline);
    if (remainingAfterObservationMs <= 0) return 'not-confirmed';
    await sleepWhileAuthorized(Math.min(ABSENCE_POLL_MS, remainingAfterObservationMs), environment);
  }
}

async function confirmAbsence<Scope extends symbol>(
  containment: RecordedContainmentIdentity,
  recordedRoots: readonly RecordedProcessIdentity[],
  exitDeadline: MonotonicInstant<Scope>,
  environment: ProcessContainmentEnvironment<Scope>,
): Promise<RecordedSetAbsenceVerdict> {
  const confirmationDeadline = environment.clock.shiftMilliseconds(
    environment.clock.now(),
    CONTAINMENT_DISAPPEARANCE_CONFIRM_MS,
  );
  if (environment.clock.compare(confirmationDeadline, exitDeadline) > 0) return 'not-confirmed';

  while (environment.clock.compare(environment.clock.now(), confirmationDeadline) < 0) {
    assertContainmentAuthorized(environment.signal);
    const verdict = requireAbsenceVerdict(
      await observeRecordedSetAbsence(containment, recordedRoots, exitDeadline, environment),
      'exit deadline',
    );
    if (verdict !== 'absent') return verdict;
    const remainingMs = environment.clock.millisecondsBetween(environment.clock.now(), confirmationDeadline);
    await sleepWhileAuthorized(Math.max(0, Math.min(ABSENCE_POLL_MS, remainingMs)), environment);
  }
  return requireAbsenceVerdict(
    await observeRecordedSetAbsence(containment, recordedRoots, exitDeadline, environment, true),
    'exit deadline',
  );
}

/**
 * Reaps exactly the recorded group and additional recorded process identities before one absolute deadline.
 */
export async function reapRecordedContainment<Scope extends symbol>(
  containment: RecordedContainmentIdentity,
  recordedRoots: readonly RecordedProcessIdentity[],
  exitDeadline: MonotonicInstant<Scope>,
  environment: ProcessContainmentEnvironment<Scope>,
): Promise<RecordedContainmentReapResult> {
  assertContainmentAuthorized(environment.signal);
  assertRecordedSet(containment, recordedRoots, environment.maxRecordedRoots);

  let observationResult = await observeRecordedSet(containment, recordedRoots, exitDeadline, environment);
  let observation = requireObservedSet(observationResult, 'exit deadline');
  let verdict = recordedSetAbsenceVerdict(observation);
  if (verdict === 'recorded-group-unattributable') return { kind: verdict };
  if (verdict === 'absent') {
    verdict = await confirmAbsence(containment, recordedRoots, exitDeadline, environment);
    if (verdict === 'recorded-group-unattributable') return { kind: verdict };
    if (verdict === 'absent') return { kind: 'containment-absent' };
    throw reapFailure('Recorded containment absence could not be confirmed before the exit deadline.');
  }

  let delivery = await signalRecordedSet(containment, recordedRoots, observation, 'SIGTERM', exitDeadline, environment);
  if (delivery.kind === 'refused') return { kind: 'recorded-group-unattributable' };
  const termWaitDeadline = environment.clock.earlier(
    exitDeadline,
    environment.clock.shiftMilliseconds(environment.clock.now(), SIGTERM_GRACE_MS),
  );
  verdict = await waitForAbsence(containment, recordedRoots, termWaitDeadline, environment);
  if (verdict === 'recorded-group-unattributable') return { kind: verdict };
  if (verdict === 'absent') {
    verdict = await confirmAbsence(containment, recordedRoots, exitDeadline, environment);
    if (verdict === 'recorded-group-unattributable') return { kind: verdict };
    if (verdict === 'absent') return { kind: 'containment-absent' };
    throw reapFailure('Recorded containment absence could not be confirmed before the exit deadline.');
  }

  assertContainmentAuthorized(environment.signal);
  observationResult = await observeRecordedSet(containment, recordedRoots, exitDeadline, environment);
  observation = requireObservedSet(observationResult, 'exit deadline');
  delivery = await signalRecordedSet(containment, recordedRoots, observation, 'SIGKILL', exitDeadline, environment);
  if (delivery.kind === 'refused') return { kind: 'recorded-group-unattributable' };
  const killWaitDeadline = environment.clock.earlier(
    exitDeadline,
    environment.clock.shiftMilliseconds(environment.clock.now(), SIGKILL_GRACE_MS),
  );
  verdict = await waitForAbsence(containment, recordedRoots, killWaitDeadline, environment);
  if (verdict === 'recorded-group-unattributable') return { kind: verdict };
  if (verdict === 'absent') {
    verdict = await confirmAbsence(containment, recordedRoots, exitDeadline, environment);
    if (verdict === 'recorded-group-unattributable') return { kind: verdict };
    if (verdict === 'absent') return { kind: 'containment-absent' };
  }

  throw reapFailure('Recorded containment remained present at the exit deadline.', {
    remainingMs: environment.clock.millisecondsBetween(environment.clock.now(), exitDeadline),
  });
}

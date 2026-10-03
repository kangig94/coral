import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

import { readDiscoveryRecordDisposition, type CoordinatorDiscoveryRecord } from '../infra/backend-discovery.js';
import { updateLaunchStatus, type LaunchStatus } from '../infra/launch-status.js';
import {
  listLaunchSubjects,
  observeLaunchSubject,
  removeAbsentLaunchSubject,
  removeAbandonedLaunchPreparations,
  repairDamagedLaunchSubject,
  type LaunchSubject,
  type LaunchAdmission,
} from '../infra/launch-admission-record.js';
import { observeProcessLiveness, probeProcessIncarnation, type ProcessIncarnation } from '../infra/node-process.js';
import { readUpgradeIntent } from '../infra/upgrade-intent.js';
import { createRealRuntime } from '../runtime/real.js';
import { childHasExited } from './child-state.js';

export type LaunchProcess = Readonly<{ pid: number; incarnation: ProcessIncarnation }>;
export type LaunchOwner = Readonly<{
  id: string;
  process: LaunchProcess;
  buildSetId: string;
  mode: 'supervised' | 'recovering';
}>;
export type LaunchReservation = Readonly<{
  id: string;
  buildSetId: string;
  purpose: 'startup' | 'contender' | 'succession' | 'recovery' | 'legacy-retirement';
  phase: 'reserved' | 'admitted' | 'serving' | 'exited';
  admittedAt?: number;
  admittedMonotonicMs?: number;
  attemptDeadline?: number;
  admissionProven?: boolean;
  unidentifiedPid?: number;
  recoveryHold?: 'envelope-conflict' | 'timing-unavailable' | 'identity-unavailable';
  observedHealthyAt?: number;
  parent?: LaunchProcess;
  child?: LaunchProcess;
  terminationAt?: number;
  killAt?: number;
  killMonotonicAt?: number;
  termDelivered?: boolean;
  killDelivered?: boolean;
}>;

export type ChildWatchState = {
  armed: boolean;
  pendingHello: boolean;
  lastAnswer: number;
  lastWake: number;
  outstanding: number | null;
  sequence: number;
  escalationAt: number | null;
  killed: boolean;
  lastKillAttemptAt: number;
  wedged: boolean;
  dStateSince: number | null;
  served: boolean;
  discovered: boolean;
  admitted: boolean;
  startupDeadline: number;
  servingObservation: boolean | 'unknown';
  disconnectedAt: number | null;
};
export type ChildRetirement = { at: number | null };
type InheritedWatch = {
  firstSeen: number;
  lastHealthy: number;
  uninterruptibleSince: number | null;
  terminationAt: number | null;
};

type SupervisorState = Readonly<{
  owner: LaunchOwner;
  launch: LaunchReservation | null;
  attempt: LaunchReservation | null;
}>;

function identityDisposition(identity: LaunchProcess): 'matching' | 'absent' | 'unknown' {
  if (childHasExited(identity.pid)) return 'absent';
  const observed = probeProcessIncarnation(identity.pid);
  if (observed !== null) return observed === identity.incarnation ? 'matching' : 'absent';
  return observeProcessLiveness(identity.pid) === 'absent' ? 'absent' : 'unknown';
}

function reservationKey(slot: LaunchReservation): string {
  return JSON.stringify([slot.id, slot.child?.pid ?? slot.unidentifiedPid, slot.child?.incarnation]);
}

function sameReservation(left: LaunchReservation, right: LaunchReservation): boolean {
  return reservationKey(left) === reservationKey(right);
}

function refinableReservation(left: LaunchReservation, right: LaunchReservation): boolean {
  if (sameReservation(left, right)) return true;
  if (left.id !== right.id) return false;
  if (left.child === undefined && right.child !== undefined) return left.unidentifiedPid === right.child.pid;
  if (right.child === undefined && left.child !== undefined) return right.unidentifiedPid === left.child.pid;
  return false;
}

function mergeReservationEvidence(known: LaunchReservation, entry: LaunchReservation): LaunchReservation {
  const conflict =
    (known.buildSetId !== 'unknown' && entry.buildSetId !== 'unknown' && known.buildSetId !== entry.buildSetId) ||
    (known.admittedAt !== undefined && entry.admittedAt !== undefined && known.admittedAt !== entry.admittedAt) ||
    (known.admittedMonotonicMs !== undefined &&
      entry.admittedMonotonicMs !== undefined &&
      known.admittedMonotonicMs !== entry.admittedMonotonicMs) ||
    (known.parent !== undefined &&
      entry.parent !== undefined &&
      (known.parent.pid !== entry.parent.pid || known.parent.incarnation !== entry.parent.incarnation)) ||
    known.purpose !== entry.purpose ||
    (known.attemptDeadline !== undefined &&
      entry.attemptDeadline !== undefined &&
      known.attemptDeadline !== entry.attemptDeadline);
  if (conflict) return { ...known, recoveryHold: 'envelope-conflict' };
  return {
    ...entry,
    ...known,
    buildSetId: known.buildSetId === 'unknown' ? entry.buildSetId : known.buildSetId,
    child: known.child ?? entry.child,
    unidentifiedPid: known.child !== undefined || entry.child !== undefined ? undefined : known.unidentifiedPid,
    admittedAt: known.admittedAt ?? entry.admittedAt,
    admittedMonotonicMs: known.admittedMonotonicMs ?? entry.admittedMonotonicMs,
    parent: known.parent ?? entry.parent,
    admissionProven: known.admissionProven === true || entry.admissionProven === true,
    phase:
      known.phase === 'serving' || entry.phase === 'serving'
        ? 'serving'
        : known.phase === 'admitted'
          ? 'admitted'
          : entry.phase,
    attemptDeadline: known.attemptDeadline ?? entry.attemptDeadline,
    recoveryHold:
      known.recoveryHold === 'envelope-conflict'
        ? known.recoveryHold
        : entry.recoveryHold === 'identity-unavailable' && (known.child !== undefined || entry.child !== undefined)
          ? undefined
          : entry.recoveryHold,
  };
}

function matchesReservation(current: LaunchReservation, reference: LaunchReservation): boolean {
  return (
    current.id === reference.id &&
    ((reference.child === undefined && reference.unidentifiedPid === undefined) || sameReservation(current, reference))
  );
}

function reservationDisposition(slot: LaunchReservation): 'matching' | 'absent' | 'unknown' {
  if (slot.child !== undefined) return identityDisposition(slot.child);
  if (slot.unidentifiedPid === undefined) return 'unknown';
  return childHasExited(slot.unidentifiedPid) || observeProcessLiveness(slot.unidentifiedPid) === 'absent'
    ? 'absent'
    : 'unknown';
}

function fromAdmission(admission: LaunchAdmission): LaunchReservation {
  return {
    id: admission.launchId,
    buildSetId: admission.build.buildSetId,
    purpose: admission.purpose,
    phase: 'admitted',
    admittedAt: admission.admittedAt,
    admittedMonotonicMs: admission.admittedMonotonicMs,
    admissionProven: true,
    parent: admission.parent,
    child: admission.child,
  };
}

function discoveryLaunchReservation(record: CoordinatorDiscoveryRecord): LaunchReservation {
  const identity =
    record.incarnation === undefined
      ? { unidentifiedPid: record.pid, recoveryHold: 'identity-unavailable' as const }
      : { child: { pid: record.pid, incarnation: record.incarnation } };
  const { supervision } = record;
  if (supervision === undefined) {
    return {
      id: `discovery:${record.bootToken}`,
      buildSetId: 'unknown',
      purpose: 'legacy-retirement',
      phase: 'serving',
      ...identity,
    };
  }
  return {
    id: supervision.launchId,
    buildSetId: supervision.buildSetId,
    purpose: supervision.purpose,
    phase: 'admitted',
    admittedAt: supervision.admittedAt,
    parent: supervision.parent,
    ...identity,
  };
}

function discoveryBuildConflicts(
  admitted: LaunchAdmission,
  discovered: LaunchReservation,
  record: CoordinatorDiscoveryRecord,
): boolean {
  return (
    admitted.build.buildSetId !== discovered.buildSetId ||
    admitted.build.bundleHash !== record.bundleHash ||
    admitted.build.flavor !== record.flavor ||
    (record.version !== undefined && admitted.build.version !== record.version)
  );
}

function discoveryAdmissionConflicts(
  admitted: LaunchAdmission | undefined,
  discovered: LaunchReservation,
  record: CoordinatorDiscoveryRecord,
): admitted is LaunchAdmission {
  return (
    admitted !== undefined &&
    (admitted.admittedAt !== discovered.admittedAt ||
      discoveryBuildConflicts(admitted, discovered, record) ||
      admitted.purpose !== discovered.purpose ||
      admitted.parent?.pid !== discovered.parent?.pid ||
      admitted.parent?.incarnation !== discovered.parent?.incarnation ||
      admitted.child.pid !== record.pid ||
      (record.incarnation !== undefined && admitted.child.incarnation !== record.incarnation))
  );
}

export class SupervisorLaunchMemory {
  #state: SupervisorState;
  readonly #runDir: string;
  #authority = true;
  readonly #childWatches = new Map<string, ChildWatchState>();
  readonly #childRetirements = new Map<string, ChildRetirement>();
  readonly inheritedWatch = new Map<string, InheritedWatch>();
  #subjects: LaunchSubject[] = [];
  readonly #settledSubjects = new Map<string, LaunchSubject>();
  readonly #servedBuilds = new Set<string>();
  #retained: LaunchReservation[] = [];

  constructor(runDir: string, process: LaunchProcess, buildSetId: string) {
    this.#runDir = runDir;
    this.#subjects = listLaunchSubjects(runDir);
    const unsettled = this.#subjects.filter((subject) => observeLaunchSubject(subject) !== 'absent');
    const admissions = unsettled.flatMap((subject) =>
      [subject.admission, subject.conflictingAdmission].flatMap((admission) =>
        admission === undefined
          ? []
          : [
              {
                ...fromAdmission(admission),
                ...(subject.problem === 'envelope-conflict' ? { recoveryHold: 'envelope-conflict' as const } : {}),
              },
            ],
      ),
    );
    const discovered = this.#discoveredChild();
    if (discovered !== null) admissions.push(discovered);
    const intent = readUpgradeIntent(runDir);
    const incumbent = intent.kind === 'readable' ? intent.intent.incumbent : null;
    let incumbentSlot: LaunchReservation | undefined;
    if (incumbent !== null) {
      incumbentSlot =
        incumbent.incarnation === null
          ? undefined
          : admissions.find(
              (entry) => entry.child?.pid === incumbent.pid && entry.child.incarnation === incumbent.incarnation,
            );
      if (incumbentSlot === undefined) {
        incumbentSlot = {
          id: `incumbent:${incumbent.instanceId}:${incumbent.incarnation}`,
          buildSetId: 'unknown',
          purpose: 'legacy-retirement',
          phase: 'serving',
          ...(incumbent.incarnation === null
            ? { unidentifiedPid: incumbent.pid, recoveryHold: 'identity-unavailable' as const }
            : { child: { pid: incumbent.pid, incarnation: incumbent.incarnation } }),
        };
        if (reservationDisposition(incumbentSlot) !== 'absent') admissions.push(incumbentSlot);
        else incumbentSlot = undefined;
      }
    }
    const attemptIdentity = intent.kind === 'readable' ? intent.intent.attemptChild : null;
    let attemptSlot: LaunchReservation | undefined;
    if (attemptIdentity !== null && attemptIdentity !== undefined && intent.kind === 'readable') {
      attemptSlot =
        attemptIdentity.incarnation === null
          ? undefined
          : admissions.find(
              (entry) =>
                entry.child?.pid === attemptIdentity.pid && entry.child.incarnation === attemptIdentity.incarnation,
            );
      const deadline = intent.intent.attemptDeadline === null ? undefined : Date.parse(intent.intent.attemptDeadline);
      if (attemptSlot === undefined) {
        attemptSlot = {
          id: `attempt:${attemptIdentity.attemptId}`,
          buildSetId: intent.intent.target.build.buildSetId,
          purpose: 'succession',
          phase: 'reserved',
          attemptDeadline: deadline,
          recoveryHold: attemptIdentity.incarnation === null ? 'identity-unavailable' : 'timing-unavailable',
          ...(attemptIdentity.incarnation === null
            ? { unidentifiedPid: attemptIdentity.pid }
            : { child: { pid: attemptIdentity.pid, incarnation: attemptIdentity.incarnation } }),
        };
        if (reservationDisposition(attemptSlot) !== 'absent') admissions.push(attemptSlot);
        else attemptSlot = undefined;
      } else {
        const index = admissions.indexOf(attemptSlot);
        const receipt = intent.intent.completionReceipt;
        const servingCommitted =
          receipt?.kind === 'serving' &&
          receipt.attemptId === attemptIdentity.attemptId &&
          receipt.successor.pid === attemptIdentity.pid &&
          receipt.successor.incarnation === attemptIdentity.incarnation &&
          receipt.successor.build.buildSetId === attemptSlot.buildSetId;
        attemptSlot = {
          ...attemptSlot,
          ...(servingCommitted ? { phase: 'serving' as const } : {}),
          attemptDeadline: deadline,
          ...(attemptSlot.buildSetId !== intent.intent.target.build.buildSetId
            ? { recoveryHold: 'envelope-conflict' as const }
            : {}),
        };
        admissions[index] = attemptSlot;
      }
    }
    const unique: LaunchReservation[] = [];
    for (const entry of admissions) {
      const index = unique.findIndex((known) => refinableReservation(known, entry));
      if (index < 0) unique.push(entry);
      else unique[index] = mergeReservationEvidence(unique[index], entry);
    }
    for (let index = 0; index < unique.length; index++) {
      if (unique.some((other, otherIndex) => otherIndex !== index && other.id === unique[index].id))
        unique[index] = { ...unique[index], recoveryHold: 'envelope-conflict' };
    }
    const attempt =
      (attemptSlot === undefined ? undefined : unique.find((entry) => sameReservation(entry, attemptSlot))) ??
      unique.find((entry) => entry.purpose === 'succession' || entry.purpose === 'contender') ??
      null;
    const launch =
      (incumbentSlot === undefined
        ? undefined
        : unique.find((entry) => entry !== attempt && sameReservation(entry, incumbentSlot))) ??
      unique.find((entry) => entry !== attempt) ??
      attempt;
    this.#retained = unique.filter((entry) => entry !== launch && entry !== attempt);
    this.#state = {
      owner: {
        id: randomUUID(),
        process,
        buildSetId,
        mode:
          unique.length > 0 || unsettled.length > 0 || (intent.kind !== 'readable' && intent.kind !== 'absent')
            ? 'recovering'
            : 'supervised',
      },
      launch,
      attempt: launch === attempt ? null : attempt,
    };
  }

  #discoveredChild(): LaunchReservation | null {
    const runDir = this.#runDir;
    const runtime = createRealRuntime(runDir.endsWith('run-dev') ? 'dev' : 'prod', {
      baseDir: dirname(dirname(runDir)),
    });
    const discovery = readDiscoveryRecordDisposition(runtime, join(runDir, 'coordinator.json'));
    if (discovery.kind !== 'record') return null;
    const discovered = discoveryLaunchReservation(discovery.record);
    if (discovery.record.supervision === undefined)
      return reservationDisposition(discovered) === 'absent' ? null : discovered;
    const subject = this.#subjects.find((entry) => entry.admission?.launchId === discovered.id);
    const admitted = subject?.admission;
    if (discoveryAdmissionConflicts(admitted, discovered, discovery.record) && subject !== undefined) {
      this.#subjects = this.#subjects.map((entry) =>
        entry === subject ? { ...entry, problem: 'envelope-conflict' } : entry,
      );
      if (admitted?.child.pid === discovered.child?.pid && admitted.child.incarnation === discovered.child.incarnation)
        return null;
      return { ...discovered, recoveryHold: 'envelope-conflict' };
    }
    return reservationDisposition(discovered) === 'absent' ? null : discovered;
  }

  childWatch(reservation: LaunchReservation, startupBudgetMs: number): ChildWatchState {
    const existing = this.#childWatches.get(reservation.id);
    if (existing !== undefined) return existing;
    const lastAnswer = Number(process.hrtime.bigint() / 1_000_000n);
    const state: ChildWatchState = {
      armed: false,
      pendingHello: false,
      lastAnswer,
      lastWake: lastAnswer,
      outstanding: null,
      sequence: 0,
      escalationAt: null,
      killed: false,
      lastKillAttemptAt: 0,
      wedged: false,
      dStateSince: null,
      served: false,
      discovered: false,
      admitted: false,
      startupDeadline: lastAnswer + startupBudgetMs,
      servingObservation: false,
      disconnectedAt: null,
    };
    this.#childWatches.set(reservation.id, state);
    return state;
  }

  childRetirement(reservation: LaunchReservation): ChildRetirement {
    const existing = this.#childRetirements.get(reservation.id);
    if (existing !== undefined) return existing;
    const retirement: ChildRetirement = { at: null };
    this.#childRetirements.set(reservation.id, retirement);
    return retirement;
  }

  hasAuthority(owner: LaunchOwner): boolean {
    return this.#authority && owner.id === this.#state.owner.id;
  }

  authorityLease(release: () => void): () => void {
    const authority = this.#state.owner;
    return () => {
      if (authority.id === this.#state.owner.id) this.suspendAuthority();
      release();
    };
  }

  suspendAuthority(): void {
    this.#authority = false;
  }

  resumeAuthority(): void {
    this.#reconcileAdmissions();
    const recovered = new SupervisorLaunchMemory(this.#runDir, this.#state.owner.process, this.#state.owner.buildSetId);
    const merged = new Map<string, LaunchReservation>();
    for (const slot of [...recovered.children(), ...this.children()]) {
      if (slot.phase === 'exited') continue;
      const key = reservationKey(slot);
      const known = merged.get(key);
      merged.set(key, known === undefined ? slot : mergeReservationEvidence(known, slot));
    }
    const slots = [...merged.values()];
    this.#state = {
      owner: { ...this.#state.owner, id: randomUUID(), mode: recovered.read().owner.mode },
      launch: slots[0] ?? null,
      attempt: slots[1] ?? null,
    };
    this.#retained = slots.slice(2);
    this.#reconcileAdmissions();
    this.#authority = true;
  }

  reconcileAdmissions(): void {
    if (this.#authority) this.#reconcileAdmissions();
  }

  #reconcileAdmissions(): void {
    const preparationFailures = removeAbandonedLaunchPreparations(this.#runDir);
    const intent = readUpgradeIntent(this.#runDir);
    const recovered = new SupervisorLaunchMemory(this.#runDir, this.#state.owner.process, this.#state.owner.buildSetId);
    this.#mergeAdmissionSubjects(recovered.#subjects);
    for (const entry of recovered.children()) this.#reconcileAdmissionReservation(entry, intent);
    const holds: NonNullable<LaunchStatus['admissionHolds']> = preparationFailures.map((path) => ({
      path,
      disposition: 'cleanup-pending',
    }));
    this.#reconcileReservationLiveness(holds);
    this.#holdUnprovenAdmissions(intent, holds);
    this.#settleAdmissionSubjects(holds);
    this.#status((status) => ({ ...status, admissionHolds: holds }));
    this.#normalizeOwner();
  }

  #mergeAdmissionSubjects(observed: readonly LaunchSubject[]): void {
    const subjects = new Map(this.#subjects.map((subject) => [subject.path, subject]));
    for (const subject of observed) {
      if (
        this.#settledSubjects.has(subject.path) ||
        [...this.#settledSubjects.values()].some(
          (settled) =>
            settled.admission !== undefined &&
            subject.path.startsWith(join(this.#runDir, 'launch-lifetimes.v1', settled.admission.launchId)),
        )
      )
        continue;
      const previous = subjects.get(subject.path);
      subjects.set(subject.path, {
        ...subject,
        acquisitionComplete:
          subject.acquisitionComplete ||
          (subject.problem === undefined &&
            subject.lifetimePath !== undefined &&
            subject.lifetimePath === previous?.lifetimePath &&
            subject.inode?.dev === previous.inode?.dev &&
            subject.inode?.ino === previous.inode?.ino &&
            previous.acquisitionComplete) === true,
      });
    }
    this.#subjects = [...subjects.values()].filter(
      (subject) =>
        subject.admission !== undefined ||
        observed.some((entry) => entry.path === subject.path) ||
        !observed.some(
          (entry) =>
            (entry.lifetimePath?.startsWith(`${subject.path}/`) ?? false) ||
            (entry.lifetimeDirectory?.startsWith(`${subject.path}/`) ?? false),
        ),
    );
  }

  #matchesAdmissionPlaceholder(
    slot: LaunchReservation,
    entry: LaunchReservation,
    intent: ReturnType<typeof readUpgradeIntent>,
  ): boolean {
    if (!/^(incumbent|attempt|discovery):/u.test(slot.id) || entry.child === undefined) return false;
    if (slot.child !== undefined)
      return slot.child.pid === entry.child.pid && slot.child.incarnation === entry.child.incarnation;
    if (slot.unidentifiedPid !== entry.child.pid) return false;
    if (slot.id.startsWith('discovery:')) {
      const discovery = readDiscoveryRecordDisposition(
        createRealRuntime(this.#runDir.endsWith('run-dev') ? 'dev' : 'prod', {
          baseDir: dirname(dirname(this.#runDir)),
        }),
        join(this.#runDir, 'coordinator.json'),
      );
      return (
        discovery.kind === 'record' &&
        slot.id === `discovery:${discovery.record.bootToken}` &&
        discovery.record.supervision?.launchId === entry.id &&
        discovery.record.pid === entry.child.pid &&
        discovery.record.incarnation === entry.child.incarnation
      );
    }
    if (intent.kind !== 'readable') return false;
    const identity =
      slot.id === `attempt:${intent.intent.attemptChild?.attemptId}`
        ? intent.intent.attemptChild
        : slot.id.startsWith(`incumbent:${intent.intent.incumbent.instanceId}:`)
          ? intent.intent.incumbent
          : null;
    return identity?.pid === entry.child.pid && identity.incarnation === entry.child.incarnation;
  }

  #transferChildWatches(previousId: string, currentId: string): void {
    const watch = this.#childWatches.get(previousId);
    const retirement = this.#childRetirements.get(previousId);
    const inherited = this.inheritedWatch.get(previousId);
    if (watch !== undefined) this.#childWatches.set(currentId, watch);
    if (retirement !== undefined) this.#childRetirements.set(currentId, retirement);
    if (inherited !== undefined) this.inheritedWatch.set(currentId, inherited);
    this.#childWatches.delete(previousId);
    this.#childRetirements.delete(previousId);
    this.inheritedWatch.delete(previousId);
  }

  #reconcileAdmissionReservation(entry: LaunchReservation, intent: ReturnType<typeof readUpgradeIntent>): void {
    const exact = this.children().find((slot) => refinableReservation(slot, entry));
    const placeholder = this.children().find((slot) => this.#matchesAdmissionPlaceholder(slot, entry, intent));
    const known = exact ?? placeholder;
    if (known !== undefined) {
      if (known.phase === 'exited') return;
      const evidence =
        known === placeholder && known.id !== entry.id
          ? {
              ...known,
              id: entry.id,
              buildSetId: entry.buildSetId,
              purpose: entry.purpose,
              child: entry.child,
              unidentifiedPid: undefined,
              recoveryHold: undefined,
            }
          : known;
      this.#set(known, mergeReservationEvidence(evidence, entry));
      if (known.id !== entry.id) this.#transferChildWatches(known.id, entry.id);
    } else if (
      !/^(incumbent|attempt|discovery):/u.test(entry.id) ||
      !this.children().some(
        (slot) => slot.child?.pid === entry.child?.pid && slot.child?.incarnation === entry.child?.incarnation,
      )
    ) {
      if (this.#state.launch === null) this.#state = { ...this.#state, launch: entry };
      else if (this.#state.attempt === null) this.#state = { ...this.#state, attempt: entry };
      else this.#retained.push(entry);
    }
  }

  #reconcileReservationLiveness(holds: NonNullable<LaunchStatus['admissionHolds']>): void {
    for (const slot of this.children()) {
      if (slot.phase === 'exited' || (slot.child === undefined && slot.unidentifiedPid === undefined)) continue;
      const disposition = reservationDisposition(slot);
      if (disposition === 'absent') {
        if (slot.child !== undefined) this.exited(slot, slot.child);
        else this.#set(slot, { ...slot, phase: 'exited' });
      } else if (disposition === 'unknown') {
        this.#recovering();
        const subject = this.#subjects.find((entry) => entry.admission?.launchId === slot.id);
        const path =
          subject?.path ??
          join(this.#runDir, slot.id.startsWith('discovery:') ? 'coordinator.json' : 'upgrade.v1.json');
        if (!holds.some((hold) => hold.path === path)) holds.push({ path, disposition: 'unknown' });
      }
    }
  }

  #holdUnprovenAdmissions(
    intent: ReturnType<typeof readUpgradeIntent>,
    holds: NonNullable<LaunchStatus['admissionHolds']>,
  ): void {
    if (intent.kind !== 'readable' && intent.kind !== 'absent') {
      this.#recovering();
      holds.push({ path: join(this.#runDir, 'upgrade.v1.json'), disposition: 'unknown' });
    }
    if (
      this.children().some(
        (slot) =>
          slot.phase !== 'exited' &&
          (slot.recoveryHold !== undefined ||
            (slot.parent === undefined &&
              slot.admittedAt === undefined &&
              (slot.child !== undefined || slot.unidentifiedPid !== undefined))),
      )
    )
      holds.push({ path: join(this.#runDir, 'upgrade.v1.json'), disposition: 'unknown' });
  }

  #settleAdmissionSubjects(holds: NonNullable<LaunchStatus['admissionHolds']>): void {
    for (const subject of this.#subjects) {
      repairDamagedLaunchSubject(subject);
      const disposition = this.#settledSubjects.has(subject.path) ? 'absent' : observeLaunchSubject(subject);
      if (disposition === 'absent') {
        this.#settledSubjects.set(subject.path, subject);
        const slot = this.children().find(
          (entry) =>
            entry.id === subject.admission?.launchId &&
            entry.child?.pid === subject.admission.child.pid &&
            entry.child.incarnation === subject.admission.child.incarnation,
        );
        if (slot?.child !== undefined && slot.phase !== 'exited') this.exited(slot, slot.child);
        if (!removeAbsentLaunchSubject(subject)) {
          this.#settledSubjects.delete(subject.path);
          holds.push({ path: subject.path, disposition: 'cleanup-pending' });
        } else {
          this.#subjects = this.#subjects.filter((entry) => entry !== subject);
          this.#settledSubjects.delete(subject.path);
        }
      } else if (disposition === 'unknown' || disposition === 'acquisition-window') {
        this.#recovering();
        const index = holds.findIndex((hold) => hold.path === subject.path);
        const hold = { path: subject.path, disposition };
        if (index < 0) holds.push(hold);
        else holds[index] = hold;
      }
    }
  }

  get runDir(): string {
    return this.#runDir;
  }

  read(): SupervisorState {
    return this.#state;
  }

  children(): LaunchReservation[] {
    return [this.#state.launch, this.#state.attempt, ...this.#retained].filter(
      (slot): slot is LaunchReservation => slot !== null,
    );
  }

  supervisionEligible(reservation: LaunchReservation): boolean {
    return (
      reservation.admissionProven === true &&
      reservation.parent !== undefined &&
      reservation.admittedAt !== undefined &&
      reservation.buildSetId !== 'unknown' &&
      reservation.recoveryHold === undefined &&
      !this.#hasUnknownEnvelope(reservation.id)
    );
  }

  hasUnknownOccupancy(): boolean {
    const intent = readUpgradeIntent(this.#runDir);
    const unknown =
      (intent.kind !== 'readable' && intent.kind !== 'absent') ||
      this.children().some(
        (slot) =>
          slot.phase !== 'exited' &&
          (slot.child !== undefined || slot.unidentifiedPid !== undefined) &&
          reservationDisposition(slot) === 'unknown',
      ) ||
      this.#subjects.some(
        (subject) =>
          !this.#settledSubjects.has(subject.path) &&
          ['unknown', 'acquisition-window'].includes(observeLaunchSubject(subject)),
      );
    if (unknown) this.#recovering();
    return unknown;
  }

  #recovering(): void {
    this.#state = { ...this.#state, owner: { ...this.#state.owner, mode: 'recovering' } };
  }

  #slot(reservation: LaunchReservation): 'launch' | 'attempt' | 'retained' | null {
    if (this.#state.launch !== null && matchesReservation(this.#state.launch, reservation)) return 'launch';
    if (this.#state.attempt !== null && matchesReservation(this.#state.attempt, reservation)) return 'attempt';
    if (this.#retained.some((entry) => matchesReservation(entry, reservation))) return 'retained';
    return null;
  }

  #set(reservation: LaunchReservation, change: LaunchReservation | null): void {
    const slot = this.#slot(reservation);
    if (slot === 'launch') this.#state = { ...this.#state, launch: change };
    else if (slot === 'attempt') this.#state = { ...this.#state, attempt: change };
    else if (slot === 'retained')
      this.#retained = this.#retained.flatMap((entry) =>
        matchesReservation(entry, reservation) ? (change === null ? [] : [change]) : [entry],
      );
  }

  reserve(owner: LaunchOwner, buildSetId: string, purpose: LaunchReservation['purpose']): LaunchReservation | null {
    return this.#reserve(owner, buildSetId, purpose, false);
  }

  reserveRepairSuccession(
    owner: LaunchOwner,
    buildSetId: string,
    predecessor: LaunchProcess,
  ): LaunchReservation | null {
    const launch = this.#state.launch;
    if (
      launch?.phase !== 'serving' ||
      launch.child?.pid !== predecessor.pid ||
      launch.child.incarnation !== predecessor.incarnation ||
      !this.supervisionEligible(launch) ||
      identityDisposition(predecessor) !== 'matching'
    )
      return null;
    return this.#reserve(owner, buildSetId, 'succession', true);
  }

  #reserve(
    owner: LaunchOwner,
    buildSetId: string,
    purpose: LaunchReservation['purpose'],
    repair: boolean,
  ): LaunchReservation | null {
    if (!this.hasAuthority(owner)) return null;
    this.#reconcileAdmissions();
    if (this.hasUnknownOccupancy()) return null;
    if (this.#state.owner.mode === 'recovering' && !repair) return null;
    if (
      this.#subjects.some((subject) => {
        if (this.#settledSubjects.has(subject.path)) return false;
        const disposition = observeLaunchSubject(subject);
        return (
          disposition === 'unknown' ||
          disposition === 'acquisition-window' ||
          (disposition === 'occupied' && !this.children().some((slot) => slot.id === subject.admission?.launchId))
        );
      })
    ) {
      this.#recovering();
      return null;
    }
    if (
      this.children().some(
        (slot) =>
          slot.phase !== 'exited' &&
          ((slot.child !== undefined && identityDisposition(slot.child) === 'unknown') ||
            slot.unidentifiedPid !== undefined ||
            slot.recoveryHold !== undefined ||
            (slot.phase !== 'reserved' && (slot.admittedAt === undefined || slot.buildSetId === 'unknown'))),
      )
    ) {
      this.#recovering();
      return null;
    }
    if (this.#retained.some((slot) => slot.phase !== 'exited')) return null;
    this.normalize();
    const succession = (purpose === 'succession' || purpose === 'contender') && this.#state.launch?.phase === 'serving';
    const slot = succession ? this.#state.attempt : this.#state.launch;
    if (slot !== null && slot.phase !== 'exited') return null;
    const reservation: LaunchReservation = { id: randomUUID(), buildSetId, purpose, phase: 'reserved' };
    this.#state = succession ? { ...this.#state, attempt: reservation } : { ...this.#state, launch: reservation };
    return reservation;
  }

  spawned(reservation: LaunchReservation, parent: LaunchProcess, child: LaunchProcess): boolean {
    const slot = this.#slot(reservation);
    const current = slot === 'launch' ? this.#state.launch : slot === 'attempt' ? this.#state.attempt : null;
    if (
      !this.#authority ||
      current?.phase !== 'reserved' ||
      current.child !== undefined ||
      parent.pid !== this.#state.owner.process.pid ||
      parent.incarnation !== this.#state.owner.process.incarnation
    )
      return false;
    this.#set(reservation, { ...current, parent, child });
    return true;
  }

  admit(reservation: LaunchReservation, parent: LaunchProcess, child: LaunchProcess, admittedAt: number): boolean {
    const slot = this.#slot(reservation);
    const current = slot === 'launch' ? this.#state.launch : slot === 'attempt' ? this.#state.attempt : null;
    if (
      !this.#authority ||
      current === null ||
      current.phase === 'exited' ||
      (current.phase !== 'reserved' && current.admittedAt !== admittedAt) ||
      parent.pid !== this.#state.owner.process.pid ||
      parent.incarnation !== this.#state.owner.process.incarnation ||
      current.child?.pid !== child.pid ||
      current.child.incarnation !== child.incarnation
    )
      return false;
    this.#set(reservation, {
      ...current,
      phase: current.phase === 'serving' ? 'serving' : 'admitted',
      admittedAt,
      admissionProven: true,
      parent,
      child,
    });
    return true;
  }

  cancelReservation(reservation: LaunchReservation): void {
    if (this.#slot(reservation) === null) return;
    this.#set(reservation, null);
    this.#childWatches.delete(reservation.id);
    this.#childRetirements.delete(reservation.id);
    this.inheritedWatch.delete(reservation.id);
  }

  serving(reservation: LaunchReservation, child: LaunchProcess): boolean {
    const current = this.currentChild(reservation, child);
    if (!this.#authority || current === null || current.phase !== 'admitted' || current.terminationAt !== undefined)
      return false;
    this.#set(reservation, { ...current, phase: 'serving', observedHealthyAt: Date.now() });
    this.#servedBuilds.add(current.buildSetId);
    this.#normalizeOwner();
    return true;
  }

  hasServed(buildSetId: string): boolean {
    return this.#servedBuilds.has(buildSetId);
  }

  currentChild(reservation: LaunchReservation, child: LaunchProcess): LaunchReservation | null {
    const current = this.children().find((entry) => matchesReservation(entry, reservation));
    return current?.child?.pid === child.pid && current.child.incarnation === child.incarnation ? current : null;
  }

  exited(reservation: LaunchReservation, child: LaunchProcess): boolean {
    const current = this.currentChild(reservation, child);
    if (current === null || current.phase === 'exited') return false;
    this.#set(reservation, { ...current, phase: 'exited' });
    this.#childWatches.delete(reservation.id);
    this.#childRetirements.delete(reservation.id);
    this.inheritedWatch.delete(reservation.id);
    this.#status((status) => ({
      ...status,
      inheritedHolds: status.inheritedHolds.filter((hold) => hold.launchId !== reservation.id),
      signalHolds: status.signalHolds.filter((hold) => hold.launchId !== reservation.id),
    }));
    this.normalize();
    return true;
  }

  settleAbsentChild(reservation: LaunchReservation): boolean {
    if (reservation.child === undefined || identityDisposition(reservation.child) !== 'absent') return false;
    return this.exited(reservation, reservation.child);
  }

  normalize(): LaunchReservation | null {
    const { launch, attempt } = this.#state;
    if (launch?.phase === 'exited' && attempt !== null && attempt.phase !== 'exited') {
      this.#state = { ...this.#state, launch: attempt, attempt: null };
      this.#normalizeOwner();
      return attempt;
    }
    return null;
  }

  #normalizeOwner(): void {
    if (!this.#authority || this.#state.owner.mode !== 'recovering') return;
    if (this.hasUnknownOccupancy()) return;
    const live = this.children().filter((slot) => slot.phase !== 'exited');
    if (
      this.#subjects.some(
        (subject) =>
          !this.#settledSubjects.has(subject.path) &&
          observeLaunchSubject(subject) !== 'absent' &&
          !live.some(
            (slot) =>
              slot.id === subject.admission?.launchId &&
              slot.child?.pid === subject.admission.child.pid &&
              slot.child.incarnation === subject.admission.child.incarnation &&
              subject.problem === undefined,
          ),
      ) ||
      (live.length > 0 &&
        (this.#state.launch?.phase !== 'serving' ||
          live.some(
            (slot) =>
              slot.child === undefined ||
              identityDisposition(slot.child) !== 'matching' ||
              !this.supervisionEligible(slot) ||
              slot.parent?.pid !== this.#state.owner.process.pid ||
              slot.parent.incarnation !== this.#state.owner.process.incarnation,
          )))
    )
      return;
    this.#state = { ...this.#state, owner: { ...this.#state.owner, mode: 'supervised' } };
  }

  #hasUnknownEnvelope(launchId: string): boolean {
    const lifetime = join(this.#runDir, 'launch-lifetimes.v1', launchId);
    return this.#subjects.some(
      (subject) =>
        subject.problem !== undefined &&
        (subject.path === join(this.#runDir, 'launch-admissions.v2', `${launchId}.json`) ||
          subject.path === lifetime ||
          subject.path.startsWith(`${lifetime}/`)),
    );
  }

  canTerminateChild(owner: LaunchOwner, reservation: LaunchReservation, identity: LaunchProcess): boolean {
    if (!this.hasAuthority(owner)) return false;
    const current = this.currentChild(reservation, identity);
    if (current === null || current.phase === 'exited' || current.parent === undefined) return false;
    if (this.#hasUnknownEnvelope(current.id) || current.recoveryHold !== undefined) return false;
    if (reservationDisposition(current) === 'unknown') return false;
    if (current.parent.pid === owner.process.pid && current.parent.incarnation === owner.process.incarnation)
      return true;
    return this.supervisionEligible(current) && identityDisposition(identity) === 'matching';
  }

  commitTermination(
    owner: LaunchOwner,
    reservation: LaunchReservation,
    identity: LaunchProcess,
    now: number,
    graceMs: number,
  ): boolean {
    if (!this.canTerminateChild(owner, reservation, identity)) return false;
    const current = this.currentChild(reservation, identity);
    if (current === null) return false;
    if (current.terminationAt === undefined)
      this.#set(reservation, { ...current, terminationAt: now, killAt: now + graceMs });
    return true;
  }

  observeInheritedHealth(reservation: LaunchReservation, now: number): void {
    if (!this.#authority) return;
    const current = reservation.child === undefined ? null : this.currentChild(reservation, reservation.child);
    if (
      current !== null &&
      this.supervisionEligible(current) &&
      current.child !== undefined &&
      identityDisposition(current.child) === 'matching' &&
      current.termDelivered !== true &&
      current.killDelivered !== true
    ) {
      this.#set(reservation, {
        ...current,
        phase: 'serving',
        observedHealthyAt: now,
        terminationAt: undefined,
        killAt: undefined,
      });
      this.inheritedWatch.delete(current.id);
      this.#servedBuilds.add(current.buildSetId);
      const child = current.child;
      this.#status((status) => ({
        ...status,
        inheritedHealth: [
          ...(status.inheritedHealth ?? []).filter((observation) => observation.launchId !== current.id).slice(-1),
          { launchId: current.id, supervisor: this.#state.owner.process, child, observedHealthyAt: now },
        ],
        inheritedHolds: status.inheritedHolds.filter((hold) => hold.launchId !== current.id),
        signalHolds: status.signalHolds.filter((hold) => hold.launchId !== current.id),
      }));
    }
  }

  recordTerminationDelivery(owner: LaunchOwner, reservation: LaunchReservation, signal: 'SIGTERM' | 'SIGKILL'): void {
    if (!this.hasAuthority(owner)) return;
    const current = this.children().find((entry) => matchesReservation(entry, reservation));
    if (current?.child === undefined || current.terminationAt === undefined) return;
    this.#set(reservation, {
      ...current,
      ...(signal === 'SIGTERM'
        ? {
            termDelivered: true,
            killMonotonicAt:
              current.termDelivered === true
                ? current.killMonotonicAt
                : Number(process.hrtime.bigint() / 1_000_000n) +
                  ((current.killAt ?? current.terminationAt) - current.terminationAt),
            killAt:
              current.termDelivered === true
                ? current.killAt
                : Date.now() + ((current.killAt ?? current.terminationAt) - current.terminationAt),
          }
        : { killDelivered: true }),
    });
  }

  terminationGraceElapsed(reservation: LaunchReservation): boolean {
    const current = this.children().find((entry) => matchesReservation(entry, reservation));
    if (current?.termDelivered !== true) return false;
    return current.killMonotonicAt === undefined
      ? Date.now() >= (current.killAt ?? Infinity)
      : Number(process.hrtime.bigint() / 1_000_000n) >= current.killMonotonicAt;
  }

  release(): boolean {
    return (
      this.children().every((slot) => slot.phase === 'exited') &&
      this.#subjects.every(
        (subject) => this.#settledSubjects.has(subject.path) || observeLaunchSubject(subject) === 'absent',
      )
    );
  }

  #status(change: Parameters<typeof updateLaunchStatus>[1]): void {
    try {
      updateLaunchStatus(this.#runDir, change);
    } catch (error: unknown) {
      process.stderr.write(`Coordinator launch status could not be written: ${String(error)}\n`);
    }
  }

  holdInheritedChild(_owner: LaunchOwner, reservation: LaunchReservation): boolean {
    const child = reservation.child;
    if (child === undefined) return false;
    this.#status((status) => ({
      ...status,
      inheritedHolds: [
        ...status.inheritedHolds.filter((hold) => hold.launchId !== reservation.id),
        {
          launchId: reservation.id,
          pid: child.pid,
          incarnation: child.incarnation,
          observation: probeProcessIncarnation(child.pid) ?? 'unknown',
        },
      ],
    }));
    return true;
  }

  holdSignalRefusal(_owner: LaunchOwner, reservation: LaunchReservation, child: LaunchProcess): boolean {
    this.#status((status) => ({
      ...status,
      signalHolds: [
        ...status.signalHolds.filter((hold) => hold.launchId !== reservation.id),
        { launchId: reservation.id, pid: child.pid, incarnation: child.incarnation },
      ],
    }));
    return true;
  }

  clearSignalRefusal(reservation: LaunchReservation): void {
    this.#status((status) => ({
      ...status,
      signalHolds: status.signalHolds.filter((hold) => hold.launchId !== reservation.id),
    }));
  }

  hold(_owner: LaunchOwner, controller: string, boundedEvidence = false): boolean {
    const intent = readUpgradeIntent(this.#runDir);
    this.#status((status) => ({
      ...status,
      hold: {
        kind: 'no-eligible-build',
        controller,
        requestId: intent.kind === 'readable' ? intent.intent.requestId : undefined,
        observation:
          controller === 'unknown' ? 'controller-evidence-indeterminate' : 'no-eligible-installed-or-retained-build',
        retry: boundedEvidence
          ? undefined
          : controller === 'unknown'
            ? 'controller-evidence-change'
            : 'eligible-build-appears',
        boundedExit: boundedEvidence ? 'launch-original-after-2000ms' : undefined,
      },
    }));
    return true;
  }

  holdUnreadableCustody(_owner: LaunchOwner, path: string): boolean {
    this.#status((status) => ({
      ...status,
      hold: {
        kind: 'custody-unreadable',
        path,
        observation: 'custody-record-unreadable',
        boundedExit: 'launch-original-after-2000ms',
      },
    }));
    return true;
  }

  clearHold(): void {
    this.#status((status) => ({ ...status, hold: undefined }));
  }
}

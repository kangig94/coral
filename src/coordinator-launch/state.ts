import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

import { readDiscoveryRecordDisposition } from '../infra/backend-discovery.js';
import { updateLaunchStatus } from '../infra/launch-status.js';
import { listLaunchAdmissions, type LaunchAdmission } from '../infra/launch-admission-record.js';
import { probeProcessIncarnation, type ProcessIncarnation } from '../infra/node-process.js';
import { readUpgradeIntent } from '../infra/upgrade-intent.js';
import { createRealRuntime } from '../runtime/real.js';

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
  observedHealthyAt?: number;
  parent?: LaunchProcess;
  child?: LaunchProcess;
  terminationAt?: number;
  killAt?: number;
}>;

type SupervisorState = Readonly<{
  owner: LaunchOwner;
  launch: LaunchReservation | null;
  attempt: LaunchReservation | null;
}>;

function active(identity: LaunchProcess): boolean {
  return probeProcessIncarnation(identity.pid) === identity.incarnation;
}

function fromAdmission(admission: LaunchAdmission): LaunchReservation {
  return {
    id: admission.launchId,
    buildSetId: admission.build.buildSetId,
    purpose: admission.purpose,
    phase: 'admitted',
    admittedAt: admission.admittedAt,
    parent: admission.parent,
    child: admission.child,
  };
}

/** The lock holder's local knowledge of children; no state in this object is persisted. */
export class SupervisorLaunchMemory {
  #state: SupervisorState;
  readonly #runDir: string;
  readonly #servedBuilds = new Set<string>();

  constructor(runDir: string, process: LaunchProcess, buildSetId: string) {
    this.#runDir = runDir;
    const admissions = listLaunchAdmissions(runDir)
      .filter((entry): entry is Extract<typeof entry, { kind: 'readable' }> => entry.kind === 'readable')
      .map((entry) => fromAdmission(entry.admission))
      .filter((entry) => entry.child !== undefined && active(entry.child));
    const runtime = createRealRuntime(runDir.endsWith('run-dev') ? 'dev' : 'prod', {
      baseDir: dirname(dirname(runDir)),
    });
    const discovery = readDiscoveryRecordDisposition(runtime, join(runDir, 'coordinator.json'));
    if (
      discovery.kind === 'record' &&
      discovery.record.supervision !== undefined &&
      discovery.record.incarnation !== undefined
    ) {
      const { supervision } = discovery.record;
      const discovered: LaunchReservation = {
        id: supervision.launchId,
        buildSetId: supervision.buildSetId,
        purpose: supervision.purpose,
        phase: 'serving',
        admittedAt: supervision.admittedAt,
        parent: supervision.parent,
        child: { pid: discovery.record.pid, incarnation: discovery.record.incarnation },
      };
      if (discovered.child !== undefined && active(discovered.child)) admissions.push(discovered);
    }
    const unique = [...new Map(admissions.map((entry) => [entry.id, entry])).values()];
    const intent = readUpgradeIntent(runDir);
    const attemptIdentity = intent.kind === 'readable' ? intent.intent.attemptChild : null;
    const attempt =
      (attemptIdentity === null || attemptIdentity === undefined
        ? null
        : unique.find(
            (entry) =>
              entry.child?.pid === attemptIdentity.pid && entry.child.incarnation === attemptIdentity.incarnation,
          )) ??
      unique.find((entry) => entry.purpose === 'succession' || entry.purpose === 'contender') ??
      null;
    const launch = unique.find((entry) => entry.id !== attempt?.id) ?? attempt;
    this.#state = {
      owner: { id: randomUUID(), process, buildSetId, mode: unique.length > 0 ? 'recovering' : 'supervised' },
      launch,
      attempt: launch === attempt ? null : attempt,
    };
  }

  read(): SupervisorState {
    return this.#state;
  }

  #slot(reservation: LaunchReservation): 'launch' | 'attempt' | null {
    if (this.#state.launch?.id === reservation.id) return 'launch';
    if (this.#state.attempt?.id === reservation.id) return 'attempt';
    return null;
  }

  #set(reservation: LaunchReservation, change: LaunchReservation | null): void {
    const slot = this.#slot(reservation);
    if (slot === 'launch') this.#state = { ...this.#state, launch: change };
    else if (slot === 'attempt') this.#state = { ...this.#state, attempt: change };
  }

  reserve(owner: LaunchOwner, buildSetId: string, purpose: LaunchReservation['purpose']): LaunchReservation | null {
    if (owner.id !== this.#state.owner.id) return null;
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
      current?.phase !== 'reserved' ||
      parent.pid !== this.#state.owner.process.pid ||
      parent.incarnation !== this.#state.owner.process.incarnation ||
      current.child?.pid !== child.pid ||
      current.child.incarnation !== child.incarnation
    )
      return false;
    this.#set(reservation, { ...current, phase: 'admitted', admittedAt, parent, child });
    return true;
  }

  cancelReservation(reservation: LaunchReservation): void {
    if (this.#slot(reservation) !== null) this.#set(reservation, null);
  }

  serving(reservation: LaunchReservation, child: LaunchProcess): boolean {
    const current = this.currentChild(reservation, child);
    if (current === null || current.phase !== 'admitted' || current.terminationAt !== undefined) return false;
    this.#set(reservation, { ...current, phase: 'serving', observedHealthyAt: Date.now() });
    this.#servedBuilds.add(current.buildSetId);
    return true;
  }

  hasServed(buildSetId: string): boolean {
    return this.#servedBuilds.has(buildSetId);
  }

  currentChild(reservation: LaunchReservation, child: LaunchProcess): LaunchReservation | null {
    const slot = this.#slot(reservation);
    const current = slot === 'launch' ? this.#state.launch : slot === 'attempt' ? this.#state.attempt : null;
    return current?.child?.pid === child.pid && current.child.incarnation === child.incarnation ? current : null;
  }

  exited(reservation: LaunchReservation, child: LaunchProcess): boolean {
    const current = this.currentChild(reservation, child);
    if (current === null || current.phase === 'exited') return false;
    this.#set(reservation, { ...current, phase: 'exited' });
    this.#status((status) => ({
      ...status,
      inheritedHolds: status.inheritedHolds.filter((hold) => hold.launchId !== reservation.id),
      signalHolds: status.signalHolds.filter((hold) => hold.launchId !== reservation.id),
    }));
    this.normalize();
    return true;
  }

  settleAbsentChild(reservation: LaunchReservation): boolean {
    if (reservation.child === undefined || active(reservation.child)) return false;
    return this.exited(reservation, reservation.child);
  }

  normalize(): LaunchReservation | null {
    const { launch, attempt } = this.#state;
    if (launch?.phase === 'exited' && attempt !== null && attempt.phase !== 'exited') {
      this.#state = { ...this.#state, launch: attempt, attempt: null };
      return attempt;
    }
    return null;
  }

  commitTermination(
    owner: LaunchOwner,
    reservation: LaunchReservation,
    identity: LaunchProcess,
    now: number,
    graceMs: number,
  ): boolean {
    if (owner.id !== this.#state.owner.id) return false;
    const current = this.currentChild(reservation, identity);
    if (current === null || current.phase === 'exited') return false;
    if (current.terminationAt === undefined)
      this.#set(reservation, { ...current, terminationAt: now, killAt: now + graceMs });
    return true;
  }

  observeInheritedHealth(reservation: LaunchReservation, now: number): void {
    const current = reservation.child === undefined ? null : this.currentChild(reservation, reservation.child);
    if (current !== null && current.terminationAt === undefined) {
      this.#set(reservation, { ...current, phase: 'serving', observedHealthyAt: now });
      this.#servedBuilds.add(current.buildSetId);
    }
  }

  release(): boolean {
    return [this.#state.launch, this.#state.attempt].every((slot) => slot === null || slot.phase === 'exited');
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
        { launchId: reservation.id, pid: child.pid },
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

  hold(_owner: LaunchOwner, controller: string): boolean {
    this.#status((status) => ({
      ...status,
      hold: {
        kind: 'no-eligible-build',
        controller,
        retry: controller === 'unknown' ? 'controller-evidence-change' : 'eligible-build-appears',
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
        retry: 'restore-readable-custody-record',
      },
    }));
    return true;
  }

  clearHold(): void {
    this.#status((status) => ({ ...status, hold: undefined }));
  }
}

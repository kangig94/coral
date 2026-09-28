import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { coordinatorLaunchPath } from './path/index.js';
import { observeProcessLiveness, probeProcessIncarnation, type ProcessIncarnation } from './node-process.js';

export type LaunchProcess = Readonly<{ pid: number; incarnation: ProcessIncarnation }>;

function replacementSignalHoldId(child: LaunchProcess): string {
  return `replacement:${child.pid}:${child.incarnation}`;
}
export type LaunchOwner = Readonly<{
  id: string;
  process: LaunchProcess;
  buildSetId: string;
  epoch: number;
  renewal: number;
  leaseUntil: number;
  mode: 'supervised' | 'recovering';
}>;
export type LaunchReservation = Readonly<{
  id: string;
  ownerEpoch: number;
  buildSetId: string;
  purpose: 'startup' | 'contender' | 'succession' | 'recovery' | 'legacy-retirement';
  phase: 'reserved' | 'admitted' | 'serving' | 'exited';
  admittedAt?: number;
  observedHealthyAt?: number;
  parent?: LaunchProcess;
  child?: LaunchProcess;
  terminationAt?: number;
  terminationOwnerEpoch?: number;
  killAt?: number;
}>;
export type LaunchRequest = Readonly<{
  id: string;
  executable: string;
  buildSetId: string;
  incumbent?: Readonly<{
    instanceId: string;
    pid: number;
    incarnation: ProcessIncarnation | null;
    version: string;
    bundleHash: string;
    flavor: 'prod' | 'dev';
  }>;
  completionReceipt?: Readonly<{
    launchId: string;
    successor: Readonly<{ instanceId: string; pid: number; incarnation: ProcessIncarnation }>;
    epochKey: string;
    controlGeneration: number;
    recordedAt: string;
  }>;
  status: 'recorded' | 'accepted' | 'completed' | 'unavailable';
  acceptedEpoch?: number;
}>;
export type CoordinatorLaunchState = Readonly<{
  schemaGeneration: 1;
  namespaceId: string;
  revision: number;
  ownerEpoch: number;
  owner: LaunchOwner | null;
  launch: LaunchReservation | null;
  attempt: LaunchReservation | null;
  requests: readonly LaunchRequest[];
  signalHolds?: readonly Readonly<{ launchId: string; pid: number; incarnation: ProcessIncarnation }>[];
  inheritedHolds?: readonly Readonly<{ launchId: string; pid: number }>[];
  recovery?: Readonly<{
    id: string;
    sourceLaunchId: string;
    nominee: LaunchProcess;
    challenge: string;
  }>;
  hold?:
    | Readonly<{
        kind: 'no-eligible-build';
        controller: string;
        retry?: 'controller-evidence-change' | 'eligible-build-appears';
      }>
    | Readonly<{ kind: 'custody-unreadable'; path: string; retry: 'restore-readable-custody-record' }>
    | Readonly<{ kind: 'target-indeterminate'; requestId: string }>
    | Readonly<{ kind: 'inherited-child-unresponsive'; launchId: string; pid: number }>;
}>;

export const LAUNCH_OWNER_LEASE_MS = 10 * 60_000;

export function readCoordinatorLaunchState(runDir: string): CoordinatorLaunchState {
  const database = new DatabaseSync(coordinatorLaunchPath(runDir), { readOnly: true });
  try {
    const row = database.prepare('SELECT state FROM control WHERE id = 1').get() as { state: string };
    const state = JSON.parse(row.state) as CoordinatorLaunchState;
    if (state.schemaGeneration !== 1) throw new Error('Unsupported coordinator launch generation');
    return state;
  } finally {
    database.close();
  }
}

/** One short SQLite write transaction owns each protocol transition. No caller holds it across process I/O. */
export class CoordinatorLaunchRecord {
  readonly #database: DatabaseSync;

  constructor(runDir: string) {
    const path = coordinatorLaunchPath(runDir);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.#database = new DatabaseSync(path);
    this.#database.exec('PRAGMA busy_timeout = 5000');
    this.#database.exec('PRAGMA journal_mode = DELETE');
    this.#database.exec('PRAGMA synchronous = FULL');
    this.#database.exec(
      'CREATE TABLE IF NOT EXISTS control (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL)',
    );
    this.#database.prepare('INSERT OR IGNORE INTO control (id, state) VALUES (1, ?)').run(
      JSON.stringify({
        schemaGeneration: 1,
        namespaceId: randomUUID(),
        revision: 0,
        ownerEpoch: 0,
        owner: null,
        launch: null,
        attempt: null,
        requests: [],
        hold: undefined,
      } satisfies CoordinatorLaunchState),
    );
    const parent = openSync(dirname(path), 'r');
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
  }

  close(): void {
    this.#database.close();
  }

  read(): CoordinatorLaunchState {
    const row = this.#database.prepare('SELECT state FROM control WHERE id = 1').get() as { state: string };
    const state = JSON.parse(row.state) as CoordinatorLaunchState;
    if (state.schemaGeneration !== 1) throw new Error('Unsupported coordinator launch generation');
    return state;
  }

  #change<T>(transition: (state: CoordinatorLaunchState) => { state: CoordinatorLaunchState; result: T }): T {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const persisted = this.read();
      const legacyHold = persisted.hold?.kind === 'inherited-child-unresponsive' ? persisted.hold : null;
      const activeChild = [persisted.launch, persisted.attempt].some(
        (slot) =>
          legacyHold !== null &&
          slot?.id === legacyHold.launchId &&
          (slot.phase === 'admitted' || slot.phase === 'serving'),
      );
      const current =
        legacyHold === null
          ? persisted
          : {
              ...persisted,
              hold: undefined,
              inheritedHolds:
                activeChild && !persisted.inheritedHolds?.some((hold) => hold.launchId === legacyHold.launchId)
                  ? [...(persisted.inheritedHolds ?? []), { launchId: legacyHold.launchId, pid: legacyHold.pid }]
                  : persisted.inheritedHolds,
            };
      const { state, result } = transition(current);
      if (state !== persisted) {
        this.#database
          .prepare('UPDATE control SET state = ? WHERE id = 1')
          .run(JSON.stringify({ ...state, revision: persisted.revision + 1 }));
      }
      this.#database.exec('COMMIT');
      return result;
    } catch (error: unknown) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  acquire(holder: Omit<LaunchOwner, 'epoch' | 'renewal' | 'leaseUntil' | 'mode'>, now: number): LaunchOwner | null {
    return this.#change((state) => {
      if (state.owner !== null) {
        const observed = probeProcessIncarnation(state.owner.process.pid);
        const ownerPresent =
          observed === state.owner.process.incarnation ||
          (observed === null && observeProcessLiveness(state.owner.process.pid) !== 'absent');
        const sameHolder =
          holder.id === state.owner.id &&
          holder.process.pid === state.owner.process.pid &&
          holder.process.incarnation === state.owner.process.incarnation;
        const committedChild = [state.launch, state.attempt].some(
          (slot) => slot !== null && slot.phase !== 'exited' && slot.terminationAt !== undefined,
        );
        if (ownerPresent && (state.owner.leaseUntil > now || (committedChild && !sameHolder)))
          return { state, result: null };
      }
      const launch =
        state.launch?.phase === 'reserved' && state.launch.terminationAt === undefined ? null : state.launch;
      const attempt =
        state.attempt?.phase === 'reserved' && state.attempt.terminationAt === undefined ? null : state.attempt;
      const normalized = this.#normalize({ ...state, launch, attempt });
      const owner: LaunchOwner = {
        ...holder,
        epoch: state.ownerEpoch + 1,
        renewal: 0,
        leaseUntil: now + LAUNCH_OWNER_LEASE_MS,
        mode: this.#mode(normalized, holder.process),
      };
      return {
        state: {
          ...normalized,
          ownerEpoch: owner.epoch,
          owner,
          recovery: undefined,
          requests: state.requests.map((request) =>
            (request.status === 'recorded' || request.status === 'accepted') &&
            !this.#terminatingBuild(normalized, request.buildSetId)
              ? { ...request, status: 'accepted' as const, acceptedEpoch: owner.epoch }
              : request,
          ),
        },
        result: owner,
      };
    });
  }

  nominateRecovery(source: LaunchProcess, nominee: LaunchProcess, challenge: string): string | null {
    return this.#change((state) => {
      const normalized = this.#normalize(state);
      const selected = [normalized.launch, normalized.attempt].find(
        (slot) =>
          slot?.phase === 'serving' &&
          slot.terminationAt === undefined &&
          slot.child?.pid === source.pid &&
          slot.child.incarnation === source.incarnation,
      );
      if (selected === undefined || selected === null) return { state, result: null };
      const recovery = { id: randomUUID(), sourceLaunchId: selected.id, nominee, challenge };
      return { state: { ...normalized, recovery }, result: recovery.id };
    });
  }

  acceptRecoveryTransfer(
    holder: Omit<LaunchOwner, 'epoch' | 'renewal' | 'leaseUntil' | 'mode'>,
    recoveryId: string,
    challenge: string,
    now: number,
  ): LaunchOwner | null {
    return this.#change((state) => {
      const normalized = this.#normalize(state);
      const recovery = normalized.recovery;
      if (
        recovery?.id !== recoveryId ||
        recovery.challenge !== challenge ||
        recovery.nominee.pid !== holder.process.pid ||
        recovery.nominee.incarnation !== holder.process.incarnation ||
        ![normalized.launch, normalized.attempt].some(
          (slot) =>
            slot?.id === recovery.sourceLaunchId && slot.phase === 'serving' && slot.terminationAt === undefined,
        )
      )
        return { state, result: null };
      const owner: LaunchOwner = {
        ...holder,
        epoch: state.ownerEpoch + 1,
        renewal: 0,
        leaseUntil: now + LAUNCH_OWNER_LEASE_MS,
        mode: this.#mode(normalized, holder.process),
      };
      return {
        state: {
          ...normalized,
          ownerEpoch: owner.epoch,
          owner,
          recovery: undefined,
          signalHolds: (normalized.signalHolds ?? []).filter(
            (hold) => hold.launchId !== replacementSignalHoldId(holder.process),
          ),
          requests: normalized.requests.map((request) =>
            (request.status === 'recorded' || request.status === 'accepted') &&
            !this.#terminatingBuild(normalized, request.buildSetId)
              ? { ...request, status: 'accepted' as const, acceptedEpoch: owner.epoch }
              : request,
          ),
        },
        result: owner,
      };
    });
  }

  cancelRecoveryForTermination(source: LaunchProcess, nominee: LaunchProcess): boolean {
    return this.#change((state) => {
      if (state.owner?.process.pid === nominee.pid && state.owner.process.incarnation === nominee.incarnation)
        return { state, result: false };
      if (
        state.recovery !== undefined &&
        (state.recovery.nominee.pid !== nominee.pid || state.recovery.nominee.incarnation !== nominee.incarnation)
      )
        return { state, result: false };
      const selected = [state.launch, state.attempt].find(
        (slot) =>
          slot?.phase === 'serving' && slot.child?.pid === source.pid && slot.child.incarnation === source.incarnation,
      );
      if (selected === undefined) return { state, result: false };
      return { state: state.recovery === undefined ? state : { ...state, recovery: undefined }, result: true };
    });
  }

  renew(owner: LaunchOwner, now: number): LaunchOwner | null {
    return this.#change((state) => {
      const current = state.owner;
      if (current === null || !this.#current(state, owner, now)) return { state, result: null };
      const renewed = {
        ...current,
        renewal: current.renewal + 1,
        leaseUntil: now + LAUNCH_OWNER_LEASE_MS,
      };
      return { state: { ...state, owner: renewed }, result: renewed };
    });
  }

  reserve(
    owner: LaunchOwner,
    buildSetId: string,
    purpose: LaunchReservation['purpose'],
    now: number,
  ): LaunchReservation | null {
    return this.#change((state) => {
      const normalized = this.#normalize(state);
      const succession =
        (purpose === 'succession' || purpose === 'contender') &&
        normalized.launch?.phase === 'serving' &&
        normalized.launch.terminationAt === undefined;
      if (
        !this.#current(normalized, owner, now) ||
        (succession
          ? normalized.attempt !== null && normalized.attempt.phase !== 'exited'
          : normalized.launch !== null && normalized.launch.phase !== 'exited')
      )
        return { state: normalized, result: null };
      const launch: LaunchReservation = {
        id: randomUUID(),
        ownerEpoch: owner.epoch,
        buildSetId,
        purpose,
        phase: 'reserved',
      };
      return {
        state: succession ? { ...normalized, attempt: launch } : { ...normalized, launch },
        result: launch,
      };
    });
  }

  request(executable: string, buildSetId: string, incumbent?: LaunchRequest['incumbent']): LaunchRequest {
    return this.#change((state) => {
      const existing = state.requests.find(
        (request) =>
          request.executable === executable &&
          request.buildSetId === buildSetId &&
          (request.status === 'recorded' || request.status === 'accepted'),
      );
      if (existing !== undefined) {
        if (
          incumbent === undefined ||
          (existing.incumbent?.pid === incumbent.pid &&
            existing.incumbent.incarnation === incumbent.incarnation &&
            existing.incumbent.instanceId === incumbent.instanceId &&
            existing.incumbent.bundleHash === incumbent.bundleHash)
        )
          return { state, result: existing };
        const updated = { ...existing, incumbent };
        return {
          state: { ...state, requests: state.requests.map((entry) => (entry.id === existing.id ? updated : entry)) },
          result: updated,
        };
      }
      const request: LaunchRequest = {
        id: randomUUID(),
        executable,
        buildSetId,
        status: 'recorded',
        ...(incumbent === undefined ? {} : { incumbent }),
      };
      return { state: { ...state, requests: [...state.requests, request] }, result: request };
    });
  }

  hold(owner: LaunchOwner, controller: string, now: number): boolean {
    return this.#change((state) => {
      if (!this.#current(state, owner, now)) return { state, result: false };
      const retry = controller === 'unknown' ? 'controller-evidence-change' : 'eligible-build-appears';
      if (
        state.hold?.kind === 'no-eligible-build' &&
        state.hold.controller === controller &&
        state.hold.retry === retry
      )
        return { state, result: true };
      return { state: { ...state, hold: { kind: 'no-eligible-build', controller, retry } }, result: true };
    });
  }

  holdUnreadableCustody(owner: LaunchOwner, path: string, now: number): boolean {
    return this.#change((state) => {
      if (!this.#current(state, owner, now)) return { state, result: false };
      if (state.hold?.kind === 'custody-unreadable' && state.hold.path === path) return { state, result: true };
      return {
        state: { ...state, hold: { kind: 'custody-unreadable', path, retry: 'restore-readable-custody-record' } },
        result: true,
      };
    });
  }

  clearHold(owner: LaunchOwner, now: number): void {
    this.#change((state) => {
      if (
        !this.#current(state, owner, now) ||
        (state.hold?.kind !== 'no-eligible-build' && state.hold?.kind !== 'custody-unreadable')
      )
        return { state, result: undefined };
      return { state: { ...state, hold: undefined }, result: undefined };
    });
  }

  holdTarget(owner: LaunchOwner, requestId: string, now: number): boolean {
    return this.#change((state) => {
      if (!this.#current(state, owner, now)) return { state, result: false };
      return { state: { ...state, hold: { kind: 'target-indeterminate', requestId } }, result: true };
    });
  }

  clearTargetHold(owner: LaunchOwner, now: number): void {
    this.#change((state) => {
      if (!this.#current(state, owner, now) || state.hold?.kind !== 'target-indeterminate')
        return { state, result: undefined };
      return { state: { ...state, hold: undefined }, result: undefined };
    });
  }

  holdInheritedChild(owner: LaunchOwner, reservation: LaunchReservation, now: number): boolean {
    return this.#change((state) => {
      if (!this.#current(state, owner, now) || reservation.child === undefined) return { state, result: false };
      const slot = this.#slot(state, reservation);
      const launch = slot === 'launch' ? state.launch : state.attempt;
      if (
        !this.#exactChild(launch, reservation, reservation.child) ||
        (launch?.phase !== 'admitted' && launch?.phase !== 'serving')
      )
        return { state, result: false };
      const holds = state.inheritedHolds ?? [];
      if (holds.some((hold) => hold.launchId === reservation.id)) return { state, result: true };
      return {
        state: { ...state, inheritedHolds: [...holds, { launchId: reservation.id, pid: reservation.child.pid }] },
        result: true,
      };
    });
  }

  clearInheritedChildHold(owner: LaunchOwner, reservation: LaunchReservation, now: number): void {
    this.#change((state) => {
      if (!this.#current(state, owner, now) || !state.inheritedHolds?.some((hold) => hold.launchId === reservation.id))
        return { state, result: undefined };
      return {
        state: {
          ...state,
          inheritedHolds: (state.inheritedHolds ?? []).filter((hold) => hold.launchId !== reservation.id),
        },
        result: undefined,
      };
    });
  }

  holdSignalRefusal(owner: LaunchOwner, reservation: LaunchReservation, child: LaunchProcess, now: number): boolean {
    return this.#change((state) => {
      const slot = this.#slot(state, reservation);
      const launch = slot === 'launch' ? state.launch : state.attempt;
      if (
        !this.#current(state, owner, now) ||
        !this.#exactChild(launch, reservation, child) ||
        (launch?.phase !== 'admitted' &&
          launch?.phase !== 'serving' &&
          (launch?.phase !== 'reserved' || launch.terminationAt === undefined))
      )
        return { state, result: false };
      const holds = state.signalHolds ?? [];
      if (holds.some((hold) => hold.launchId === reservation.id)) return { state, result: true };
      return {
        state: {
          ...state,
          signalHolds: [...holds, { launchId: reservation.id, pid: child.pid, incarnation: child.incarnation }],
        },
        result: true,
      };
    });
  }

  clearSignalRefusal(reservation: LaunchReservation, child: LaunchProcess): void {
    this.#change((state) => {
      const slot = this.#slot(state, reservation);
      const launch = slot === 'launch' ? state.launch : state.attempt;
      if (!this.#exactChild(launch, reservation, child)) return { state, result: undefined };
      return {
        state: { ...state, signalHolds: (state.signalHolds ?? []).filter((hold) => hold.launchId !== reservation.id) },
        result: undefined,
      };
    });
  }

  holdReplacementSignalRefusal(source: LaunchProcess, replacement: LaunchProcess): boolean {
    return this.#change((state) => {
      if (
        ![state.launch, state.attempt].some(
          (slot) =>
            (slot?.phase === 'admitted' || slot?.phase === 'serving') &&
            slot.child?.pid === source.pid &&
            slot.child.incarnation === source.incarnation,
        )
      )
        return { state, result: false };
      const launchId = replacementSignalHoldId(replacement);
      if (state.signalHolds?.some((hold) => hold.launchId === launchId)) return { state, result: true };
      return {
        state: {
          ...state,
          signalHolds: [...(state.signalHolds ?? []), { launchId, ...replacement }],
        },
        result: true,
      };
    });
  }

  clearReplacementSignalRefusal(replacement: LaunchProcess): void {
    this.#change((state) => {
      const launchId = replacementSignalHoldId(replacement);
      if (!state.signalHolds?.some((hold) => hold.launchId === launchId)) return { state, result: undefined };
      return {
        state: { ...state, signalHolds: state.signalHolds.filter((hold) => hold.launchId !== launchId) },
        result: undefined,
      };
    });
  }

  reconcileReplacementSignalHolds(): void {
    if (!this.read().signalHolds?.some((hold) => hold.launchId.startsWith('replacement:'))) return;
    this.#change((state) => {
      const holds = state.signalHolds ?? [];
      const remaining: (typeof holds)[number][] = [];
      for (const hold of holds) {
        if (!hold.launchId.startsWith('replacement:')) {
          remaining.push(hold);
          continue;
        }
        const observed = probeProcessIncarnation(hold.pid);
        if (observed === hold.incarnation || (observed === null && observeProcessLiveness(hold.pid) !== 'absent'))
          remaining.push(hold);
      }
      return {
        state: remaining.length === holds.length ? state : { ...state, signalHolds: remaining },
        result: undefined,
      };
    });
  }

  accept(owner: LaunchOwner, requestId: string, now: number): boolean {
    return this.#change((state) => {
      if (!this.#current(state, owner, now)) return { state, result: false };
      const target = state.requests.find((request) => request.id === requestId);
      if (target === undefined || this.#terminatingBuild(state, target.buildSetId)) return { state, result: false };
      const requests = state.requests.map((request) =>
        request.id === requestId && (request.status === 'recorded' || request.status === 'accepted')
          ? { ...request, status: 'accepted' as const, acceptedEpoch: owner.epoch }
          : request,
      );
      if (!requests.some((request) => request.id === requestId && request.acceptedEpoch === owner.epoch))
        return { state, result: false };
      return { state: { ...state, requests }, result: true };
    });
  }

  complete(owner: LaunchOwner, requestId: string, now: number): boolean {
    return this.#change((state) => {
      if (!this.#current(state, owner, now)) return { state, result: false };
      const target = state.requests.find((request) => request.id === requestId);
      const matching = [state.launch, state.attempt].filter((slot) => slot?.buildSetId === target?.buildSetId);
      if (
        target === undefined ||
        (matching.some((slot) => slot?.terminationAt !== undefined) &&
          !matching.some((slot) => slot?.phase === 'serving' && slot.terminationAt === undefined))
      )
        return { state, result: false };
      const requests = state.requests.map((request) =>
        request.id === requestId && request.acceptedEpoch === owner.epoch
          ? { ...request, status: 'completed' as const }
          : request,
      );
      if (!requests.some((request) => request.id === requestId && request.status === 'completed'))
        return { state, result: false };
      return { state: { ...state, requests }, result: true };
    });
  }

  unavailable(owner: LaunchOwner, requestId: string, now: number): boolean {
    return this.#change((state) => {
      if (!this.#current(state, owner, now)) return { state, result: false };
      const request = state.requests.find((entry) => entry.id === requestId);
      if (request === undefined || (request.status !== 'recorded' && request.status !== 'accepted'))
        return { state, result: false };
      const requests = state.requests.map((entry) =>
        entry.id === requestId ? { ...entry, status: 'unavailable' as const } : entry,
      );
      return { state: { ...state, requests }, result: true };
    });
  }

  legacyLaunch(
    child: LaunchProcess,
    buildSetId: string,
  ): Readonly<{
    launch: LaunchReservation;
    request: LaunchRequest;
  }> | null {
    const state = this.read();
    const launch = state.launch;
    if (
      launch?.purpose !== 'legacy-retirement' ||
      launch.terminationAt !== undefined ||
      launch.buildSetId !== buildSetId ||
      (launch.phase !== 'admitted' && launch.phase !== 'serving') ||
      launch.child?.pid !== child.pid ||
      launch.child.incarnation !== child.incarnation
    )
      return null;
    const request = state.requests.find(
      (entry) => entry.buildSetId === buildSetId && entry.incumbent !== undefined && entry.status === 'accepted',
    );
    return request === undefined ? null : { launch, request };
  }

  recordLegacyReceipt(
    child: LaunchProcess,
    requestId: string,
    receipt: NonNullable<LaunchRequest['completionReceipt']>,
  ): boolean {
    return this.#change((state) => {
      const launch = state.launch;
      const request = state.requests.find((entry) => entry.id === requestId);
      if (
        launch?.id !== receipt.launchId ||
        launch.purpose !== 'legacy-retirement' ||
        launch.terminationAt !== undefined ||
        launch.phase !== 'admitted' ||
        launch.child?.pid !== child.pid ||
        launch.child.incarnation !== child.incarnation ||
        request?.status !== 'accepted' ||
        request.buildSetId !== launch.buildSetId ||
        request.incumbent === undefined
      )
        return { state, result: false };
      if (request.completionReceipt !== undefined)
        return { state, result: JSON.stringify(request.completionReceipt) === JSON.stringify(receipt) };
      const requests = state.requests.map((entry) =>
        entry.id === requestId ? { ...entry, completionReceipt: receipt } : entry,
      );
      return { state: { ...state, requests }, result: true };
    });
  }

  admit(reservation: LaunchReservation, parent: LaunchProcess, child: LaunchProcess, now: number): boolean {
    return this.#change((state) => {
      const slot = this.#slot(state, reservation);
      const launch = slot === 'launch' ? state.launch : state.attempt;
      if (
        state.owner === null ||
        state.owner.epoch !== reservation.ownerEpoch ||
        state.owner.leaseUntil <= now ||
        state.owner.process.pid !== parent.pid ||
        state.owner.process.incarnation !== parent.incarnation ||
        launch?.id !== reservation.id ||
        launch.phase !== 'reserved' ||
        launch.terminationAt !== undefined
      )
        return { state, result: false };
      const admitted: LaunchReservation = { ...launch, phase: 'admitted', admittedAt: now, parent, child };
      return {
        state: slot === 'launch' ? { ...state, launch: admitted } : { ...state, attempt: admitted },
        result: true,
      };
    });
  }

  cancelReservation(owner: LaunchOwner, reservation: LaunchReservation, now: number): boolean {
    return this.#change((state) => {
      const slot = this.#slot(state, reservation);
      const launch = slot === 'launch' ? state.launch : state.attempt;
      if (
        !this.#current(state, owner, now) ||
        launch?.id !== reservation.id ||
        launch.phase !== 'reserved' ||
        launch.terminationAt !== undefined
      )
        return { state, result: false };
      return { state: slot === 'launch' ? { ...state, launch: null } : { ...state, attempt: null }, result: true };
    });
  }

  serving(reservation: LaunchReservation, child: LaunchProcess): boolean {
    return this.#change((state) => {
      const slot = this.#slot(state, reservation);
      const launch = slot === 'launch' ? state.launch : state.attempt;
      if (
        !this.#exactChild(launch, reservation, child) ||
        launch?.phase !== 'admitted' ||
        launch.terminationAt !== undefined
      )
        return { state, result: false };
      const serving: LaunchReservation = { ...launch, phase: 'serving', observedHealthyAt: Date.now() };
      return {
        state: slot === 'launch' ? { ...state, launch: serving } : { ...state, attempt: serving },
        result: true,
      };
    });
  }

  exited(reservation: LaunchReservation, child: LaunchProcess): boolean {
    return this.#change((state) => {
      const slot = this.#slot(state, reservation);
      const launch = slot === 'launch' ? state.launch : state.attempt;
      if (!this.#exactChild(launch, reservation, child) || launch === null || launch.phase === 'exited')
        return { state, result: false };
      const exited: LaunchReservation = { ...launch, phase: 'exited' };
      return {
        state: {
          ...(slot === 'launch' ? { ...state, launch: exited } : { ...state, attempt: exited }),
          signalHolds: (state.signalHolds ?? []).filter((hold) => hold.launchId !== reservation.id),
          inheritedHolds: (state.inheritedHolds ?? []).filter((hold) => hold.launchId !== reservation.id),
        },
        result: true,
      };
    });
  }

  /** A successor owner may settle an inherited child only after decisive process absence. */
  settleAbsentChild(owner: LaunchOwner, reservation: LaunchReservation, now: number): boolean {
    return this.#change((state) => {
      const slot = this.#slot(state, reservation);
      const launch = slot === 'launch' ? state.launch : state.attempt;
      if (
        !this.#current(state, owner, now) ||
        launch?.id !== reservation.id ||
        launch.phase === 'reserved' ||
        launch.phase === 'exited' ||
        launch.child?.pid !== reservation.child?.pid ||
        launch.child?.incarnation !== reservation.child?.incarnation
      )
        return { state, result: false };
      const exited: LaunchReservation = { ...launch, phase: 'exited' };
      return {
        state: this.#normalize({
          ...(slot === 'launch' ? { ...state, launch: exited } : { ...state, attempt: exited }),
          signalHolds: (state.signalHolds ?? []).filter((hold) => hold.launchId !== reservation.id),
          inheritedHolds: (state.inheritedHolds ?? []).filter((hold) => hold.launchId !== reservation.id),
        }),
        result: true,
      };
    });
  }

  normalize(owner: LaunchOwner, now: number): LaunchReservation | null {
    return this.#change((state) => {
      if (!this.#current(state, owner, now)) return { state, result: null };
      const normalized = this.#normalize(state);
      return { state: normalized, result: normalized.launch?.id !== state.launch?.id ? normalized.launch : null };
    });
  }

  commitTermination(
    owner: LaunchOwner,
    reservation: LaunchReservation,
    identity: LaunchProcess,
    now: number,
    graceMs: number,
  ): boolean {
    return this.#change((state) => {
      if (!this.#current(state, owner, now)) return { state, result: false };
      const slot = this.#slot(state, reservation);
      const child = slot === 'launch' ? state.launch : state.attempt;
      if (
        slot === null ||
        child?.id !== reservation.id ||
        child.phase === 'exited' ||
        (child.child !== undefined &&
          (child.child.pid !== identity.pid || child.child.incarnation !== identity.incarnation))
      )
        return { state, result: false };
      if (child.terminationAt !== undefined && child.terminationOwnerEpoch === owner.epoch)
        return { state, result: true };
      const committed = {
        ...child,
        child: identity,
        terminationAt: child.terminationAt ?? now,
        killAt: child.killAt ?? now + graceMs,
        terminationOwnerEpoch: owner.epoch,
      };
      return {
        state: slot === 'launch' ? { ...state, launch: committed } : { ...state, attempt: committed },
        result: true,
      };
    });
  }

  observeInheritedHealth(owner: LaunchOwner, reservation: LaunchReservation, now: number): void {
    this.#change((state) => {
      if (!this.#current(state, owner, now)) return { state, result: undefined };
      const slot = this.#slot(state, reservation);
      const child = slot === 'launch' ? state.launch : state.attempt;
      if (slot === null || child?.id !== reservation.id || child.terminationAt !== undefined)
        return { state, result: undefined };
      const healthy = { ...child, observedHealthyAt: now };
      return {
        state: slot === 'launch' ? { ...state, launch: healthy } : { ...state, attempt: healthy },
        result: undefined,
      };
    });
  }

  release(owner: LaunchOwner): boolean {
    return this.#change((state) => {
      if (
        !this.#current(state, owner, Date.now()) ||
        (state.launch !== null && state.launch.phase !== 'exited') ||
        (state.attempt !== null && state.attempt.phase !== 'exited') ||
        state.requests.some((request) => request.status === 'recorded' || request.status === 'accepted')
      )
        return { state, result: false };
      return { state: { ...state, owner: null }, result: true };
    });
  }

  #current(state: CoordinatorLaunchState, owner: LaunchOwner, now: number): boolean {
    return state.owner?.id === owner.id && state.owner.epoch === owner.epoch && state.owner.leaseUntil > now;
  }

  #terminatingBuild(state: CoordinatorLaunchState, buildSetId: string): boolean {
    return [state.launch, state.attempt].some(
      (slot) => slot?.buildSetId === buildSetId && slot.phase !== 'exited' && slot.terminationAt !== undefined,
    );
  }

  #exactChild(launch: LaunchReservation | null, reservation: LaunchReservation, child: LaunchProcess): boolean {
    return (
      launch?.id === reservation.id && launch.child?.pid === child.pid && launch.child.incarnation === child.incarnation
    );
  }

  #slot(state: CoordinatorLaunchState, reservation: LaunchReservation): 'launch' | 'attempt' | null {
    if (state.launch?.id === reservation.id) return 'launch';
    if (state.attempt?.id === reservation.id) return 'attempt';
    return null;
  }

  #mode(state: CoordinatorLaunchState, parent: LaunchProcess): LaunchOwner['mode'] {
    return [state.launch, state.attempt].some(
      (slot) =>
        slot !== null &&
        (slot.phase === 'admitted' || slot.phase === 'serving') &&
        (slot.parent?.pid !== parent.pid || slot.parent.incarnation !== parent.incarnation),
    )
      ? 'recovering'
      : 'supervised';
  }

  #normalize(state: CoordinatorLaunchState): CoordinatorLaunchState {
    const next =
      state.launch?.phase === 'exited' && state.attempt !== null && state.attempt.phase !== 'exited'
        ? { ...state, launch: state.attempt, attempt: null }
        : state;
    if (next.owner === null) return next;
    const mode = this.#mode(next, next.owner.process);
    return next.owner.mode === mode ? next : { ...next, owner: { ...next.owner, mode } };
  }
}

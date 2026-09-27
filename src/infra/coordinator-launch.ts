import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { coordinatorLaunchPath } from './path/index.js';
import { observeProcessLiveness, probeProcessIncarnation, type ProcessIncarnation } from './node-process.js';

export type LaunchProcess = Readonly<{ pid: number; incarnation: ProcessIncarnation }>;
export type LaunchOwner = Readonly<{
  id: string;
  process: LaunchProcess;
  buildSetId: string;
  epoch: number;
  renewal: number;
  leaseUntil: number;
}>;
export type LaunchReservation = Readonly<{
  id: string;
  ownerEpoch: number;
  buildSetId: string;
  purpose: 'startup' | 'contender' | 'succession' | 'recovery' | 'legacy-retirement';
  phase: 'reserved' | 'admitted' | 'serving' | 'exited';
  parent?: LaunchProcess;
  child?: LaunchProcess;
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
  hold?:
    | Readonly<{ kind: 'no-eligible-build'; controller: string }>
    | Readonly<{ kind: 'target-indeterminate'; requestId: string }>;
}>;

export const LAUNCH_OWNER_LEASE_MS = 10 * 60_000;

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
      const current = this.read();
      const { state, result } = transition(current);
      if (state !== current) {
        this.#database
          .prepare('UPDATE control SET state = ? WHERE id = 1')
          .run(JSON.stringify({ ...state, revision: current.revision + 1 }));
      }
      this.#database.exec('COMMIT');
      return result;
    } catch (error: unknown) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  acquire(holder: Omit<LaunchOwner, 'epoch' | 'renewal' | 'leaseUntil'>, now: number): LaunchOwner | null {
    return this.#change((state) => {
      if (state.owner !== null && state.owner.leaseUntil > now) {
        const observed = probeProcessIncarnation(state.owner.process.pid);
        if (
          observed === state.owner.process.incarnation ||
          (observed === null && observeProcessLiveness(state.owner.process.pid) !== 'absent')
        )
          return { state, result: null };
      }
      const owner: LaunchOwner = {
        ...holder,
        epoch: state.ownerEpoch + 1,
        renewal: 0,
        leaseUntil: now + LAUNCH_OWNER_LEASE_MS,
      };
      const launch = state.launch?.phase === 'reserved' ? null : state.launch;
      const attempt = state.attempt?.phase === 'reserved' ? null : state.attempt;
      return {
        state: { ...state, ownerEpoch: owner.epoch, owner, launch, attempt },
        result: owner,
      };
    });
  }

  renew(owner: LaunchOwner, now: number): LaunchOwner | null {
    return this.#change((state) => {
      if (!this.#current(state, owner, now)) return { state, result: null };
      const renewed = {
        ...owner,
        renewal: (state.owner?.renewal ?? owner.renewal) + 1,
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
      const succession = (purpose === 'succession' || purpose === 'contender') && state.launch?.phase === 'serving';
      if (
        !this.#current(state, owner, now) ||
        (succession
          ? state.attempt !== null && state.attempt.phase !== 'exited'
          : state.launch !== null && state.launch.phase !== 'exited')
      )
        return { state, result: null };
      const launch: LaunchReservation = {
        id: randomUUID(),
        ownerEpoch: owner.epoch,
        buildSetId,
        purpose,
        phase: 'reserved',
      };
      return { state: succession ? { ...state, attempt: launch } : { ...state, launch }, result: launch };
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

  hold(owner: LaunchOwner, controller: string, now: number): void {
    this.#change((state) => {
      if (
        !this.#current(state, owner, now) ||
        (state.hold?.kind === 'no-eligible-build' && state.hold.controller === controller)
      )
        return { state, result: undefined };
      return { state: { ...state, hold: { kind: 'no-eligible-build', controller } }, result: undefined };
    });
  }

  clearHold(owner: LaunchOwner, now: number): void {
    this.#change((state) => {
      if (!this.#current(state, owner, now) || state.hold?.kind !== 'no-eligible-build')
        return { state, result: undefined };
      return { state: { ...state, hold: undefined }, result: undefined };
    });
  }

  holdTarget(owner: LaunchOwner, requestId: string, now: number): void {
    this.#change((state) => {
      if (!this.#current(state, owner, now)) return { state, result: undefined };
      return { state: { ...state, hold: { kind: 'target-indeterminate', requestId } }, result: undefined };
    });
  }

  clearTargetHold(owner: LaunchOwner, now: number): void {
    this.#change((state) => {
      if (!this.#current(state, owner, now) || state.hold?.kind !== 'target-indeterminate')
        return { state, result: undefined };
      return { state: { ...state, hold: undefined }, result: undefined };
    });
  }

  accept(owner: LaunchOwner, requestId: string, now: number): boolean {
    return this.#change((state) => {
      if (!this.#current(state, owner, now)) return { state, result: false };
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
        launch.phase !== 'reserved'
      )
        return { state, result: false };
      const admitted: LaunchReservation = { ...launch, phase: 'admitted', parent, child };
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
      if (!this.#current(state, owner, now) || launch?.id !== reservation.id || launch.phase !== 'reserved')
        return { state, result: false };
      return { state: slot === 'launch' ? { ...state, launch: null } : { ...state, attempt: null }, result: true };
    });
  }

  serving(reservation: LaunchReservation, child: LaunchProcess): boolean {
    return this.#change((state) => {
      const slot = this.#slot(state, reservation);
      const launch = slot === 'launch' ? state.launch : state.attempt;
      if (!this.#exactChild(launch, reservation, child) || launch?.phase !== 'admitted')
        return { state, result: false };
      const serving: LaunchReservation = { ...launch, phase: 'serving' };
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
      return { state: slot === 'launch' ? { ...state, launch: exited } : { ...state, attempt: exited }, result: true };
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
      return { state: slot === 'launch' ? { ...state, launch: exited } : { ...state, attempt: exited }, result: true };
    });
  }

  promoteAttempt(owner: LaunchOwner, now: number): LaunchReservation | null {
    return this.#change((state) => {
      if (
        !this.#current(state, owner, now) ||
        state.launch?.phase !== 'exited' ||
        state.attempt === null ||
        state.attempt.phase === 'exited'
      )
        return { state, result: null };
      return { state: { ...state, launch: state.attempt, attempt: null }, result: state.attempt };
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
}

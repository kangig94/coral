import { join, resolve } from 'node:path';

import {
  createSharedFileLockSync,
  tryAcquireExclusiveFileLockSync,
  waitSync,
  type FileLockLease,
} from '../infra/fs-lock.js';
import type { Runtime } from '../runtime/ports.js';
import type { StoragePort } from '../infra/port-types.js';
import { resolveGenerationBoundaryPaths } from './generation-mutation-coordination.js';

export type SuccessionWriterGeneration = Readonly<{
  generation: number;
  storeRoot: string;
  epoch: string;
}>;

export type SuccessionServingRecord = Readonly<{
  attemptId: string;
  epochKey: string;
  successorInstanceId: string;
  controlGeneration: number;
  recordedAt: string;
}>;

export class SuccessionServingCommittedError extends Error {
  constructor() {
    super('Succession serving was committed; the incumbent cannot reclaim its writer.');
  }
}

export class SuccessionWriterGenerationExhaustedError extends Error {
  constructor() {
    super('Succession writer generation exhausted its counter.');
  }
}

function nextWriterGeneration(generation: number): number {
  if (!Number.isSafeInteger(generation) || generation >= Number.MAX_SAFE_INTEGER) {
    throw new SuccessionWriterGenerationExhaustedError();
  }
  return generation + 1;
}

declare const committedServing: unique symbol;
export type CommittedSuccessionServing = SuccessionServingRecord & Readonly<{ [committedServing]: true }>;

type SuccessionWriterRecord = SuccessionWriterGeneration &
  Readonly<{
    serving?: SuccessionServingRecord;
    priorServings?: readonly SuccessionServingRecord[];
    refusedAttemptIds?: readonly string[];
    reconstructedGeneration?: number;
  }>;

export class SuccessionAttemptRefusedError extends Error {
  constructor(attemptId: string) {
    super(`Succession attempt ${attemptId} was refused by its incumbent.`);
  }
}

export type SuccessionAttemptRefusal =
  | Readonly<{ kind: 'refused' }>
  | Readonly<{ kind: 'serving'; serving: CommittedSuccessionServing }>;

export interface SuccessionWriterEntitlement {
  readonly generation: SuccessionWriterGeneration;
  assertCurrent(): void;
  withWriteTurn<T>(write: () => T): T;
  beginWriteTurn(): FileLockLease;
  onPark(closeWritableHandle: () => void): () => void;
  onUnpark(reopenWritableHandle: () => void): () => void;
  park(): void;
  rebind(generation: SuccessionWriterGeneration): void;
  unpark(): void;
}

const GUARD_FILE = 'succession-writer.lock';
const RECORD_FILE = 'succession-writer-generation.v1.json';
const GUARD_WAIT_MS = 5_000;

const REFUSED_ATTEMPT_MEMORY = 8;
type LocalParkState = {
  generation: SuccessionWriterGeneration;
  parked: boolean;
  closeWritableHandles: Set<() => void>;
  reopenWritableHandles: Set<() => void>;
};
const localParkStates = new Map<string, LocalParkState>();

function localParkKey(record: string, generation: SuccessionWriterGeneration): string {
  return `${record}\0${generation.generation}\0${generation.storeRoot}\0${generation.epoch}`;
}

function paths(runtime: Pick<Runtime, 'paths'>): { root: string; guard: string; record: string } {
  const root = resolveGenerationBoundaryPaths(runtime).coordinationRoot;
  return { root, guard: join(root, GUARD_FILE), record: join(root, RECORD_FILE) };
}

function canonicalText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value && !value.includes('\0');
}

function canonicalPath(value: unknown): value is string {
  return canonicalText(value) && resolve(value) === value;
}

function canonicalEpoch(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9]\d*$/u.test(value);
}

function matchesFullEpochKey(key: string, generation: SuccessionWriterGeneration): boolean {
  try {
    const epoch: unknown = JSON.parse(key);
    return (
      typeof epoch === 'object' &&
      epoch !== null &&
      'storeRoot' in epoch &&
      epoch.storeRoot === generation.storeRoot &&
      'epoch' in epoch &&
      epoch.epoch === generation.epoch &&
      'path' in epoch &&
      canonicalPath(epoch.path)
    );
  } catch {
    return false;
  }
}

function validServing(value: unknown, generation: SuccessionWriterGeneration): value is SuccessionServingRecord {
  if (typeof value !== 'object' || value === null) return false;
  if (
    !('attemptId' in value) ||
    !canonicalText(value.attemptId) ||
    !('epochKey' in value) ||
    typeof value.epochKey !== 'string' ||
    !matchesFullEpochKey(value.epochKey, generation) ||
    !('successorInstanceId' in value) ||
    !canonicalText(value.successorInstanceId) ||
    !('controlGeneration' in value) ||
    value.controlGeneration !== generation.generation ||
    !('recordedAt' in value) ||
    typeof value.recordedAt !== 'string'
  ) {
    return false;
  }
  try {
    return new Date(value.recordedAt).toISOString() === value.recordedAt;
  } catch {
    return false;
  }
}

function validPriorServing(value: unknown, current: SuccessionWriterGeneration): value is SuccessionServingRecord {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('epochKey' in value) ||
    typeof value.epochKey !== 'string' ||
    !('controlGeneration' in value) ||
    typeof value.controlGeneration !== 'number' ||
    !Number.isSafeInteger(value.controlGeneration) ||
    value.controlGeneration < 1 ||
    value.controlGeneration >= current.generation
  ) {
    return false;
  }
  try {
    const epoch: unknown = JSON.parse(value.epochKey);
    return (
      typeof epoch === 'object' &&
      epoch !== null &&
      'storeRoot' in epoch &&
      canonicalPath(epoch.storeRoot) &&
      'epoch' in epoch &&
      canonicalEpoch(epoch.epoch) &&
      validServing(value, {
        generation: value.controlGeneration,
        storeRoot: epoch.storeRoot,
        epoch: epoch.epoch,
      })
    );
  } catch {
    return false;
  }
}

export type SuccessionWriterGenerationRead =
  | Readonly<{ kind: 'recorded'; record: SuccessionWriterRecord }>
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'corrupt'; raw: string }>;

export function readSuccessionWriterGeneration(runtime: Runtime): SuccessionWriterGenerationRead {
  return readGeneration(runtime, paths(runtime).record);
}

function requireGeneration(runtime: Runtime, record: string): SuccessionWriterRecord | null {
  const read = readGeneration(runtime, record);
  if (read.kind === 'corrupt') throw new Error(`Corrupt succession writer generation record: ${record}`);
  return read.kind === 'recorded' ? read.record : null;
}

function readGeneration(runtime: Runtime, record: string): SuccessionWriterGenerationRead {
  let raw: string;
  try {
    raw = runtime.storage.readFileSync(record, 'utf-8');
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { kind: 'absent' };
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return { kind: 'corrupt', raw };
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    !('generation' in value) ||
    typeof value.generation !== 'number' ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1 ||
    !('storeRoot' in value) ||
    !canonicalPath(value.storeRoot) ||
    !('epoch' in value) ||
    !canonicalEpoch(value.epoch)
  ) {
    return { kind: 'corrupt', raw };
  }
  if ('serving' in value) {
    if (!validServing(value.serving, value as SuccessionWriterGeneration)) {
      return { kind: 'corrupt', raw };
    }
  }
  if (
    'priorServings' in value &&
    (!Array.isArray(value.priorServings) ||
      !value.priorServings.every((serving) => validPriorServing(serving, value as SuccessionWriterGeneration)))
  ) {
    return { kind: 'corrupt', raw };
  }
  if (
    'refusedAttemptIds' in value &&
    (!Array.isArray(value.refusedAttemptIds) || !value.refusedAttemptIds.every(canonicalText))
  ) {
    return { kind: 'corrupt', raw };
  }
  if (
    'reconstructedGeneration' in value &&
    (typeof value.reconstructedGeneration !== 'number' ||
      !Number.isSafeInteger(value.reconstructedGeneration) ||
      value.reconstructedGeneration < 1 ||
      value.reconstructedGeneration > value.generation)
  ) {
    return { kind: 'corrupt', raw };
  }
  return { kind: 'recorded', record: value as SuccessionWriterRecord };
}

type WriterRecoveryEvidence = Readonly<{
  store: Readonly<{ storeRoot: string; epoch: string }>;
  generations: readonly number[];
  servings: readonly SuccessionServingRecord[];
  release(): void;
}>;

function recoveredWriterGeneration(
  runtime: Runtime,
  record: string,
  raw: string,
  evidence: WriterRecoveryEvidence,
): SuccessionWriterGeneration {
  const local = [...localParkStates].filter(([key]) => key.startsWith(`${record}\0`));
  const generations = [...evidence.generations, ...local.map(([, state]) => state.generation.generation)];
  for (const match of raw.matchAll(/"(?:generation|controlGeneration)"\s*:\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/gu)) {
    const value = Number(match[1]);
    if (Number.isSafeInteger(value)) generations.push(value);
  }
  const generation = nextWriterGeneration(
    generations.reduce((highest, value) => Math.max(highest, value), runtime.time.now()),
  );
  return { generation, ...evidence.store };
}

function retainedWriterFields(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
  } catch {
    // Unparseable additive fields must not prevent evidence-backed reconstruction.
  }
  return {};
}

function reconstructWriterRecord(
  raw: string,
  current: SuccessionWriterGeneration,
  evidence: WriterRecoveryEvidence,
): SuccessionWriterRecord {
  const priorServings = evidence.servings.filter((serving) => validPriorServing(serving, current));
  const retained = retainedWriterFields(raw);
  if (
    validServing(retained.serving, retained as SuccessionWriterGeneration) &&
    validPriorServing(retained.serving, current)
  )
    priorServings.push(retained.serving);
  if (Array.isArray(retained.priorServings)) {
    priorServings.push(
      ...retained.priorServings.filter((serving): serving is SuccessionServingRecord =>
        validPriorServing(serving, current),
      ),
    );
  }
  delete retained.serving;
  if (!Array.isArray(retained.refusedAttemptIds) || !retained.refusedAttemptIds.every(canonicalText))
    delete retained.refusedAttemptIds;
  return { ...retained, ...current, priorServings, reconstructedGeneration: current.generation };
}

function quarantineWriterRecord(runtime: Runtime, location: ReturnType<typeof paths>): void {
  const quarantine = `${location.record}.corrupt-${runtime.ids.uuid()}`;
  runtime.storage.linkSync(location.record, quarantine);
  const fd = runtime.storage.openSync(quarantine, 'r');
  try {
    runtime.storage.fdatasyncSync(fd);
  } finally {
    runtime.storage.closeSync(fd);
  }
  if (!runtime.storage.syncDirectoryDurableSync(location.root)) {
    throw new Error('Could not quarantine corrupt succession writer generation.');
  }
}

/** Runs evidence collection only while all writer turns are excluded. */
export function recoverSuccessionWriterGeneration(runtime: Runtime, proveRecovery: () => WriterRecoveryEvidence): void {
  const location = paths(runtime);
  if (readGeneration(runtime, location.record).kind !== 'corrupt') return;
  ensureGuard(runtime);
  const release = exclusiveGuard(runtime, location.guard);
  try {
    const damaged = readGeneration(runtime, location.record);
    if (damaged.kind !== 'corrupt') return;
    const evidence = proveRecovery();
    try {
      const current = recoveredWriterGeneration(runtime, location.record, damaged.raw, evidence);
      const record = reconstructWriterRecord(damaged.raw, current, evidence);
      quarantineWriterRecord(runtime, location);
      writeGeneration(runtime, location.record, record);
    } finally {
      evidence.release();
    }
  } finally {
    release();
  }
}

function assertNotRefused(current: SuccessionWriterRecord, attemptId: string): void {
  if (current.refusedAttemptIds?.includes(attemptId) === true) throw new SuccessionAttemptRefusedError(attemptId);
}

function writeGeneration(runtime: Runtime, record: string, generation: SuccessionWriterRecord): void {
  if (!runtime.storage.writeAtomicDurableSync(record, `${JSON.stringify(generation)}\n`, { mode: 0o600 })) {
    throw new Error(`Could not durably record succession writer generation: ${record}`);
  }
}

function exclusiveGuard(runtime: Runtime, guard: string, deadlineMonotonicMs?: number): FileLockLease {
  const waitMs =
    deadlineMonotonicMs === undefined
      ? GUARD_WAIT_MS
      : Math.min(GUARD_WAIT_MS, Math.max(0, deadlineMonotonicMs - Number(runtime.time.monotonicNow())));
  const deadline = runtime.time.monotonicNow() + BigInt(Math.ceil(waitMs));
  let cause: unknown;
  for (;;) {
    try {
      const release = tryAcquireExclusiveFileLockSync(guard);
      if (release !== null) return release;
    } catch (error: unknown) {
      cause = error;
    }
    if (runtime.time.monotonicNow() >= deadline)
      throw new Error(`Succession writer guard timed out: ${guard}`, { cause });
    waitSync(10);
  }
}

function ensureGuard(runtime: Runtime): ReturnType<typeof paths> {
  const location = paths(runtime);
  runtime.storage.mkdirSync(location.root, { recursive: true, mode: 0o700 });
  createSharedFileLockSync(location.guard)();
  return location;
}

function parkSuccessionWriterGeneration(
  runtime: Runtime,
  location: ReturnType<typeof paths>,
  state: LocalParkState,
): void {
  state.parked = true;
  let closeError: unknown;
  for (const close of [...state.closeWritableHandles]) {
    try {
      close();
    } catch (error: unknown) {
      closeError ??= error;
    }
  }
  const release = exclusiveGuard(runtime, location.guard);
  release();
  if (closeError !== undefined) {
    throw closeError instanceof Error ? closeError : new Error('Writable handle close failed.', { cause: closeError });
  }
}

function rebindSuccessionWriterGeneration(
  runtime: Runtime,
  location: ReturnType<typeof paths>,
  state: LocalParkState,
  next: SuccessionWriterGeneration,
): void {
  if (!state.parked) throw new Error('A live succession writer cannot rebind its generation.');
  const release = createSharedFileLockSync(location.guard);
  try {
    const observed = requireGeneration(runtime, location.record);
    if (
      observed?.generation !== next.generation ||
      observed.storeRoot !== next.storeRoot ||
      observed.epoch !== next.epoch ||
      observed.serving !== undefined ||
      next.generation <= state.generation.generation ||
      next.storeRoot !== state.generation.storeRoot ||
      next.epoch !== state.generation.epoch
    ) {
      throw new Error(`Succession writer generation ${state.generation.generation} cannot rebind.`);
    }
    const nextKey = localParkKey(location.record, next);
    const localSuccessor = localParkStates.get(nextKey);
    if (localSuccessor !== undefined && localSuccessor !== state) {
      throw new Error(`Succession writer generation ${next.generation} already has a local holder.`);
    }
    localParkStates.delete(localParkKey(location.record, state.generation));
    state.generation = next;
    localParkStates.set(nextKey, state);
  } finally {
    release();
  }
}

function unparkSuccessionWriterGeneration(
  runtime: Runtime,
  location: ReturnType<typeof paths>,
  state: LocalParkState,
): void {
  const release = createSharedFileLockSync(location.guard);
  try {
    const generation = state.generation;
    const observed = requireGeneration(runtime, location.record);
    if (
      observed?.generation !== generation.generation ||
      observed.storeRoot !== generation.storeRoot ||
      observed.epoch !== generation.epoch
    ) {
      throw new Error(`Succession writer generation ${generation.generation} cannot unpark after advance.`);
    }
  } finally {
    release();
  }
  state.parked = false;
  try {
    for (const reopen of [...state.reopenWritableHandles]) reopen();
  } catch (error: unknown) {
    state.parked = true;
    for (const close of [...state.closeWritableHandles]) {
      try {
        close();
      } catch {
        // A failed close does not make the parked entitlement writable.
      }
    }
    throw error;
  }
}

export function joinSuccessionWriterGeneration(
  runtime: Runtime,
  store: Readonly<{ storeRoot: string; epoch: string }>,
): SuccessionWriterEntitlement {
  const location = ensureGuard(runtime);
  let current = requireGeneration(runtime, location.record);
  if (current === null) {
    const release = exclusiveGuard(runtime, location.guard);
    try {
      current = requireGeneration(runtime, location.record);
      if (current === null) {
        current = { generation: 1, storeRoot: store.storeRoot, epoch: store.epoch };
        writeGeneration(runtime, location.record, current);
      }
    } finally {
      release();
    }
  }
  if (current.storeRoot !== store.storeRoot || current.epoch !== store.epoch) {
    throw new Error(`Store epoch ${store.epoch} is not the active succession writer epoch.`);
  }
  const localKey = localParkKey(location.record, current);
  let parkState = localParkStates.get(localKey);
  if (parkState === undefined) {
    parkState = {
      generation: current,
      parked: false,
      closeWritableHandles: new Set(),
      reopenWritableHandles: new Set(),
    };
    localParkStates.set(localKey, parkState);
  }
  const state = parkState;
  const assertCurrent = () => {
    const generation = state.generation;
    if (state.parked) throw new Error(`Succession writer generation ${generation.generation} is parked.`);
    const observed = requireGeneration(runtime, location.record);
    if (
      observed?.generation !== generation.generation ||
      observed.storeRoot !== generation.storeRoot ||
      observed.epoch !== generation.epoch
    ) {
      throw new Error(`Succession writer generation ${generation.generation} lost its entitlement.`);
    }
  };
  const beginWriteTurn = (): FileLockLease => {
    if (state.parked) throw new Error(`Succession writer generation ${state.generation.generation} is parked.`);
    return createSharedFileLockSync(location.guard);
  };
  return {
    get generation() {
      return state.generation;
    },
    assertCurrent,
    beginWriteTurn,
    onPark(closeWritableHandle) {
      if (state.parked) throw new Error(`Succession writer generation ${state.generation.generation} is parked.`);
      state.closeWritableHandles.add(closeWritableHandle);
      return () => state.closeWritableHandles.delete(closeWritableHandle);
    },
    onUnpark(reopenWritableHandle) {
      if (state.parked) throw new Error(`Succession writer generation ${state.generation.generation} is parked.`);
      state.reopenWritableHandles.add(reopenWritableHandle);
      return () => state.reopenWritableHandles.delete(reopenWritableHandle);
    },
    withWriteTurn<T>(write: () => T): T {
      const release = beginWriteTurn();
      try {
        assertCurrent();
        return write();
      } finally {
        release();
      }
    },
    park: () => parkSuccessionWriterGeneration(runtime, location, state),
    rebind: (next) => rebindSuccessionWriterGeneration(runtime, location, state, next),
    unpark: () => unparkSuccessionWriterGeneration(runtime, location, state),
  };
}

/** An attempt child names its attempt, so an advance its incumbent already refused is refused under the guard. */
export function advanceSuccessionWriterGeneration(
  runtime: Runtime,
  expected: SuccessionWriterGeneration,
  store: Readonly<{ storeRoot: string; epoch: string }>,
  attemptId?: string,
): SuccessionWriterGeneration {
  const location = ensureGuard(runtime);
  const release = exclusiveGuard(runtime, location.guard);
  try {
    const current = requireGeneration(runtime, location.record);
    if (
      current?.generation !== expected.generation ||
      current.storeRoot !== expected.storeRoot ||
      current.epoch !== expected.epoch
    ) {
      throw new Error(`Succession writer generation ${expected.generation} cannot advance.`);
    }
    if (attemptId !== undefined) assertNotRefused(current, attemptId);
    const next = {
      ...current,
      generation: nextWriterGeneration(current.generation),
      storeRoot: store.storeRoot,
      epoch: store.epoch,
    };
    if (current.serving !== undefined) next.priorServings = [...(current.priorServings ?? []), current.serving];
    delete next.serving;
    writeGeneration(runtime, location.record, next);
    return next;
  } finally {
    release();
  }
}

/** Keep retirement publication ordered with refusal on the writer-generation guard. */
export function withSuccessionAttemptMayAdvance<T>(
  runtime: Runtime,
  expected: SuccessionWriterGeneration,
  attemptId: string,
  publish: () => T,
): T {
  const location = ensureGuard(runtime);
  const release = exclusiveGuard(runtime, location.guard);
  try {
    const current = requireGeneration(runtime, location.record);
    if (
      current?.generation !== expected.generation ||
      current.storeRoot !== expected.storeRoot ||
      current.epoch !== expected.epoch
    ) {
      throw new Error(`Succession writer generation ${expected.generation} cannot advance.`);
    }
    assertNotRefused(current, attemptId);
    return publish();
  } finally {
    release();
  }
}

export function assertSuccessionAttemptMayAdvance(
  runtime: Runtime,
  expected: SuccessionWriterGeneration,
  attemptId: string,
): void {
  withSuccessionAttemptMayAdvance(runtime, expected, attemptId, () => {});
}

export function recordSuccessionServing(
  runtime: Runtime,
  generation: SuccessionWriterGeneration,
  serving: SuccessionServingRecord,
): CommittedSuccessionServing {
  const location = ensureGuard(runtime);
  const release = exclusiveGuard(runtime, location.guard);
  try {
    const current = requireGeneration(runtime, location.record);
    if (
      current?.generation !== generation.generation ||
      current.storeRoot !== generation.storeRoot ||
      current.epoch !== generation.epoch ||
      serving.controlGeneration !== generation.generation
    ) {
      throw new Error('Succession cannot record serving without the current writer generation.');
    }
    if (!validServing(serving, current)) {
      throw new Error('Succession serving record must name a current full epoch key and valid identity.');
    }
    assertNotRefused(current, serving.attemptId);
    if (current.serving !== undefined) {
      if (
        current.serving.attemptId !== serving.attemptId ||
        current.serving.epochKey !== serving.epochKey ||
        current.serving.successorInstanceId !== serving.successorInstanceId ||
        current.serving.controlGeneration !== serving.controlGeneration ||
        current.serving.recordedAt !== serving.recordedAt
      ) {
        throw new Error('Succession writer generation already serves another attempt.');
      }
      return current.serving as CommittedSuccessionServing;
    }
    writeGeneration(runtime, location.record, { ...current, serving });
    return serving as CommittedSuccessionServing;
  } finally {
    release();
  }
}

export function refuseSuccessionAttempt(
  runtime: Runtime,
  attemptId: string,
  deadlineMonotonicMs?: number,
): SuccessionAttemptRefusal {
  const location = ensureGuard(runtime);
  const release = exclusiveGuard(runtime, location.guard, deadlineMonotonicMs);
  try {
    const current = requireGeneration(runtime, location.record);
    if (current === null) throw new Error('Succession cannot refuse an attempt without a writer generation.');
    if (current.serving?.attemptId === attemptId) {
      return { kind: 'serving', serving: current.serving as CommittedSuccessionServing };
    }
    const earlier = (current.refusedAttemptIds ?? []).filter((refused) => refused !== attemptId);
    writeGeneration(runtime, location.record, {
      ...current,
      refusedAttemptIds: [...earlier, attemptId].slice(-REFUSED_ATTEMPT_MEMORY),
    });
    return { kind: 'refused' };
  } finally {
    release();
  }
}

export function observeSuccessionServing(runtime: Runtime, attemptId: string): SuccessionServingRecord | null {
  const location = paths(runtime);
  const current = requireGeneration(runtime, location.record);
  if (current?.serving?.attemptId === attemptId) return current.serving;
  return current !== null && current.reconstructedGeneration === current.generation
    ? (current.priorServings?.find((serving) => serving.attemptId === attemptId) ?? null)
    : null;
}

export function observeCurrentSuccessionServing(runtime: Runtime): SuccessionServingRecord | null {
  const location = paths(runtime);
  return requireGeneration(runtime, location.record)?.serving ?? null;
}

export function generationForLegacySuccessor(
  runtime: Runtime,
  expected: SuccessionWriterGeneration,
  attemptId: string,
  previousAttemptId: string,
): SuccessionWriterGeneration {
  const location = ensureGuard(runtime);
  const release = exclusiveGuard(runtime, location.guard);
  try {
    const current = requireGeneration(runtime, location.record);
    if (
      current?.generation !== expected.generation ||
      current.storeRoot !== expected.storeRoot ||
      current.epoch !== expected.epoch
    ) {
      throw new Error(`Succession writer generation ${expected.generation} cannot advance.`);
    }
    assertNotRefused(current, attemptId);
    if (current.serving?.attemptId === attemptId) return expected;
    if (current.serving?.attemptId !== previousAttemptId) {
      throw new Error('Previous succession serving changed before legacy successor generation advance.');
    }
    const next = {
      ...current,
      generation: nextWriterGeneration(current.generation),
      priorServings: [...(current.priorServings ?? []), current.serving],
    };
    delete next.serving;
    writeGeneration(runtime, location.record, next);
    return { generation: next.generation, storeRoot: next.storeRoot, epoch: next.epoch };
  } finally {
    release();
  }
}

export function observeSuccessionWriterGeneration(runtime: Runtime): SuccessionWriterGeneration | null {
  const location = paths(runtime);
  const current = requireGeneration(runtime, location.record);
  return current === null
    ? null
    : { generation: current.generation, storeRoot: current.storeRoot, epoch: current.epoch };
}

export function handbackSuccessionWriterGeneration(
  runtime: Runtime,
  failed: SuccessionWriterGeneration,
  incumbentStore: Readonly<{ storeRoot: string; epoch: string }>,
): SuccessionWriterGeneration {
  const location = ensureGuard(runtime);
  const release = exclusiveGuard(runtime, location.guard);
  try {
    const current = requireGeneration(runtime, location.record);
    if (
      current?.generation !== failed.generation ||
      current.storeRoot !== failed.storeRoot ||
      current.epoch !== failed.epoch
    ) {
      throw new Error(`Succession writer generation ${failed.generation} cannot hand back.`);
    }
    if (current.serving !== undefined) throw new SuccessionServingCommittedError();
    const next = {
      ...current,
      generation: nextWriterGeneration(current.generation),
      storeRoot: incumbentStore.storeRoot,
      epoch: incumbentStore.epoch,
    };
    writeGeneration(runtime, location.record, next);
    for (const [key, state] of [...localParkStates]) {
      if (
        key.startsWith(`${location.record}\0`) &&
        state.parked &&
        state.generation.storeRoot === incumbentStore.storeRoot &&
        state.generation.epoch === incumbentStore.epoch &&
        state.generation.generation < failed.generation
      ) {
        localParkStates.delete(key);
        state.generation = next;
        localParkStates.set(localParkKey(location.record, next), state);
      }
    }
    return next;
  } finally {
    release();
  }
}

const STORAGE_MUTATIONS = new Set<keyof StoragePort>([
  'writeFileSync',
  'renameSync',
  'linkSync',
  'mkdirSync',
  'rmSync',
  'writeSync',
  'fdatasyncSync',
  'appendFileSync',
  'appendFileDurableSync',
  'appendFileWithCanonicalCheckSync',
  'rmdirSync',
  'unlinkSync',
  'tryExclusiveWriteSync',
  'writeAtomicSync',
  'writeAtomicDurableSync',
  'syncDirectoryDurableSync',
  'chmodSync',
]);

export function fenceCorpusStorage(storage: StoragePort, entitlement: SuccessionWriterEntitlement): StoragePort {
  return new Proxy(storage, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      if (property === 'rm' || property === 'unlink' || property === 'syncDirectoryDurable') {
        return async (...args: unknown[]) => {
          const release = entitlement.beginWriteTurn();
          try {
            entitlement.assertCurrent();
            return await Reflect.apply(value, target, args);
          } finally {
            release();
          }
        };
      }
      if (property === 'openSync') {
        return (path: string, flags: string, mode?: number) =>
          /[wa+]/u.test(flags)
            ? entitlement.withWriteTurn(() => target.openSync(path, flags, mode))
            : target.openSync(path, flags, mode);
      }
      if (STORAGE_MUTATIONS.has(property as keyof StoragePort)) {
        return (...args: unknown[]) => entitlement.withWriteTurn(() => Reflect.apply(value, target, args));
      }
      return value.bind(target);
    },
  });
}

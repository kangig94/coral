import { join } from 'node:path';

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

declare const committedServing: unique symbol;
export type CommittedSuccessionServing = SuccessionServingRecord & Readonly<{ [committedServing]: true }>;

type SuccessionWriterRecord = SuccessionWriterGeneration & Readonly<{ serving?: SuccessionServingRecord }>;

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

const GUARD_FILE = 'succession-writer-guard.db';
const RECORD_FILE = 'succession-writer-generation.v1.json';
const GUARD_WAIT_MS = 5_000;
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
      typeof epoch.path === 'string' &&
      epoch.path.length > 0
    );
  } catch {
    return false;
  }
}

function validServing(value: unknown, generation: SuccessionWriterGeneration): value is SuccessionServingRecord {
  if (typeof value !== 'object' || value === null) return false;
  if (
    !('attemptId' in value) ||
    typeof value.attemptId !== 'string' ||
    value.attemptId.length === 0 ||
    !('epochKey' in value) ||
    typeof value.epochKey !== 'string' ||
    !matchesFullEpochKey(value.epochKey, generation) ||
    !('successorInstanceId' in value) ||
    typeof value.successorInstanceId !== 'string' ||
    value.successorInstanceId.length === 0 ||
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

function readGeneration(runtime: Runtime, record: string): SuccessionWriterRecord | null {
  let raw: string;
  try {
    raw = runtime.storage.readFileSync(record, 'utf-8');
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
  const value: unknown = JSON.parse(raw);
  if (
    typeof value !== 'object' ||
    value === null ||
    !('generation' in value) ||
    typeof value.generation !== 'number' ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1 ||
    !('storeRoot' in value) ||
    typeof value.storeRoot !== 'string' ||
    !('epoch' in value) ||
    typeof value.epoch !== 'string'
  ) {
    throw new Error(`Invalid succession writer generation record: ${record}`);
  }
  if ('serving' in value) {
    if (!validServing(value.serving, value as SuccessionWriterGeneration)) {
      throw new Error(`Invalid succession serving record: ${record}`);
    }
  }
  return value as SuccessionWriterRecord;
}

function writeGeneration(runtime: Runtime, record: string, generation: SuccessionWriterRecord): void {
  if (!runtime.storage.writeAtomicDurableSync(record, `${JSON.stringify(generation)}\n`, { mode: 0o600 })) {
    throw new Error(`Could not durably record succession writer generation: ${record}`);
  }
}

function exclusiveGuard(runtime: Runtime, guard: string): FileLockLease {
  const deadline = runtime.time.monotonicNow() + BigInt(GUARD_WAIT_MS);
  for (;;) {
    const release = tryAcquireExclusiveFileLockSync(guard);
    if (release !== null) return release;
    if (runtime.time.monotonicNow() >= deadline) throw new Error(`Succession writer guard timed out: ${guard}`);
    waitSync(10);
  }
}

function ensureGuard(runtime: Runtime): ReturnType<typeof paths> {
  const location = paths(runtime);
  runtime.storage.mkdirSync(location.root, { recursive: true, mode: 0o700 });
  createSharedFileLockSync(location.guard)();
  return location;
}

export function joinSuccessionWriterGeneration(
  runtime: Runtime,
  store: Readonly<{ storeRoot: string; epoch: string }>,
): SuccessionWriterEntitlement {
  const location = ensureGuard(runtime);
  let current = readGeneration(runtime, location.record);
  if (current === null) {
    const release = exclusiveGuard(runtime, location.guard);
    try {
      current = readGeneration(runtime, location.record);
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
    const observed = readGeneration(runtime, location.record);
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
    park() {
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
      if (closeError !== undefined) throw closeError;
    },
    rebind(next) {
      if (!state.parked) throw new Error('A live succession writer cannot rebind its generation.');
      const release = createSharedFileLockSync(location.guard);
      try {
        const observed = readGeneration(runtime, location.record);
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
    },
    unpark() {
      const release = createSharedFileLockSync(location.guard);
      try {
        const generation = state.generation;
        const observed = readGeneration(runtime, location.record);
        if (
          observed?.generation !== generation.generation ||
          observed.storeRoot !== generation.storeRoot ||
          observed.epoch !== generation.epoch
        ) {
          throw new Error(`Succession writer generation ${generation.generation} cannot unpark after advance.`);
        }
        if (observed.serving !== undefined) throw new SuccessionServingCommittedError();
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
    },
  };
}

export function advanceSuccessionWriterGeneration(
  runtime: Runtime,
  expected: SuccessionWriterGeneration,
  store: Readonly<{ storeRoot: string; epoch: string }>,
): SuccessionWriterGeneration {
  const location = ensureGuard(runtime);
  const release = exclusiveGuard(runtime, location.guard);
  try {
    const current = readGeneration(runtime, location.record);
    if (
      current?.generation !== expected.generation ||
      current.storeRoot !== expected.storeRoot ||
      current.epoch !== expected.epoch
    ) {
      throw new Error(`Succession writer generation ${expected.generation} cannot advance.`);
    }
    const next = { ...current, generation: current.generation + 1, storeRoot: store.storeRoot, epoch: store.epoch };
    delete next.serving;
    writeGeneration(runtime, location.record, next);
    return next;
  } finally {
    release();
  }
}

export function recordSuccessionServing(
  runtime: Runtime,
  generation: SuccessionWriterGeneration,
  serving: SuccessionServingRecord,
): CommittedSuccessionServing {
  const location = ensureGuard(runtime);
  const release = exclusiveGuard(runtime, location.guard);
  try {
    const current = readGeneration(runtime, location.record);
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

export function observeSuccessionServing(runtime: Runtime, attemptId: string): SuccessionServingRecord | null {
  const location = paths(runtime);
  const current = readGeneration(runtime, location.record);
  return current?.serving?.attemptId === attemptId ? current.serving : null;
}

export function observeSuccessionWriterGeneration(runtime: Runtime): SuccessionWriterGeneration | null {
  const location = paths(runtime);
  const current = readGeneration(runtime, location.record);
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
    const current = readGeneration(runtime, location.record);
    if (
      current?.generation !== failed.generation ||
      current.storeRoot !== failed.storeRoot ||
      current.epoch !== failed.epoch
    ) {
      throw new Error(`Succession writer generation ${failed.generation} cannot hand back.`);
    }
    if (current.serving !== undefined) throw new SuccessionServingCommittedError();
    const next = { ...current, generation: current.generation + 1, ...incumbentStore };
    writeGeneration(runtime, location.record, next);
    for (const [key, state] of localParkStates) {
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

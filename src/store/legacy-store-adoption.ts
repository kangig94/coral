import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

import {
  acquireDirectoryLock,
  isDirectoryLockTimeoutError,
  tryRemoveStaleDirectoryLock,
  type DirectoryLockDeps,
  type DirectoryLockLease,
} from '../infra/fs-lock.js';
import { isNoEntryError } from '../infra/fs-errors.js';
import {
  PACKAGE_OPERATION_LOCK_HEARTBEAT_MS,
  PACKAGE_OPERATION_LOCK_STALE_MS,
} from '../infra/package-operation-lock.js';
import { compareProductVersions, validateProductVersion } from '../infra/product-version.js';
import { documentedCoralSetupError } from '../runtime/errors.js';
import type { Runtime } from '../runtime/ports.js';
import { type Database } from './db.js';
import type { StoreFormatDescription } from './format-fingerprint.js';
import {
  acquireGenerationMaintenanceLease,
  resolveGenerationBoundaryPaths,
  type GenerationBoundaryPaths,
} from './generation-mutation-coordination.js';

const STORE_FORMAT_FINGERPRINT_KEY = 'store_format_fingerprint';
const STORE_PRODUCT_VERSION_KEY = 'store_product_version';
const ADOPTED_FROM_LEGACY_AT_KEY = 'adopted_from_legacy_at';
const ADOPTED_BY_VERSION_KEY = 'adopted_by_version';
const LEGACY_GENERATION_READER_VERSION = '0.9.x';
const ADOPTION_LOCK_TIMEOUT_MS = 5_000;
const ADOPTION_LOCK_STALE_MS = 10 * 60 * 1_000;
const ADOPTION_LOCK_HEARTBEAT_MS = 10 * 1_000;

type AdoptionSourceState =
  | { readonly kind: 'adoptable' }
  | { readonly kind: 'prepared-adoption'; readonly adoptedAt: string };

export type LegacyStoreAdoptionResult =
  | {
      readonly kind: 'adopted';
      readonly flavor: Runtime['flavor'];
      readonly source: string;
      readonly destination: string;
      readonly adoptedAt: string;
      readonly sourceState: AdoptionSourceState['kind'];
    }
  | {
      readonly kind: 'already-adopted';
      readonly flavor: Runtime['flavor'];
      readonly destination: string;
      readonly adoptedAt: string;
    }
  | { readonly kind: 'no-legacy-source'; readonly flavor: Runtime['flavor']; readonly source: string };

export interface AdoptionSocketGuard {
  release(): Promise<void>;
}

export type AdoptLegacyStoreOptions = {
  readonly runtime: Runtime;
  readonly storeFormat: StoreFormatDescription;
  readonly adoptionLockTimeoutMs?: number;
  readonly maintenanceTimeoutMs?: number;
  readonly acquireSocketGuard: (socketPath: string, flavor: Runtime['flavor']) => Promise<AdoptionSocketGuard>;
  readonly faults?: {
    readonly afterProvenanceCommitBeforeClose?: () => void;
    readonly afterRename?: () => void;
  };
};

type SourceIdentity = {
  readonly fingerprint: string | null;
  readonly productVersion: string | null;
  readonly adoptedAt: string | null;
  readonly adoptedByVersion: string | null;
};

function storeDbPath(flavorRoot: string): string {
  return join(flavorRoot, 'store', 'store.db');
}

function readMetadata(db: Database, key: string): string | null {
  try {
    const row = db.prepare<[string], { value?: unknown }>('SELECT value FROM meta WHERE key = ? LIMIT 1').get(key);
    return typeof row?.value === 'string' ? row.value : null;
  } catch (error: unknown) {
    if (error instanceof Error && /no such table: meta|no such column/i.test(error.message)) {
      return null;
    }
    throw error;
  }
}

function readSourceIdentity(db: Database): SourceIdentity {
  return {
    fingerprint: readMetadata(db, STORE_FORMAT_FINGERPRINT_KEY),
    productVersion: readMetadata(db, STORE_PRODUCT_VERSION_KEY),
    adoptedAt: readMetadata(db, ADOPTED_FROM_LEGACY_AT_KEY),
    adoptedByVersion: readMetadata(db, ADOPTED_BY_VERSION_KEY),
  };
}

function validAdoptionTimestamp(value: string | null): value is string {
  if (value === null) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function sourceState(identity: SourceIdentity, storeFormat: StoreFormatDescription): AdoptionSourceState | null {
  if (identity.fingerprint !== storeFormat.fingerprint) return null;
  if (identity.adoptedAt === null && identity.adoptedByVersion === null) {
    return { kind: 'adoptable' };
  }
  if (validAdoptionTimestamp(identity.adoptedAt) && identity.adoptedByVersion === storeFormat.productVersion) {
    return { kind: 'prepared-adoption', adoptedAt: identity.adoptedAt };
  }
  return null;
}

function readerVersion(identity: SourceIdentity): string {
  return (
    (identity.productVersion === null ? null : validateProductVersion(identity.productVersion)) ??
    LEGACY_GENERATION_READER_VERSION
  );
}

function foreignGenerationError(runtime: Pick<Runtime, 'flavor'>, legacyPath: string, identity: SourceIdentity): Error {
  return documentedCoralSetupError({
    code: 'legacy_foreign_generation',
    flavor: runtime.flavor,
    legacyPath,
    version: readerVersion(identity),
  });
}

function readAdoptionSource(
  runtime: Pick<Runtime, 'flavor' | 'storage'>,
  paths: GenerationBoundaryPaths,
  storeFormat: StoreFormatDescription,
): AdoptionSourceState {
  const dbFile = storeDbPath(paths.legacyFlavorRoot);
  if (!runtime.storage.existsSync(dbFile)) {
    throw foreignGenerationError(runtime, paths.legacyFlavorRoot, {
      fingerprint: null,
      productVersion: null,
      adoptedAt: null,
      adoptedByVersion: null,
    });
  }

  let db: Database;
  try {
    db = new DatabaseSync(dbFile, { readOnly: true }) as unknown as Database;
  } catch {
    throw foreignGenerationError(runtime, paths.legacyFlavorRoot, {
      fingerprint: null,
      productVersion: null,
      adoptedAt: null,
      adoptedByVersion: null,
    });
  }
  try {
    const identity = readSourceIdentity(db);
    const state = sourceState(identity, storeFormat);
    if (state === null) throw foreignGenerationError(runtime, paths.legacyFlavorRoot, identity);
    return state;
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'legacy_foreign_generation') {
      throw error;
    }
    throw foreignGenerationError(runtime, paths.legacyFlavorRoot, {
      fingerprint: null,
      productVersion: null,
      adoptedAt: null,
      adoptedByVersion: null,
    });
  } finally {
    db.close();
  }
}

function lockDeps(runtime: Runtime): DirectoryLockDeps {
  return {
    storage: runtime.storage,
    time: {
      now: () => runtime.time.now(),
      sleep: (ms) => runtime.time.sleep(ms),
      setInterval: runtime.time.setInterval.bind(runtime.time),
      clearInterval: runtime.time.clearInterval.bind(runtime.time),
    },
    staleMs: ADOPTION_LOCK_STALE_MS,
    heartbeatMs: ADOPTION_LOCK_HEARTBEAT_MS,
  };
}

function packageLockDeps(runtime: Runtime): DirectoryLockDeps {
  return {
    ...lockDeps(runtime),
    staleMs: PACKAGE_OPERATION_LOCK_STALE_MS,
    heartbeatMs: PACKAGE_OPERATION_LOCK_HEARTBEAT_MS,
  };
}

function notQuiescent(runtime: Pick<Runtime, 'flavor'>, holder: string): Error {
  return documentedCoralSetupError({
    code: 'legacy_source_not_quiescent',
    flavor: runtime.flavor,
    holder,
  });
}

function legacyPackageLocks(runtime: Runtime, paths: GenerationBoundaryPaths): string[] {
  const lockRoot = join(paths.legacyFlavorRoot, 'engines', '.locks');
  try {
    return runtime.storage
      .readdirSync(lockRoot)
      .filter((entry) => entry.endsWith('.lock'))
      .map((entry) => join(lockRoot, entry));
  } catch (error: unknown) {
    if (isNoEntryError(error)) return [];
    throw notQuiescent(runtime, `unreadable install.lock directory at ${lockRoot}`);
  }
}

function removeDeadLegacyPackageLocks(runtime: Runtime, paths: GenerationBoundaryPaths): void {
  for (const lockPath of legacyPackageLocks(runtime, paths)) {
    let isDirectory: boolean;
    try {
      const stat = runtime.storage.lstatSync(lockPath);
      isDirectory = stat.isDirectory() && !stat.isSymbolicLink();
    } catch (error: unknown) {
      if (isNoEntryError(error)) continue;
      throw notQuiescent(runtime, `unreadable install.lock at ${lockPath}`);
    }
    if (!isDirectory || !tryRemoveStaleDirectoryLock(lockPath, packageLockDeps(runtime))) {
      throw notQuiescent(runtime, `install.lock at ${lockPath}`);
    }
  }
}

function assertNoLegacyPackageLocks(runtime: Runtime, paths: GenerationBoundaryPaths): void {
  const [lockPath] = legacyPackageLocks(runtime, paths);
  if (lockPath !== undefined) {
    throw notQuiescent(runtime, `install.lock at ${lockPath}`);
  }
}

function writeMetadata(db: Database, key: string, value: string): void {
  db.prepare<[string, string]>(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

function stampAdoptionProvenance(
  runtime: Runtime,
  paths: GenerationBoundaryPaths,
  storeFormat: StoreFormatDescription,
  fault?: () => void,
): { readonly adoptedAt: string; readonly sourceState: AdoptionSourceState['kind'] } {
  const db = new DatabaseSync(storeDbPath(paths.legacyFlavorRoot)) as unknown as Database;
  let committed = false;
  try {
    db.exec('PRAGMA synchronous = FULL');
    db.exec('BEGIN IMMEDIATE');
    const identity = readSourceIdentity(db);
    const state = sourceState(identity, storeFormat);
    if (state === null) throw foreignGenerationError(runtime, paths.legacyFlavorRoot, identity);

    const adoptedAt = state.kind === 'prepared-adoption' ? state.adoptedAt : new Date(runtime.time.now()).toISOString();
    if (state.kind === 'adoptable') {
      writeMetadata(db, ADOPTED_FROM_LEGACY_AT_KEY, adoptedAt);
      writeMetadata(db, ADOPTED_BY_VERSION_KEY, storeFormat.productVersion);
    }

    const storedVersion = identity.productVersion === null ? null : validateProductVersion(identity.productVersion);
    if (storedVersion === null || compareProductVersions(storedVersion, storeFormat.productVersion) < 0) {
      writeMetadata(db, STORE_PRODUCT_VERSION_KEY, storeFormat.productVersion);
    }
    db.exec('COMMIT');
    committed = true;
    fault?.();
    return { adoptedAt, sourceState: state.kind };
  } catch (error) {
    if (!committed) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Preserve the stamping failure.
      }
    }
    throw error;
  } finally {
    db.close();
  }
}

function readCompletedAdoption(
  runtime: Pick<Runtime, 'flavor' | 'storage'>,
  paths: GenerationBoundaryPaths,
  storeFormat: StoreFormatDescription,
): string | null {
  const dbFile = storeDbPath(paths.generatedFlavorRoot);
  if (!runtime.storage.existsSync(dbFile)) return null;
  const db = new DatabaseSync(dbFile, { readOnly: true }) as unknown as Database;
  try {
    const state = sourceState(readSourceIdentity(db), storeFormat);
    return state?.kind === 'prepared-adoption' ? state.adoptedAt : null;
  } finally {
    db.close();
  }
}

function syncRenameParents(runtime: Runtime, paths: GenerationBoundaryPaths): void {
  if (!runtime.storage.syncDirectoryDurableSync(paths.baseDir)) {
    throw new Error(`Failed to durably synchronize legacy source parent '${paths.baseDir}'.`);
  }
  if (!runtime.storage.syncDirectoryDurableSync(paths.generationRoot)) {
    throw new Error(`Failed to durably synchronize generated destination parent '${paths.generationRoot}'.`);
  }
}

async function acquireAdoptionGuard(
  runtime: Runtime,
  paths: GenerationBoundaryPaths,
  timeoutMs: number,
): Promise<DirectoryLockLease> {
  runtime.storage.mkdirSync(paths.generationRoot, { recursive: true });
  try {
    return await acquireDirectoryLock(paths.adoptionLock, lockDeps(runtime), timeoutMs);
  } catch (error: unknown) {
    if (isDirectoryLockTimeoutError(error)) {
      throw notQuiescent(runtime, `adoption lock at ${paths.adoptionLock}`);
    }
    throw error;
  }
}

export async function adoptLegacyStore({
  runtime,
  storeFormat,
  adoptionLockTimeoutMs = ADOPTION_LOCK_TIMEOUT_MS,
  maintenanceTimeoutMs,
  acquireSocketGuard,
  faults,
}: AdoptLegacyStoreOptions): Promise<LegacyStoreAdoptionResult> {
  const paths = resolveGenerationBoundaryPaths(runtime);
  if (runtime.storage.existsSync(paths.generatedFlavorRoot)) {
    const adoptedAt = readCompletedAdoption(runtime, paths, storeFormat);
    if (adoptedAt === null) {
      throw new Error(
        `Generated target '${paths.generatedFlavorRoot}' already exists and is not a completed adoption.`,
      );
    }
    syncRenameParents(runtime, paths);
    return { kind: 'already-adopted', flavor: runtime.flavor, destination: paths.generatedFlavorRoot, adoptedAt };
  }
  if (!runtime.storage.existsSync(paths.legacyFlavorRoot)) {
    return { kind: 'no-legacy-source', flavor: runtime.flavor, source: paths.legacyFlavorRoot };
  }

  readAdoptionSource(runtime, paths, storeFormat);
  const socketGuard = await acquireSocketGuard(runtime.paths.coral.coordinator.socketPath, runtime.flavor);
  try {
    const releaseAdoption = await acquireAdoptionGuard(runtime, paths, adoptionLockTimeoutMs);
    try {
      if (runtime.storage.existsSync(paths.generatedFlavorRoot)) {
        throw new Error(`Generated target '${paths.generatedFlavorRoot}' appeared during adoption.`);
      }
      if (!runtime.storage.existsSync(paths.legacyFlavorRoot)) {
        throw new Error(`Legacy source '${paths.legacyFlavorRoot}' disappeared during adoption.`);
      }

      const maintenance = await acquireGenerationMaintenanceLease(runtime, maintenanceTimeoutMs);
      try {
        removeDeadLegacyPackageLocks(runtime, paths);
        assertNoLegacyPackageLocks(runtime, paths);
        const source = readAdoptionSource(runtime, paths, storeFormat);
        assertNoLegacyPackageLocks(runtime, paths);
        const provenance = stampAdoptionProvenance(
          runtime,
          paths,
          storeFormat,
          faults?.afterProvenanceCommitBeforeClose,
        );
        assertNoLegacyPackageLocks(runtime, paths);
        runtime.storage.renameSync(paths.legacyFlavorRoot, paths.generatedFlavorRoot);
        try {
          faults?.afterRename?.();
        } finally {
          syncRenameParents(runtime, paths);
        }
        return {
          kind: 'adopted',
          flavor: runtime.flavor,
          source: paths.legacyFlavorRoot,
          destination: paths.generatedFlavorRoot,
          adoptedAt: provenance.adoptedAt,
          sourceState: source.kind,
        };
      } finally {
        maintenance.release();
      }
    } finally {
      releaseAdoption();
    }
  } finally {
    await socketGuard.release();
  }
}

import { basename, dirname, join } from 'node:path';

import { backendLog } from '../infra/backend-log.js';
import { assertNever } from '../infra/error-format.js';
import { isNoEntryError } from '../infra/fs-errors.js';
import {
  acquireDirectoryLock,
  isDirectoryLockTimeoutError,
  tryAcquireDirectoryLock,
  type DirectoryLockLease,
} from '../infra/fs-lock.js';
import { validateProductVersion } from '../infra/product-version.js';
import { documentedCoralSetupError } from '../runtime/errors.js';
import type { Runtime } from '../runtime/ports.js';
import { classifyStoreFile } from './db.js';
import type { StoreFormatClassification, StoreFormatDescription } from './format-fingerprint.js';

export type GenerationMutationKind = 'install' | 'update' | 'uninstall' | 'kb-child' | 'routing-status';

export interface GenerationReadinessCompletion {
  release(): void;
}

export interface GenerationWriterLease {
  assertOwned(): void;
  release(): void;
}

export type GenerationWriterLeaseAttempt =
  | Readonly<{ kind: 'acquired'; lease: GenerationWriterLease }>
  | Readonly<{ kind: 'maintenance-active' }>
  | Readonly<{ kind: 'contended' }>;

export interface GenerationMutationCoordination {
  // `storeFormat` is threaded in rather than defaulted to `currentCoralStoreFormat()`:
  // that default made this store module import `src/store-format.ts`, which drags the
  // whole provider registry into the simulation's sealed import graph and breaks
  // `npm run build`. Callers in the CLI already hold the description.
  completeReadiness(
    runtime: Runtime,
    storeFormat: StoreFormatDescription,
    mutation: { readonly kind: GenerationMutationKind; readonly name: string },
  ): Promise<GenerationReadinessCompletion>;
  acquireWriterLease(
    runtime: Runtime,
    mutation: { readonly kind: GenerationMutationKind; readonly name: string },
  ): Promise<GenerationWriterLease>;
}

export type GenerationBoundaryPaths = {
  readonly baseDir: string;
  readonly generationRoot: string;
  readonly generatedFlavorRoot: string;
  readonly legacyFlavorRoot: string;
  readonly adoptionLock: string;
  readonly coordinationRoot: string;
  readonly admissionLock: string;
  readonly maintenanceLock: string;
  readonly writersRoot: string;
};

/**
 * A previous generation's tree is never a precondition for this one. Whether its
 * store is readable by this build or not makes no difference to startup: the
 * generation boundary exists to end the coupling, so legacy bytes are left where
 * they are and this generation initializes its own state. `legacy-ignored`
 * therefore covers both a foreign store and one this build happens to be able to
 * read — the distinction only ever mattered to a migration path that no longer
 * exists.
 */
export type GenerationReadiness =
  | { readonly kind: 'generated-ready' }
  | { readonly kind: 'no-legacy' }
  | {
      readonly kind: 'legacy-ignored';
      readonly legacyPath: string;
      readonly generatedPath: string;
      readonly storedProductVersion: string | null;
    };

export interface GenerationMaintenanceLease {
  assertOwned(): void;
  release(): void;
}

export interface GenerationAdoptionLease {
  assertOwned(): void;
  release(): void;
}

const GENERATION_ADOPTION_LOCK_BRAND: unique symbol = Symbol('GenerationAdoptionLockLease');

export type GenerationAdoptionLockLease = DirectoryLockLease & {
  readonly [GENERATION_ADOPTION_LOCK_BRAND]: true;
};

const GENERATION_COORDINATION_TIMEOUT_MS = 5_000;
const GENERATION_COORDINATION_STALE_MS = 10 * 60 * 1_000;
const GENERATION_COORDINATION_HEARTBEAT_MS = 10 * 1_000;
const GENERATION_COORDINATION_RETRY_MS = 25;

export function resolveGenerationBoundaryPaths(runtime: Pick<Runtime, 'paths'>): GenerationBoundaryPaths {
  const generation = runtime.paths.coral.generation;
  const flavorDir = basename(generation.dataRoot);
  const coordinationRoot = join(generation.root, `.mutation-${flavorDir}`);
  return {
    baseDir: dirname(generation.legacyDataRoot),
    generationRoot: generation.root,
    generatedFlavorRoot: generation.dataRoot,
    legacyFlavorRoot: generation.legacyDataRoot,
    adoptionLock: generation.adoptionLock,
    coordinationRoot,
    admissionLock: join(coordinationRoot, 'admission.lock'),
    maintenanceLock: join(coordinationRoot, 'maintenance.lock'),
    writersRoot: join(coordinationRoot, 'writers'),
  };
}

export function inspectGenerationReadiness(
  runtime: Pick<Runtime, 'flavor' | 'paths' | 'storage'>,
  storeFormat: StoreFormatDescription,
): GenerationReadiness {
  const paths = resolveGenerationBoundaryPaths(runtime);
  if (runtime.storage.existsSync(paths.generatedFlavorRoot)) {
    return { kind: 'generated-ready' };
  }
  if (!runtime.storage.existsSync(paths.legacyFlavorRoot)) {
    return { kind: 'no-legacy' };
  }

  // The stored version is read for the notice only. Nothing branches on whether
  // this build could read the legacy store, because nothing imports it — an
  // unreadable one is reported as unknown rather than diagnosed.
  const storedProductVersion = ((): string | null => {
    try {
      const classification: StoreFormatClassification = classifyStoreFile(
        join(paths.legacyFlavorRoot, 'store', 'store.db'),
        runtime.storage,
        storeFormat,
      );
      return 'storedProductVersion' in classification && classification.storedProductVersion !== null
        ? validateProductVersion(classification.storedProductVersion)
        : null;
    } catch {
      return null;
    }
  })();

  return {
    kind: 'legacy-ignored',
    legacyPath: paths.legacyFlavorRoot,
    generatedPath: paths.generatedFlavorRoot,
    storedProductVersion,
  };
}

export function formatLegacyGenerationIgnoredNotice(
  readiness: Extract<GenerationReadiness, { readonly kind: 'legacy-ignored' }>,
): string {
  return (
    `Legacy Coral history remains at ${readiness.legacyPath} (stored Coral version ` +
    `${readiness.storedProductVersion ?? 'unknown'}) and is left untouched. This generation initializes ` +
    `its own state at ${readiness.generatedPath}.`
  );
}

function directoryLockDeps(runtime: Runtime) {
  return {
    storage: runtime.storage,
    time: {
      now: () => runtime.time.now(),
      sleep: (ms: number) => runtime.time.sleep(ms),
      setInterval: runtime.time.setInterval.bind(runtime.time),
      clearInterval: runtime.time.clearInterval.bind(runtime.time),
    },
    staleMs: GENERATION_COORDINATION_STALE_MS,
    heartbeatMs: GENERATION_COORDINATION_HEARTBEAT_MS,
  };
}

export function generationNotQuiescentError(runtime: Pick<Runtime, 'flavor'>, holder: string): Error {
  return documentedCoralSetupError({
    code: 'legacy_source_not_quiescent',
    flavor: runtime.flavor,
    holder,
  });
}

function ensureCoordinationRoot(runtime: Runtime, paths: GenerationBoundaryPaths): void {
  runtime.storage.mkdirSync(paths.writersRoot, { recursive: true });
}

export async function acquireGenerationAdoptionLock(
  runtime: Runtime,
  timeoutMs = GENERATION_COORDINATION_TIMEOUT_MS,
): Promise<GenerationAdoptionLockLease> {
  const paths = resolveGenerationBoundaryPaths(runtime);
  runtime.storage.mkdirSync(paths.generationRoot, { recursive: true });
  try {
    const lease = await acquireDirectoryLock(paths.adoptionLock, directoryLockDeps(runtime), timeoutMs);
    Object.defineProperty(lease, GENERATION_ADOPTION_LOCK_BRAND, { value: true });
    return lease as GenerationAdoptionLockLease;
  } catch (error: unknown) {
    if (isDirectoryLockTimeoutError(error)) {
      throw generationNotQuiescentError(runtime, `adoption lock at ${paths.adoptionLock}`);
    }
    throw error;
  }
}

export async function acquireGenerationAdoptionLease(
  runtime: Runtime,
  storeFormat: StoreFormatDescription,
  timeoutMs = GENERATION_COORDINATION_TIMEOUT_MS,
): Promise<GenerationAdoptionLease> {
  const releaseAdoption = await acquireGenerationAdoptionLock(runtime, timeoutMs);
  try {
    const readiness = inspectGenerationReadiness(runtime, storeFormat);
    switch (readiness.kind) {
      case 'generated-ready':
      case 'no-legacy':
        break;
      case 'legacy-ignored':
        backendLog.warn(formatLegacyGenerationIgnoredNotice(readiness));
        break;
      default:
        assertNever(readiness);
    }
  } catch (error) {
    releaseAdoption();
    throw error;
  }
  return {
    assertOwned: releaseAdoption.assertOwned,
    release: releaseAdoption,
  };
}

function writerLeaseName(runtime: Runtime, mutation: { readonly kind: GenerationMutationKind; readonly name: string }) {
  return `${runtime.env.pid()}-${mutation.kind}-${encodeURIComponent(mutation.name)}.lease-${runtime.ids.uuid()}.lock`;
}

function writerHolder(entry: string): { readonly pid: number; readonly description: string } | null {
  const match = /^(\d+)-(install|update|uninstall|kb-child|routing-status)-(.+)\.lease-[^.]+\.lock$/u.exec(entry);
  if (match === null) return null;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  let name: string;
  try {
    name = decodeURIComponent(match[3]);
  } catch {
    return null;
  }
  return { pid, description: `${match[2]}:${name} (pid ${pid})` };
}

function writerEntries(runtime: Runtime, paths: GenerationBoundaryPaths): string[] {
  try {
    return runtime.storage.readdirSync(paths.writersRoot).filter((entry) => entry.endsWith('.lock'));
  } catch (error: unknown) {
    if (isNoEntryError(error)) return [];
    throw generationNotQuiescentError(runtime, `unreadable writer lease directory at ${paths.writersRoot}`);
  }
}

function removeDeadWriterLeases(runtime: Runtime, paths: GenerationBoundaryPaths): string[] {
  const live: string[] = [];
  for (const entry of writerEntries(runtime, paths)) {
    const holder = writerHolder(entry);
    if (holder === null) {
      live.push(entry);
      continue;
    }
    if (runtime.process.observeLiveness(holder.pid) !== 'absent') {
      live.push(holder.description);
      continue;
    }
    runtime.storage.rmSync(join(paths.writersRoot, entry), { recursive: true, force: true });
  }
  return live;
}

function acquireWriterLeaseUnderAdmission(
  runtime: Runtime,
  paths: GenerationBoundaryPaths,
  mutation: { readonly kind: GenerationMutationKind; readonly name: string },
): GenerationWriterLeaseAttempt {
  if (runtime.storage.existsSync(paths.maintenanceLock)) return { kind: 'maintenance-active' };
  const releaseWriter = tryAcquireDirectoryLock(
    join(paths.writersRoot, writerLeaseName(runtime, mutation)),
    directoryLockDeps(runtime),
  );
  return releaseWriter === null
    ? { kind: 'contended' }
    : {
        kind: 'acquired',
        lease: {
          assertOwned: releaseWriter.assertOwned,
          release: releaseWriter,
        },
      };
}

export function tryAcquireGenerationWriterLease(
  runtime: Runtime,
  mutation: { readonly kind: GenerationMutationKind; readonly name: string },
): GenerationWriterLeaseAttempt {
  const paths = resolveGenerationBoundaryPaths(runtime);
  ensureCoordinationRoot(runtime, paths);
  const releaseAdmission = tryAcquireDirectoryLock(paths.admissionLock, directoryLockDeps(runtime));
  if (releaseAdmission === null) return { kind: 'contended' };
  try {
    return acquireWriterLeaseUnderAdmission(runtime, paths, mutation);
  } finally {
    releaseAdmission();
  }
}

export const generationMutationCoordinationSeam: GenerationMutationCoordination = {
  async completeReadiness(runtime, storeFormat) {
    return acquireGenerationAdoptionLease(runtime, storeFormat);
  },
  async acquireWriterLease(runtime, mutation) {
    const paths = resolveGenerationBoundaryPaths(runtime);
    ensureCoordinationRoot(runtime, paths);
    const deadline = runtime.time.now() + GENERATION_COORDINATION_TIMEOUT_MS;

    while (runtime.time.now() < deadline) {
      const releaseAdmission = await acquireDirectoryLock(
        paths.admissionLock,
        directoryLockDeps(runtime),
        GENERATION_COORDINATION_TIMEOUT_MS,
      );
      try {
        const attempt = acquireWriterLeaseUnderAdmission(runtime, paths, mutation);
        if (attempt.kind === 'acquired') return attempt.lease;
      } finally {
        releaseAdmission();
      }
      await runtime.time.sleep(GENERATION_COORDINATION_RETRY_MS);
    }

    throw generationNotQuiescentError(runtime, 'generation maintenance');
  },
};

export async function acquireGenerationMaintenanceLease(
  runtime: Runtime,
  timeoutMs = GENERATION_COORDINATION_TIMEOUT_MS,
): Promise<GenerationMaintenanceLease> {
  const paths = resolveGenerationBoundaryPaths(runtime);
  ensureCoordinationRoot(runtime, paths);
  const releaseAdmission = await acquireDirectoryLock(paths.admissionLock, directoryLockDeps(runtime), timeoutMs);
  let releaseMaintenance: DirectoryLockLease;
  try {
    releaseMaintenance = await acquireDirectoryLock(paths.maintenanceLock, directoryLockDeps(runtime), timeoutMs);
  } finally {
    releaseAdmission();
  }

  const deadline = runtime.time.now() + timeoutMs;
  try {
    while (true) {
      const live = removeDeadWriterLeases(runtime, paths);
      if (live.length === 0) break;
      if (runtime.time.now() >= deadline) {
        throw generationNotQuiescentError(runtime, live.join(', '));
      }
      await runtime.time.sleep(GENERATION_COORDINATION_RETRY_MS);
    }

    let owned = true;
    return {
      assertOwned() {
        if (!owned) throw new Error('Generation maintenance lease is no longer owned.');
        releaseMaintenance.assertOwned();
      },
      release() {
        if (!owned) return;
        owned = false;
        releaseMaintenance();
      },
    };
  } catch (error) {
    releaseMaintenance();
    throw error;
  }
}

export async function acquireGenerationWriterLeaseAfterReadiness(
  coordination: GenerationMutationCoordination,
  runtime: Runtime,
  storeFormat: StoreFormatDescription,
  mutation: { readonly kind: GenerationMutationKind; readonly name: string },
): Promise<GenerationWriterLease> {
  const readiness = await coordination.completeReadiness(runtime, storeFormat, mutation);
  readiness.release();
  return coordination.acquireWriterLease(runtime, mutation);
}
